"""Allow stopping (deactivating) models and sizes from the master data screens.

- products.is_active / product_variants.is_active (default true for all existing rows).
  A stopped model or size cannot be used in new production orders; existing orders, stock
  movements and BOM versions remain unchanged. Rows are never deleted.

Revision ID: 20261109_0021
Revises: 20261109_0020
Create Date: 2026-11-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261109_0021"
down_revision: Union[str, Sequence[str], None] = "20261109_0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("products", sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")))
    op.add_column("product_variants", sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")))


def downgrade() -> None:
    op.drop_column("product_variants", "is_active")
    op.drop_column("products", "is_active")
