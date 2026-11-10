"""Per-size Bill of Materials and frozen BOM snapshot inside production orders.

- production_templates.variant_id: a template bound to one product variant (size / spec) is that
  variant's BOM, versioned through the existing production_template_versions (reference quantity = 1 piece).
  Existing product-level templates keep variant_id NULL and are untouched.
- production_order_item_materials: per order line, a frozen copy of the BOM used at creation
  (item, unit, names, quantity per piece, total). Later BOM edits never change existing orders.

Revision ID: 20261109_0020
Revises: 20261109_0019
Create Date: 2026-11-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261109_0020"
down_revision: Union[str, Sequence[str], None] = "20261109_0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "production_templates",
        sa.Column("variant_id", sa.String(36), sa.ForeignKey("product_variants.id"), nullable=True),
    )
    op.create_index("ix_production_templates_variant_id", "production_templates", ["variant_id"])

    op.create_table(
        "production_order_item_materials",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_item_id", sa.String(36), sa.ForeignKey("production_order_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("template_version_id", sa.String(36), sa.ForeignKey("production_template_versions.id"), nullable=False),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("item_name_snapshot", sa.String(128), nullable=False),
        sa.Column("unit_name_snapshot", sa.String(64), nullable=False, server_default=""),
        sa.Column("quantity_per_piece", sa.Numeric(14, 4), nullable=False),
        sa.Column("total_quantity", sa.Numeric(14, 4), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("quantity_per_piece > 0", name="ck_order_item_materials_qty_positive"),
    )
    op.create_index("ix_production_order_item_materials_order_item_id", "production_order_item_materials", ["order_item_id"])


def downgrade() -> None:
    op.drop_index("ix_production_order_item_materials_order_item_id", table_name="production_order_item_materials")
    op.drop_table("production_order_item_materials")
    op.drop_index("ix_production_templates_variant_id", table_name="production_templates")
    op.drop_column("production_templates", "variant_id")
