"""Allow multiple stocktake lines per item across ownership/order buckets.

20261108_0017 added stocktake_lines.bucket_reference and stocktake_service
creates one line per (item_id, bucket_reference), e.g. factory_brand vs
private_label:{customer_id} in finished_goods or order:{id} in work_in_progress.
However 20261102_0015 kept uq_stocktake_lines_session_item on (stocktake_id, item_id),
causing UniqueViolationError whenever an item exists in more than one bucket.

Revision ID: 20261111_0023
Revises: 20261111_0022
Create Date: 2026-11-11
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20261111_0023"
down_revision: Union[str, Sequence[str], None] = "20261111_0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index("uq_stocktake_lines_session_item", table_name="stocktake_lines")
    op.create_index(
        "uq_stocktake_lines_session_item_bucket",
        "stocktake_lines",
        ["stocktake_id", "item_id", sa.text("COALESCE(bucket_reference, '')")],
        unique=True,
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1
            FROM stocktake_lines
            GROUP BY stocktake_id, item_id
            HAVING COUNT(*) > 1
          ) THEN
            RAISE EXCEPTION 'multi-bucket stocktake lines exist; downgrade would violate unique index';
          END IF;
        END $$;
        """
    )
    op.drop_index("uq_stocktake_lines_session_item_bucket", table_name="stocktake_lines")
    op.create_index(
        "uq_stocktake_lines_session_item",
        "stocktake_lines",
        ["stocktake_id", "item_id"],
        unique=True,
    )

