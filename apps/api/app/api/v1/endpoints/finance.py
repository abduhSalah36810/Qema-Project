from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser
from app.core.idempotency import execute_idempotent_operation
from app.core.permissions import get_user_roles, require_permission
from app.db.session import get_db
from app.modules.finance.models import (
    Account, CashAccount, CashDocument, CashLedgerEntry, CustodySettlement, JournalEntry, JournalEntryLine,
    Supplier, SupplierInvoice, SupplierInvoiceLine, SupplierPayment, SupplierReceipt,
)
from app.modules.finance.schemas import (
    CashAccountRead, CashDocumentCreate, CashDocumentDecision, CashDocumentRead,
    CustodySettlementCreate, CustodySettlementRead,
    SupplierCreate, SupplierRead, SupplierUpdate, SupplierInvoiceCreate, SupplierInvoiceRead,
    SupplierInvoiceLineRead, SupplierPaymentCreate, SupplierPaymentLineRead, SupplierReceiptConfirm,
    SupplierFullBalanceRequest, SupplierFullBalanceRequestAck,
)
from app.modules.production.models import CatalogItem, StockLedgerEntry, Unit, Warehouse
from app.modules.production.service import lock_stock_balance
from app.modules.finance.service import (
    cash_account_balance, create_cash_document, decide_cash_document, finalize_cash_document, get_main_treasury,
    posts_on_creation,
)
from app.modules.finance.ledger_service import post_journal_entry, CANONICAL_TREASURY_ID
from app.modules.finance.balances import supplier_invoice_financials

_CANONICAL_TREASURY_ID = CANONICAL_TREASURY_ID
QTY_TOLERANCE = 1e-9

router = APIRouter(prefix="/finance", tags=["finance"])


@router.get("/accounts", response_model=List[CashAccountRead])
async def list_cash_accounts(
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    accounts = (await db.scalars(select(CashAccount).order_by(CashAccount.account_type, CashAccount.account_number))).all()
    return [
        CashAccountRead(
            id=account.id, account_number=account.account_number, name=account.name,
            account_type=account.account_type, parent_account_id=account.parent_account_id,
            is_active=account.is_active, balance=await cash_account_balance(db, account.id),
        )
        for account in accounts
    ]


@router.post("/petty-cash", response_model=CashAccountRead, status_code=status.HTTP_201_CREATED)
async def create_petty_cash_account(
    name: str,
    business_date: datetime,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    """فتح صندوق عهدة جديد (برصيد صفر). التمويل يتم بمستند تحويل من الخزنة يُعتمد من شاشة الخزينة."""
    treasury = await get_main_treasury(db)
    account = CashAccount(
        id=str(uuid.uuid4()), account_number=f"PC-{business_date:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
        name=name.strip(), account_type="petty_cash", parent_account_id=treasury.id,
        business_date=business_date, created_by=current_user.id,
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return CashAccountRead(
        id=account.id, account_number=account.account_number, name=account.name,
        account_type=account.account_type, parent_account_id=account.parent_account_id,
        is_active=account.is_active, balance=Decimal("0"),
    )


@router.get("/cash-documents", response_model=List[CashDocumentRead])
async def list_cash_documents(
    status: Optional[str] = Query(default=None),
    approvable_by_me: bool = Query(default=False),
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(CashDocument).order_by(CashDocument.created_at.desc())
    if status:
        stmt = stmt.where(CashDocument.status == status)
    if approvable_by_me:
        # نفس قواعد الخزينة: لا يظهر للمستخدم ما أنشأه، ولا سند صرف رواتب شارك في إعداد كشفه
        from app.modules.production.models import PAYROLL_PREPARATION_ACTIONS, PayPeriodEvent

        prepared_by_me = (
            select(PayPeriodEvent.id)
            .where(
                PayPeriodEvent.period_id == CashDocument.source_reference,
                PayPeriodEvent.actor_id == current_user.id,
                PayPeriodEvent.action.in_(PAYROLL_PREPARATION_ACTIONS),
            )
            .exists()
        )
        stmt = stmt.where(
            CashDocument.status == "pending",
            CashDocument.created_by != current_user.id,
            ~((CashDocument.source_system == "payroll") & prepared_by_me),
        )
    return (await db.scalars(stmt)).all()


@router.post("/cash-documents", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def post_cash_document(
    data: CashDocumentCreate,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:create")),
    db: AsyncSession = Depends(get_db),
):
    """
    تسجيل مستند نقدي (قبض/صرف/تحويل). مستندات المدير المالي تُعتمد وتُرحّل فوراً؛
    مستندات غيره تبقى معلقة حتى يعتمدها المدير المالي من شاشة الخزينة.
    محمي بنظام منع التكرار الموحد (Idempotency-Key): إعادة إرسال الطلب نفسه بعد نجاحه
    (مثلاً بعد انقطاع شبكة) تعيد نفس المستند دون تكرار الحركة النقدية أو القيد.
    """

    async def _execute():
        document = await create_cash_document(db, data, current_user.id, commit=False)
        document = await finalize_cash_document(
            db, document, current_user.id, await get_user_roles(current_user, db=db), commit=False,
        )
        return CashDocumentRead.model_validate(document)

    return await execute_idempotent_operation(
        db=db,
        idempotency_key=idempotency_key,
        operation_type="finance.create_cash_document",
        resource_id="cash_documents",
        user_id=current_user.id,
        # model_dump(mode="json") لضمان قابلية التسلسل في بصمة الطلب (Decimal/datetime → str)
        payload=data.model_dump(mode="json"),
        execute_fn=_execute,
    )


@router.post("/cash-documents/{document_id}/decision", response_model=CashDocumentRead)
async def decide_cash_document_route(
    document_id: str,
    data: CashDocumentDecision,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:approve")),
    db: AsyncSession = Depends(get_db),
):
    """نقطة الاعتماد المالي الوحيدة في النظام (شاشة الخزينة)."""
    return await decide_cash_document(db, document_id, data, current_user.id)


# ─── الموردون وفواتير المشتريات ────────────────────────────────────────────

def _can_view_prices(user_roles: set[str] | None) -> bool:
    if user_roles is None:
        return True
    return bool(user_roles.intersection({"general_manager", "finance_manager"}))


FULL_BALANCE_ELIGIBLE_STATUSES = ("received", "partially_received")


def _full_balance_outstanding(invoice: SupplierInvoice, fin) -> Decimal:
    """المستحق الفعلي عن الكميات المستلمة ناقص ما سُدد أو طُلب سداده (معتمد أو معلق)."""
    if invoice.status not in FULL_BALANCE_ELIGIBLE_STATUSES:
        return Decimal("0.00")
    return max(Decimal("0.00"), fin.received_value - fin.paid_approved - fin.paid_pending)


async def serialize_supplier_invoice(
    db: AsyncSession,
    invoice: SupplierInvoice,
    user_roles: set[str] | None = None,
) -> SupplierInvoiceRead:
    supplier = await db.get(Supplier, invoice.supplier_id)
    lines = (await db.scalars(select(SupplierInvoiceLine).where(SupplierInvoiceLine.invoice_id == invoice.id))).all()
    fin = await supplier_invoice_financials(db, invoice, lines)
    show = _can_view_prices(user_roles)
    zero = Decimal("0.00")

    line_rows = []
    for line in lines:
        item = await db.get(CatalogItem, line.item_id)
        unit = await db.get(Unit, line.unit_id)
        line_total = fin.line_totals.get(line.id, zero)
        line_rows.append(SupplierInvoiceLineRead(
            id=line.id, item_id=line.item_id, item_code=item.code if item else "",
            item_name_ar=item.name_ar if item else "", unit_id=line.unit_id,
            unit_name_ar=unit.name_ar if unit else "", invoiced_quantity=line.invoiced_quantity,
            received_quantity=line.received_quantity or 0.0,
            remaining_quantity=max(0.0, round(line.invoiced_quantity - (line.received_quantity or 0.0), 4)),
            unit_price=line.unit_price if show else zero,
            discount_amount=(line.discount_amount or zero) if show else zero,
            line_total=line_total if show else zero,
            notes=line.notes,
        ))

    payment_records = (await db.scalars(
        select(SupplierPayment).where(SupplierPayment.invoice_id == invoice.id).order_by(SupplierPayment.created_at.desc())
    )).all()
    payment_rows = [
        SupplierPaymentLineRead(
            id=p.id, cash_document_id=p.cash_document_id, amount=p.amount if show else zero,
            status=p.status, created_by=p.created_by, created_at=p.created_at,
        )
        for p in payment_records
    ]

    return SupplierInvoiceRead(
        id=invoice.id, internal_number=invoice.internal_number, supplier_id=invoice.supplier_id,
        supplier_name=supplier.name if supplier else "", invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date,
        invoice_total=fin.invoice_total if show else zero,
        paid_total=fin.paid_approved if show else zero,
        balance_due=fin.balance_due if show else zero,
        received_value=fin.received_value if show else zero,
        pending_payments_total=fin.paid_pending if show else zero,
        payable_balance=fin.payable_balance if show else zero,
        has_pending_payment_request=fin.paid_pending > zero,
        can_request_full_balance=_full_balance_outstanding(invoice, fin) > zero and fin.paid_pending <= zero,
        status=invoice.status,
        notes=invoice.notes, created_by=invoice.created_by, received_by=invoice.received_by,
        received_at=invoice.received_at, lines=line_rows, payments=payment_rows,
    )


@router.get("/suppliers", response_model=List[SupplierRead])
async def list_suppliers(
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    rows = (await db.scalars(select(Supplier).order_by(Supplier.name))).all()
    return [SupplierRead(id=row.id, code=row.code, name=row.name, phone=row.phone, address=row.address, is_active=row.is_active) for row in rows]


@router.post("/suppliers", response_model=SupplierRead, status_code=status.HTTP_201_CREATED)
async def create_supplier(
    data: SupplierCreate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:manage")),
    db: AsyncSession = Depends(get_db),
):
    if await db.scalar(select(Supplier.id).where(Supplier.code == data.code.strip())):
        raise HTTPException(409, "كود المورد مستخدم بالفعل.")
    row = Supplier(
        id=str(uuid.uuid4()), code=data.code.strip(), name=data.name.strip(),
        phone=data.phone.strip(), address=data.address.strip(), created_by=current_user.id,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return SupplierRead(id=row.id, code=row.code, name=row.name, phone=row.phone, address=row.address, is_active=row.is_active)


@router.patch("/suppliers/{supplier_id}", response_model=SupplierRead)
async def update_supplier(
    supplier_id: str,
    data: SupplierUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تعديل اسم المورد وبيانات التواصل أو إيقافه. الكود ثابت حتى لا تنقطع الصلة بالفواتير السابقة."""
    row = await db.get(Supplier, supplier_id)
    if not row:
        raise HTTPException(404, "المورد غير موجود.")
    if data.name is not None:
        row.name = data.name.strip()
    if data.phone is not None:
        row.phone = data.phone.strip()
    if data.address is not None:
        row.address = data.address.strip()
    if data.is_active is not None:
        row.is_active = data.is_active
    await db.commit()
    await db.refresh(row)
    return SupplierRead(id=row.id, code=row.code, name=row.name, phone=row.phone, address=row.address, is_active=row.is_active)


@router.get("/supplier-invoices", response_model=List[SupplierInvoiceRead])
async def list_supplier_invoices(
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    user_roles = await get_user_roles(current_user, db=db)
    invoices = (await db.scalars(select(SupplierInvoice).order_by(SupplierInvoice.invoice_date.desc()))).all()
    return [await serialize_supplier_invoice(db, invoice, user_roles=user_roles) for invoice in invoices]


@router.post("/supplier-invoices", response_model=SupplierInvoiceRead, status_code=status.HTTP_201_CREATED)
async def create_supplier_invoice(
    data: SupplierInvoiceCreate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:invoices:create")),
    db: AsyncSession = Depends(get_db),
):
    """تسجيل فاتورة مورد. الإجمالي يُحسب من البنود (الكمية × السعر − الخصم) ولا يُدخل يدوياً."""
    supplier = await db.get(Supplier, data.supplier_id)
    if not supplier or not supplier.is_active:
        raise HTTPException(404, "المورد غير موجود أو موقوف.")
    if await db.scalar(select(SupplierInvoice.id).where(
        SupplierInvoice.supplier_id == data.supplier_id,
        SupplierInvoice.invoice_number == data.invoice_number.strip(),
    )):
        raise HTTPException(409, "رقم فاتورة المورد مسجل من قبل.")
    if len({line.item_id for line in data.lines}) != len(data.lines):
        raise HTTPException(422, "لا تكرر الصنف نفسه في أكثر من بند؛ اجمع كميته في بند واحد.")

    lines_total = Decimal("0.00")
    for line in data.lines:
        item = await db.get(CatalogItem, line.item_id)
        if not item or not item.is_active or item.unit_id != line.unit_id:
            raise HTTPException(422, "أحد أصناف الفاتورة غير نشط أو وحدة القياس لا تطابق الصنف.")
        if item.approval_status != "approved":
            raise HTTPException(422, f"الصنف '{item.name_ar}' غير معتمد في دليل الأصناف (حالة الاعتماد: {item.approval_status})؛ لا يمكن إدراجه في فواتير المشتريات.")
        gross = (Decimal(str(line.invoiced_quantity)) * line.unit_price).quantize(Decimal("0.01"))
        if line.discount_amount > gross:
            raise HTTPException(422, f"خصم بند الصنف '{item.name_ar}' أكبر من قيمته.")
        lines_total += gross - line.discount_amount

    if lines_total <= Decimal("0.00"):
        raise HTTPException(422, "إجمالي الفاتورة يجب أن يكون أكبر من الصفر.")
    if data.invoice_total is not None and data.invoice_total > Decimal("0.00") and data.invoice_total != lines_total:
        raise HTTPException(
            422,
            f"إجمالي الفاتورة يُحسب من البنود ({lines_total:.2f}) ولا يطابق الإجمالي المُدخل ({data.invoice_total:.2f}). راجع الكميات والأسعار والخصومات.",
        )

    invoice = SupplierInvoice(
        id=str(uuid.uuid4()), internal_number=f"PIN-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:8].upper()}",
        supplier_id=supplier.id, invoice_number=data.invoice_number.strip(), invoice_date=data.invoice_date,
        invoice_total=lines_total, notes=data.notes.strip(), created_by=current_user.id,
    )
    db.add(invoice)
    await db.flush()
    for line in data.lines:
        db.add(SupplierInvoiceLine(
            id=str(uuid.uuid4()), invoice_id=invoice.id, item_id=line.item_id, unit_id=line.unit_id,
            invoiced_quantity=line.invoiced_quantity, unit_price=line.unit_price,
            discount_amount=line.discount_amount, notes=line.notes.strip(),
        ))
    await db.commit()
    await db.refresh(invoice)
    return await serialize_supplier_invoice(db, invoice, user_roles=await get_user_roles(current_user, db=db))


@router.post("/supplier-invoices/{invoice_id}/receive", response_model=SupplierInvoiceRead)
async def confirm_supplier_receipt(
    invoice_id: str,
    data: SupplierReceiptConfirm,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:receive")),
    db: AsyncSession = Depends(get_db),
):
    """
    تأكيد استلام فعلي (كلي أو جزئي) لبنود فاتورة مورد.
    كل استلام = مستند استلام مستقل يزيد رصيد مخزن الخامات ويثبت استحقاق المورد بقيمته.
    لا يمكن استلام أكثر من الكمية المتبقية في الفاتورة.
    """
    invoice = await db.scalar(select(SupplierInvoice).where(SupplierInvoice.id == invoice_id).with_for_update())
    if not invoice:
        raise HTTPException(404, "فاتورة المورد غير موجودة.")
    if invoice.status not in ("awaiting_receipt", "partially_received"):
        raise HTTPException(409, "تم استلام كامل كميات هذه الفاتورة أو إلغاؤها.")
    lines = (await db.scalars(
        select(SupplierInvoiceLine).where(SupplierInvoiceLine.invoice_id == invoice.id).with_for_update()
    )).all()
    by_id = {line.id: line for line in lines}
    received = {entry.line_id: entry for entry in data.lines}
    if len(received) != len(data.lines):
        raise HTTPException(422, "لا تكرر البند نفسه في مستند الاستلام.")
    unknown = set(received) - set(by_id)
    if unknown:
        raise HTTPException(422, "أحد بنود الاستلام لا يتبع هذه الفاتورة.")
    if not any(entry.received_quantity > 0 for entry in received.values()):
        raise HTTPException(422, "يجب أن يحتوي الاستلام على كمية مستلمة واحدة على الأقل.")
    warehouse = await db.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials"))
    if not warehouse:
        raise HTTPException(503, "مخزن الخامات الرئيسي غير مهيأ.")

    fin = await supplier_invoice_financials(db, invoice, lines)
    now = datetime.now(timezone.utc)
    receipt = SupplierReceipt(
        id=str(uuid.uuid4()),
        receipt_number=f"GRN-{now:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
        invoice_id=invoice.id, received_by=current_user.id, received_at=now,
        notes=data.notes.strip(),
    )
    db.add(receipt)
    await db.flush()

    total_received_cost = Decimal("0.00")
    for line_id in sorted(received):
        entry = received[line_id]
        qty = float(entry.received_quantity)
        if qty <= 0:
            continue
        line = by_id[line_id]
        already = float(line.received_quantity or 0.0)
        remaining = round(line.invoiced_quantity - already, 6)
        if qty > remaining + QTY_TOLERANCE:
            item = await db.get(CatalogItem, line.item_id)
            raise HTTPException(
                409,
                f"الكمية المستلمة للصنف '{item.name_ar if item else line.item_id}' ({qty:g}) تتجاوز المتبقي في الفاتورة ({max(0.0, remaining):g}).",
            )
        await lock_stock_balance(db, line.item_id, warehouse.id)
        unit_cost = fin.net_unit_costs[line.id]
        total_cost = (Decimal(str(qty)) * unit_cost).quantize(Decimal("0.01"))
        total_received_cost += total_cost
        line.received_quantity = round(already + qty, 6)
        if entry.notes.strip():
            line.notes = (line.notes + " | استلام: " + entry.notes.strip()).strip(" |")
        db.add(StockLedgerEntry(
            id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
            warehouse_id=warehouse.id, location_type="warehouse", quantity=qty,
            reference_doc_type="supplier_receipt", reference_doc_id=receipt.id,
            entry_type="supplier_receipt", created_by=current_user.id,
            unit_cost=unit_cost, total_cost=total_cost,
        ))

    receipt.total_cost = total_received_cost
    fully_received = all(
        float(line.received_quantity or 0.0) + QTY_TOLERANCE >= line.invoiced_quantity for line in lines
    )
    invoice.status = "received" if fully_received else "partially_received"
    invoice.received_by = current_user.id
    invoice.received_at = now
    if data.notes.strip():
        invoice.notes = (invoice.notes + " | " + data.notes.strip()).strip(" |")

    # استحقاق المورد بقيمة المستلم فعلياً: Dr مخزون خامات 1210 / Cr موردون 2100
    if total_received_cost > Decimal("0.00"):
        await post_journal_entry(
            db,
            source_doc_type="supplier_receipt",
            source_doc_id=receipt.id,
            description=f"استلام خامات {receipt.receipt_number} عن فاتورة المورد رقم {invoice.invoice_number}",
            lines=[
                {"account_code": "1210", "debit": total_received_cost, "credit": 0, "description": f"استلام خامات بمخزن الخامات ({receipt.receipt_number})"},
                {"account_code": "2100", "debit": 0, "credit": total_received_cost, "description": f"استحقاق مورد عن فاتورة رقم {invoice.invoice_number}"},
            ],
            user_id=current_user.id,
            entry_date=now,
        )

    await db.commit()
    await db.refresh(invoice)
    return await serialize_supplier_invoice(db, invoice, user_roles=await get_user_roles(current_user, db=db))


@router.post("/supplier-invoices/{invoice_id}/payments", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def create_supplier_payment(
    invoice_id: str,
    data: SupplierPaymentCreate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:payments:request")),
    db: AsyncSession = Depends(get_db),
):
    """طلب سداد دفعة لمورد؛ يُنشأ مستند صرف معلق ولا يُخصم من الخزنة إلا بعد اعتماده من شاشة الخزينة."""
    invoice = await db.scalar(
        select(SupplierInvoice)
        .options(selectinload(SupplierInvoice.lines))
        .where(SupplierInvoice.id == invoice_id)
        .with_for_update()
    )
    if not invoice or invoice.status == "cancelled":
        raise HTTPException(404, "فاتورة المورد غير متاحة.")
    treasury = await get_main_treasury(db)
    fin = await supplier_invoice_financials(db, invoice, list(invoice.lines))
    committed = fin.paid_approved + fin.paid_pending
    # قبل اكتمال الاستلام يُسمح بالسداد حتى إجمالي الفاتورة (دفعات مقدمة)،
    # وبعد إغلاق الاستلام بعجز يصبح الحد الأقصى هو قيمة ما استُلم فعلياً.
    max_allowed = fin.received_value if invoice.status == "received" else fin.invoice_total
    if committed + data.amount > max_allowed:
        raise HTTPException(
            409,
            f"قيمة الدفعة تتجاوز المستحق الفعلي على الفاتورة بناءً على الكميات المستلمة "
            f"(الحد الأقصى: {max_allowed:.2f}، المسدد والمعلق: {committed:.2f}، المتاح: {max(Decimal('0'), max_allowed - committed):.2f}).",
        )

    payment_id, document_id = str(uuid.uuid4()), str(uuid.uuid4())
    document = CashDocument(
        id=document_id, document_number=f"CSH-SP-{uuid.uuid4().hex[:10].upper()}",
        document_type="expense", from_account_id=treasury.id, to_account_id=None,
        amount=data.amount, description=data.description.strip(), occurred_at=datetime.now(timezone.utc),
        source_system="supplier_payment", source_reference=payment_id,
        status="pending", created_by=current_user.id,
    )
    payment = SupplierPayment(
        id=payment_id, invoice_id=invoice.id, cash_document_id=document_id,
        amount=data.amount, status="pending", created_by=current_user.id,
    )
    db.add(document)
    db.add(payment)
    return await finalize_cash_document(db, document, current_user.id, await get_user_roles(current_user, db=db))


@router.post(
    "/supplier-invoices/{invoice_id}/payment-requests/full-balance",
    response_model=SupplierFullBalanceRequestAck,
    status_code=status.HTTP_201_CREATED,
)
async def request_supplier_full_balance_payment(
    invoice_id: str,
    data: SupplierFullBalanceRequest = SupplierFullBalanceRequest(),
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:payments:request_full_balance")),
    db: AsyncSession = Depends(get_db),
):
    """
    طلب سداد كامل المستحق لفاتورة مورد مستلمة كلياً أو جزئياً.
    الخادم يحسب المبلغ (قيمة المستلم − المسدد − المعلق) ولا يعيده في الاستجابة؛ يظهر للمالية في الخزينة فقط.
    يُرفض الطلب إن وُجد طلب سداد معلق للفاتورة أو لم يتبق مستحق، ويبقى الاعتماد في الخزينة لغير منشئ الطلب.
    """
    invoice = await db.scalar(
        select(SupplierInvoice).options(selectinload(SupplierInvoice.lines))
        .where(SupplierInvoice.id == invoice_id).with_for_update()
    )
    if not invoice or invoice.status == "cancelled":
        raise HTTPException(404, "فاتورة المورد غير متاحة.")
    if invoice.status not in FULL_BALANCE_ELIGIBLE_STATUSES:
        raise HTTPException(409, "لا يمكن طلب سداد فاتورة لم يُستلم منها شيء بعد. أكد الاستلام أولاً.")
    fin = await supplier_invoice_financials(db, invoice, list(invoice.lines))
    if fin.paid_pending > Decimal("0.00"):
        raise HTTPException(409, "يوجد طلب سداد معلق لهذه الفاتورة بانتظار الخزينة؛ لا يُنشأ طلب مكرر.")
    amount = _full_balance_outstanding(invoice, fin)
    if amount <= Decimal("0.00"):
        raise HTTPException(409, "لا يوجد مستحق جديد على هذه الفاتورة عن الكميات المستلمة.")

    supplier = await db.get(Supplier, invoice.supplier_id)
    supplier_name = supplier.name if supplier else ""
    treasury = await get_main_treasury(db)
    payment_id, document_id = str(uuid.uuid4()), str(uuid.uuid4())
    description = f"سداد كامل المستحق عن الكميات المستلمة لفاتورة المورد {invoice.internal_number} ({supplier_name})"
    if data.notes.strip():
        description += f" — {data.notes.strip()}"
    document = CashDocument(
        id=document_id, document_number=f"CSH-SP-{uuid.uuid4().hex[:10].upper()}",
        document_type="expense", from_account_id=treasury.id, to_account_id=None,
        amount=amount, description=description, occurred_at=datetime.now(timezone.utc),
        source_system="supplier_payment", source_reference=payment_id,
        status="pending", created_by=current_user.id,
    )
    payment = SupplierPayment(
        id=payment_id, invoice_id=invoice.id, cash_document_id=document_id,
        amount=amount, status="pending", created_by=current_user.id,
    )
    db.add(document)
    db.add(payment)
    roles = await get_user_roles(current_user, db=db)
    document = await finalize_cash_document(db, document, current_user.id, roles)
    posted = document.status == "approved"
    return SupplierFullBalanceRequestAck(
        invoice_id=invoice.id, invoice_internal_number=invoice.internal_number, supplier_name=supplier_name,
        payment_request_id=payment_id, cash_document_number=document.document_number,
        status="approved" if posted else "pending",
        message=(
            "تم سداد كامل المستحق للمورد وخُصم من الخزنة."
            if posted else
            "أُرسل طلب سداد كامل المستحق إلى الخزينة. يحدد النظام المبلغ، ويعتمده المسؤول المالي من شاشة الخزينة."
        ),
    )


# ─── العهد النقدية (Custody / Petty cash) ─────────────────────────────────────

async def _custody_position(db: AsyncSession, account: CashAccount) -> dict[str, Decimal]:
    """
    موقف العهدة من دفتر النقدية مباشرة:
    funded = إجمالي التمويل الوارد، spent = المصروفات المعتمدة منها،
    returned = ما رُد للخزنة سابقاً، balance = الرصيد النقدي الحالي.
    """
    rows = (await db.execute(
        select(CashDocument.document_type, func.coalesce(func.sum(CashLedgerEntry.amount), 0))
        .join(CashDocument, CashDocument.id == CashLedgerEntry.document_id)
        .where(CashLedgerEntry.account_id == account.id)
        .group_by(CashDocument.document_type)
    )).all()
    by_type = {doc_type: Decimal(str(total or 0)) for doc_type, total in rows}
    funded = Decimal("0.00")
    returned = Decimal("0.00")
    transfer_rows = (await db.execute(
        select(CashLedgerEntry.amount)
        .join(CashDocument, CashDocument.id == CashLedgerEntry.document_id)
        .where(CashLedgerEntry.account_id == account.id, CashDocument.document_type == "transfer")
    )).scalars().all()
    for amount in transfer_rows:
        value = Decimal(str(amount))
        if value > 0:
            funded += value
        else:
            returned += -value
    spent = -by_type.get("expense", Decimal("0.00"))
    balance = await cash_account_balance(db, account.id)
    pending_settlement = await db.scalar(
        select(func.count(CustodySettlement.id)).where(
            CustodySettlement.custody_account_id == account.id, CustodySettlement.status == "pending",
        )
    )
    return {
        "funded": funded, "spent": spent, "returned": returned, "balance": balance,
        "pending_settlements": Decimal(int(pending_settlement or 0)),
    }


def _settlement_read(settlement: CustodySettlement, account_name: str, cash_document_id: str | None = None) -> CustodySettlementRead:
    return CustodySettlementRead(
        id=settlement.id,
        settlement_number=settlement.settlement_number,
        custody_account_id=settlement.custody_account_id,
        custody_account_name=account_name,
        original_custody_amount=settlement.original_custody_amount,
        approved_expenses_amount=settlement.approved_expenses_amount,
        returned_cash_amount=settlement.returned_cash_amount,
        remaining_unsettled_amount=settlement.remaining_unsettled_amount,
        status=settlement.status,
        notes=settlement.notes,
        created_by=settlement.created_by,
        approved_by=settlement.approved_by,
        approved_at=settlement.approved_at,
        created_at=settlement.created_at,
        is_mathematically_balanced=(
            settlement.original_custody_amount
            == settlement.approved_expenses_amount + settlement.returned_cash_amount + settlement.remaining_unsettled_amount
        ),
        cash_document_id=cash_document_id,
    )


@router.get("/petty-cash/{account_id}/settlement-preview")
async def preview_petty_cash_settlement(
    account_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    """موقف العهدة كما يحسبه النظام من دفتر النقدية (تمويل، مصروفات، مردود سابق، رصيد حالي)."""
    account = await db.get(CashAccount, account_id)
    if not account or account.account_type != "petty_cash":
        raise HTTPException(404, "حساب صندوق العهدة غير موجود.")
    pos = await _custody_position(db, account)
    net_custody = pos["funded"] - pos["returned"]
    return {
        "account_id": account.id,
        "account_name": account.name,
        "account_number": account.account_number,
        "is_active": account.is_active,
        "original_custody_amount": float(net_custody),
        "total_funded": float(pos["funded"]),
        "total_expenses_recorded": float(pos["spent"]),
        "previously_returned": float(pos["returned"]),
        "current_balance": float(pos["balance"]),
        "suggested_returned_cash": float(max(Decimal("0.00"), pos["balance"])),
        "has_pending_settlement": pos["pending_settlements"] > 0,
        "formula": "صافي العهدة = المصروفات المعتمدة + النقدية المردودة الآن + المتبقي مع صاحب العهدة",
    }


async def _create_custody_settlement(
    db: AsyncSession,
    account_id: str,
    returned_cash_amount: Decimal | None,
    notes: str,
    user_id: str,
    user_roles: set[str] | None = None,
) -> tuple[CustodySettlement, CashAccount, str | None]:
    account = await db.scalar(
        select(CashAccount).where(CashAccount.id == account_id, CashAccount.account_type == "petty_cash").with_for_update()
    )
    if not account:
        raise HTTPException(404, "حساب صندوق العهدة غير موجود.")
    if not account.is_active:
        raise HTTPException(409, "حساب صندوق العهدة مغلق بالفعل.")
    pos = await _custody_position(db, account)
    if pos["pending_settlements"] > 0:
        raise HTTPException(409, "توجد تسوية سابقة لهذه العهدة بانتظار اعتماد الخزينة. اعتمدها أو ارفضها أولاً.")
    if pos["funded"] <= Decimal("0.00"):
        raise HTTPException(422, "هذه العهدة لم يتم تمويلها بعد؛ لا يوجد ما يُسوى.")

    balance = pos["balance"]
    returned = balance if returned_cash_amount is None else returned_cash_amount
    if returned < Decimal("0.00") or returned > balance:
        raise HTTPException(
            409,
            f"المبلغ المردود ({returned:.2f}) يجب أن يكون بين صفر والرصيد الفعلي بالعهدة ({balance:.2f}).",
        )
    now = datetime.now(timezone.utc)
    settlement = CustodySettlement(
        id=str(uuid.uuid4()),
        settlement_number=f"CST-{now:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
        custody_account_id=account.id,
        original_custody_amount=pos["funded"] - pos["returned"],
        approved_expenses_amount=pos["spent"],
        returned_cash_amount=returned,
        remaining_unsettled_amount=balance - returned,
        status="pending",
        notes=notes.strip(),
        created_by=user_id,
        created_at=now,
    )
    db.add(settlement)
    await db.flush()

    cash_document_id = None
    if returned > Decimal("0.00"):
        treasury = await get_main_treasury(db)
        doc = await create_cash_document(
            db,
            CashDocumentCreate(
                document_type="transfer",
                from_account_id=account.id,
                to_account_id=treasury.id,
                amount=returned,
                description=f"رد نقدية عهدة {account.name} للخزنة بموجب تسوية {settlement.settlement_number}",
                occurred_at=now,
                source_system="custody_settlement",
                source_reference=settlement.id,
            ),
            user_id,
            allow_system_source=True,
            commit=False,
        )
        cash_document_id = doc.id
    else:
        # لا توجد نقدية تتحرك: التسوية توثيقية فقط، وتُغلق العهدة إذا كان رصيدها صفراً
        settlement.status = "approved"
        settlement.approved_by = user_id
        settlement.approved_at = now
        if balance == Decimal("0.00"):
            account.is_active = False

    if cash_document_id and posts_on_creation(user_roles):
        # المدير المالي: رد النقدية يُعتمد فوراً (ويغلق العهدة إذا رُد كامل رصيدها)
        await finalize_cash_document(db, doc, user_id, user_roles)
    else:
        await db.commit()
    await db.refresh(settlement)
    await db.refresh(account)
    return settlement, account, cash_document_id


@router.post("/petty-cash/{account_id}/settlement", response_model=CustodySettlementRead, status_code=status.HTTP_201_CREATED)
async def create_custody_settlement(
    account_id: str,
    data: CustodySettlementCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    """
    رفع تسوية عهدة: يحدد المستخدم النقدية المردودة فقط، ويحسب النظام المصروفات والمتبقي من الدفتر.
    رد النقدية يُنشأ كمستند تحويل معلق يعتمد من شاشة الخزينة، وتُغلق العهدة تلقائياً عند رد كامل رصيدها.
    """
    settlement, account, doc_id = await _create_custody_settlement(
        db, account_id, data.returned_cash_amount, data.notes, current_user.id,
        await get_user_roles(current_user, db=db),
    )
    return _settlement_read(settlement, account.name, doc_id)


@router.get("/petty-cash/settlements", response_model=List[CustodySettlementRead])
async def list_custody_settlements(
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    settlements = (await db.scalars(select(CustodySettlement).order_by(CustodySettlement.created_at.desc()))).all()
    result = []
    for s in settlements:
        acc = await db.get(CashAccount, s.custody_account_id)
        doc_id = await db.scalar(select(CashDocument.id).where(
            CashDocument.source_system == "custody_settlement", CashDocument.source_reference == s.id,
        ))
        result.append(_settlement_read(s, acc.name if acc else "", doc_id))
    return result


@router.post("/petty-cash/{account_id}/settle", response_model=CustodySettlementRead, status_code=status.HTTP_201_CREATED)
async def settle_petty_cash(
    account_id: str,
    description: str = "تسوية وإغلاق صندوق العهدة",
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تسوية نهائية: رد كامل الرصيد المتبقي للخزنة (بانتظار اعتماد الخزينة) ثم إغلاق العهدة تلقائياً."""
    settlement, account, doc_id = await _create_custody_settlement(
        db, account_id, None, description, current_user.id, await get_user_roles(current_user, db=db),
    )
    return _settlement_read(settlement, account.name, doc_id)


# ─── المصروفات اليومية من صندوق العهدة ──────────────────────────────────────

@router.get("/daily-expenses", response_model=List[CashDocumentRead])
async def list_daily_expenses(
    account_id: str = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(CashDocument).where(CashDocument.source_system == "daily_expense").order_by(CashDocument.occurred_at.desc())
    if account_id:
        stmt = stmt.where(CashDocument.from_account_id == account_id)
    return (await db.scalars(stmt)).all()


@router.post("/daily-expenses", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def create_daily_expense(
    data: CashDocumentCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:expenses:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تسجيل مصروف يومي من صندوق عهدة؛ يُخصم من العهدة بعد اعتماده من شاشة الخزينة."""
    payload = data.model_copy(update={
        "document_type": "expense",
        "to_account_id": None,
        "source_system": "daily_expense",
        "source_reference": str(uuid.uuid4()),
    })
    document = await create_cash_document(db, payload, current_user.id, commit=False)
    return await finalize_cash_document(db, document, current_user.id, await get_user_roles(current_user, db=db))



# ═══════════════════════════════════════════════════════════════════════════════
# دفتر الأستاذ العام — Chart of Accounts & Journal Entries
# ═══════════════════════════════════════════════════════════════════════════════

class AccountRead(dict):
    pass  # نستخدم dict مباشرة للاستجابة البسيطة


@router.get("/gl/accounts")
async def list_gl_accounts(
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    """قائمة مخطط الحسابات مع أرصدة صافية من سطور القيود."""
    accounts = (await db.scalars(select(Account).where(Account.is_active.is_(True)).order_by(Account.code))).all()
    result = []
    for acc in accounts:
        total_debit = await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.debit), 0)).where(JournalEntryLine.account_id == acc.id)
        )
        total_credit = await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.credit), 0)).where(JournalEntryLine.account_id == acc.id)
        )
        result.append({
            "id": acc.id,
            "code": acc.code,
            "name_ar": acc.name_ar,
            "account_type": acc.account_type,
            "parent_id": acc.parent_id,
            "total_debit": float(total_debit or 0),
            "total_credit": float(total_credit or 0),
            "net_balance": float(Decimal(str(total_debit or 0)) - Decimal(str(total_credit or 0))),
        })
    return result


@router.get("/gl/trial-balance")
async def get_trial_balance(
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    """ميزان المراجعة — إجمالي المدين والدائن لكل حساب."""
    accounts = (await db.scalars(select(Account).where(Account.is_active.is_(True)).order_by(Account.code))).all()
    rows = []
    total_dr = Decimal("0.00")
    total_cr = Decimal("0.00")
    for acc in accounts:
        dr = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.debit), 0)).where(JournalEntryLine.account_id == acc.id)
        ) or 0))
        cr = Decimal(str(await db.scalar(
            select(func.coalesce(func.sum(JournalEntryLine.credit), 0)).where(JournalEntryLine.account_id == acc.id)
        ) or 0))
        if dr == 0 and cr == 0:
            continue
        rows.append({"code": acc.code, "name_ar": acc.name_ar, "account_type": acc.account_type,
                     "total_debit": float(dr), "total_credit": float(cr), "net": float(dr - cr)})
        total_dr += dr
        total_cr += cr
    return {
        "rows": rows,
        "totals": {"total_debit": float(total_dr), "total_credit": float(total_cr), "balanced": total_dr == total_cr},
    }


@router.get("/gl/journal-entries")
async def list_journal_entries(
    source_doc_type: str = Query(default=None),
    source_doc_id: str = Query(default=None),
    from_date: str = Query(default=None),
    to_date: str = Query(default=None),
    limit: int = Query(default=50, le=200),
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    """قائمة قيود اليومية مع فلترة اختيارية."""
    stmt = select(JournalEntry).order_by(JournalEntry.entry_date.desc()).limit(limit)
    if source_doc_type:
        stmt = stmt.where(JournalEntry.source_doc_type == source_doc_type)
    if source_doc_id:
        stmt = stmt.where(JournalEntry.source_doc_id == source_doc_id)
    entries = (await db.scalars(stmt)).all()
    result = []
    for entry in entries:
        lines = (await db.scalars(select(JournalEntryLine).where(JournalEntryLine.entry_id == entry.id))).all()
        line_rows = []
        for ln in lines:
            account = await db.get(Account, ln.account_id)
            line_rows.append({
                "account_code": account.code if account else "",
                "account_name_ar": account.name_ar if account else "",
                "debit": float(ln.debit),
                "credit": float(ln.credit),
                "description": ln.description,
            })
        result.append({
            "id": entry.id,
            "entry_number": entry.entry_number,
            "entry_date": entry.entry_date.isoformat() if entry.entry_date else None,
            "source_doc_type": entry.source_doc_type,
            "source_doc_id": entry.source_doc_id,
            "description": entry.description,
            "status": entry.status,
            "created_by": entry.created_by,
            "posted_at": entry.posted_at.isoformat() if entry.posted_at else None,
            "lines": line_rows,
        })
    return result


@router.get("/gl/canonical-treasury")
async def get_canonical_treasury_info(
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    """معلومات الخزنة الرئيسية الكانونية مع رصيدها الحالي."""
    treasury = await get_main_treasury(db)
    balance = await db.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == treasury.id)
    )
    return {
        "id": treasury.id,
        "account_number": treasury.account_number,
        "name": treasury.name,
        "is_canonical": treasury.id == _CANONICAL_TREASURY_ID,
        "balance": float(balance or 0),
        "note": "هذا هو الحساب الكانوني للخزنة الرئيسية — جميع العمليات الجديدة تُسجَّل عليه.",
    }
