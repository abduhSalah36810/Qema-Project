"""Manufacturing Costing Refinements, Agreed Service Price, and Waste Settlement (Phase 6 / T6).

Revision ID: 20261115_0032
Revises: 20261115_0031
Create Date: 2026-11-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0032"
down_revision: Union[str, Sequence[str], None] = "20261115_0031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Production Orders: agreed service price, waste settlement, costing metadata ──
    op.add_column(
        "production_orders",
        sa.Column("agreed_service_price", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
    )
    op.add_column(
        "production_orders",
        sa.Column(
            "excess_waste_settlement_status",
            sa.String(32),
            nullable=False,
            server_default="pending_review",
        ),
    )
    op.add_column(
        "production_orders",
        sa.Column("cost_calculated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "production_orders",
        sa.Column("cost_calculated_by", sa.String(64), nullable=True),
    )

    op.create_check_constraint(
        "ck_production_orders_waste_settlement",
        "production_orders",
        "excess_waste_settlement_status IN ('pending_review', 'approved_by_factory', 'claimed_from_customer', 'waived')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_production_orders_waste_settlement", "production_orders", type_="check")
    op.drop_column("production_orders", "cost_calculated_by")
    op.drop_column("production_orders", "cost_calculated_at")
    op.drop_column("production_orders", "excess_waste_settlement_status")
    op.drop_column("production_orders", "agreed_service_price")
