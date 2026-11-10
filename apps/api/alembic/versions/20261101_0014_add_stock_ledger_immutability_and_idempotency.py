"""Add stock ledger immutability trigger and idempotent requests table.

Revision ID: 20261101_0014
Revises: 20261101_0013
Create Date: 2026-11-01
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "20261101_0014"
down_revision: Union[str, Sequence[str], None] = "20261101_0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Create idempotent_requests table ────────────────────────────────────
    op.create_table(
        "idempotent_requests",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("user_id", sa.String(64), nullable=False),
        sa.Column("operation_type", sa.String(64), nullable=False),
        sa.Column("resource_id", sa.String(64), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="in_progress"),
        sa.Column("response_code", sa.Integer(), nullable=True),
        sa.Column("response_body", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "uq_idempotent_requests_op_key",
        "idempotent_requests",
        ["operation_type", "idempotency_key"],
        unique=True,
    )
    op.create_index(
        "ix_idempotent_requests_created_at",
        "idempotent_requests",
        ["created_at"],
    )

    # ── 2. Create PostgreSQL append-only trigger on stock_ledger_entries ───────
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION trg_stock_ledger_entries_append_only()
            RETURNS TRIGGER AS $$
            BEGIN
                RAISE EXCEPTION 'سجل حركات المخزون غير قابل للتعديل أو المسح (stock_ledger_entries is strictly append-only)';
            END;
            $$ LANGUAGE plpgsql;
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_stock_ledger_entries_prevent_update_delete
            BEFORE UPDATE OR DELETE ON stock_ledger_entries
            FOR EACH ROW
            EXECUTE FUNCTION trg_stock_ledger_entries_append_only();
            """
        )
    )


def downgrade() -> None:
    # ── 1. Drop trigger and function ──────────────────────────────────────────
    op.execute(
        sa.text("DROP TRIGGER IF EXISTS trg_stock_ledger_entries_prevent_update_delete ON stock_ledger_entries;")
    )
    op.execute(
        sa.text("DROP FUNCTION IF EXISTS trg_stock_ledger_entries_append_only();")
    )

    # ── 2. Drop idempotent_requests table ─────────────────────────────────────
    op.drop_index("ix_idempotent_requests_created_at", table_name="idempotent_requests")
    op.drop_index("uq_idempotent_requests_op_key", table_name="idempotent_requests")
    op.drop_table("idempotent_requests")
