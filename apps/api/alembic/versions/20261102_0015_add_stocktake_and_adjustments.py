"""Add stocktake sessions, lines, count history, and audit logs.

Revision ID: 20261102_0015
Revises: 20261101_0014
Create Date: 2026-11-02
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "20261102_0015"
down_revision: Union[str, Sequence[str], None] = "20261101_0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Create stocktake_sessions table ─────────────────────────────────────
    op.create_table(
        "stocktake_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("session_number", sa.String(64), nullable=False),
        sa.Column("warehouse_id", sa.String(36), sa.ForeignKey("warehouses.id"), nullable=False),
        sa.Column("scope_type", sa.String(32), nullable=False, server_default="full_warehouse"),
        sa.Column("status", sa.String(32), nullable=False, server_default="draft"),
        sa.Column("description", sa.String(255), nullable=False, server_default=""),
        sa.Column("counting_date", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("snapshot_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("submitted_by", sa.String(64), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by", sa.String(64), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_notes", sa.Text(), nullable=True),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approval_notes", sa.Text(), nullable=True),
        sa.Column("posted_by", sa.String(64), nullable=True),
        sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by", sa.String(64), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancellation_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index(
        "uq_stocktake_session_number",
        "stocktake_sessions",
        ["session_number"],
        unique=True,
    )
    op.create_index(
        "ix_stocktake_sessions_warehouse_status",
        "stocktake_sessions",
        ["warehouse_id", "status"],
    )
    op.create_index(
        "ix_stocktake_sessions_status",
        "stocktake_sessions",
        ["status"],
    )

    # ── 2. Create stocktake_lines table ───────────────────────────────────────
    op.create_table(
        "stocktake_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("stocktake_id", sa.String(36), sa.ForeignKey("stocktake_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("book_quantity", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("counted_quantity", sa.Float(), nullable=True),
        sa.Column("variance", sa.Float(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="uncounted"),
        sa.Column("counter_id", sa.String(64), nullable=True),
        sa.Column("counted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index(
        "uq_stocktake_lines_session_item",
        "stocktake_lines",
        ["stocktake_id", "item_id"],
        unique=True,
    )
    op.create_index(
        "ix_stocktake_lines_item_id",
        "stocktake_lines",
        ["item_id"],
    )

    # ── 3. Create stocktake_count_history table ───────────────────────────────
    op.create_table(
        "stocktake_count_history",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("line_id", sa.String(36), sa.ForeignKey("stocktake_lines.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stocktake_id", sa.String(36), sa.ForeignKey("stocktake_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("counted_quantity", sa.Float(), nullable=False),
        sa.Column("previous_quantity", sa.Float(), nullable=True),
        sa.Column("counter_id", sa.String(64), nullable=False),
        sa.Column("counted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("reason", sa.String(255), nullable=False, server_default="initial_count"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index(
        "ix_stocktake_count_history_line_id",
        "stocktake_count_history",
        ["line_id"],
    )
    op.create_index(
        "ix_stocktake_count_history_stocktake_id",
        "stocktake_count_history",
        ["stocktake_id"],
    )

    # ── 4. Create stocktake_audit_logs table ──────────────────────────────────
    op.create_table(
        "stocktake_audit_logs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("stocktake_id", sa.String(36), sa.ForeignKey("stocktake_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(64), nullable=False),
        sa.Column("actor_role", sa.String(64), nullable=False, server_default=""),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
    )
    op.create_index(
        "ix_stocktake_audit_logs_stocktake_id",
        "stocktake_audit_logs",
        ["stocktake_id"],
    )
    op.create_index(
        "ix_stocktake_audit_logs_timestamp",
        "stocktake_audit_logs",
        ["timestamp"],
    )


def downgrade() -> None:
    op.drop_table("stocktake_audit_logs")
    op.drop_table("stocktake_count_history")
    op.drop_table("stocktake_lines")
    op.drop_table("stocktake_sessions")

