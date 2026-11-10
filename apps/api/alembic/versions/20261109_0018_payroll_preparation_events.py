"""Payroll preparation events: append-only record of who calculated, adjusted, or
submitted a pay period, so the treasury can refuse approval of a payroll
disbursement by anyone who prepared that payroll (maker-checker on the source).

Revision ID: 20261109_0018
Revises: 20261108_0017
Create Date: 2026-11-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261109_0018"
down_revision: Union[str, Sequence[str], None] = "20261108_0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pay_period_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("period_id", sa.String(36), sa.ForeignKey("pay_periods.id"), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("actor_id", sa.String(64), nullable=False),
        sa.Column("details", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint(
            "action in ('calculate', 'adjust', 'submit_for_disbursement')", name="ck_pay_period_events_action"
        ),
    )
    op.create_index("ix_pay_period_events_period_id", "pay_period_events", ["period_id"])

    # سجل تدقيق append-only: يمنع تعديل أو حذف أحداث إعداد الرواتب
    op.execute(
        """
        CREATE OR REPLACE FUNCTION pay_period_events_immutable() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'pay_period_events is append-only';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_pay_period_events_immutable
        BEFORE UPDATE OR DELETE ON pay_period_events
        FOR EACH ROW EXECUTE FUNCTION pay_period_events_immutable();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_pay_period_events_immutable ON pay_period_events")
    op.execute("DROP FUNCTION IF EXISTS pay_period_events_immutable()")
    op.drop_index("ix_pay_period_events_period_id", table_name="pay_period_events")
    op.drop_table("pay_period_events")
