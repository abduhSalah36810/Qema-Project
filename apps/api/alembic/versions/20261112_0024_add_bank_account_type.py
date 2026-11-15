"""Add bank account type to cash_accounts and seed canonical bank account.

Revision ID: 20261112_0024
Revises: 20261111_0023
Create Date: 2026-11-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261112_0024"
down_revision: Union[str, Sequence[str], None] = "20261111_0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CANONICAL_BANK_ID = "00000000-0000-0000-0000-000000000002"


def upgrade() -> None:
    # 1. Update check constraint on cash_accounts to allow ('treasury', 'petty_cash', 'bank')
    op.drop_constraint("ck_cash_accounts_type", "cash_accounts", type_="check")
    op.create_check_constraint(
        "ck_cash_accounts_type",
        "cash_accounts",
        "account_type in ('treasury', 'petty_cash', 'bank')",
    )

    # 2. Seed canonical factory bank account if not exists
    op.execute(
        sa.text(
            f"""
            INSERT INTO cash_accounts (id, account_number, name, account_type, is_active, created_by, created_at)
            VALUES ('{CANONICAL_BANK_ID}', 'BANK-MAIN', 'حساب بنك المصنع', 'bank', TRUE, 'system', NOW())
            ON CONFLICT (id) DO NOTHING;
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            f"""
            DELETE FROM cash_ledger_entries WHERE account_id = '{CANONICAL_BANK_ID}';
            DELETE FROM cash_accounts WHERE id = '{CANONICAL_BANK_ID}';
            """
        )
    )
    op.drop_constraint("ck_cash_accounts_type", "cash_accounts", type_="check")
    op.create_check_constraint(
        "ck_cash_accounts_type",
        "cash_accounts",
        "account_type in ('treasury', 'petty_cash')",
    )

