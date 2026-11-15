"""Opening Balances Architecture, Clearing Account 3900, and Subledger Isolation (Phase B).

Revision ID: 20261115_0033
Revises: 20261115_0032
Create Date: 2026-11-15
"""
import uuid
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "20261115_0033"
down_revision: Union[str, Sequence[str], None] = "20261115_0032"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Seed Account 3900 in Chart of Accounts ─────────────────────────────
    accounts_table = sa.table(
        "accounts",
        sa.column("id", sa.String),
        sa.column("code", sa.String),
        sa.column("name_ar", sa.String),
        sa.column("account_type", sa.String),
        sa.column("is_active", sa.Boolean),
    )
    op.execute(
        "INSERT INTO accounts (id, code, name_ar, account_type, is_active) "
        f"VALUES ('{uuid.uuid4()}', '3900', 'أرصدة افتتاحية معلقة وسيطة', 'equity', true) "
        "ON CONFLICT (code) DO NOTHING"
    )

    # ── 2. Stocktake: is_opening on session, unit_cost on line ────────────────
    op.add_column(
        "stocktake_sessions",
        sa.Column("is_opening", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "stocktake_lines",
        sa.Column("unit_cost", sa.Numeric(14, 4), nullable=True),
    )

    # ── 3. Supplier Invoices: opening balance & approval tracking ─────────────
    op.add_column(
        "supplier_invoices",
        sa.Column("is_opening", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "supplier_invoices",
        sa.Column("is_advance", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "supplier_invoices",
        sa.Column("approved_by", sa.String(64), nullable=True),
    )
    op.add_column(
        "supplier_invoices",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ── 4. Customer Orders: opening balance & approval tracking ───────────────
    op.add_column(
        "customer_orders",
        sa.Column("is_opening", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "customer_orders",
        sa.Column("is_advance", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "customer_orders",
        sa.Column("opening_amount", sa.Numeric(14, 2), nullable=True),
    )
    op.add_column(
        "customer_orders",
        sa.Column("original_order_number", sa.String(128), nullable=True),
    )
    op.add_column(
        "customer_orders",
        sa.Column("approved_by", sa.String(64), nullable=True),
    )
    op.add_column(
        "customer_orders",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("customer_orders", "approved_at")
    op.drop_column("customer_orders", "approved_by")
    op.drop_column("customer_orders", "original_order_number")
    op.drop_column("customer_orders", "opening_amount")
    op.drop_column("customer_orders", "is_advance")
    op.drop_column("customer_orders", "is_opening")

    op.drop_column("supplier_invoices", "approved_at")
    op.drop_column("supplier_invoices", "approved_by")
    op.drop_column("supplier_invoices", "is_advance")
    op.drop_column("supplier_invoices", "is_opening")

    op.drop_column("stocktake_lines", "unit_cost")
    op.drop_column("stocktake_sessions", "is_opening")

    op.execute("DELETE FROM accounts WHERE code = '3900'")
