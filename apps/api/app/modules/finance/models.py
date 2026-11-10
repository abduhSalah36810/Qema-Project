import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, DateTime, Float, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

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
        CheckConstraint("status in ('awaiting_receipt', 'partially_received', 'received', 'cancelled')", name="ck_supplier_invoice_status"),
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

    lines: Mapped[list["SupplierInvoiceLine"]] = relationship("SupplierInvoiceLine", cascade="all, delete-orphan")


class SupplierInvoiceLine(Base):
    __tablename__ = "supplier_invoice_lines"
    __table_args__ = (
        CheckConstraint("invoiced_quantity > 0", name="ck_supplier_invoice_line_quantity_positive"),
        CheckConstraint("received_quantity >= 0", name="ck_supplier_invoice_line_received_nonnegative"),
        CheckConstraint("unit_price >= 0", name="ck_supplier_invoice_line_price_nonnegative"),
        CheckConstraint("discount_amount >= 0", name="ck_supplier_invoice_line_discount_nonnegative"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    invoice_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier_invoices.id", ondelete="CASCADE"), nullable=False, index=True)
    item_id: Mapped[str] = mapped_column(String(36), ForeignKey("catalog_items.id"), nullable=False)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("units.id"), nullable=False)
    invoiced_quantity: Mapped[float] = mapped_column(Float, nullable=False)
    received_quantity: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    unit_price: Mapped[object] = mapped_column(Numeric(14, 4), nullable=False)
    discount_amount: Mapped[object] = mapped_column(Numeric(14, 2), nullable=False, default=0)
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


# ─── الحسابات والدفتر العام (Chart of Accounts & General Ledger) ─────────────

class Account(Base):
    """دليل الحسابات الموحد لمصنع القمة."""
    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint("account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')", name="ck_accounts_type"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    name_ar: Mapped[str] = mapped_column(String(128), nullable=False)
    account_type: Mapped[str] = mapped_column(String(32), nullable=False)  # asset, liability, equity, revenue, expense
    parent_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    lines: Mapped[list["JournalEntryLine"]] = relationship("JournalEntryLine", back_populates="account")


class JournalEntry(Base):
    """قيد اليومية العامة المزدوج (Double-Entry Journal Entry)."""
    __tablename__ = "journal_entries"
    __table_args__ = (
        CheckConstraint("status in ('draft', 'submitted', 'pending_approval', 'approved', 'posted', 'reversed')", name="ck_journal_entries_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    entry_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    entry_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    source_doc_type: Mapped[str] = mapped_column(String(64), nullable=False)
    source_doc_id: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="posted", nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    approved_by: Mapped[str | None] = mapped_column(String(64))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reversed_entry_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("journal_entries.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    lines: Mapped[list["JournalEntryLine"]] = relationship("JournalEntryLine", back_populates="entry", cascade="all, delete-orphan")


class JournalEntryLine(Base):
    """طرف القيد المحاسبي (مدين أو دائن)."""
    __tablename__ = "journal_entry_lines"
    __table_args__ = (
        CheckConstraint("debit >= 0", name="ck_journal_line_debit_positive"),
        CheckConstraint("credit >= 0", name="ck_journal_line_credit_positive"),
        CheckConstraint("(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)", name="ck_journal_line_either_debit_or_credit"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    entry_id: Mapped[str] = mapped_column(String(36), ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False, index=True)
    debit: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0.00"), nullable=False)
    credit: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0.00"), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)

    entry: Mapped["JournalEntry"] = relationship("JournalEntry", back_populates="lines")
    account: Mapped["Account"] = relationship("Account", back_populates="lines")


class CustodySettlement(Base):
    """تسوية العهدة النقدية والمطابقة الرياضية المحكمة."""
    __tablename__ = "custody_settlements"
    __table_args__ = (
        CheckConstraint("status in ('pending', 'approved', 'rejected')", name="ck_custody_settlement_status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    settlement_number: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    custody_account_id: Mapped[str] = mapped_column(String(36), ForeignKey("cash_accounts.id"), nullable=False, index=True)
    original_custody_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    approved_expenses_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0.00"), nullable=False)
    returned_cash_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0.00"), nullable=False)
    remaining_unsettled_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal("0.00"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    approved_by: Mapped[str | None] = mapped_column(String(64))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    custody_account: Mapped["CashAccount"] = relationship("CashAccount")



class SupplierReceipt(Base):
    """مستند استلام فعلي (كلي أو جزئي) لبنود فاتورة مورد."""
    __tablename__ = "supplier_receipts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    receipt_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    invoice_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier_invoices.id"), nullable=False, index=True)
    received_by: Mapped[str] = mapped_column(String(64), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    total_cost: Mapped[object] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
