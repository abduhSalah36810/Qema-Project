"""Add treasury, petty cash, cash documents, and append-only cash ledger."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0005"
down_revision: Union[str, Sequence[str], None] = "20261030_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TREASURY_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    op.create_table(
        "cash_accounts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("account_number", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("account_type", sa.String(32), nullable=False),
        sa.Column("parent_account_id", sa.String(36), sa.ForeignKey("cash_accounts.id"), nullable=True),
        sa.Column("business_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("account_type in ('treasury', 'petty_cash')", name="ck_cash_accounts_type"),
    )
    op.create_table(
        "cash_documents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_number", sa.String(64), nullable=False, unique=True),
        sa.Column("document_type", sa.String(32), nullable=False),
        sa.Column("from_account_id", sa.String(36), sa.ForeignKey("cash_accounts.id"), nullable=True),
        sa.Column("to_account_id", sa.String(36), sa.ForeignKey("cash_accounts.id"), nullable=True),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_system", sa.String(64), nullable=True),
        sa.Column("source_reference", sa.String(128), nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_by", sa.String(64), nullable=True),
        sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("document_type in ('income', 'expense', 'transfer')", name="ck_cash_documents_type"),
        sa.CheckConstraint("status in ('pending', 'approved', 'rejected', 'reversed')", name="ck_cash_documents_status"),
        sa.CheckConstraint("amount > 0", name="ck_cash_documents_amount_positive"),
        sa.UniqueConstraint("source_system", "source_reference", name="uq_cash_document_source_reference"),
    )
    op.create_index("ix_cash_documents_created_at", "cash_documents", ["created_at"])
    op.create_table(
        "cash_ledger_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("document_id", sa.String(36), sa.ForeignKey("cash_documents.id"), nullable=False),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("cash_accounts.id"), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("document_id", "account_id", name="uq_cash_ledger_document_account"),
    )
    op.create_index("ix_cash_ledger_account_id", "cash_ledger_entries", ["account_id"])
    op.bulk_insert(
        sa.table("cash_accounts", sa.column("id", sa.String), sa.column("account_number", sa.String),
                 sa.column("name", sa.String), sa.column("account_type", sa.String),
                 sa.column("is_active", sa.Boolean), sa.column("created_by", sa.String)),
        [{"id": TREASURY_ID, "account_number": "TREASURY-MAIN", "name": "الخزنة الرئيسية",
          "account_type": "treasury", "is_active": True, "created_by": "system"}],
    )


def downgrade() -> None:
    op.drop_index("ix_cash_ledger_account_id", table_name="cash_ledger_entries")
    op.drop_table("cash_ledger_entries")
    op.drop_index("ix_cash_documents_created_at", table_name="cash_documents")
    op.drop_table("cash_documents")
    op.drop_table("cash_accounts")
