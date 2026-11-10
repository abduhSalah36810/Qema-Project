"""Add catalog governance, approval status, revisions, and append-only audit history.

Revision ID: 20261101_0012
Revises: 20261031_0011
Create Date: 2026-11-01
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "20261101_0012"
down_revision: Union[str, Sequence[str], None] = "20261031_0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Add governance columns to catalog_items ───────────────────────────
    op.add_column(
        "catalog_items",
        sa.Column(
            "approval_status",
            sa.String(32),
            nullable=False,
            server_default="draft",
        ),
    )
    op.add_column(
        "catalog_items",
        sa.Column("rejection_reason", sa.Text(), nullable=True),
    )
    op.add_column(
        "catalog_items",
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "catalog_items",
        sa.Column("submitted_by", sa.String(64), nullable=True),
    )
    op.add_column(
        "catalog_items",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "catalog_items",
        sa.Column("approved_by", sa.String(64), nullable=True),
    )

    # ── 2. Create catalog_item_revisions table ───────────────────────────────
    op.create_table(
        "catalog_item_revisions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "item_id",
            sa.String(36),
            sa.ForeignKey("catalog_items.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("revision_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "status",
            sa.String(32),
            nullable=False,
            server_default="pending_review",
        ),
        sa.Column(
            "proposed_changes",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("change_summary", sa.Text(), nullable=False),
        sa.Column(
            "base_fingerprint",
            sa.String(64),
            nullable=True,
            server_default="",
        ),
        sa.Column("submitted_by", sa.String(64), nullable=False),
        sa.Column(
            "submitted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("reviewed_by", sa.String(64), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    # Partial unique index: at most one open revision per catalog item
    op.create_index(
        "uq_catalog_item_single_open_revision",
        "catalog_item_revisions",
        ["item_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending_review'"),
    )

    # ── 3. Create catalog_approval_history table ─────────────────────────────
    op.create_table(
        "catalog_approval_history",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "item_id",
            sa.String(36),
            sa.ForeignKey("catalog_items.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("revision_id", sa.String(36), nullable=True),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("from_status", sa.String(32), nullable=True),
        sa.Column("to_status", sa.String(32), nullable=False),
        sa.Column("actor_id", sa.String(64), nullable=False),
        sa.Column("actor_role", sa.String(64), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "before_snapshot",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "after_snapshot",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            index=True,
        ),
    )

    # ── 4. Trigger for true append-only audit log protection ───────────────────
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION trg_catalog_approval_history_append_only()
            RETURNS TRIGGER AS $$
            BEGIN
                RAISE EXCEPTION 'سجل التدقيق غير قابل للتعديل أو المسح (catalog_approval_history is strictly append-only)';
            END;
            $$ LANGUAGE plpgsql;
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_catalog_approval_history_prevent_update_delete
            BEFORE UPDATE OR DELETE ON catalog_approval_history
            FOR EACH ROW
            EXECUTE FUNCTION trg_catalog_approval_history_append_only();
            """
        )
    )

    # ── 5. Deterministic Legacy Backfill (73 Existing Items) ───────────────────
    # A. 15 Finished Goods (FG-VAR-* / finished_garment): set to approved
    op.execute(
        sa.text(
            """
            UPDATE catalog_items
            SET approval_status = 'approved',
                approved_at = created_at,
                approved_by = 'system_migration_0012'
            WHERE code LIKE 'FG-VAR-%' OR item_type = 'finished_garment';
            """
        )
    )

    # B. 7 Legacy Transacted Raw Materials with stock movements: approved via grandfathering
    op.execute(
        sa.text(
            """
            UPDATE catalog_items
            SET approval_status = 'approved',
                approved_at = created_at,
                approved_by = 'system_migration_0012_grandfathered'
            WHERE id IN (SELECT DISTINCT item_id FROM stock_ledger_entries)
              AND code NOT LIKE 'FG-VAR-%';
            """
        )
    )

    # C. Record explicit historical audit trail entries for the 7 grandfathered items and FG
    op.execute(
        sa.text(
            """
            INSERT INTO catalog_approval_history (
                id, item_id, revision_id, event_type, from_status, to_status,
                actor_id, actor_role, reason, before_snapshot, after_snapshot, created_at
            )
            SELECT
                gen_random_uuid()::text,
                id,
                NULL,
                'legacy_backfill',
                'draft',
                'approved',
                'system_migration_0012',
                'system_admin',
                CASE
                    WHEN code LIKE 'FG-VAR-%' THEN 'اعتماد نظامي للمنتجات التامة الموحدة (Finished Goods Backfill)'
                    ELSE 'اعتماد استمراري للأصناف التاريخية ذات الرصيد القائم (Legacy Grandfathering - Phase 3.5 Backfill)'
                END,
                '{}'::jsonb,
                jsonb_build_object(
                    'code', code,
                    'name_ar', name_ar,
                    'item_type', item_type,
                    'unit_id', unit_id,
                    'category_id', category_id,
                    'classification_status', classification_status,
                    'attributes', attributes
                ),
                NOW()
            FROM catalog_items
            WHERE approval_status = 'approved';
            """
        )
    )

    # D. All remaining 51 non-transacted items (18 fabrics + 33 raw_materials) remain 'draft'
    op.execute(
        sa.text(
            """
            UPDATE catalog_items
            SET approval_status = 'draft'
            WHERE approval_status IS NULL OR approval_status = '';
            """
        )
    )

    # ── 6. Check Constraints ──────────────────────────────────────────────────
    op.create_check_constraint(
        "ck_catalog_items_approval_status",
        "catalog_items",
        "approval_status IN ('draft', 'pending_review', 'approved', 'rejected')",
    )

    op.create_check_constraint(
        "ck_catalog_items_active_consistency",
        "catalog_items",
        "is_active = TRUE OR approval_status = 'approved'",
    )

    op.create_check_constraint(
        "ck_catalog_item_revisions_status",
        "catalog_item_revisions",
        "status IN ('pending_review', 'applied', 'rejected', 'cancelled')",
    )


def downgrade() -> None:
    # ── 1. Drop check constraints ─────────────────────────────────────────────
    op.drop_constraint("ck_catalog_item_revisions_status", "catalog_item_revisions", type_="check")
    op.drop_constraint("ck_catalog_items_active_consistency", "catalog_items", type_="check")
    op.drop_constraint("ck_catalog_items_approval_status", "catalog_items", type_="check")

    # ── 2. Drop append-only trigger and trigger function ───────────────────────
    op.execute(
        sa.text(
            "DROP TRIGGER IF EXISTS trg_catalog_approval_history_prevent_update_delete ON catalog_approval_history;"
        )
    )
    op.execute(
        sa.text(
            "DROP FUNCTION IF EXISTS trg_catalog_approval_history_append_only();"
        )
    )

    # ── 3. Drop tables and indexes ────────────────────────────────────────────
    op.drop_table("catalog_approval_history")
    op.drop_index("uq_catalog_item_single_open_revision", table_name="catalog_item_revisions")
    op.drop_table("catalog_item_revisions")

    # ── 4. Drop columns from catalog_items ────────────────────────────────────
    op.drop_column("catalog_items", "approved_by")
    op.drop_column("catalog_items", "approved_at")
    op.drop_column("catalog_items", "submitted_by")
    op.drop_column("catalog_items", "submitted_at")
    op.drop_column("catalog_items", "rejection_reason")
    op.drop_column("catalog_items", "approval_status")
