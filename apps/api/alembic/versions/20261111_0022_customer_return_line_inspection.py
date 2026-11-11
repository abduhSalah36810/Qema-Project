"""Customer returns: per-line condition and split inspection (resalable / damaged).

- customer_delivery_return_lines.condition: the condition seen when the goods came back
  (good / damaged / unknown). Informational; the stock decision is made at inspection.
- customer_delivery_return_lines.restocked_quantity / scrapped_quantity: the inspection
  result per line. Their sum equals the line quantity once inspected, 0 before.
- customer_delivery_returns.inspected_by / inspected_at / inspection_notes: who decided and when.
- disposition gains the value 'partially_restocked' for mixed results.

Existing inspected returns are backfilled from their whole-document disposition, so history
keeps its meaning. No stock or journal rows are touched.

Revision ID: 20261111_0022
Revises: 20261109_0021
Create Date: 2026-11-11
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261111_0022"
down_revision: Union[str, Sequence[str], None] = "20261109_0021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "customer_delivery_return_lines",
        sa.Column("condition", sa.String(length=32), nullable=False, server_default="unknown"),
    )
    op.add_column(
        "customer_delivery_return_lines",
        sa.Column("restocked_quantity", sa.Numeric(12, 3), nullable=False, server_default="0"),
    )
    op.add_column(
        "customer_delivery_return_lines",
        sa.Column("scrapped_quantity", sa.Numeric(12, 3), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "ck_customer_return_lines_condition",
        "customer_delivery_return_lines",
        "condition in ('good', 'damaged', 'unknown')",
    )
    op.create_check_constraint(
        "ck_customer_return_lines_inspection_qty",
        "customer_delivery_return_lines",
        "restocked_quantity >= 0 AND scrapped_quantity >= 0 AND restocked_quantity + scrapped_quantity <= quantity",
    )
    op.drop_constraint("ck_customer_delivery_returns_disposition", "customer_delivery_returns", type_="check")
    op.create_check_constraint(
        "ck_customer_delivery_returns_disposition",
        "customer_delivery_returns",
        "disposition in ('pending_inspection', 'restocked', 'scrapped', 'partially_restocked')",
    )
    op.add_column("customer_delivery_returns", sa.Column("inspected_by", sa.String(length=64), nullable=True))
    op.add_column("customer_delivery_returns", sa.Column("inspected_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "customer_delivery_returns",
        sa.Column("inspection_notes", sa.Text(), nullable=False, server_default=""),
    )

    # الحفاظ على معنى المرتجعات المفحوصة سابقاً بقرار واحد للمستند كله
    op.execute(
        """
        UPDATE customer_delivery_return_lines AS l
        SET restocked_quantity = l.quantity
        FROM customer_delivery_returns AS r
        WHERE r.id = l.return_id AND r.disposition = 'restocked'
        """
    )
    op.execute(
        """
        UPDATE customer_delivery_return_lines AS l
        SET scrapped_quantity = l.quantity
        FROM customer_delivery_returns AS r
        WHERE r.id = l.return_id AND r.disposition = 'scrapped'
        """
    )


def downgrade() -> None:
    # المرتجعات المختلطة لا يمثلها القيد القديم؛ تُرفض العودة بدلاً من تغيير معناها بصمت
    op.execute(
        """
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM customer_delivery_returns WHERE disposition = 'partially_restocked') THEN
            RAISE EXCEPTION 'partially_restocked returns exist; downgrade would lose their meaning';
          END IF;
        END $$;
        """
    )
    op.drop_constraint("ck_customer_delivery_returns_disposition", "customer_delivery_returns", type_="check")
    op.create_check_constraint(
        "ck_customer_delivery_returns_disposition",
        "customer_delivery_returns",
        "disposition in ('pending_inspection', 'restocked', 'scrapped')",
    )
    op.drop_column("customer_delivery_returns", "inspection_notes")
    op.drop_column("customer_delivery_returns", "inspected_at")
    op.drop_column("customer_delivery_returns", "inspected_by")
    op.drop_constraint("ck_customer_return_lines_inspection_qty", "customer_delivery_return_lines", type_="check")
    op.drop_constraint("ck_customer_return_lines_condition", "customer_delivery_return_lines", type_="check")
    op.drop_column("customer_delivery_return_lines", "scrapped_quantity")
    op.drop_column("customer_delivery_return_lines", "restocked_quantity")
    op.drop_column("customer_delivery_return_lines", "condition")
