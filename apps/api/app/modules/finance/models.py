import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class CashAccount(Base):
    __tablename__ = "cash_accounts"
    __table_args__ = (CheckConstraint("account_type in ('treasury', 'petty_cash')", name="ck_cash_accounts_type"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    account_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    account_type: Mapped[str] = mapped_column(String(32), nullable=False)
    parent_account_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cash_accounts.id"))
    business_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class CashDocument(Base):
    __tablename__ = "cash_documents"
    __table_args__ = (
        CheckConstraint("document_type in ('income', 'expense', 'transfer')", name="ck_cash_documents_type"),
        CheckConstraint("status in ('pending', 'approved', 'rejected', 'reversed')", name="ck_cash_documents_status"),
        CheckConstraint("amount > 0", name="ck_cash_documents_amount_positive"),
        UniqueConstraint("source_system", "source_reference", name="uq_cash_document_source_reference"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    document_type: Mapped[str] = mapped_column(String(32), nullable=False)
    from_account_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cash_accounts.id"))
    to_account_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cash_accounts.id"))
    amount: Mapped[object] = mapped_column(Numeric(14, 2), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_system: Mapped[str | None] = mapped_column(String(64))
    source_reference: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    approved_by: Mapped[str | None] = mapped_column(String(64))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_by: Mapped[str | None] = mapped_column(String(64))
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class CashLedgerEntry(Base):
    __tablename__ = "cash_ledger_entries"
    __table_args__ = (UniqueConstraint("document_id", "account_id", name="uq_cash_ledger_document_account"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    document_id: Mapped[str] = mapped_column(String(36), ForeignKey("cash_documents.id"), nullable=False)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("cash_accounts.id"), nullable=False)
    amount: Mapped[object] = mapped_column(Numeric(14, 2), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    address: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class SupplierInvoice(Base):
    __tablename__ = "supplier_invoices"
    __table_args__ = (
        UniqueConstraint("supplier_id", "invoice_number", name="uq_supplier_invoice_number"),
        CheckConstraint("invoice_total > 0", name="ck_supplier_invoice_total_positive"),
        CheckConstraint("status in ('awaiting_receipt', 'received', 'cancelled')", name="ck_supplier_invoice_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    internal_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    supplier_id: Mapped[str] = mapped_column(String(36), ForeignKey("suppliers.id"), nullable=False, index=True)
    invoice_number: Mapped[str] = mapped_column(String(128), nullable=False)
    invoice_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    invoice_total: Mapped[object] = mapped_column(Numeric(14, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="awaiting_receipt")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    received_by: Mapped[str | None] = mapped_column(String(64))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class SupplierInvoiceLine(Base):
    __tablename__ = "supplier_invoice_lines"
    __table_args__ = (
        CheckConstraint("invoiced_quantity > 0", name="ck_supplier_invoice_line_quantity_positive"),
        CheckConstraint("received_quantity >= 0", name="ck_supplier_invoice_line_received_nonnegative"),
        CheckConstraint("unit_price >= 0", name="ck_supplier_invoice_line_price_nonnegative"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    invoice_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier_invoices.id", ondelete="CASCADE"), nullable=False, index=True)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    invoiced_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    received_quantity: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    unit_price: Mapped[object] = mapped_column(Numeric(14, 4), nullable=False)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")


class SupplierPayment(Base):
    __tablename__ = "supplier_payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_supplier_payment_amount_positive"),
        CheckConstraint("status in ('pending', 'approved', 'rejected')", name="ck_supplier_payment_status"),
        UniqueConstraint("cash_document_id", name="uq_supplier_payment_cash_document"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    invoice_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier_invoices.id"), nullable=False, index=True)
    cash_document_id: Mapped[str] = mapped_column(String(36), ForeignKey("cash_documents.id"), nullable=False)
    amount: Mapped[object] = mapped_column(Numeric(14, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    decided_by: Mapped[str | None] = mapped_column(String(64))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
