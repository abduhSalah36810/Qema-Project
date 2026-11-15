"""Production Stage Timing, Working Calendar, Stage Skipping, and Bottlenecks (Phase 7).

Revision ID: 20261113_0027
Revises: 20261112_0026
Create Date: 2026-11-13
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261113_0027"
down_revision: Union[str, Sequence[str], None] = "20261112_0026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Production Stage Events: Timing, Skipping & Bottleneck tracking ──
    op.add_column("production_stage_events", sa.Column("started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("production_stage_events", sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("production_stage_events", sa.Column("expected_duration_minutes", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("production_stage_events", sa.Column("elapsed_minutes", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("production_stage_events", sa.Column("working_minutes", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("production_stage_events", sa.Column("is_working_time_provisional", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.add_column("production_stage_events", sa.Column("is_skipped", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("production_stage_events", sa.Column("skip_reason", sa.Text(), nullable=True))
    op.add_column("production_stage_events", sa.Column("delay_reason", sa.String(64), nullable=True))
    op.add_column("production_stage_events", sa.Column("delay_notes", sa.Text(), nullable=True))
    op.add_column("production_stage_events", sa.Column("is_bottleneck", sa.Boolean(), nullable=False, server_default=sa.false()))

    # ── 2. Factory Work Calendar Configuration Table ──
    op.create_table(
        "factory_calendar_configs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("shift_name", sa.String(128), nullable=False),
        sa.Column("shift_start_time", sa.String(8), nullable=False, server_default="08:00"),
        sa.Column("shift_end_time", sa.String(8), nullable=False, server_default="17:00"),
        sa.Column("working_days", sa.String(255), nullable=False, server_default="saturday,sunday,monday,tuesday,wednesday,thursday"),
        sa.Column("weekly_holidays", sa.String(255), nullable=False, server_default="friday"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_approved", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("factory_calendar_configs")
    op.drop_column("production_stage_events", "is_bottleneck")
    op.drop_column("production_stage_events", "delay_notes")
    op.drop_column("production_stage_events", "delay_reason")
    op.drop_column("production_stage_events", "skip_reason")
    op.drop_column("production_stage_events", "is_skipped")
    op.drop_column("production_stage_events", "is_working_time_provisional")
    op.drop_column("production_stage_events", "working_minutes")
    op.drop_column("production_stage_events", "elapsed_minutes")
    op.drop_column("production_stage_events", "expected_duration_minutes")
    op.drop_column("production_stage_events", "completed_at")
    op.drop_column("production_stage_events", "started_at")

