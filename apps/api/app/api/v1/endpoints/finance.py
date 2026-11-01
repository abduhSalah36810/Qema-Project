from datetime import datetime, timezone
from decimal import Decimal
from typing import List
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthenticatedUser
from app.core.permissions import require_permission
from app.db.session import get_db
from app.modules.finance.models import (
    CashAccount, CashDocument, CashLedgerEntry, Supplier, SupplierInvoice,
    SupplierInvoiceLine, SupplierPayment,
)
from app.modules.finance.schemas import (
    CashAccountRead, CashDocumentCreate, CashDocumentDecision, CashDocumentRead,
    SupplierCreate, SupplierRead, SupplierInvoiceCreate, SupplierInvoiceRead,
    SupplierInvoiceLineRead, SupplierPaymentCreate, SupplierReceiptConfirm,
)
from app.modules.production.models import CatalogItem, StockLedgerEntry, Unit, Warehouse
from app.modules.finance.service import create_cash_document, decide_cash_document

router = APIRouter(prefix="/finance", tags=["finance"])


@router.get("/accounts", response_model=List[CashAccountRead])
async def list_cash_accounts(
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    accounts = (await db.scalars(select(CashAccount).order_by(CashAccount.account_type, CashAccount.account_number))).all()
    result = []
    for account in accounts:
        balance = await db.scalar(select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account.id))
        result.append(CashAccountRead(
            id=account.id, account_number=account.account_number, name=account.name,
            account_type=account.account_type, parent_account_id=account.parent_account_id,
            is_active=account.is_active, balance=Decimal(str(balance)),
        ))
    return result


@router.post("/petty-cash", response_model=CashAccountRead, status_code=status.HTTP_201_CREATED)
async def create_petty_cash_account(
    name: str,
    business_date: datetime,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    treasury = await db.scalar(select(CashAccount).where(CashAccount.account_type == "treasury", CashAccount.is_active.is_(True)))
    if not treasury:
        raise HTTPException(503, "حساب الخزنة الرئيسية غير مهيأ.")
    account = CashAccount(
        id=str(uuid.uuid4()), account_number=f"PC-{business_date:%Y%m%d}-{uuid.uuid4().hex[:6].upper()}",
        name=name, account_type="petty_cash", parent_account_id=treasury.id,
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
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    return (await db.scalars(select(CashDocument).order_by(CashDocument.created_at.desc()))).all()


@router.post("/cash-documents", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def post_cash_document(
    data: CashDocumentCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    return await create_cash_document(db, data, current_user.id)


@router.post("/cash-documents/{document_id}/decision", response_model=CashDocumentRead)
async def decide_cash_document_route(
    document_id: str,
    data: CashDocumentDecision,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    return await decide_cash_document(db, document_id, data, current_user.id)


async def serialize_supplier_invoice(db: AsyncSession, invoice: SupplierInvoice) -> SupplierInvoiceRead:
    supplier = await db.get(Supplier, invoice.supplier_id)
    lines = (await db.scalars(select(SupplierInvoiceLine).where(SupplierInvoiceLine.invoice_id == invoice.id))).all()
    paid = await db.scalar(select(func.coalesce(func.sum(SupplierPayment.amount), 0)).where(
        SupplierPayment.invoice_id == invoice.id, SupplierPayment.status == "approved",
    ))
    line_rows = []
    for line in lines:
        item = await db.get(CatalogItem, line.item_id)
        unit = await db.get(Unit, line.unit_id)
        line_rows.append(SupplierInvoiceLineRead(
            id=line.id, item_id=line.item_id, item_code=item.code if item else "",
            item_name_ar=item.name_ar if item else "", unit_id=line.unit_id,
            unit_name_ar=unit.name_ar if unit else "", invoiced_quantity=line.invoiced_quantity,
            received_quantity=line.received_quantity, unit_price=line.unit_price, notes=line.notes,
        ))
    paid_total = Decimal(str(paid or 0))
    return SupplierInvoiceRead(
        id=invoice.id, internal_number=invoice.internal_number, supplier_id=invoice.supplier_id,
        supplier_name=supplier.name if supplier else "", invoice_number=invoice.invoice_number,
        invoice_date=invoice.invoice_date, invoice_total=invoice.invoice_total, paid_total=paid_total,
        balance_due=max(Decimal("0"), invoice.invoice_total - paid_total), status=invoice.status,
        notes=invoice.notes, created_by=invoice.created_by, received_by=invoice.received_by,
        received_at=invoice.received_at, lines=line_rows,
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


@router.get("/supplier-invoices", response_model=List[SupplierInvoiceRead])
async def list_supplier_invoices(
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:view")),
    db: AsyncSession = Depends(get_db),
):
    invoices = (await db.scalars(select(SupplierInvoice).order_by(SupplierInvoice.invoice_date.desc()))).all()
    return [await serialize_supplier_invoice(db, invoice) for invoice in invoices]


@router.post("/supplier-invoices", response_model=SupplierInvoiceRead, status_code=status.HTTP_201_CREATED)
async def create_supplier_invoice(
    data: SupplierInvoiceCreate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:manage")),
    db: AsyncSession = Depends(get_db),
):
    supplier = await db.get(Supplier, data.supplier_id)
    if not supplier or not supplier.is_active:
        raise HTTPException(404, "المورد غير موجود أو موقوف.")
    if await db.scalar(select(SupplierInvoice.id).where(
        SupplierInvoice.supplier_id == data.supplier_id,
        SupplierInvoice.invoice_number == data.invoice_number.strip(),
    )):
        raise HTTPException(409, "رقم فاتورة المورد مسجل من قبل.")
    prepared_lines = []
    for line in data.lines:
        item = await db.get(CatalogItem, line.item_id)
        if not item or not item.is_active or item.unit_id != line.unit_id:
            raise HTTPException(422, "أحد أصناف الفاتورة غير نشط أو وحدة القياس لا تطابق الصنف.")
        if item.approval_status != "approved":
            raise HTTPException(422, f"الصنف '{item.name_ar}' غير معتمد في دليل الأصناف (حالة الاعتماد: {item.approval_status})؛ لا يمكن إدراجه في فواتير المشتريات.")
        prepared_lines.append(line)
    invoice = SupplierInvoice(
        id=str(uuid.uuid4()), internal_number=f"PIN-{datetime.now(timezone.utc):%Y%m%d}-{uuid.uuid4().hex[:8].upper()}",
        supplier_id=supplier.id, invoice_number=data.invoice_number.strip(), invoice_date=data.invoice_date,
        invoice_total=data.invoice_total, notes=data.notes.strip(), created_by=current_user.id,
    )
    db.add(invoice)
    await db.flush()
    for line in prepared_lines:
        db.add(SupplierInvoiceLine(
            id=str(uuid.uuid4()), invoice_id=invoice.id, item_id=line.item_id, unit_id=line.unit_id,
            invoiced_quantity=line.invoiced_quantity, unit_price=line.unit_price, notes=line.notes.strip(),
        ))
    await db.commit()
    await db.refresh(invoice)
    return await serialize_supplier_invoice(db, invoice)


@router.post("/supplier-invoices/{invoice_id}/receive", response_model=SupplierInvoiceRead)
async def confirm_supplier_receipt(
    invoice_id: str,
    data: SupplierReceiptConfirm,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:receive")),
    db: AsyncSession = Depends(get_db),
):
    invoice = await db.scalar(select(SupplierInvoice).where(SupplierInvoice.id == invoice_id).with_for_update())
    if not invoice:
        raise HTTPException(404, "فاتورة المورد غير موجودة.")
    if invoice.status != "awaiting_receipt":
        raise HTTPException(409, "تم تأكيد استلام هذه الفاتورة أو إلغاؤها.")
    lines = (await db.scalars(select(SupplierInvoiceLine).where(SupplierInvoiceLine.invoice_id == invoice.id).with_for_update())).all()
    by_id = {line.id: line for line in lines}
    received = {entry.line_id: entry for entry in data.lines}
    if len(received) != len(data.lines) or set(received) != set(by_id):
        raise HTTPException(422, "يجب تسجيل كمية الاستلام الفعلي لكل بند مرة واحدة.")
    if not any(entry.received_quantity > 0 for entry in received.values()):
        raise HTTPException(422, "يجب أن تحتوي عملية الاستلام على كمية مقبولة واحدة على الأقل.")
    warehouse = await db.scalar(select(Warehouse).where(Warehouse.code == "main_raw_materials").with_for_update())
    if not warehouse:
        raise HTTPException(503, "مخزن الخامات الرئيسي غير مهيأ.")
    now = datetime.now(timezone.utc)
    for line_id, line in by_id.items():
        receipt_line = received[line_id]
        line.received_quantity = receipt_line.received_quantity
        if receipt_line.notes.strip():
            line.notes = (line.notes + " | استلام: " + receipt_line.notes.strip()).strip(" |")
        if receipt_line.received_quantity:
            db.add(StockLedgerEntry(
                id=str(uuid.uuid4()), item_id=line.item_id, unit_id=line.unit_id,
                warehouse_id=warehouse.id, location_type="warehouse", quantity=receipt_line.received_quantity,
                reference_doc_type="supplier_invoice_receipt", reference_doc_id=invoice.id,
                entry_type="supplier_receipt", created_by=current_user.id,
            ))
    invoice.status = "received"
    invoice.received_by = current_user.id
    invoice.received_at = now
    if data.notes.strip():
        invoice.notes = (invoice.notes + " | " + data.notes.strip()).strip(" |")
    await db.commit()
    await db.refresh(invoice)
    return await serialize_supplier_invoice(db, invoice)


@router.post("/supplier-invoices/{invoice_id}/payments", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def create_supplier_payment(
    invoice_id: str,
    data: SupplierPaymentCreate,
    current_user: AuthenticatedUser = Depends(require_permission("suppliers:manage")),
    db: AsyncSession = Depends(get_db),
):
    invoice = await db.scalar(select(SupplierInvoice).where(SupplierInvoice.id == invoice_id).with_for_update())
    if not invoice or invoice.status == "cancelled":
        raise HTTPException(404, "فاتورة المورد غير متاحة.")
    treasury = await db.scalar(select(CashAccount).where(CashAccount.account_type == "treasury", CashAccount.is_active.is_(True)))
    if not treasury:
        raise HTTPException(503, "الخزنة الرئيسية غير مهيأة.")
    settled_or_pending = await db.scalar(select(func.coalesce(func.sum(SupplierPayment.amount), 0)).where(
        SupplierPayment.invoice_id == invoice.id, SupplierPayment.status.in_(["pending", "approved"]),
    ))
    if Decimal(str(settled_or_pending or 0)) + data.amount > invoice.invoice_total:
        raise HTTPException(409, "قيمة الدفعة تتجاوز المبلغ المتبقي على الفاتورة.")
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
    await db.commit()
    await db.refresh(document)
    return document


# ─── تسوية صندوق العهدة اليومية ─────────────────────────────────────────────

@router.post("/petty-cash/{account_id}/settle", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def settle_petty_cash(
    account_id: str,
    description: str = "تسوية صندوق العهدة اليومية",
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    """إعادة الرصيد المتبقي في صندوق العهدة إلى الخزنة الرئيسية وإغلاق الحساب."""
    account = await db.scalar(select(CashAccount).where(CashAccount.id == account_id, CashAccount.account_type == "petty_cash").with_for_update())
    if not account:
        raise HTTPException(404, "حساب صندوق العهدة غير موجود.")
    if not account.is_active:
        raise HTTPException(409, "حساب صندوق العهدة مغلق بالفعل.")
    treasury = await db.scalar(select(CashAccount).where(CashAccount.account_type == "treasury", CashAccount.is_active.is_(True)))
    if not treasury:
        raise HTTPException(503, "الخزنة الرئيسية غير مهيأة.")
    balance = await db.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account.id)
    )
    remaining = Decimal(str(balance or 0))
    doc_id = str(uuid.uuid4())
    doc = CashDocument(
        id=doc_id,
        document_number=f"CSH-PCSET-{uuid.uuid4().hex[:10].upper()}",
        document_type="transfer",
        from_account_id=account.id,
        to_account_id=treasury.id,
        amount=remaining if remaining > 0 else Decimal("0"),
        description=description.strip(),
        occurred_at=datetime.now(timezone.utc),
        source_system="petty_cash_settlement",
        source_reference=account.id,
        status="approved",
        created_by=current_user.id,
        approved_by=current_user.id,
        approved_at=datetime.now(timezone.utc),
    )
    db.add(doc)
    if remaining > 0:
        # خصم من صندوق العهدة
        db.add(CashLedgerEntry(
            id=str(uuid.uuid4()), document_id=doc_id, account_id=account.id,
            amount=-remaining, created_by=current_user.id,
        ))
        # إضافة للخزنة الرئيسية
        db.add(CashLedgerEntry(
            id=str(uuid.uuid4()), document_id=doc_id, account_id=treasury.id,
            amount=remaining, created_by=current_user.id,
        ))
    account.is_active = False
    await db.commit()
    await db.refresh(doc)
    return doc


# ─── المصروفات اليومية من صندوق العهدة ──────────────────────────────────────

@router.get("/daily-expenses", response_model=List[CashDocumentRead])
async def list_daily_expenses(
    account_id: str = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(CashDocument).where(
        CashDocument.source_system == "daily_expense",
        CashDocument.status == "approved",
    ).order_by(CashDocument.occurred_at.desc())
    if account_id:
        stmt = stmt.where(CashDocument.from_account_id == account_id)
    return (await db.scalars(stmt)).all()


@router.post("/daily-expenses", response_model=CashDocumentRead, status_code=status.HTTP_201_CREATED)
async def create_daily_expense(
    data: CashDocumentCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:cash:manage")),
    db: AsyncSession = Depends(get_db),
):
    """تسجيل مصروف يومي وخصمه مباشرة من صندوق العهدة."""
    account = await db.scalar(
        select(CashAccount).where(CashAccount.id == data.from_account_id, CashAccount.is_active.is_(True)).with_for_update()
    )
    if not account:
        raise HTTPException(404, "حساب صندوق العهدة غير موجود أو مغلق.")
    balance = await db.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == account.id)
    )
    if Decimal(str(balance or 0)) < data.amount:
        raise HTTPException(409, f"رصيد صندوق العهدة غير كافٍ. المتاح: {balance}.")
    doc_id = str(uuid.uuid4())
    doc = CashDocument(
        id=doc_id,
        document_number=f"CSH-EXP-{uuid.uuid4().hex[:10].upper()}",
        document_type="expense",
        from_account_id=account.id,
        to_account_id=None,
        amount=data.amount,
        description=data.description.strip(),
        occurred_at=data.occurred_at,
        source_system="daily_expense",
        source_reference=str(uuid.uuid4()),
        status="approved",
        created_by=current_user.id,
        approved_by=current_user.id,
        approved_at=datetime.now(timezone.utc),
    )
    db.add(doc)
    db.add(CashLedgerEntry(
        id=str(uuid.uuid4()), document_id=doc_id, account_id=account.id,
        amount=-data.amount, created_by=current_user.id,
    ))
    await db.commit()
    await db.refresh(doc)
    return doc
