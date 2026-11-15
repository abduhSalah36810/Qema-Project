"""Add expense_category to cash_documents and seed 5210, 5220, 5410 expense accounts.

Revision ID: 20261112_0025
Revises: 20261112_0024
Create Date: 2026-11-12
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261112_0025"
down_revision: Union[str, Sequence[str], None] = "20261112_0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add expense_category to cash_documents
    op.add_column("cash_documents", sa.Column("expense_category", sa.String(64), nullable=True))

    # 2. Seed distinct expense sub-accounts into accounts
    sub_accounts = [
        {"id": str(uuid.uuid4()), "code": "5210", "name_ar": "أجور عمال التشغيل والإنتاج المباشرة", "account_type": "expense", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "5220", "name_ar": "هالك إنتاج وفروق جرد وتشغيل", "account_type": "expense", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "5410", "name_ar": "مرتبات ومكافآت الإدارة والخدمات", "account_type": "expense", "is_active": True},
    ]
    for acc in sub_accounts:
        op.execute(
            sa.text(
                f"""
                INSERT INTO accounts (id, code, name_ar, account_type, is_active, created_at)
                VALUES ('{acc["id"]}', '{acc["code"]}', '{acc["name_ar"]}', '{acc["account_type"]}', TRUE, NOW())
                ON CONFLICT (code) DO NOTHING;
                """
            )
        )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DELETE FROM journal_entry_lines WHERE account_id IN (
                SELECT id FROM accounts WHERE code IN ('5210', '5220', '5410')
            );
            DELETE FROM accounts WHERE code IN ('5210', '5220', '5410');
            """
        )
    )
    op.drop_column("cash_documents", "expense_category")

