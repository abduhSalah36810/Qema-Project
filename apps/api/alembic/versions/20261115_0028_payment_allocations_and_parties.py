"""Payment allocations, unallocated advance payments, and party links on cash documents (Phase 1).

Revision ID: 20261115_0028
Revises: 20261113_0027
Create Date: 2026-11-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0028"
down_revision: Union[str, Sequence[str], None] = "20261113_0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. ربط المستند النقدي بالمورد أو العميل ──
    op.add_column("cash_documents", sa.Column("supplier_id", sa.String(36), sa.ForeignKey("suppliers.id"), nullable=True))
    op.add_column("cash_documents", sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=True))
    op.create_index("ix_cash_documents_supplier_id", "cash_documents", ["supplier_id"])
    op.create_index("ix_cash_documents_customer_id", "cash_documents", ["customer_id"])

    # ── 2. جدول تخصيص وتسوية المدفوعات (Payment Allocations) ──
    op.create_table(
        "payment_allocations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("allocation_number", sa.String(64), unique=True, nullable=False),
        sa.Column("cash_document_id", sa.String(36), sa.ForeignKey("cash_documents.id"), nullable=False),
        sa.Column("supplier_id", sa.String(36), sa.ForeignKey("suppliers.id"), nullable=True),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=True),
        sa.Column("supplier_invoice_id", sa.String(36), sa.ForeignKey("supplier_invoices.id"), nullable=True),
        sa.Column("customer_order_id", sa.String(36), sa.ForeignKey("customer_orders.id"), nullable=True),
        sa.Column("allocated_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("allocated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("allocated_by", sa.String(64), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("allocated_amount > 0", name="ck_payment_allocation_amount_positive"),
    )
    op.create_index("ix_payment_allocations_allocation_number", "payment_allocations", ["allocation_number"])
    op.create_index("ix_payment_allocations_cash_document_id", "payment_allocations", ["cash_document_id"])
    op.create_index("ix_payment_allocations_supplier_id", "payment_allocations", ["supplier_id"])
    op.create_index("ix_payment_allocations_customer_id", "payment_allocations", ["customer_id"])
    op.create_index("ix_payment_allocations_supplier_invoice_id", "payment_allocations", ["supplier_invoice_id"])
    op.create_index("ix_payment_allocations_customer_order_id", "payment_allocations", ["customer_order_id"])


def downgrade() -> None:
    op.drop_table("payment_allocations")
    op.drop_index("ix_cash_documents_customer_id", table_name="cash_documents")
    op.drop_index("ix_cash_documents_supplier_id", table_name="cash_documents")
    op.drop_column("cash_documents", "customer_id")
    op.drop_column("cash_documents", "supplier_id")

