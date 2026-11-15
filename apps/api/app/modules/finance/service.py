"""
خدمة المستندات النقدية والاعتماد المركزي من الخزينة.
─────────────────────────────────────────────────────────────────────────────
قواعد ثابتة:
1. كل حركة نقدية تبدأ كمستند معلق (pending) ولا تؤثر على الرصيد قبل اعتمادها.
2. الاعتماد يتم من مكان واحد: شاشة الخزينة (decide_cash_document) ومرة واحدة فقط.
3. منشئ المستند لا يعتمده بنفسه (Maker-Checker) أياً كان دوره.
4. الاعتماد يكتب دفتر النقدية وقيد اليومية في نفس المعاملة؛ أي فشل يلغي العملية كاملة.
5. الرصيد يُشتق دائماً من cash_ledger_entries ولا يُخزّن.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.ledger_service import CANONICAL_BANK_ID, CANONICAL_TREASURY_ID, post_journal_entry, resolve_expense_code
from app.modules.finance.models import (
    CashAccount,
    CashDocument,
    CashLedgerEntry,
    PaymentAllocation,
    Supplier,
    SupplierInvoice,
    SupplierPayment,
)
from app.modules.customers.models import Customer, CustomerOrder
from app.modules.finance.schemas import CashDocumentCreate, CashDocumentDecision

# مصادر المستندات التي تنشئها الوحدات المتخصصة فقط (لا تُقبل من شاشة المستند النقدي العام)
SYSTEM_SOURCE_SYSTEMS = {
    "supplier_payment",
    "customer_payment",
    "payroll",
    "custody_settlement",
    "petty_cash_settlement",
}

PAYROLL_EXPENSE_ACCOUNT = "5200"  # أجور ومصروفات تصنيع مباشرة (حساب الأجور الوحيد في الدليل الحالي)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def cash_account_balance(db: AsyncSession, account_id: str) -> Decimal:
    """الرصيد الفعلي لحساب نقدي = مجموع حركات دفتر النقدية المعتمدة."""
    value = await db.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account_id)
    )
    return Decimal(str(value or 0))


async def get_main_treasury(db: AsyncSession) -> CashAccount:
    """الخزنة الرئيسية الوحيدة المعتمدة لكل العمليات (معرف ثابت)."""
    treasury = await db.get(CashAccount, CANONICAL_TREASURY_ID)
    if not treasury or not treasury.is_active:
        raise HTTPException(503, "الخزنة الرئيسية غير مهيأة أو موقوفة. راجع إعدادات الحسابات النقدية.")
    return treasury


async def get_main_bank(db: AsyncSession) -> CashAccount | None:
    """حساب البنك الرئيسي للمصنع."""
    bank = await db.get(CashAccount, CANONICAL_BANK_ID)
    return bank if bank and bank.is_active else None


def _cash_gl_code(account: CashAccount) -> str:
    if account.account_type == "treasury":
        return "1010"
    if account.account_type == "bank":
        return "1030"
    return "1020"


async def create_cash_document(
    db: AsyncSession,
    data: CashDocumentCreate,
    user_id: str,
    *,
    allow_system_source: bool = False,
    commit: bool = True,
) -> CashDocument:
    """إنشاء مستند نقدي معلق بانتظار اعتماد الخزينة. لا يغير أي رصيد."""
    if data.source_system in SYSTEM_SOURCE_SYSTEMS and not allow_system_source:
        raise HTTPException(422, "هذا النوع من المستندات يُنشأ من شاشته المختصة فقط (موردين/عملاء/رواتب/عهد).")
    if data.source_system and data.source_reference:
        existing = await db.scalar(select(CashDocument.id).where(
            CashDocument.source_system == data.source_system,
            CashDocument.source_reference == data.source_reference,
        ))
        if existing:
            raise HTTPException(409, "تم تسجيل العملية المرتبطة بهذا المرجع من قبل.")
    account_ids = [value for value in (data.from_account_id, data.to_account_id) if value]
    accounts = (await db.scalars(select(CashAccount).where(CashAccount.id.in_(account_ids)))).all()
    by_id = {account.id: account for account in accounts}
    if len(by_id) != len(set(account_ids)) or any(not by_id[account_id].is_active for account_id in account_ids):
        raise HTTPException(404, "الحساب النقدي غير موجود أو موقوف.")
    if data.document_type == "transfer":
        source, destination = by_id[data.from_account_id], by_id[data.to_account_id]
        if source.account_type == "petty_cash" and destination.account_type != "treasury":
            raise HTTPException(422, "تسوية العهدة تكون بإرجاع المتبقي إلى الخزنة الرئيسية.")
        if source.account_type == "treasury" and destination.account_type == "petty_cash" and destination.parent_account_id != source.id:
            raise HTTPException(422, "العهدة غير مرتبطة بالخزنة المحددة.")
    elif data.document_type == "expense" and by_id[data.from_account_id].account_type not in ("treasury", "petty_cash"):
        raise HTTPException(422, "مصدر الصرف غير صالح.")
    elif data.document_type == "income" and by_id[data.to_account_id].account_type != "treasury":
        raise HTTPException(422, "تسجل الإيرادات في الخزنة الرئيسية.")
    if data.source_system == "daily_expense" and by_id[data.from_account_id].account_type != "petty_cash":
        raise HTTPException(422, "المصروف اليومي يُصرف من صندوق عهدة فقط.")
    if data.supplier_id:
        supplier = await db.get(Supplier, data.supplier_id)
        if not supplier or not supplier.is_active:
            raise HTTPException(404, "المورد المحدد غير موجود أو موقوف.")
    if data.customer_id:
        customer = await db.get(Customer, data.customer_id)
        if not customer or getattr(customer, "status", "active") != "active":
            raise HTTPException(404, "العميل المحدد غير موجود أو موقوف.")

    now = utc_now()
    document = CashDocument(
        id=str(uuid.uuid4()), document_number=f"CSH-{now:%Y%m%d}-{uuid.uuid4().hex[:8].upper()}",
        document_type=data.document_type, from_account_id=data.from_account_id, to_account_id=data.to_account_id,
        amount=data.amount, description=data.description, occurred_at=data.occurred_at,
        source_system=data.source_system, source_reference=data.source_reference, created_by=user_id,
        supplier_id=data.supplier_id, customer_id=data.customer_id,
        expense_category=getattr(data, "expense_category", None),
        status="pending",
    )
    db.add(document)
    if commit:
        await db.commit()
        await db.refresh(document)
    else:
        await db.flush()
    return document


async def _post_document_journal(
    db: AsyncSession,
    document: CashDocument,
    accounts: dict[str, CashAccount],
    user_id: str,
) -> None:
    """ترحيل قيد اليومية المقابل لمستند نقدي معتمد. أي خطأ يرفع ويُلغي الاعتماد بالكامل."""
    source = document.source_system
    amount = document.amount
    label = document.description or document.document_number
    from_acc = accounts.get(document.from_account_id) if document.from_account_id else None
    to_acc = accounts.get(document.to_account_id) if document.to_account_id else None

    if document.document_type == "transfer":
        if not from_acc or not to_acc:
            raise HTTPException(409, "حسابات التحويل غير مكتملة.")
        from_code, to_code = _cash_gl_code(from_acc), _cash_gl_code(to_acc)
        if from_code == to_code:
            return  # تحويل داخل نفس حساب الأستاذ لا يغير القيود
        lines = [
            {"account_code": to_code, "debit": amount, "credit": 0, "description": f"استلام تحويل في {to_acc.name}"},
            {"account_code": from_code, "debit": 0, "credit": amount, "description": f"صرف تحويل من {from_acc.name}"},
        ]
        doc_type = "cash_transfer"
    elif document.document_type == "income":
        if not to_acc:
            raise HTTPException(409, "حساب الإيداع غير محدد.")
        if source == "customer_payment" or document.customer_id:
            credit_code, doc_type = "1100", "customer_payment"
        else:
            credit_code = "4100" if "مبيعات" in (document.description or "") else "4200"
            doc_type = "cash_income"
        lines = [
            {"account_code": _cash_gl_code(to_acc), "debit": amount, "credit": 0, "description": f"إيداع في {to_acc.name}"},
            {"account_code": credit_code, "debit": 0, "credit": amount, "description": label},
        ]
    else:  # expense
        if not from_acc:
            raise HTTPException(409, "حساب الصرف غير محدد.")
        if source == "supplier_payment" or document.supplier_id:
            debit_code, doc_type = "2100", "supplier_payment"
        elif source == "payroll":
            debit_code, doc_type = PAYROLL_EXPENSE_ACCOUNT, "payroll_disbursement"
        else:
            cat = getattr(document, "expense_category", None)
            if cat == "direct_wages":
                debit_code = await resolve_expense_code(db, "5210", "5200")
            elif cat == "scrap_variance":
                debit_code = await resolve_expense_code(db, "5220", "5200")
            elif cat in ("operating_expense", "maintenance"):
                debit_code = await resolve_expense_code(db, "5300", "5300")
            elif cat in ("administrative", "admin_expense"):
                debit_code = await resolve_expense_code(db, "5400", "5400")
            elif cat == "admin_salary":
                debit_code = await resolve_expense_code(db, "5410", "5400")
            else:
                debit_code = "5300" if any(w in (document.description or "") for w in ("صيانة", "تشغيل", "إنتاج")) else "5400"
            doc_type = "cash_expense"
        lines = [
            {"account_code": debit_code, "debit": amount, "credit": 0, "description": label},
            {"account_code": _cash_gl_code(from_acc), "debit": 0, "credit": amount, "description": f"صرف من {from_acc.name}"},
        ]

    await post_journal_entry(
        db,
        source_doc_type=doc_type,
        source_doc_id=document.id,
        description=f"مستند نقدي معتمد {document.document_number}: {label}",
        lines=lines,
        user_id=user_id,
        entry_date=document.occurred_at,
    )


async def _apply_source_effects(db: AsyncSession, document: CashDocument, user_id: str, approved: bool) -> None:
    """تحديث المستند المصدر (دفعة مورد/تحصيل عميل/رواتب/تسوية عهدة) بنتيجة قرار الخزينة."""
    now = utc_now()
    source, reference = document.source_system, document.source_reference
    if not source or not reference:
        return

    if source == "supplier_payment":
        payment = await db.scalar(select(SupplierPayment).where(SupplierPayment.id == reference).with_for_update())
        if not payment or payment.status != "pending":
            raise HTTPException(409, "حالة دفعة المورد لا تتوافق مع المستند النقدي.")
        payment.status = "approved" if approved else "rejected"
        payment.decided_by = user_id
        payment.decided_at = now

    elif source == "customer_payment":
        from app.modules.customers.models import CustomerPayment

        payment = await db.scalar(select(CustomerPayment).where(CustomerPayment.id == reference).with_for_update())
        if not payment or payment.status != "pending":
            raise HTTPException(409, "حالة تحصيل العميل لا تتوافق مع المستند النقدي.")
        payment.status = "approved" if approved else "rejected"

    elif source == "payroll":
        from app.modules.production.models import PayPeriod, PayrollRun

        period = await db.scalar(select(PayPeriod).where(PayPeriod.id == reference).with_for_update())
        if not period or period.status != "submitted":
            raise HTTPException(409, "حالة فترة الرواتب لا تتوافق مع مستند الصرف.")
        runs = (await db.scalars(select(PayrollRun).where(PayrollRun.period_id == period.id).with_for_update())).all()
        if approved:
            period.status = "paid"
            for run in runs:
                run.status = "paid"
                run.cash_document_id = document.id
        else:
            period.status = "calculated"
            for run in runs:
                run.status = "draft"
                run.cash_document_id = None

    elif source == "custody_settlement":
        from app.modules.finance.models import CustodySettlement

        settlement = await db.scalar(select(CustodySettlement).where(CustodySettlement.id == reference).with_for_update())
        if not settlement or settlement.status != "pending":
            raise HTTPException(409, "حالة تسوية العهدة لا تتوافق مع المستند النقدي.")
        settlement.status = "approved" if approved else "rejected"
        settlement.approved_by = user_id if approved else None
        settlement.approved_at = now if approved else None


async def _close_custody_if_settled(db: AsyncSession, document: CashDocument) -> None:
    """إغلاق صندوق العهدة تلقائياً عند اعتماد رد كامل رصيده للخزنة."""
    if document.source_system != "custody_settlement" or not document.from_account_id:
        return
    account = await db.get(CashAccount, document.from_account_id)
    if not account or account.account_type != "petty_cash":
        return
    await db.flush()
    if await cash_account_balance(db, account.id) == Decimal("0"):
        account.is_active = False


async def decide_cash_document(
    db: AsyncSession,
    document_id: str,
    data: CashDocumentDecision,
    user_id: str,
    user_roles: set[str] | None = None,
    *,
    post_on_creation: bool = False,
    commit: bool = True,
) -> CashDocument:
    """
    القرار المركزي الوحيد على المستندات النقدية (اعتماد/رفض).
    - يُقفل المستند والحسابات لمنع الاعتماد المزدوج والسحب المتزامن.
    - منشئ المستند لا يعتمده ولا يرفضه بنفسه، إلا مستندات المدير المالي التي تُعتمد عند إنشائها
      (post_on_creation=True من finalize_cash_document فقط؛ قرار المصنع: لا توجد جهة اعتماد فوق المدير المالي).
    - الاعتماد يكتب دفتر النقدية + قيد اليومية + أثر المستند المصدر في معاملة واحدة.
    """
    del user_roles  # الصلاحية تُفرض على مستوى المسار
    document = await db.scalar(select(CashDocument).where(CashDocument.id == document_id).with_for_update())
    if not document:
        raise HTTPException(404, "المستند النقدي غير موجود.")
    if document.status != "pending":
        raise HTTPException(409, "تمت معالجة هذا المستند ولا يمكن اعتماده أو رفضه مرة أخرى.")
    if not post_on_creation and document.created_by and document.created_by == user_id:
        raise HTTPException(
            status_code=409,
            detail="لا يجوز لمنشئ المستند النقدي اعتماده أو رفضه بنفسه. يعتمده مسؤول مالي آخر أو المدير العام.",
        )
    if not post_on_creation and document.source_system == "payroll" and document.source_reference:
        # Maker-Checker على مصدر الكشف: من أعد كشف الرواتب أو عدّله لا يقرر سند صرفه، ولو أنشأ السند غيره
        from app.modules.production.models import PAYROLL_PREPARATION_ACTIONS, PayPeriodEvent

        preparers = set((await db.scalars(
            select(PayPeriodEvent.actor_id).where(
                PayPeriodEvent.period_id == document.source_reference,
                PayPeriodEvent.action.in_(PAYROLL_PREPARATION_ACTIONS),
            )
        )).all())
        if user_id in preparers:
            raise HTTPException(
                status_code=409,
                detail="لا يجوز لمن أعد كشف الرواتب أو عدّله أن يعتمد سند صرفه أو يرفضه. يقرره مسؤول آخر لم يشارك في إعداد الكشف.",
            )

    now = utc_now()
    if data.decision == "reject":
        if not data.rejection_reason:
            raise HTTPException(422, "سبب الرفض مطلوب.")
        document.status = "rejected"
        document.rejected_by = user_id
        document.rejected_at = now
        document.rejection_reason = data.rejection_reason
        await _apply_source_effects(db, document, user_id, approved=False)
        if commit:
            await db.commit()
        else:
            await db.flush()
        await db.refresh(document)
        return document

    account_ids = sorted(value for value in (document.from_account_id, document.to_account_id) if value)
    accounts = (await db.scalars(
        select(CashAccount).where(CashAccount.id.in_(account_ids)).order_by(CashAccount.id).with_for_update()
    )).all()
    if len(accounts) != len(account_ids):
        raise HTTPException(409, "أحد الحسابات المرتبطة بالمستند لم يعد متاحاً.")
    if any(not account.is_active for account in accounts):
        raise HTTPException(409, "أحد الحسابات المرتبطة بالمستند موقوف أو مغلق؛ لا يمكن تحريك نقدية عليه.")
    by_id = {account.id: account for account in accounts}

    if document.from_account_id:
        balance = await cash_account_balance(db, document.from_account_id)
        if balance < document.amount:
            raise HTTPException(409, f"الرصيد غير كافٍ لاعتماد الصرف. المتاح: {balance:.2f} ج.م والمطلوب: {document.amount:.2f} ج.م.")
        db.add(CashLedgerEntry(document_id=document.id, account_id=document.from_account_id, amount=-document.amount, created_by=user_id))
    if document.to_account_id:
        db.add(CashLedgerEntry(document_id=document.id, account_id=document.to_account_id, amount=document.amount, created_by=user_id))

    document.status = "approved"
    document.approved_by = user_id
    document.approved_at = now

    await _apply_source_effects(db, document, user_id, approved=True)
    await _post_document_journal(db, document, by_id, user_id)
    await _close_custody_if_settled(db, document)

    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(document)
    return document


# ─── المستندات التي تُعتمد عند إنشائها ────────────────────────────────────────
# قرار المصنع (2026-11-10): المدير المالي هو مُصدر المستندات المالية ولا توجد جهة اعتماد فوقه،
# فمستنداته تُعتمد وتُرحّل لحظة إنشائها. باقي الأدوار (أمين المخزن، المدير العام) تبقى مستنداتهم
# معلقة حتى يعتمدها المدير المالي من شاشة الخزينة.
POST_ON_CREATION_ROLES = frozenset({"finance_manager"})


def posts_on_creation(user_roles: set[str] | None) -> bool:
    return bool(set(user_roles or ()) & POST_ON_CREATION_ROLES)


async def finalize_cash_document(
    db: AsyncSession,
    document: CashDocument,
    user_id: str,
    user_roles: set[str] | None,
    *,
    commit: bool = True,
) -> CashDocument:
    """
    يُنهي معاملة إنشاء مستند نقدي: للمدير المالي يعتمده في نفس المعاملة (فحص الرصيد ودفتر النقدية
    والقيد وأثر المصدر كما في الاعتماد العادي)؛ أي فشل يلغي الإنشاء كله فلا يبقى مستند معلق.
    لغيره يحفظ المستند معلقاً كما هو.
    """
    if document.status == "pending" and posts_on_creation(user_roles):
        await db.flush()
        try:
            return await decide_cash_document(
                db, document.id, CashDocumentDecision(decision="approve"), user_id,
                post_on_creation=True, commit=commit,
            )
        except Exception:
            # فشل الاعتماد (مثل رصيد غير كافٍ) يلغي المستند وكل ما أُنشئ معه في نفس الطلب
            await db.rollback()
            raise
    if commit:
        await db.commit()
    else:
        await db.flush()
    await db.refresh(document)
    return document


# ─── محرك تخصيص وتسوية المدفوعات (Payment Allocation Engine) ─────────────────

async def get_unallocated_supplier_payments(
    db: AsyncSession,
    supplier_id: str,
) -> list[dict]:
    """
    استعراض الدفعات النقدية المعتمدة للمورد التي لم تُخصم/تُخصص بالكامل بعد على فواتير.
    تشمل: مستندات الصرف المعتمدة التي تحمل supplier_id.
    """
    stmt = (
        select(CashDocument)
        .where(
            CashDocument.supplier_id == supplier_id,
            CashDocument.document_type == "expense",
            CashDocument.status == "approved",
        )
        .order_by(CashDocument.occurred_at.asc())
    )
    docs = (await db.scalars(stmt)).all()
    results = []
    for doc in docs:
        allocated = await db.scalar(
            select(func.coalesce(func.sum(PaymentAllocation.allocated_amount), 0))
            .where(PaymentAllocation.cash_document_id == doc.id)
        )
        allocated_amt = Decimal(str(allocated or 0))
        total_amt = Decimal(str(doc.amount or 0))
        unallocated_amt = max(Decimal("0.00"), total_amt - allocated_amt)
        if unallocated_amt > Decimal("0.00"):
            results.append({
                "cash_document_id": doc.id,
                "document_number": doc.document_number,
                "document_type": doc.document_type,
                "occurred_at": doc.occurred_at,
                "total_amount": total_amt,
                "allocated_amount": allocated_amt,
                "unallocated_amount": unallocated_amt,
                "description": doc.description,
            })
    return results


async def get_unallocated_customer_payments(
    db: AsyncSession,
    customer_id: str,
) -> list[dict]:
    """
    استعراض المقبوضات النقدية المعتمدة للعميل التي لم تُخصص بالكامل بعد على طلبات بيع.
    """
    stmt = (
        select(CashDocument)
        .where(
            CashDocument.customer_id == customer_id,
            CashDocument.document_type == "income",
            CashDocument.status == "approved",
        )
        .order_by(CashDocument.occurred_at.asc())
    )
    docs = (await db.scalars(stmt)).all()
    results = []
    for doc in docs:
        allocated = await db.scalar(
            select(func.coalesce(func.sum(PaymentAllocation.allocated_amount), 0))
            .where(PaymentAllocation.cash_document_id == doc.id)
        )
        allocated_amt = Decimal(str(allocated or 0))
        total_amt = Decimal(str(doc.amount or 0))
        unallocated_amt = max(Decimal("0.00"), total_amt - allocated_amt)
        if unallocated_amt > Decimal("0.00"):
            results.append({
                "cash_document_id": doc.id,
                "document_number": doc.document_number,
                "document_type": doc.document_type,
                "occurred_at": doc.occurred_at,
                "total_amount": total_amt,
                "allocated_amount": allocated_amt,
                "unallocated_amount": unallocated_amt,
                "description": doc.description,
            })
    return results


async def allocate_supplier_payment(
    db: AsyncSession,
    *,
    invoice_id: str,
    cash_document_id: str,
    amount: Decimal,
    user_id: str,
    notes: str = "",
) -> PaymentAllocation:
    """
    تخصيص وتسوية دفعة نقدية سابقة ومعتمدة على فاتورة مورد دون تكرار حركة الخزينة أو قيد اليومية.
    """
    from app.modules.finance.balances import supplier_invoice_financials

    invoice = await db.scalar(
        select(SupplierInvoice).where(SupplierInvoice.id == invoice_id).with_for_update()
    )
    if not invoice or invoice.status == "cancelled":
        raise HTTPException(404, "فاتورة المورد غير موجودة أو ملغاة.")

    doc = await db.scalar(
        select(CashDocument).where(CashDocument.id == cash_document_id).with_for_update()
    )
    if not doc:
        raise HTTPException(404, "المستند النقدي غير موجود.")
    if doc.status != "approved" or doc.document_type != "expense":
        raise HTTPException(409, "لا يمكن التخصيص إلا من مستند صرف نقدي معتمد.")
    if doc.supplier_id != invoice.supplier_id:
        raise HTTPException(422, "المستند النقدي لا يتبع نفس المورد صاحب الفاتورة.")

    allocated = await db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.allocated_amount), 0))
        .where(PaymentAllocation.cash_document_id == doc.id)
    )
    available_on_doc = Decimal(str(doc.amount)) - Decimal(str(allocated or 0))
    if amount > available_on_doc:
        raise HTTPException(
            409,
            f"المبلغ المطلوب تخصيصه ({amount:.2f}) يتجاوز المتبقي غير المخصص في المستند ({available_on_doc:.2f})."
        )

    fin = await supplier_invoice_financials(db, invoice)
    max_payable = fin.received_value if invoice.status == "received" else fin.invoice_total
    committed = fin.paid_approved + fin.paid_pending
    unpaid_invoice = max(Decimal("0.00"), max_payable - committed)
    if amount > unpaid_invoice:
        raise HTTPException(
            409,
            f"المبلغ المطلوب تخصيصه ({amount:.2f}) يتجاوز المستحق غير المسدد على الفاتورة ({unpaid_invoice:.2f})."
        )

    now = utc_now()
    alloc_num = f"ALC-{now:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}"
    allocation = PaymentAllocation(
        id=str(uuid.uuid4()),
        allocation_number=alloc_num,
        cash_document_id=doc.id,
        supplier_id=invoice.supplier_id,
        supplier_invoice_id=invoice.id,
        allocated_amount=amount,
        allocated_at=now,
        allocated_by=user_id,
        notes=notes.strip(),
    )
    db.add(allocation)
    await db.flush()
    return allocation


async def allocate_customer_payment(
    db: AsyncSession,
    *,
    customer_id: str,
    order_id: str,
    cash_document_id: str,
    amount: Decimal,
    user_id: str,
    notes: str = "",
) -> PaymentAllocation:
    """
    تخصيص وتسوية دفعة تحصيل سابقة ومعتمدة على طلب عميل دون تكرار حركة الخزينة.
    """
    from app.modules.finance.balances import customer_order_financials
    from app.modules.customers.models import CustomerOrder
    from sqlalchemy.orm import selectinload

    order = await db.scalar(
        select(CustomerOrder)
        .options(
            selectinload(CustomerOrder.lines),
            selectinload(CustomerOrder.deliveries),
            selectinload(CustomerOrder.returns),
            selectinload(CustomerOrder.payments),
            selectinload(CustomerOrder.allocations),
        )
        .where(CustomerOrder.id == order_id)
        .with_for_update()
    )
    if not order or order.customer_id != customer_id or order.status == "cancelled":
        raise HTTPException(404, "طلب العميل غير موجود أو ملغى.")

    doc = await db.scalar(
        select(CashDocument).where(CashDocument.id == cash_document_id).with_for_update()
    )
    if not doc:
        raise HTTPException(404, "المستند النقدي غير موجود.")
    if doc.status != "approved" or doc.document_type != "income":
        raise HTTPException(409, "لا يمكن التخصيص إلا من مستند قبض نقدي معتمد.")
    if doc.customer_id != customer_id:
        raise HTTPException(422, "المستند النقدي لا يتبع نفس العميل.")

    allocated = await db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.allocated_amount), 0))
        .where(PaymentAllocation.cash_document_id == doc.id)
    )
    available_on_doc = Decimal(str(doc.amount)) - Decimal(str(allocated or 0))
    if amount > available_on_doc:
        raise HTTPException(
            409,
            f"المبلغ المطلوب تخصيصه ({amount:.2f}) يتجاوز المتبقي غير المخصص في المستند ({available_on_doc:.2f})."
        )

    fin = customer_order_financials(order)
    available_on_order = fin.remaining_on_order - fin.paid_pending
    if amount > available_on_order:
        raise HTTPException(
            409,
            f"المبلغ المطلوب تخصيصه ({amount:.2f}) يتجاوز المتبقي على الطلب ({available_on_order:.2f})."
        )

    now = utc_now()
    alloc_num = f"ALC-{now:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}"
    allocation = PaymentAllocation(
        id=str(uuid.uuid4()),
        allocation_number=alloc_num,
        cash_document_id=doc.id,
        customer_id=customer_id,
        customer_order_id=order.id,
        allocated_amount=amount,
        allocated_at=now,
        allocated_by=user_id,
        notes=notes.strip(),
    )
    db.add(allocation)
    await db.flush()
    return allocation
