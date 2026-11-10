"""Add provisional customer orders, delivery batches, and payment records.

Revision ID: 20261024_0003
Revises: 20261024_0002
Create Date: 2026-10-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261024_0003"
down_revision: Union[str, Sequence[str], None] = "20261024_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_orders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_number", sa.String(64), nullable=False, unique=True),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("order_type", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="open"),
        sa.Column("order_date", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expected_delivery_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("discount_amount", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("payment_terms", sa.Text(), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("order_type in ('ready_goods', 'custom_manufacturing')", name="ck_customer_orders_type"),
        sa.CheckConstraint("status in ('open', 'partially_delivered', 'delivered', 'cancelled')", name="ck_customer_orders_status"),
        sa.CheckConstraint("discount_amount >= 0", name="ck_customer_orders_discount_nonnegative"),
    )
    op.create_index("ix_customer_orders_customer_id", "customer_orders", ["customer_id"])
    op.create_index("ix_customer_orders_order_number", "customer_orders", ["order_number"])

    op.create_table(
        "customer_order_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("customer_orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("variant_id", sa.String(36), sa.ForeignKey("product_variants.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("unit_price", sa.Numeric(14, 2), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("quantity > 0", name="ck_customer_order_lines_quantity_positive"),
        sa.CheckConstraint("unit_price >= 0", name="ck_customer_order_lines_price_nonnegative"),
    )
    op.create_index("ix_customer_order_lines_order_id", "customer_order_lines", ["order_id"])

    op.create_table(
        "customer_deliveries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("delivery_number", sa.String(64), nullable=False, unique=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("customer_orders.id"), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("received_by", sa.String(128), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
    )
    op.create_index("ix_customer_deliveries_order_id", "customer_deliveries", ["order_id"])
    op.create_index("ix_customer_deliveries_delivery_number", "customer_deliveries", ["delivery_number"])

    op.create_table(
        "customer_delivery_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("delivery_id", sa.String(36), sa.ForeignKey("customer_deliveries.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_line_id", sa.String(36), sa.ForeignKey("customer_order_lines.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_customer_delivery_lines_quantity_positive"),
    )
    op.create_index("ix_customer_delivery_lines_delivery_id", "customer_delivery_lines", ["delivery_id"])

    op.create_table(
        "customer_payments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("receipt_number", sa.String(64), nullable=False, unique=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("customer_orders.id"), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("method", sa.String(32), nullable=False),
        sa.Column("reference", sa.String(128), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("recorded_by", sa.String(64), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_customer_payments_amount_positive"),
        sa.CheckConstraint("method in ('cash', 'bank_transfer', 'other')", name="ck_customer_payments_method"),
    )
    op.create_index("ix_customer_payments_order_id", "customer_payments", ["order_id"])
    op.create_index("ix_customer_payments_receipt_number", "customer_payments", ["receipt_number"])

    op.add_column("production_orders", sa.Column("customer_order_line_id", sa.String(36), nullable=True))
    op.create_foreign_key(
        "fk_prod_orders_customer_order_line",
        "production_orders", "customer_order_lines", ["customer_order_line_id"], ["id"],
    )
    op.create_index("ix_production_orders_customer_order_line_id", "production_orders", ["customer_order_line_id"])


def downgrade() -> None:
    op.drop_index("ix_production_orders_customer_order_line_id", table_name="production_orders")
    op.drop_constraint("fk_prod_orders_customer_order_line", "production_orders", type_="foreignkey")
    op.drop_column("production_orders", "customer_order_line_id")
    op.drop_index("ix_customer_payments_receipt_number", table_name="customer_payments")
    op.drop_index("ix_customer_payments_order_id", table_name="customer_payments")
    op.drop_table("customer_payments")
    op.drop_index("ix_customer_delivery_lines_delivery_id", table_name="customer_delivery_lines")
    op.drop_table("customer_delivery_lines")
    op.drop_index("ix_customer_deliveries_delivery_number", table_name="customer_deliveries")
    op.drop_index("ix_customer_deliveries_order_id", table_name="customer_deliveries")
    op.drop_table("customer_deliveries")
    op.drop_index("ix_customer_order_lines_order_id", table_name="customer_order_lines")
    op.drop_table("customer_order_lines")
    op.drop_index("ix_customer_orders_order_number", table_name="customer_orders")
    op.drop_index("ix_customer_orders_customer_id", table_name="customer_orders")
    op.drop_table("customer_orders")
