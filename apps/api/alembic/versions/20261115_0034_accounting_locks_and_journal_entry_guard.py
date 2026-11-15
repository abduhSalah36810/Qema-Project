"""Accounting Locks Table and Journal Entry Append-Only Core Protection.

Revision ID: 20261115_0034
Revises: 20261115_0033
Create Date: 2026-11-15
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0034"
down_revision: Union[str, Sequence[str], None] = "20261115_0033"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Create accounting_locks table ──────────────────────────────────────
    op.create_table(
        "accounting_locks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("lock_type", sa.String(64), nullable=False),
        sa.Column("is_locked", sa.Boolean(), nullable=False),
        sa.Column("action", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("performed_by", sa.String(64), nullable=False),
        sa.Column("performed_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=False),
        sa.Column("requested_by", sa.String(64), nullable=True),
        sa.Column("unlock_request_id", sa.String(36), nullable=True),
    )
    op.create_index(
        "ix_accounting_locks_lock_type_performed_at",
        "accounting_locks",
        ["lock_type", "performed_at"],
    )

    # ── 2. Create PostgreSQL core columns protection trigger on journal_entries ─
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION trg_journal_entries_protect_core()
            RETURNS TRIGGER AS $$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'قيود اليومية غير قابلة للحذف نهائياً (journal_entries is append-only)';
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF NEW.entry_number <> OLD.entry_number OR
                       NEW.entry_date <> OLD.entry_date OR
                       NEW.source_doc_type <> OLD.source_doc_type OR
                       NEW.source_doc_id <> OLD.source_doc_id OR
                       NEW.description <> OLD.description THEN
                        RAISE EXCEPTION 'لا يجوز تعديل البيانات الجوهرية لقيد اليومية (entry_number, entry_date, source_doc_type, source_doc_id, description)؛ استخدم قيد عكسي للتصحيح (journal_entries core columns are immutable)';
                    END IF;
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
            CREATE TRIGGER trg_journal_entries_protect_core
            BEFORE UPDATE OR DELETE ON journal_entries
            FOR EACH ROW
            EXECUTE FUNCTION trg_journal_entries_protect_core();
            """
        )
    )


def downgrade() -> None:
    # ── 1. Drop trigger and function on journal_entries ────────────────────────
    op.execute(sa.text("DROP TRIGGER IF EXISTS trg_journal_entries_protect_core ON journal_entries;"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS trg_journal_entries_protect_core();"))

    # ── 2. Drop accounting_locks table ────────────────────────────────────────
    op.drop_index("ix_accounting_locks_lock_type_performed_at", table_name="accounting_locks")
    op.drop_table("accounting_locks")
