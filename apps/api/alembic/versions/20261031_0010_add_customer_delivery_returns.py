"""Add customer delivery returns and return lines.

Revision ID: 20261031_0010
Revises: 20261030_0009
Create Date: 2026-10-31
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261031_0010"
down_revision: Union[str, Sequence[str], None] = "20261030_0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "customer_delivery_returns",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("return_number", sa.String(64), nullable=False, unique=True),
        sa.Column("delivery_id", sa.String(36), sa.ForeignKey("customer_deliveries.id"), nullable=False),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("customer_orders.id"), nullable=False),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("returned_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("received_by", sa.String(128), nullable=False, server_default=""),
        sa.Column("disposition", sa.String(32), nullable=False, server_default="pending_inspection"),
        sa.Column("idempotency_key", sa.String(64), nullable=True, unique=True),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.CheckConstraint("disposition in ('pending_inspection', 'restocked', 'scrapped')", name="ck_customer_delivery_returns_disposition"),
    )
    op.create_index("ix_customer_delivery_returns_return_number", "customer_delivery_returns", ["return_number"])
    op.create_index("ix_customer_delivery_returns_delivery_id", "customer_delivery_returns", ["delivery_id"])
    op.create_index("ix_customer_delivery_returns_order_id", "customer_delivery_returns", ["order_id"])
    op.create_index("ix_customer_delivery_returns_customer_id", "customer_delivery_returns", ["customer_id"])

    op.create_table(
        "customer_delivery_return_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("return_id", sa.String(36), sa.ForeignKey("customer_delivery_returns.id", ondelete="CASCADE"), nullable=False),
        sa.Column("delivery_line_id", sa.String(36), sa.ForeignKey("customer_delivery_lines.id"), nullable=False),
        sa.Column("order_line_id", sa.String(36), sa.ForeignKey("customer_order_lines.id"), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 3), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("quantity > 0", name="ck_customer_delivery_return_lines_quantity_positive"),
    )
    op.create_index("ix_customer_delivery_return_lines_return_id", "customer_delivery_return_lines", ["return_id"])
    op.create_index("ix_customer_delivery_return_lines_delivery_line_id", "customer_delivery_return_lines", ["delivery_line_id"])


def downgrade() -> None:
    op.drop_index("ix_customer_delivery_return_lines_delivery_line_id", table_name="customer_delivery_return_lines")
    op.drop_index("ix_customer_delivery_return_lines_return_id", table_name="customer_delivery_return_lines")
    op.drop_table("customer_delivery_return_lines")

    op.drop_index("ix_customer_delivery_returns_customer_id", table_name="customer_delivery_returns")
    op.drop_index("ix_customer_delivery_returns_order_id", table_name="customer_delivery_returns")
    op.drop_index("ix_customer_delivery_returns_delivery_id", table_name="customer_delivery_returns")
    op.drop_index("ix_customer_delivery_returns_return_number", table_name="customer_delivery_returns")
    op.drop_table("customer_delivery_returns")

