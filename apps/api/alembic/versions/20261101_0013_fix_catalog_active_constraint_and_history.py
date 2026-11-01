"""Fix catalog active constraint, add order material snapshot, and clarify legacy grandfathering.

Revision ID: 20261101_0013
Revises: 20261101_0012
Create Date: 2026-11-01
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261101_0013"
down_revision: Union[str, Sequence[str], None] = "20261101_0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Fix catalog_items is_active check constraint ───────────────────────
    # Drop incorrect constraint: (is_active = true OR approval_status = 'approved')
    op.drop_constraint("ck_catalog_items_active_consistency", "catalog_items", type_="check")

    # Ensure all draft/pending_review/rejected items are strictly inactive
    op.execute(
        sa.text(
            """
            UPDATE catalog_items
            SET is_active = FALSE
            WHERE approval_status != 'approved';
            """
        )
    )

    # Apply the correct constraint: NOT is_active OR approval_status = 'approved'
    # Meaning: an item can only be active (is_active = true) if approval_status = 'approved'.
    # Draft, pending_review, and rejected items can NEVER be active.
    op.create_check_constraint(
        "ck_catalog_items_active_consistency",
        "catalog_items",
        "NOT is_active OR approval_status = 'approved'",
    )

    # ── 2. Add item_name_snapshot to production_order_materials ───────────────
    op.add_column(
        "production_order_materials",
        sa.Column("item_name_snapshot", sa.String(128), nullable=True),
    )

    # Backfill item_name_snapshot for any existing order materials
    op.execute(
        sa.text(
            """
            UPDATE production_order_materials pom
            SET item_name_snapshot = ci.name_ar
            FROM catalog_items ci
            WHERE pom.item_id = ci.id AND pom.item_name_snapshot IS NULL;
            """
        )
    )

    # ── 3. Append-only audit clarification for the 7 grandfathered items ─────
    # Clarify that operational grandfathering is NOT factory specification approval
    op.execute(
        sa.text(
            """
            INSERT INTO catalog_approval_history (
                id,
                item_id,
                revision_id,
                event_type,
                from_status,
                to_status,
                actor_id,
                actor_role,
                reason,
                before_snapshot,
                after_snapshot,
                created_at
            )
            SELECT
                gen_random_uuid()::text,
                id,
                NULL,
                'legacy_clarification',
                'approved',
                'approved',
                'system_migration_0013',
                'system_admin',
                'توضيح تدقيقي معماري: اعتماد الصنف تشغيلي استمراري فقط لحماية حركة الرصيد القائم (Operational Grandfathering) ولا يُعد اعتماداً فعلياً لمواصفات الصنف من إدارة المصنع. تظل المواصفات الفنية معلقة بانتظار اعتماد المصنع في OPEN_DECISIONS_AR.md.',
                '{}'::jsonb,
                '{}'::jsonb,
                NOW()
            FROM catalog_items
            WHERE code LIKE 'LED_%' AND approval_status = 'approved';
            """
        )
    )


def downgrade() -> None:
    # ── 1. Revert check constraint ───────────────────────────────────────────
    op.drop_constraint("ck_catalog_items_active_consistency", "catalog_items", type_="check")
    op.create_check_constraint(
        "ck_catalog_items_active_consistency",
        "catalog_items",
        "is_active = TRUE OR approval_status = 'approved'",
    )

    # ── 2. Drop item_name_snapshot column ────────────────────────────────────
    op.drop_column("production_order_materials", "item_name_snapshot")
