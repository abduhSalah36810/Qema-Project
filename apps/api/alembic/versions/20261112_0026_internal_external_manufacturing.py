"""Internal and External Manufacturing, Customer Material Tracking, and Costing (Phase 6).

Revision ID: 20261112_0026
Revises: 20261112_0025
Create Date: 2026-11-12
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261112_0026"
down_revision: Union[str, Sequence[str], None] = "20261112_0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Production Orders: manufacturing type, costing method, waste & overhead ──
    op.add_column("production_orders", sa.Column("manufacturing_type", sa.String(32), nullable=False, server_default="internal"))
    op.add_column("production_orders", sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=True))
    op.add_column("production_orders", sa.Column("labor_costing_method", sa.String(32), nullable=False, server_default="piece_based"))
    op.add_column("production_orders", sa.Column("labor_rate", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("labor_hours", sa.Numeric(10, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("allowed_waste_pct", sa.Numeric(6, 2), nullable=False, server_default="1.50"))
    op.add_column("production_orders", sa.Column("actual_waste_pct", sa.Numeric(6, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("excess_waste_qty", sa.Numeric(14, 3), nullable=False, server_default="0.000"))
    op.add_column("production_orders", sa.Column("excess_waste_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("overhead_allocation_basis", sa.String(32), nullable=True))
    op.add_column("production_orders", sa.Column("allocated_overhead_rate", sa.Numeric(14, 2), nullable=False, server_default="0.00"))

    op.create_check_constraint("ck_production_orders_mfg_type", "production_orders", "manufacturing_type IN ('internal', 'external')")
    op.create_check_constraint("ck_production_orders_labor_method", "production_orders", "labor_costing_method IN ('piece_based', 'time_based')")

    # ── 2. Production Order Materials: ownership, billing & actual quantities ──
    op.add_column("production_order_materials", sa.Column("supplied_by", sa.String(32), nullable=False, server_default="factory"))
    op.add_column("production_order_materials", sa.Column("commercial_treatment", sa.String(32), nullable=False, server_default="included_in_service_fee"))
    op.add_column("production_order_materials", sa.Column("actual_consumed_quantity", sa.Numeric(14, 3), nullable=False, server_default="0.000"))
    op.add_column("production_order_materials", sa.Column("actual_waste_quantity", sa.Numeric(14, 3), nullable=False, server_default="0.000"))
    op.add_column("production_order_materials", sa.Column("actual_returned_quantity", sa.Numeric(14, 3), nullable=False, server_default="0.000"))

    op.create_check_constraint("ck_pom_supplied_by", "production_order_materials", "supplied_by IN ('factory', 'customer')")
    op.create_check_constraint("ck_pom_commercial_treatment", "production_order_materials", "commercial_treatment IN ('included_in_service_fee', 'billed_separately')")

    # ── 3. Customer Material Receipts (سند استلام خامات عميل) ──
    op.create_table(
        "customer_material_receipts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("receipt_number", sa.String(64), unique=True, index=True, nullable=False),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=False, index=True),
        sa.Column("received_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_by", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="received"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # ── 4. Customer Material Receipt Lines ──
    op.create_table(
        "customer_material_receipt_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("receipt_id", sa.String(36), sa.ForeignKey("customer_material_receipts.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False, index=True),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("quantity_received", sa.Numeric(14, 3), nullable=False),
        sa.Column("quantity_consumed", sa.Numeric(14, 3), nullable=False, server_default="0.000"),
        sa.Column("quantity_wasted", sa.Numeric(14, 3), nullable=False, server_default="0.000"),
        sa.Column("quantity_returned", sa.Numeric(14, 3), nullable=False, server_default="0.000"),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("production_orders.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("unit_cost_estimate", sa.Numeric(14, 4), nullable=False, server_default="0.0000"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
    )

    # ── 5. Customer Material Returns (سند إرجاع خامات عميل) ──
    op.create_table(
        "customer_material_returns",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("return_number", sa.String(64), unique=True, index=True, nullable=False),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=False, index=True),
        sa.Column("receipt_line_id", sa.String(36), sa.ForeignKey("customer_material_receipt_lines.id"), nullable=False, index=True),
        sa.Column("quantity", sa.Numeric(14, 3), nullable=False),
        sa.Column("returned_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("returned_by", sa.String(64), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("customer_material_returns")
    op.drop_table("customer_material_receipt_lines")
    op.drop_table("customer_material_receipts")

    op.drop_constraint("ck_pom_commercial_treatment", "production_order_materials", type_="check")
    op.drop_constraint("ck_pom_supplied_by", "production_order_materials", type_="check")
    op.drop_column("production_order_materials", "actual_returned_quantity")
    op.drop_column("production_order_materials", "actual_waste_quantity")
    op.drop_column("production_order_materials", "actual_consumed_quantity")
    op.drop_column("production_order_materials", "commercial_treatment")
    op.drop_column("production_order_materials", "supplied_by")

    op.drop_constraint("ck_production_orders_labor_method", "production_orders", type_="check")
    op.drop_constraint("ck_production_orders_mfg_type", "production_orders", type_="check")
    op.drop_column("production_orders", "allocated_overhead_rate")
    op.drop_column("production_orders", "overhead_allocation_basis")
    op.drop_column("production_orders", "excess_waste_cost")
    op.drop_column("production_orders", "excess_waste_qty")
    op.drop_column("production_orders", "actual_waste_pct")
    op.drop_column("production_orders", "allowed_waste_pct")
    op.drop_column("production_orders", "labor_hours")
    op.drop_column("production_orders", "labor_rate")
    op.drop_column("production_orders", "labor_costing_method")
    op.drop_column("production_orders", "customer_id")
    op.drop_column("production_orders", "manufacturing_type")
