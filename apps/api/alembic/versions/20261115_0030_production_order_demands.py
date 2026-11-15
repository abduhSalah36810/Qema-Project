"""Production order demands for customer order aggregation (Phase 4).

Revision ID: 20261115_0030
Revises: 20261115_0029
Create Date: 2026-11-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0030"
down_revision: Union[str, Sequence[str], None] = "20261115_0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "production_order_demands",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("production_order_id", sa.String(36), sa.ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("customer_order_line_id", sa.String(36), sa.ForeignKey("customer_order_lines.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("customer_order_id", sa.String(36), sa.ForeignKey("customer_orders.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("products.id"), nullable=False, index=True),
        sa.Column("variant_id", sa.String(36), sa.ForeignKey("product_variants.id"), nullable=False, index=True),
        sa.Column("allocated_quantity", sa.Float, nullable=False),
        sa.Column("fulfilled_quantity", sa.Float, nullable=False, server_default="0"),
        sa.Column("notes", sa.Text, nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("allocated_quantity > 0", name="ck_production_order_demand_allocated_positive"),
        sa.CheckConstraint("fulfilled_quantity >= 0", name="ck_production_order_demand_fulfilled_nonnegative"),
    )
    op.create_index(
        "ix_production_order_demands_order_line",
        "production_order_demands",
        ["production_order_id", "customer_order_line_id"],
        unique=True,
    )
    op.create_index(
        "ix_production_order_demands_customer",
        "production_order_demands",
        ["customer_id", "customer_order_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_production_order_demands_customer", table_name="production_order_demands")
    op.drop_index("ix_production_order_demands_order_line", table_name="production_order_demands")
    op.drop_table("production_order_demands")

