"""Purchase orders and production shortage procurement (Phase 5 / T5).

Revision ID: 20261115_0031
Revises: 20261115_0030
Create Date: 2026-11-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0031"
down_revision: Union[str, Sequence[str], None] = "20261115_0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. إنشاء جدول أوامر الشراء (purchase_orders)
    op.create_table(
        "purchase_orders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_number", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("supplier_id", sa.String(36), sa.ForeignKey("suppliers.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("production_order_id", sa.String(36), sa.ForeignKey("production_orders.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="draft", index=True),
        sa.Column("expected_delivery_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("total_amount", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("notes", sa.Text, nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 2. إنشاء جدول بنود أوامر الشراء (purchase_order_lines)
    op.create_table(
        "purchase_order_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("ordered_quantity", sa.Float, nullable=False),
        sa.Column("received_quantity", sa.Float, nullable=False, server_default="0"),
        sa.Column("unit_price", sa.Numeric(14, 4), nullable=False, server_default="0.0000"),
        sa.Column("total_price", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("production_order_material_id", sa.String(36), sa.ForeignKey("production_order_materials.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("notes", sa.Text, nullable=False, server_default=""),
        sa.CheckConstraint("ordered_quantity > 0", name="ck_purchase_order_line_ordered_positive"),
        sa.CheckConstraint("received_quantity >= 0", name="ck_purchase_order_line_received_nonnegative"),
    )

    # 3. ربط فواتير واستلامات الموردين بأوامر الشراء للتتبع التبادلي
    op.add_column("supplier_invoices", sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_orders.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_supplier_invoices_purchase_order_id", "supplier_invoices", ["purchase_order_id"])

    op.add_column("supplier_invoice_lines", sa.Column("purchase_order_line_id", sa.String(36), sa.ForeignKey("purchase_order_lines.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_supplier_invoice_lines_purchase_order_line_id", "supplier_invoice_lines", ["purchase_order_line_id"])

    op.add_column("supplier_receipts", sa.Column("purchase_order_id", sa.String(36), sa.ForeignKey("purchase_orders.id", ondelete="SET NULL"), nullable=True))
    op.create_index("ix_supplier_receipts_purchase_order_id", "supplier_receipts", ["purchase_order_id"])
    op.alter_column("supplier_receipts", "invoice_id", nullable=True)


def downgrade() -> None:
    op.alter_column("supplier_receipts", "invoice_id", nullable=False)
    op.drop_index("ix_supplier_receipts_purchase_order_id", table_name="supplier_receipts")
    op.drop_column("supplier_receipts", "purchase_order_id")

    op.drop_index("ix_supplier_invoice_lines_purchase_order_line_id", table_name="supplier_invoice_lines")
    op.drop_column("supplier_invoice_lines", "purchase_order_line_id")

    op.drop_index("ix_supplier_invoices_purchase_order_id", table_name="supplier_invoices")
    op.drop_column("supplier_invoices", "purchase_order_id")

    op.drop_table("purchase_order_lines")
    op.drop_table("purchase_orders")
