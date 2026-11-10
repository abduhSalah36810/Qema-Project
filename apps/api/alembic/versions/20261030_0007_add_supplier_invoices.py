"""Add supplier directory, invoice receipt, and linked payments."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0007"
down_revision: Union[str, Sequence[str], None] = "20261030_0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "suppliers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("phone", sa.String(32), nullable=False, server_default=""),
        sa.Column("address", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "supplier_invoices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("internal_number", sa.String(64), nullable=False, unique=True),
        sa.Column("supplier_id", sa.String(36), sa.ForeignKey("suppliers.id"), nullable=False),
        sa.Column("invoice_number", sa.String(128), nullable=False),
        sa.Column("invoice_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("invoice_total", sa.Numeric(14, 2), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="awaiting_receipt"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("received_by", sa.String(64), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("invoice_total > 0", name="ck_supplier_invoice_total_positive"),
        sa.CheckConstraint("status in ('awaiting_receipt', 'received', 'cancelled')", name="ck_supplier_invoice_status"),
        sa.UniqueConstraint("supplier_id", "invoice_number", name="uq_supplier_invoice_number"),
    )
    op.create_index("ix_supplier_invoices_supplier_id", "supplier_invoices", ["supplier_id"])
    op.create_table(
        "supplier_invoice_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("invoice_id", sa.String(36), sa.ForeignKey("supplier_invoices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("invoiced_quantity", sa.Float(), nullable=False),
        sa.Column("received_quantity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("unit_price", sa.Numeric(14, 4), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("invoiced_quantity > 0", name="ck_supplier_invoice_line_quantity_positive"),
        sa.CheckConstraint("received_quantity >= 0", name="ck_supplier_invoice_line_received_nonnegative"),
        sa.CheckConstraint("unit_price >= 0", name="ck_supplier_invoice_line_price_nonnegative"),
    )
    op.create_index("ix_supplier_invoice_lines_invoice_id", "supplier_invoice_lines", ["invoice_id"])
    op.create_table(
        "supplier_payments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("invoice_id", sa.String(36), sa.ForeignKey("supplier_invoices.id"), nullable=False),
        sa.Column("cash_document_id", sa.String(36), sa.ForeignKey("cash_documents.id"), nullable=False, unique=True),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("decided_by", sa.String(64), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("amount > 0", name="ck_supplier_payment_amount_positive"),
        sa.CheckConstraint("status in ('pending', 'approved', 'rejected')", name="ck_supplier_payment_status"),
    )
    op.create_index("ix_supplier_payments_invoice_id", "supplier_payments", ["invoice_id"])


def downgrade() -> None:
    connection = op.get_bind()
    payment_count = connection.execute(sa.text("select count(*) from supplier_payments")).scalar_one()
    invoice_count = connection.execute(sa.text("select count(*) from supplier_invoices")).scalar_one()
    supplier_count = connection.execute(sa.text("select count(*) from suppliers")).scalar_one()
    if payment_count or invoice_count or supplier_count:
        raise RuntimeError("رفض التراجع: توجد فواتير موردين أو دفعات يجب حفظها.")
    op.drop_index("ix_supplier_payments_invoice_id", table_name="supplier_payments")
    op.drop_table("supplier_payments")
    op.drop_index("ix_supplier_invoice_lines_invoice_id", table_name="supplier_invoice_lines")
    op.drop_table("supplier_invoice_lines")
    op.drop_index("ix_supplier_invoices_supplier_id", table_name="supplier_invoices")
    op.drop_table("supplier_invoices")
    op.drop_table("suppliers")
