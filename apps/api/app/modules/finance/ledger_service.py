"""
خدمة دفتر الأستاذ العام (General Ledger Service)
─────────────────────────────────────────────────
تنفذ قيود اليومية المزدوجة بضمانات المحاسبة الكاملة:
1. التحقق من توازن المدين والدائن قبل الترحيل.
2. ضمان الأتومية — القيد وسطوره في معاملة واحدة.
3. منع الترحيل المزدوج (Idempotency) بـ source_doc_type + source_doc_id.
4. تنسيق رقم القيد: JE-YYYYMMDD-{hex8}.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Sequence

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.models import Account, JournalEntry, JournalEntryLine

CANONICAL_TREASURY_ID = "00000000-0000-0000-0000-000000000001"


# ── حسابات مخطط الحسابات المعيارية ─────────────────────────────────────────
ACCOUNT_CODES = {
    "cash":           "1010",
    "raw_material":   "1210",
    "wip":            "1220",
    "finished_goods": "1230",
    "accounts_payable": "2100",
    "cogs":           "5100",
    "revenue":        "4100",
}


async def get_account_by_code(db: AsyncSession, code: str) -> Account:
    account = await db.scalar(select(Account).where(Account.code == code, Account.is_active.is_(True)))
    if not account:
        raise HTTPException(500, f"حساب دفتر الأستاذ '{code}' غير موجود — تحقق من بيانات مخطط الحسابات.")
    return account


async def post_journal_entry(
    db: AsyncSession,
    *,
    source_doc_type: str,
    source_doc_id: str,
    description: str,
    lines: list[dict],  # [{"account_code": str, "debit": Decimal, "credit": Decimal, "description": str}]
    user_id: str,
    entry_date: datetime | None = None,
    allow_duplicate: bool = False,
) -> JournalEntry:
    """
    ترحّل قيد يومية مزدوجاً مكتملاً.

    المعاملات:
        source_doc_type: نوع المستند المُنشئ (supplier_payment, customer_delivery …)
        source_doc_id:   معرّف المستند
        description:     وصف القيد
        lines:           قائمة أسطر القيد — كل سطر يحتوي account_code + debit أو credit
        user_id:         مُنشئ القيد
        entry_date:      تاريخ القيد (افتراضي: الآن)
        allow_duplicate: السماح بترحيل متعدد لنفس المستند (افتراضي: False)

    يرفع 422 إذا لم يتوازن القيد.
    يرفع 409 إذا رُحِّل المستند من قبل.
    """
    # ── 1. منع الترحيل المزدوج ─────────────────────────────────────────────
    if not allow_duplicate:
        existing_id = await db.scalar(
            select(JournalEntry.id).where(
                JournalEntry.source_doc_type == source_doc_type,
                JournalEntry.source_doc_id == source_doc_id,
            )
        )
        if existing_id:
            raise HTTPException(409, f"تم ترحيل هذا المستند ({source_doc_type}/{source_doc_id}) مسبقاً في القيد {existing_id}.")

    # ── 2. التحقق من توازن القيد ───────────────────────────────────────────
    total_debit = sum(Decimal(str(ln.get("debit", 0))) for ln in lines)
    total_credit = sum(Decimal(str(ln.get("credit", 0))) for ln in lines)
    if total_debit != total_credit:
        raise HTTPException(
            422,
            f"القيد غير متوازن: إجمالي المدين {total_debit} ≠ إجمالي الدائن {total_credit}.",
        )
    if total_debit == 0:
        raise HTTPException(422, "القيد فارغ — يجب أن يحتوي على مبالغ.")

    # ── 3. جلب حسابات دفتر الأستاذ ────────────────────────────────────────
    codes = [ln["account_code"] for ln in lines]
    accounts_result = (await db.scalars(select(Account).where(Account.code.in_(codes)))).all()
    account_map = {a.code: a for a in accounts_result}
    missing = [c for c in codes if c not in account_map]
    if missing:
        raise HTTPException(500, f"حسابات غير موجودة: {missing}")

    # ── 4. إنشاء القيد والأسطر ─────────────────────────────────────────────
    now = datetime.now(timezone.utc)
    entry_number = f"JE-{now:%Y%m%d}-{uuid.uuid4().hex[:8].upper()}"
    entry = JournalEntry(
        id=str(uuid.uuid4()),
        entry_number=entry_number,
        entry_date=entry_date or now,
        source_doc_type=source_doc_type,
        source_doc_id=source_doc_id,
        description=description,
        status="posted",
        created_by=user_id,
        posted_at=now,
    )
    db.add(entry)
    await db.flush()  # الحصول على entry.id قبل إضافة الأسطر

    for ln in lines:
        account = account_map[ln["account_code"]]
        line = JournalEntryLine(
            id=str(uuid.uuid4()),
            entry_id=entry.id,
            account_id=account.id,
            debit=Decimal(str(ln.get("debit", 0))),
            credit=Decimal(str(ln.get("credit", 0))),
            description=ln.get("description", ""),
        )
        db.add(line)

    return entry


async def get_account_balance(db: AsyncSession, account_code: str) -> Decimal:
    """
    يُرجع صافي الرصيد للحساب (المدين - الدائن) من سطور القيود المرحّلة.
    الأصول والمصروفات: رصيد مدين موجب.
    الالتزامات والإيرادات: رصيد دائن موجب.
    """
    account = await db.scalar(select(Account).where(Account.code == account_code))
    if not account:
        return Decimal("0.00")

    total_debit = await db.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.debit), 0)).where(
            JournalEntryLine.account_id == account.id
        )
    )
    total_credit = await db.scalar(
        select(func.coalesce(func.sum(JournalEntryLine.credit), 0)).where(
            JournalEntryLine.account_id == account.id
        )
    )
    return Decimal(str(total_debit)) - Decimal(str(total_credit))


async def get_weighted_average_cost(db: AsyncSession, item_id: str, warehouse_id: str | None = None) -> Decimal:
    """
    يحسب متوسط التكلفة المرجح (WAC) لصنف في مخزن.
    الصيغة: SUM(total_cost) / SUM(quantity) لكل الحركات الموجبة.

    تُستثنى حركات حاوية «مرتجع تحت الفحص» (return_pending_inspection:{cid}): المرتجع يُقيَّد
    موجباً عند إنشائه ثم يُحرَّر بقيد سالب عند الفحص، وإعادة التخزين تُقيَّد مرة واحدة موجبة في
    حاوية البيع — فلولا هذا الاستثناء لاحتُسبت كمية المرتجع المعاد تخزينه مرتين في المجاميع.

    يُرجع 0 إذا لم تُجد تكاليف.
    """
    # التبعية الدورية: نستورد هنا داخل الدالة لتجنب الحلقة
    from sqlalchemy import or_

    from app.modules.production.models import StockLedgerEntry
    from app.modules.production.stock import RETURN_PENDING_PREFIX

    # حاويات NULL (مخزن الخامات) تبقى داخل الحساب؛ تُستثنى حاوية الفحص فقط
    exclude_quarantine = or_(
        StockLedgerEntry.bucket_reference.is_(None),
        ~StockLedgerEntry.bucket_reference.startswith(RETURN_PENDING_PREFIX),
    )

    filters = [
        StockLedgerEntry.item_id == item_id,
        StockLedgerEntry.quantity > 0,
        StockLedgerEntry.total_cost > 0,
        exclude_quarantine,
    ]
    if warehouse_id:
        filters.append(StockLedgerEntry.warehouse_id == warehouse_id)

    total_cost = await db.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.total_cost), 0)).where(*filters)
    )
    total_qty = await db.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0)).where(
            StockLedgerEntry.item_id == item_id,
            StockLedgerEntry.quantity > 0,
            exclude_quarantine,
            *([StockLedgerEntry.warehouse_id == warehouse_id] if warehouse_id else []),
        )
    )

    if not total_qty or Decimal(str(total_qty)) == 0:
        return Decimal("0.0000")
    return (Decimal(str(total_cost)) / Decimal(str(total_qty))).quantize(Decimal("0.0001"))

