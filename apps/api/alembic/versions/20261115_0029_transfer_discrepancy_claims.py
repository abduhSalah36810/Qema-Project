"""Transfer discrepancy claims between production and warehouse (Phase 3).

Revision ID: 20261115_0029
Revises: 20261115_0028
Create Date: 2026-11-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0029"
down_revision: Union[str, Sequence[str], None] = "20261115_0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "transfer_discrepancy_claims",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("claim_number", sa.String(64), unique=True, index=True, nullable=False),
        sa.Column("transfer_id", sa.String(36), sa.ForeignKey("warehouse_transfers.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("transfer_line_id", sa.String(36), sa.ForeignKey("warehouse_transfer_lines.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False, index=True),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("dispatched_quantity", sa.Float, nullable=False),
        sa.Column("received_quantity", sa.Float, nullable=False),
        sa.Column("discrepancy_quantity", sa.Float, nullable=False),
        sa.Column("unit_cost", sa.Numeric(14, 4), nullable=False, server_default="0.0000"),
        sa.Column("total_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("status", sa.String(32), default="pending_investigation", nullable=False, index=True),
        sa.Column("claimed_by", sa.String(64), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("claim_notes", sa.Text, default="", nullable=False),
        sa.Column("resolved_by", sa.String(64), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolution_notes", sa.Text, default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status in ('pending_investigation', 'accepted_transit_loss', 'accepted_measurement_error', 'rejected_under_carrier_liability')",
            name="ck_transfer_discrepancy_claim_status",
        ),
    )
    op.create_index(
        "ix_transfer_discrepancy_claims_order_status",
        "transfer_discrepancy_claims",
        ["order_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_transfer_discrepancy_claims_order_status", table_name="transfer_discrepancy_claims")
    op.drop_table("transfer_discrepancy_claims")

