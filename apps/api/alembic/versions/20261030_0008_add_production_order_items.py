"""Add production order items for multi-product orders and fabric specifications."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0008"
down_revision: Union[str, Sequence[str], None] = "20261030_0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "production_order_items",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("production_orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("product_id", sa.String(36), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("variant_id", sa.String(36), sa.ForeignKey("product_variants.id"), nullable=False),
        sa.Column("product_type", sa.String(32), nullable=False),
        sa.Column("customer_id", sa.String(36), sa.ForeignKey("customers.id"), nullable=True),
        sa.Column("template_version_id", sa.String(36), sa.ForeignKey("production_template_versions.id"), nullable=True),
        sa.Column("target_quantity", sa.Float(), nullable=False),
        sa.Column("season", sa.String(32), nullable=False),
        sa.Column("fabric_area", sa.String(128), nullable=False, server_default=""),
        sa.Column("fabric_name", sa.String(128), nullable=False, server_default=""),
        sa.Column("fabric_color", sa.String(64), nullable=False, server_default=""),
        sa.Column("fabric_weight", sa.String(64), nullable=False, server_default=""),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("product_type in ('factory_brand', 'private_label')", name="ck_production_order_item_type"),
        sa.CheckConstraint("target_quantity > 0", name="ck_production_order_item_target_positive"),
    )
    op.create_index("ix_production_order_items_order_id", "production_order_items", ["order_id"])


def downgrade() -> None:
    op.drop_index("ix_production_order_items_order_id", table_name="production_order_items")
    op.drop_table("production_order_items")

