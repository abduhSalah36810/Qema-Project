"""Add production defect and repair tracking records.

Revision ID: 20261030_0004
Revises: 20261024_0003
Create Date: 2026-10-30
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0004"
down_revision: Union[str, Sequence[str], None] = "20261024_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "production_defects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("defect_number", sa.String(64), nullable=False, unique=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("production_orders.id"), nullable=False),
        sa.Column("stage_name", sa.String(32), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("affected_quantity", sa.Float(), nullable=False),
        sa.Column("responsible", sa.String(128), nullable=False),
        sa.Column("repair_action", sa.Text(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="reported"),
        sa.Column("repair_cost_description", sa.Text(), nullable=False, server_default=""),
        sa.Column("reported_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("affected_quantity > 0", name="ck_production_defects_quantity_positive"),
        sa.CheckConstraint(
            "stage_name in ('cutting', 'finishing', 'snap_installation', 'ironing', 'packing')",
            name="ck_production_defects_stage",
        ),
        sa.CheckConstraint(
            "status in ('reported', 'repair_in_progress', 'repaired', 'closed')",
            name="ck_production_defects_status",
        ),
    )
    op.create_index("ix_production_defects_defect_number", "production_defects", ["defect_number"])
    op.create_index("ix_production_defects_order_id", "production_defects", ["order_id"])


def downgrade() -> None:
    op.drop_index("ix_production_defects_order_id", table_name="production_defects")
    op.drop_index("ix_production_defects_defect_number", table_name="production_defects")
    op.drop_table("production_defects")
