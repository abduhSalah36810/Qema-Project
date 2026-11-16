"""Allow opening_balance in cash_documents document_type.

Revision ID: 20261116_0036
Revises: 20261115_0035
Create Date: 2026-11-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261116_0036"
down_revision: Union[str, Sequence[str], None] = "20261115_0035"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("ck_cash_documents_type", "cash_documents", type_="check")
    op.create_check_constraint(
        "ck_cash_documents_type",
        "cash_documents",
        "document_type in ('income', 'expense', 'transfer', 'opening_balance')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_cash_documents_type", "cash_documents", type_="check")
    op.create_check_constraint(
        "ck_cash_documents_type",
        "cash_documents",
        "document_type in ('income', 'expense', 'transfer')",
    )
