"""Accounting Locks Append-Only Audit Log Protection Trigger.

Revision ID: 20261115_0035
Revises: 20261115_0034
Create Date: 2026-11-15
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0035"
down_revision: Union[str, Sequence[str], None] = "20261115_0034"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Create PostgreSQL append-only protection trigger on accounting_locks ─
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION trg_accounting_locks_prevent_update_delete()
            RETURNS TRIGGER AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'سجل تدقيق أقفال الحسابات غير قابل للحذف نهائياً (accounting_locks is append-only)';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    RAISE EXCEPTION 'سجل تدقيق أقفال الحسابات غير قابل للتعديل نهائياً (accounting_locks is append-only)';
                END IF;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_accounting_locks_prevent_update_delete
            BEFORE UPDATE OR DELETE ON accounting_locks
            FOR EACH ROW
            EXECUTE FUNCTION trg_accounting_locks_prevent_update_delete();
            """
        )
    )


def downgrade() -> None:
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_accounting_locks_prevent_update_delete ON accounting_locks;"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS trg_accounting_locks_prevent_update_delete();"))
