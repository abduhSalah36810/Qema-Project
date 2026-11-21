from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Annotated, List, Optional
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser
from app.core.idempotency import execute_idempotent_operation
from app.core.permissions import get_user_roles, require_permission
from app.db.session import get_db
from app.modules.finance.models import (
    Account, AccountingLock, CashAccount, CashDocument, CashLedgerEntry, CustodySettlement, JournalEntry, JournalEntryLine,
    PaymentAllocation, PurchaseOrder, PurchaseOrderLine, Supplier, SupplierInvoice, SupplierInvoiceLine, SupplierPayment, SupplierReceipt,
)
from app.modules.finance.schemas import (
    AccountingLockRead, AccountingLockStatusRead,
    CashAccountRead, CashDocumentCreate, CashDocumentDecision, CashDocumentRead,
    CustodySettlementCreate, CustodySettlementRead,
    OpeningBalancesCreate, OpeningBalancesLockCreate, OpeningBalancesRead,
    OpeningBalancesUnlockApproveCreate, OpeningBalancesUnlockRequestCreate,
    OpeningSupplierInvoiceCreate,
    PaymentAllocationCreate, PaymentAllocationRead, UnallocatedPaymentRead,
    PurchasedItemHistoryRow, PurchasedItemsResponse, PurchasedItemsSummary,
    PurchaseOrderCreate, PurchaseOrderRead, PurchaseOrderUpdate, PurchaseOrderReceiptConfirm,
    SupplierCreate, SupplierRead, SupplierUpdate, SupplierInvoiceCreate, SupplierInvoiceRead,
    SupplierInvoiceLineRead, SupplierPaymentCreate, SupplierPaymentLineRead, SupplierReceiptConfirm,
    SupplierFullBalanceRequest, SupplierFullBalanceRequestAck,
)
from app.modules.production.models import CatalogItem, ItemCategory, StockLedgerEntry, Unit, Warehouse
from app.modules.production.service import lock_stock_balance
from app.modules.finance.service import (
    allocate_supplier_payment, cash_account_balance, create_cash_document, decide_cash_document,
    finalize_cash_document, get_main_treasury, get_unallocated_supplier_payments, posts_on_creation,
)
from app.modules.finance.purchase_orders import (
    list_purchase_orders, get_purchase_order_by_id, create_purchase_order,
    update_draft_purchase_order, approve_purchase_order, cancel_purchase_order,
    receive_purchase_order_goods,
)
from app.modules.finance.ledger_service import post_journal_entry, CANONICAL_TREASURY_ID, is_opening_balances_locked, set_accounting_lock
from app.modules.finance.balances import supplier_invoice_financials, supplier_line_net_unit_cost, supplier_line_total

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


async def _enrich_cash_document_read(db: AsyncSession, doc: CashDocument) -> CashDocumentRead:
    read = CashDocumentRead.model_validate(doc)
    if "supplier" in doc.__dict__ and doc.supplier:
        read.supplier_name = doc.supplier.name
    elif doc.supplier_id:
        sup = await db.get(Supplier, doc.supplier_id)
        if sup:
            read.supplier_name = sup.name

    if "customer" in doc.__dict__ and doc.customer:
        read.customer_name = doc.customer.name
    elif doc.customer_id:
        from app.modules.customers.models import Customer
        cust = await db.get(Customer, doc.customer_id)
        if cust:
            read.customer_name = cust.name

    if doc.source_system == "supplier_payment":
        payment = await db.scalar(
            select(SupplierPayment).where(
                or_(
                    SupplierPayment.cash_document_id == doc.id,
                    SupplierPayment.id == doc.source_reference,
                )
            )
        )
        if payment:
            invoice = await db.scalar(
                select(SupplierInvoice)
                .options(selectinload(SupplierInvoice.lines))
                .where(SupplierInvoice.id == payment.invoice_id)
            )
            if invoice:
                fin = await supplier_invoice_financials(db, invoice, list(invoice.lines))
                read.invoice_total = fin.invoice_total
                read.received_value = fin.received_value
                paid_compare = fin.paid_approved if doc.status == "approved" else (fin.paid_approved + doc.amount)
                read.is_prepayment = bool(paid_compare > fin.received_value)

    read.is_auto_posted = bool(doc.status == "approved" and doc.approved_by and doc.approved_by == doc.created_by)
    return read


@router.get("/cash-documents", response_model=List[CashDocumentRead])
async def list_cash_documents(
    status: Optional[str] = Query(default=None),
    approvable_by_me: bool = Query(default=False),
    auto_posted_only: bool = Query(default=False),
    prepayment_only: bool = Query(default=False),
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(CashDocument)
        .options(selectinload(CashDocument.supplier), selectinload(CashDocument.customer))
        .order_by(CashDocument.created_at.desc())
    )
    if status:
        stmt = stmt.where(CashDocument.status == status)
    if auto_posted_only:
        stmt = stmt.where(
            CashDocument.status == "approved",
            CashDocument.approved_by.is_not(None),
            CashDocument.approved_by == CashDocument.created_by,
        )
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
    docs = (await db.scalars(stmt)).all()
    results = []
    for d in docs:
        read_item = await _enrich_cash_document_read(db, d)
        if prepayment_only and not read_item.is_prepayment:
            continue
        results.append(read_item)
    return results


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
        await db.refresh(document, attribute_names=["supplier", "customer"])
        return await _enrich_cash_document_read(db, document)

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
    document = await decide_cash_document(db, document_id, data, current_user.id)
    return await _enrich_cash_document_read(db, document)


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
            purchase_order_line_id=getattr(line, "purchase_order_line_id", None),
            notes=line.notes,
        ))

    payment_records = (await db.scalars(
        select(SupplierPayment).where(SupplierPayment.invoice_id == invoice.id).order_by(SupplierPayment.created_at.desc())
    )).all()
    alloc_records = (await db.scalars(
        select(PaymentAllocation).where(PaymentAllocation.supplier_invoice_id == invoice.id).order_by(PaymentAllocation.allocated_at.desc())
    )).all()
    payment_rows = [
        SupplierPaymentLineRead(
            id=p.id, cash_document_id=p.cash_document_id, amount=p.amount if show else zero,
            status=p.status, created_by=p.created_by, created_at=p.created_at,
        )
        for p in payment_records
    ] + [
        SupplierPaymentLineRead(
            id=a.id, cash_document_id=a.cash_document_id, amount=a.allocated_amount if show else zero,
            status="approved", created_by=a.allocated_by, created_at=a.allocated_at,
        )
        for a in alloc_records
    ]

    po_number = None
    if getattr(invoice, "purchase_order_id", None):
        po = await db.get(PurchaseOrder, invoice.purchase_order_id)
        if po:
            po_number = po.order_number

    return SupplierInvoiceRead(
        id=invoice.id, internal_number=invoice.internal_number, supplier_id=invoice.supplier_id,
        supplier_name=supplier.name if supplier else "",
        purchase_order_id=getattr(invoice, "purchase_order_id", None),
        purchase_order_number=po_number,
        invoice_number=invoice.invoice_number,
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
        is_opening=bool(getattr(invoice, "is_opening", False)),
        is_advance=bool(getattr(invoice, "is_advance", False)),
        approved_by=getattr(invoice, "approved_by", None),
        approved_at=getattr(invoice, "approved_at", None),
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
    code = data.code.strip() if data.code and data.code.strip() else None
    if not code:
        while True:
            candidate = f"SUP-{uuid.uuid4().hex[:8].upper()}"
            if not await db.scalar(select(Supplier.id).where(Supplier.code == candidate)):
                code = candidate
                break
    else:
        if await db.scalar(select(Supplier.id).where(Supplier.code == code)):
            raise HTTPException(409, "كود المورد مستخدم بالفعل.")
    row = Supplier(
        id=str(uuid.uuid4()), code=code, name=data.name.strip(),
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


@router.get("/supplier-invoices/{invoice_id}", response_model=SupplierInvoiceRead)
async def get_supplier_invoice(
    invoice_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    invoice = await db.get(SupplierInvoice, invoice_id)
    if not invoice:
        raise HTTPException(404, "فاتورة المورد غير موجودة.")
    user_roles = await get_user_roles(current_user, db=db)
    return await serialize_supplier_invoice(db, invoice, user_roles=user_roles)


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
        supplier_id=supplier.id, purchase_order_id=data.purchase_order_id,
        invoice_number=data.invoice_number.strip(), invoice_date=data.invoice_date,
        invoice_total=lines_total, notes=data.notes.strip(), created_by=current_user.id,
    )
    db.add(invoice)
    await db.flush()
    for line in data.lines:
        db.add(SupplierInvoiceLine(
            id=str(uuid.uuid4()), invoice_id=invoice.id, item_id=line.item_id, unit_id=line.unit_id,
            purchase_order_line_id=line.purchase_order_line_id,
            invoiced_quantity=line.invoiced_quantity, unit_price=line.unit_price,
            discount_amount=line.discount_amount, notes=line.notes.strip(),
        ))
    await db.commit()
    await db.refresh(invoice)
    return await serialize_supplier_invoice(db, invoice, user_roles=await get_user_roles(current_user, db=db))


@router.post("/supplier-invoices/opening", response_model=SupplierInvoiceRead, status_code=status.HTTP_201_CREATED)
async def create_opening_supplier_invoice(
    data: OpeningSupplierInvoiceCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تسجيل فاتورة مورد افتتاحية (رصيد دائن قديم أو دفعة مقدمة) بمبلغ إجمالي دون بنود أو أثر مخزني."""
    if await is_opening_balances_locked(db):
        raise HTTPException(status_code=409, detail="تم قفل الأرصدة الافتتاحية ولا يمكن إنشاء مستندات افتتاحية جديدة.")

    supplier = await db.get(Supplier, data.supplier_id)
    if not supplier or not supplier.is_active:
        raise HTTPException(404, "المورد غير موجود أو موقوف.")

    if await db.scalar(select(SupplierInvoice.id).where(
        SupplierInvoice.supplier_id == data.supplier_id,
        SupplierInvoice.invoice_number == data.invoice_number.strip(),
    )):
        raise HTTPException(409, "رقم فاتورة المورد مسجل من قبل.")

    invoice = SupplierInvoice(
        id=str(uuid.uuid4()),
        internal_number=f"PIN-OB-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
        supplier_id=supplier.id,
        invoice_number=data.invoice_number.strip(),
        invoice_date=data.invoice_date,
        invoice_total=data.amount,
        status="awaiting_receipt",
        is_opening=True,
        is_advance=data.is_advance,
        notes=data.notes.strip(),
        created_by=current_user.id,
    )
    db.add(invoice)
    await db.commit()
    await db.refresh(invoice)
    return await serialize_supplier_invoice(db, invoice, user_roles=await get_user_roles(current_user, db=db))


@router.post("/supplier-invoices/{invoice_id}/approve-opening", response_model=SupplierInvoiceRead)
async def approve_opening_supplier_invoice(
    invoice_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """اعتماد فاتورة المورد الافتتاحية وترحيل قيدها المحاسبي لحساب 3900 (Maker-Checker)."""
    invoice = await db.scalar(
        select(SupplierInvoice)
        .options(selectinload(SupplierInvoice.lines))
        .where(SupplierInvoice.id == invoice_id)
        .with_for_update()
    )
    if not invoice or not invoice.is_opening:
        raise HTTPException(404, "فاتورة المورد الافتتاحية غير موجودة.")
    if invoice.approved_by is not None:
        raise HTTPException(409, "تم اعتماد الفاتورة الافتتاحية مسبقاً.")

    if invoice.created_by == current_user.id:
        raise HTTPException(
            status_code=403,
            detail="لا يمكن لمنشئ المستند الافتتاحي اعتماده بنفسه (Maker-Checker). يلزم اعتماد مستخدم آخر.",
        )

    now = datetime.now(timezone.utc)
    invoice.approved_by = current_user.id
    invoice.approved_at = now
    invoice.status = "received"
    invoice.received_by = current_user.id
    invoice.received_at = now

    amt = Decimal(str(invoice.invoice_total))
    if not invoice.is_advance:
        await post_journal_entry(
            db,
            source_doc_type="opening_supplier_invoice",
            source_doc_id=invoice.id,
            description=f"إثبات رصيد دائن افتتاحي للمورد عن فاتورة {invoice.invoice_number}",
            lines=[
                {"account_code": "3900", "debit": amt, "credit": 0, "description": f"رصيد افتتاحي مورد عن فاتورة {invoice.invoice_number}"},
                {"account_code": "2100", "debit": 0, "credit": amt, "description": f"استحقاق مورد عن فاتورة قديمة {invoice.invoice_number}"},
            ],
            user_id=current_user.id,
            entry_date=invoice.invoice_date,
        )
    else:
        await post_journal_entry(
            db,
            source_doc_type="opening_supplier_invoice",
            source_doc_id=invoice.id,
            description=f"إثبات دفعة مقدمة افتتاحية للمورد عن فاتورة {invoice.invoice_number}",
            lines=[
                {"account_code": "2100", "debit": amt, "credit": 0, "description": f"دفعة مقدمة للمورد عن فاتورة {invoice.invoice_number}"},
                {"account_code": "3900", "debit": 0, "credit": amt, "description": f"رصيد افتتاحي دفعة مقدمة {invoice.invoice_number}"},
            ],
            user_id=current_user.id,
            entry_date=invoice.invoice_date,
        )

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

        # إذا كان السطر مرتبطاً بأمر شراء، نحدّث سطر أمر الشراء المقابل
        if getattr(line, "purchase_order_line_id", None):
            po_l = await db.get(PurchaseOrderLine, line.purchase_order_line_id)
            if po_l:
                po_l.received_quantity = round((po_l.received_quantity or 0.0) + qty, 6)
                po_m = await db.get(PurchaseOrder, po_l.purchase_order_id)
                if po_m:
                    all_po_lines = (await db.scalars(select(PurchaseOrderLine).where(PurchaseOrderLine.purchase_order_id == po_m.id))).all()
                    po_done = all(float(l.received_quantity or 0.0) + QTY_TOLERANCE >= l.ordered_quantity for l in all_po_lines)
                    po_m.status = "received" if po_done else "partially_received"
                    po_m.updated_at = now

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
    source_acc = await get_main_treasury(db)
    if data.from_account_id:
        acc = await db.get(CashAccount, data.from_account_id)
        if not acc or not acc.is_active or acc.account_type not in ("treasury", "bank"):
            raise HTTPException(422, "حساب الصرف لسداد المورد غير صالح.")
        source_acc = acc
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
        document_type="expense", from_account_id=source_acc.id, to_account_id=None,
        amount=data.amount, description=data.description.strip(), occurred_at=datetime.now(timezone.utc),
        source_system="supplier_payment", source_reference=payment_id,
        supplier_id=invoice.supplier_id,
        status="pending", created_by=current_user.id,
    )
    payment = SupplierPayment(
        id=payment_id, invoice_id=invoice.id, cash_document_id=document_id,
        amount=data.amount, status="pending", created_by=current_user.id,
    )
    db.add(document)
    db.add(payment)
    document = await finalize_cash_document(db, document, current_user.id, await get_user_roles(current_user, db=db))
    return await _enrich_cash_document_read(db, document)


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
        supplier_id=invoice.supplier_id,
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


@router.get("/suppliers/{supplier_id}/unallocated-payments", response_model=List[UnallocatedPaymentRead])
async def list_supplier_unallocated_payments(
    supplier_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    """عرض الدفعات النقدية المسددة للمورد والتي تملك رصيداً غير مخصص بعد على فواتير الشراء."""
    rows = await get_unallocated_supplier_payments(db, supplier_id)
    return [UnallocatedPaymentRead(**row) for row in rows]


@router.post("/supplier-invoices/{invoice_id}/allocate-payment", response_model=PaymentAllocationRead)
async def allocate_payment_to_supplier_invoice(
    invoice_id: str,
    data: PaymentAllocationCreate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:payments:request")),
    db: AsyncSession = Depends(get_db),
):
    """تخصيص وتسوية دفعة نقدية سابقة ومعتمدة على فاتورة مورد دون تكرار حركة الخزينة."""
    alloc = await allocate_supplier_payment(
        db,
        invoice_id=invoice_id,
        cash_document_id=data.cash_document_id,
        amount=data.amount,
        user_id=current_user.id,
        notes=data.notes,
    )
    await db.commit()
    await db.refresh(alloc)
    cd = await db.get(CashDocument, alloc.cash_document_id)
    return PaymentAllocationRead(
        id=alloc.id,
        allocation_number=alloc.allocation_number,
        cash_document_id=alloc.cash_document_id,
        cash_document_number=cd.document_number if cd else None,
        supplier_id=alloc.supplier_id,
        customer_id=alloc.customer_id,
        supplier_invoice_id=alloc.supplier_invoice_id,
        customer_order_id=alloc.customer_order_id,
        allocated_amount=alloc.allocated_amount,
        allocated_at=alloc.allocated_at,
        allocated_by=alloc.allocated_by,
        notes=alloc.notes,
    )


@router.get("/purchased-items", response_model=PurchasedItemsResponse)
async def list_purchased_items(
    item_id: Annotated[Optional[str], Query()] = None,
    category_id: Annotated[Optional[str], Query()] = None,
    item_type: Annotated[Optional[str], Query()] = None,
    supplier_id: Annotated[Optional[str], Query()] = None,
    invoice_status: Annotated[Optional[str], Query(alias="status")] = None,
    date_from: Annotated[Optional[date], Query()] = None,
    date_to: Annotated[Optional[date], Query()] = None,
    search: Annotated[Optional[str], Query(max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    """سجل الأصناف المشتراة من فواتير الموردين مباشرةً مع إخفاء الأسعار لأمين المخزن."""
    user_roles = await get_user_roles(current_user, db=db)
    show_prices = _can_view_prices(user_roles)

    stmt = (
        select(SupplierInvoiceLine, SupplierInvoice, Supplier, CatalogItem, Unit, ItemCategory)
        .join(SupplierInvoice, SupplierInvoice.id == SupplierInvoiceLine.invoice_id)
        .join(Supplier, Supplier.id == SupplierInvoice.supplier_id)
        .join(CatalogItem, CatalogItem.id == SupplierInvoiceLine.item_id)
        .join(Unit, Unit.id == SupplierInvoiceLine.unit_id)
        .outerjoin(ItemCategory, ItemCategory.id == CatalogItem.category_id)
        .order_by(SupplierInvoice.invoice_date.desc(), SupplierInvoice.created_at.desc())
    )

    if item_id:
        stmt = stmt.where(SupplierInvoiceLine.item_id == item_id)
    if category_id:
        stmt = stmt.where(CatalogItem.category_id == category_id)
    if item_type:
        stmt = stmt.where(CatalogItem.item_type == item_type)
    if supplier_id:
        stmt = stmt.where(SupplierInvoice.supplier_id == supplier_id)
    if invoice_status:
        stmt = stmt.where(SupplierInvoice.status == invoice_status)
    else:
        stmt = stmt.where(SupplierInvoice.status != "cancelled")
    if date_from:
        stmt = stmt.where(SupplierInvoice.invoice_date >= datetime.combine(date_from, time.min, tzinfo=timezone.utc))
    if date_to:
        stmt = stmt.where(SupplierInvoice.invoice_date <= datetime.combine(date_to, time.max, tzinfo=timezone.utc))
    if search and search.strip():
        q = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                CatalogItem.code.ilike(q),
                CatalogItem.name_ar.ilike(q),
                Supplier.name.ilike(q),
                SupplierInvoice.invoice_number.ilike(q),
                SupplierInvoice.internal_number.ilike(q),
            )
        )

    stmt = stmt.limit(limit)
    rows = (await db.execute(stmt)).all()

    items_out: list[PurchasedItemHistoryRow] = []
    distinct_item_ids: set[str] = set()
    total_invoiced_qty = 0.0
    total_received_qty = 0.0
    total_amount = Decimal("0.00")

    for line, invoice, supplier, item, unit, category in rows:
        inv_qty = float(line.invoiced_quantity or 0)
        rec_qty = float(line.received_quantity or 0)
        rem_qty = max(0.0, inv_qty - rec_qty)
        line_tot = supplier_line_total(line)
        net_cost = supplier_line_net_unit_cost(line)

        if invoice.status != "cancelled":
            distinct_item_ids.add(item.id)
            total_invoiced_qty += inv_qty
            total_received_qty += rec_qty
            total_amount += line_tot

        items_out.append(
            PurchasedItemHistoryRow(
                line_id=line.id,
                invoice_id=invoice.id,
                internal_number=invoice.internal_number,
                invoice_number=invoice.invoice_number,
                invoice_date=invoice.invoice_date,
                invoice_status=invoice.status,
                supplier_id=supplier.id,
                supplier_code=supplier.code,
                supplier_name=supplier.name,
                item_id=item.id,
                item_code=item.code,
                item_name_ar=item.name_ar,
                item_type=item.item_type,
                category_id=item.category_id,
                category_name_ar=category.name_ar if category else None,
                unit_id=unit.id,
                unit_name_ar=unit.name_ar,
                invoiced_quantity=inv_qty,
                received_quantity=rec_qty,
                remaining_quantity=rem_qty,
                unit_price=Decimal(str(line.unit_price)) if show_prices else None,
                discount_amount=Decimal(str(line.discount_amount or 0)) if show_prices else None,
                net_unit_cost=net_cost if show_prices else None,
                line_total=line_tot if show_prices else None,
                notes=line.notes or "",
            )
        )

    return PurchasedItemsResponse(
        summary=PurchasedItemsSummary(
            lines_count=len(items_out),
            distinct_items_count=len(distinct_item_ids),
            total_invoiced_quantity=total_invoiced_qty,
            total_received_quantity=total_received_qty,
            total_amount=total_amount if show_prices else None,
            prices_visible=show_prices,
        ),
        items=items_out,
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


@router.get("/opening-balances", response_model=OpeningBalancesRead)
async def get_opening_balances(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعلام عن القيد الافتتاحي وتاريخ بدء الدورة المحاسبية."""
    entry = await db.scalar(
        select(JournalEntry)
        .where(JournalEntry.source_doc_type == "opening_balance")
        .order_by(JournalEntry.entry_date.desc(), JournalEntry.created_at.desc())
    )
    if not entry:
        return OpeningBalancesRead(
            is_set=False,
            message="لم يتم تسجيل القيد الافتتاحي بعد. الميزانية العمومية تتطلب قيداً افتتاحياً متوازناً لتحديد أرصدة البداية الرسمية للمصنع.",
        )
    lines = (await db.scalars(select(JournalEntryLine).where(JournalEntryLine.entry_id == entry.id))).all()
    details: dict[str, Decimal] = {}
    tot_dr, tot_cr = Decimal("0.00"), Decimal("0.00")
    for ln in lines:
        acc = await db.get(Account, ln.account_id)
        if acc:
            val = ln.debit if ln.debit > 0 else ln.credit
            details[acc.code] = val
            tot_dr += ln.debit
            tot_cr += ln.credit
    return OpeningBalancesRead(
        is_set=True,
        accounting_start_date=entry.entry_date.date() if entry.entry_date else None,
        journal_entry_id=entry.id,
        journal_entry_number=entry.entry_number,
        posted_at=entry.posted_at or entry.created_at,
        posted_by=entry.created_by,
        total_assets=tot_dr,
        total_liabilities_and_equity=tot_cr,
        is_balanced=tot_dr == tot_cr,
        details=details,
        message=f"القيد الافتتاحي مسجل برقم {entry.entry_number} بتاريخ {entry.entry_date.date() if entry.entry_date else ''}.",
    )


@router.post("/opening-balances", response_model=OpeningBalancesRead, status_code=status.HTTP_201_CREATED)
async def create_opening_balances(
    data: OpeningBalancesCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """
    تسجيل القيد الافتتاحي الرسمي لبدء الدورة المحاسبية (ACC-01 / ACC-02).
    - يشترط التوازن التام: إجمالي الأصول (المدين) = إجمالي الالتزامات ورأس المال (الدائن).
    - يمنع المعالجة الآلية أو فرض فروقات في حساب 3000 دون اعتماد صريح.
    - يدعم حسابات: الخزنة 1010، البنك 1030، العهد 1020، العملاء 1100، مخزون الخامات 1210،
      تحت التشغيل 1220، التام 1230، الموردين 2100، ورأس المال 3000.
    """
    disallowed = []
    if data.accounts_receivable > Decimal("0.00"):
        disallowed.append("1100 (ذمم العملاء)")
    if data.raw_materials_inventory > Decimal("0.00"):
        disallowed.append("1210 (مخزون الخامات)")
    if data.wip_inventory > Decimal("0.00"):
        disallowed.append("1220 (إنتاج تحت التشغيل)")
    if data.finished_goods_inventory > Decimal("0.00"):
        disallowed.append("1230 (مخزون التام)")
    if data.accounts_payable > Decimal("0.00"):
        disallowed.append("2100 (ذمم الموردين)")
    if disallowed:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"يُحظر إدخال أرصدة للحسابات التالية في القيد الافتتاحي العام: {', '.join(disallowed)}. "
                "أرصدة المخزون والعملاء والموردين تُسجل حصرياً عبر مستنداتها الافتتاحية المخصصة "
                "(الجرد الافتتاحي، فواتير الموردين الافتتاحية، وأرصدة العملاء الافتتاحية) لمنع ازدواجية القيود."
            ),
        )

    if data.custody_balance > Decimal("0.00"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="أرصدة العهد تُسجَّل بعد يوم القطع بتحويل من الخزينة إلى حساب العهدة",
        )

    if await is_opening_balances_locked(db):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="تم قفل الأرصدة الافتتاحية ولا يمكن ترحيل قيد افتتاحي جديد. راجع الإدارة لطلب إعادة فتح القفل.",
        )

    # التحقق من عدم وجود قيد افتتاحي عام مسبق في النظام (يُسمح بقيد افتتاحي عام واحد فقط للنظام)
    existing_ob = await db.scalar(
        select(JournalEntry.id).where(JournalEntry.source_doc_type == "opening_balance")
    )
    if existing_ob:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="تم تسجيل القيد الافتتاحي العام للنظام مسبقاً ولا يمكن تكراره أو ترحيل قيد افتتاحي عام ثانٍ.",
        )

    chosen_bank_account = None
    if data.bank_balance > Decimal("0.00"):
        bank_accounts = (
            await db.scalars(
                select(CashAccount).where(
                    CashAccount.account_type == "bank",
                    CashAccount.is_active.is_(True),
                )
            )
        ).all()
        if not bank_accounts:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="لا يوجد أي حساب بنكي نشط في النظام لتسجيل الرصيد الافتتاحي للبنك. يرجى تهيئة حساب بنكي أولاً.",
            )
        if len(bank_accounts) == 1:
            chosen_bank_account = bank_accounts[0]
            if data.bank_account_id and data.bank_account_id != chosen_bank_account.id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="حساب البنك المحدد غير صحيح أو غير موجود.",
                )
        else:
            if not data.bank_account_id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="يوجد أكثر من حساب بنكي نشط. حقل bank_account_id إلزامي عند وجود رصيد بنكي.",
                )
            chosen_bank_account = next((b for b in bank_accounts if b.id == data.bank_account_id), None)
            if not chosen_bank_account:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="حساب البنك المحدد غير موجود أو غير نشط.",
                )

    if data.treasury_balance > Decimal("0.00"):
        treasury = await db.get(CashAccount, CANONICAL_TREASURY_ID)
        if not treasury:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="حساب الخزينة الرئيسية الكانوني غير مهيأ في النظام.",
            )

    lines: list[dict[str, Any]] = []
    # النقدية والبنك (مدين)
    if data.treasury_balance > Decimal("0.00"):
        lines.append({"account_code": "1010", "debit": data.treasury_balance, "credit": Decimal("0.00"), "description": "رصيد الخزينة الرئيسية الافتتاحي"})
    if data.bank_balance > Decimal("0.00"):
        lines.append({"account_code": "1030", "debit": data.bank_balance, "credit": Decimal("0.00"), "description": "رصيد حساب بنك المصنع الافتتاحي"})

    # رأس المال (دائن)
    if data.paid_in_capital > Decimal("0.00"):
        lines.append({"account_code": "3000", "debit": Decimal("0.00"), "credit": data.paid_in_capital, "description": "رأس المال المدفوع وحقوق الملكية الافتتاحية"})

    if not lines:
        raise HTTPException(422, "يجب إدخال مبالغ في حسابات القيد الافتتاحي.")

    # موازنة القيد الافتتاحي بحساب 3900 إن وجد فارق بين النقدية ورأس المال
    cur_dr = sum((l["debit"] for l in lines), Decimal("0.00"))
    cur_cr = sum((l["credit"] for l in lines), Decimal("0.00"))
    if cur_dr > cur_cr:
        lines.append({"account_code": "3900", "debit": Decimal("0.00"), "credit": cur_dr - cur_cr, "description": "توازن الأرصدة الافتتاحية المعلقة"})
    elif cur_cr > cur_dr:
        lines.append({"account_code": "3900", "debit": cur_cr - cur_dr, "credit": Decimal("0.00"), "description": "توازن الأرصدة الافتتاحية المعلقة"})

    entry_date = datetime.combine(data.accounting_start_date, datetime.min.time()).replace(tzinfo=timezone.utc)
    entry = await post_journal_entry(
        db,
        source_doc_type="opening_balance",
        source_doc_id=f"OB-{data.accounting_start_date.isoformat()}",
        description=f"القيد الافتتاحي الرسمي لبدء الدورة المحاسبية بتاريخ {data.accounting_start_date} {data.notes}".strip(),
        lines=lines,
        user_id=current_user.id,
        entry_date=entry_date,
    )

    # إنشاء حركات دفتر النقدية الافتتاحية ذرّياً مع القيد
    if data.treasury_balance > Decimal("0.00"):
        doc_tr = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-OB-TR-{uuid.uuid4().hex[:8].upper()}",
            document_type="opening_balance",
            to_account_id=CANONICAL_TREASURY_ID,
            from_account_id=None,
            amount=data.treasury_balance,
            description="رصيد الخزينة الرئيسية الافتتاحي",
            occurred_at=entry_date,
            source_system="opening_balance",
            source_reference=f"OB-{data.accounting_start_date.isoformat()}-TREASURY",
            status="approved",
            created_by=current_user.id,
            approved_by=current_user.id,
            approved_at=entry_date,
        )
        db.add(doc_tr)
        await db.flush()
        db.add(
            CashLedgerEntry(
                id=str(uuid.uuid4()),
                document_id=doc_tr.id,
                account_id=CANONICAL_TREASURY_ID,
                amount=data.treasury_balance,
                created_by=current_user.id,
                created_at=entry_date,
            )
        )

    if data.bank_balance > Decimal("0.00") and chosen_bank_account:
        doc_bk = CashDocument(
            id=str(uuid.uuid4()),
            document_number=f"CSH-OB-BK-{uuid.uuid4().hex[:8].upper()}",
            document_type="opening_balance",
            to_account_id=chosen_bank_account.id,
            from_account_id=None,
            amount=data.bank_balance,
            description=f"رصيد {chosen_bank_account.name} الافتتاحي",
            occurred_at=entry_date,
            source_system="opening_balance",
            source_reference=f"OB-{data.accounting_start_date.isoformat()}-BANK",
            status="approved",
            created_by=current_user.id,
            approved_by=current_user.id,
            approved_at=entry_date,
        )
        db.add(doc_bk)
        await db.flush()
        db.add(
            CashLedgerEntry(
                id=str(uuid.uuid4()),
                document_id=doc_bk.id,
                account_id=chosen_bank_account.id,
                amount=data.bank_balance,
                created_by=current_user.id,
                created_at=entry_date,
            )
        )

    # قفل الأرصدة الافتتاحية تلقائياً عند ترحيل القيد الافتتاحي العام
    await set_accounting_lock(
        db,
        lock_type="opening_balances",
        is_locked=True,
        action="locked",
        performed_by=current_user.id,
        reason="قفل تلقائي عند ترحيل القيد الافتتاحي العام",
    )
    await db.commit()
    await db.refresh(entry)

    tot_dr = sum((l["debit"] for l in lines), Decimal("0.00"))
    tot_cr = sum((l["credit"] for l in lines), Decimal("0.00"))
    details = {l["account_code"]: (l["debit"] if l["debit"] > 0 else l["credit"]) for l in lines}

    return OpeningBalancesRead(
        is_set=True,
        accounting_start_date=data.accounting_start_date,
        journal_entry_id=entry.id,
        journal_entry_number=entry.entry_number,
        posted_at=entry.posted_at or entry.created_at,
        posted_by=current_user.id,
        total_assets=tot_dr,
        total_liabilities_and_equity=tot_cr,
        is_balanced=tot_dr == tot_cr,
        details=details,
        message="تم ترحيل القيد الافتتاحي وتفعيل الميزانية العمومية بنجاح.",
    )


@router.get("/opening-balances/lock-status", response_model=AccountingLockStatusRead)
async def get_opening_balances_lock_status(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعلام عن حالة قفل الأرصدة الافتتاحية وسجل التدقيق التاريخي الكامل للأقفال والفتحات."""
    history_records = (
        await db.scalars(
            select(AccountingLock)
            .where(AccountingLock.lock_type == "opening_balances")
            .order_by(AccountingLock.performed_at.desc(), AccountingLock.id.desc())
        )
    ).all()

    latest = history_records[0] if history_records else None
    is_locked = latest.is_locked if latest else False

    return AccountingLockStatusRead(
        is_locked=is_locked,
        lock_type="opening_balances",
        current_action=latest.action if latest else None,
        latest_reason=latest.reason if latest else None,
        latest_performed_by=latest.performed_by if latest else None,
        latest_performed_at=latest.performed_at if latest else None,
        history=[
            AccountingLockRead(
                id=h.id,
                lock_type=h.lock_type,
                is_locked=h.is_locked,
                action=h.action,
                reason=h.reason,
                performed_by=h.performed_by,
                performed_at=h.performed_at,
                requested_by=h.requested_by,
                unlock_request_id=h.unlock_request_id,
            )
            for h in history_records
        ],
    )


@router.post("/opening-balances/lock", status_code=status.HTTP_200_OK)
async def lock_opening_balances(
    payload: OpeningBalancesLockCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """قفل يدوي صريح للأرصدة الافتتاحية (محصور بالمدير العام general_manager)."""
    user_roles = await get_user_roles(current_user, db=db)
    if "general_manager" not in user_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="صلاحية قفل الدورة الافتتاحية محصورة بالمدير العام فقط (general_manager).",
        )

    await set_accounting_lock(
        db,
        lock_type="opening_balances",
        is_locked=True,
        action="locked",
        performed_by=current_user.id,
        reason=payload.reason or "قفل يدوي صريح للأرصدة الافتتاحية من المدير العام",
    )
    await db.commit()
    return {"is_locked": True, "message": "تم قفل الأرصدة الافتتاحية بنجاح."}


@router.post("/opening-balances/request-unlock", status_code=status.HTTP_201_CREATED)
async def request_unlock_opening_balances(
    payload: OpeningBalancesUnlockRequestCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """تقديم طلب فتح قفل الأرصدة الافتتاحية بسبب مكتوب إلزامي (المدير المالي أو المدير العام)."""
    user_roles = await get_user_roles(current_user, db=db)
    if not user_roles.intersection({"finance_manager", "general_manager"}):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="طلب فتح القفل متاح للمدير المالي أو المدير العام فقط.",
        )

    if not await is_opening_balances_locked(db):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="الأرصدة الافتتاحية غير مقفلة بالفعل.",
        )

    lock_req = await set_accounting_lock(
        db,
        lock_type="opening_balances",
        is_locked=True,
        action="unlock_requested",
        performed_by=current_user.id,
        reason=payload.reason.strip(),
    )
    await db.commit()
    return {
        "status": "pending_approval",
        "request_id": lock_req.id,
        "reason": lock_req.reason,
        "message": "تم تقديم طلب فتح القفل بنجاح وفي انتظار اعتماد المدير العام.",
    }


@router.post("/opening-balances/approve-unlock", status_code=status.HTTP_200_OK)
async def approve_unlock_opening_balances(
    payload: OpeningBalancesUnlockApproveCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """اعتماد طلب فتح القفل (المدير العام حصراً، مع فرض ضابط Maker-Checker لمنع الاعتماد الذاتي)."""
    user_roles = await get_user_roles(current_user, db=db)
    if "general_manager" not in user_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="صلاحية اعتماد فتح القفل محصورة بالمدير العام فقط (general_manager).",
        )

    # البحث عن طلب الفتح المعلق
    stmt = (
        select(AccountingLock)
        .where(
            AccountingLock.lock_type == "opening_balances",
            AccountingLock.action == "unlock_requested",
        )
        .order_by(AccountingLock.performed_at.desc(), AccountingLock.id.desc())
        .limit(1)
    )
    req = await db.scalar(stmt)
    if not req:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="لا يوجد طلب فتح قفل معلق للأرصدة الافتتاحية.",
        )

    # ضابط فصل المهام (Maker-Checker)
    if req.performed_by == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="لا يجوز لمُقدم طلب فتح القفل اعتماده بنفسه (فصل المهام / Maker-Checker).",
        )

    reason = payload.approval_notes.strip() if payload.approval_notes else f"اعتماد فتح القفل: {req.reason}"

    await set_accounting_lock(
        db,
        lock_type="opening_balances",
        is_locked=False,
        action="unlocked",
        performed_by=current_user.id,
        reason=reason,
        requested_by=req.performed_by,
        unlock_request_id=req.id,
    )
    await db.commit()
    return {"is_locked": False, "message": "تم اعتماد فتح قفل الأرصدة الافتتاحية بنجاح."}



@router.get("/pre-migration-audit")
async def get_pre_migration_audit(
    current_user: AuthenticatedUser = Depends(require_permission("finance:reports:view")),
    db: AsyncSession = Depends(get_db),
):
    """
    فحص العمليات التاريخية والتشغيلية المسبقة لمساعدة المحاسب في إعداد القيد الافتتاحي.
    يعرض الأرصدة التراكمية في دفاتر النقدية والمخزون والعملاء والموردين.
    """
    # 1. النقدية
    cash_total = await db.scalar(select(func.coalesce(func.sum(CashLedgerEntry.amount), 0))) or Decimal("0.00")
    # 2. حركات المخزون
    raw_qty = await db.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0))
        .join(Warehouse, Warehouse.id == StockLedgerEntry.warehouse_id)
        .where(Warehouse.code.like("%raw%"))
    ) or 0.0
    fg_qty = await db.scalar(
        select(func.coalesce(func.sum(StockLedgerEntry.quantity), 0))
        .join(Warehouse, Warehouse.id == StockLedgerEntry.warehouse_id)
        .where(Warehouse.code.like("%finish%"))
    ) or 0.0
    # 3. قيود اليومية المسجلة
    je_count = await db.scalar(select(func.count(JournalEntry.id))) or 0
    ob_entry = await db.scalar(select(JournalEntry).where(JournalEntry.source_doc_type == "opening_balance"))

    return {
        "cash_ledger_total": float(cash_total),
        "raw_materials_ledger_quantity": float(raw_qty),
        "finished_goods_ledger_quantity": float(fg_qty),
        "total_journal_entries": je_count,
        "has_opening_balance": ob_entry is not None,
        "opening_balance_number": ob_entry.entry_number if ob_entry else None,
        "guidance": "الأرصدة أعلاه هي مؤشرات تشغيلية تاريخية من دفاتر الحركات؛ القيد الافتتاحي الرسمي يجب أن يُعتمد بأرقام الجرد والمطابقة الفعلية المعتمدة من إدارة المصنع دون افتراض تلقائي.",
    }


# ─── أوامر الشراء وإدارة عجز الخامات (Purchase Orders) ────────────────────────

@router.get("/purchase-orders", response_model=List[PurchaseOrderRead])
async def get_purchase_orders(
    supplier_id: Annotated[Optional[str], Query()] = None,
    status: Annotated[Optional[str], Query()] = None,
    search: Annotated[Optional[str], Query(max_length=120)] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
    current_user: AuthenticatedUser = Depends(require_permission("purchase_orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض أوامر الشراء مع تصفية حسب المورد أو الحالة أو البحث."""
    user_roles = await get_user_roles(current_user, db=db)
    return await list_purchase_orders(
        db, supplier_id=supplier_id, status=status, search=search, limit=limit, user_roles=user_roles
    )


@router.get("/purchase-orders/{po_id}", response_model=PurchaseOrderRead)
async def get_purchase_order(
    po_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("purchase_orders:view")),
    db: AsyncSession = Depends(get_db),
):
    """استعراض تفاصيل أمر الشراء وبنوده وحركات استلامه."""
    user_roles = await get_user_roles(current_user, db=db)
    return await get_purchase_order_by_id(db, po_id, user_roles=user_roles)


@router.post("/purchase-orders", response_model=PurchaseOrderRead, status_code=status.HTTP_201_CREATED)
async def create_new_purchase_order(
    data: PurchaseOrderCreate,
    current_user: AuthenticatedUser = Depends(require_permission("purchase_orders:create")),
    db: AsyncSession = Depends(get_db),
):
    """إنشاء أمر شراء جديد بحالة مسودة."""
    return await create_purchase_order(db, data, current_user.id)


@router.put("/purchase-orders/{po_id}", response_model=PurchaseOrderRead)
async def update_purchase_order(
    po_id: str,
    data: PurchaseOrderUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("purchase_orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تعديل أمر شراء مسودة (الكميات، الملاحظات، أو إضافة بنود)."""
    return await update_draft_purchase_order(db, po_id, data, current_user.id)


@router.post("/purchase-orders/{po_id}/approve", response_model=PurchaseOrderRead)
async def approve_po(
    po_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("purchase_orders:approve")),
    db: AsyncSession = Depends(get_db),
):
    """اعتماد أمر الشراء ليصبح جاهزاً للتوريد والاستلام المخزني (دون التأثير على المخزون)."""
    return await approve_purchase_order(db, po_id, current_user.id)


@router.post("/purchase-orders/{po_id}/cancel", response_model=PurchaseOrderRead)
async def cancel_po(
    po_id: str,
    reason: Annotated[Optional[str], Query(max_length=500)] = None,
    current_user: AuthenticatedUser = Depends(require_permission("purchase_orders:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إلغاء أمر شراء قبل اكتمال الاستلام مع إبقاء الأثر التوثيقي."""
    return await cancel_purchase_order(db, po_id, current_user.id, reason=reason)


@router.post("/purchase-orders/{po_id}/receive", response_model=PurchaseOrderRead)
async def receive_po_goods(
    po_id: str,
    data: PurchaseOrderReceiptConfirm,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:receive")),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_db),
):
    """
    إثبات استلام فعلي بمخزن الخامات بناءً على أمر الشراء (GRN).
    يزيد رصيد مخزن الخامات الحر في دفتر أستاذ المخزون StockLedgerEntry ويحدث كميات أمر الشراء المستلمة وحالته.
    """
    user_roles = await get_user_roles(current_user, db=db)
    return await receive_purchase_order_goods(
        db, po_id, data, current_user.id, user_roles=user_roles, idempotency_key=idempotency_key
    )

