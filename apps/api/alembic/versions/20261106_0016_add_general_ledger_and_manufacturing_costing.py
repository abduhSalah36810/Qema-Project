"""Add general ledger, chart of accounts, manufacturing costing fields, and custody settlements.

Revision ID: 20261106_0016
Revises: 20261102_0015
Create Date: 2026-11-06
"""
from typing import Sequence, Union
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "20261106_0016"
down_revision: Union[str, Sequence[str], None] = "20261102_0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Create accounts (Chart of Accounts) ──────────────────────────────────
    op.create_table(
        "accounts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(32), unique=True, nullable=False, index=True),
        sa.Column("name_ar", sa.String(128), nullable=False),
        sa.Column("account_type", sa.String(32), nullable=False),  # asset, liability, equity, revenue, expense
        sa.Column("parent_id", sa.String(36), sa.ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.CheckConstraint("account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')", name="ck_accounts_type"),
    )

    # ── 2. Create journal_entries (General Ledger Header) ──────────────────────
    op.create_table(
        "journal_entries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entry_number", sa.String(64), unique=True, nullable=False, index=True),
        sa.Column("entry_date", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("source_doc_type", sa.String(64), nullable=False),
        sa.Column("source_doc_id", sa.String(64), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("status", sa.String(32), nullable=False, server_default="posted"),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reversed_entry_id", sa.String(36), sa.ForeignKey("journal_entries.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.CheckConstraint("status IN ('draft', 'submitted', 'pending_approval', 'approved', 'posted', 'reversed')", name="ck_journal_entries_status"),
    )
    op.create_index("ix_journal_entries_source", "journal_entries", ["source_doc_type", "source_doc_id"])

    # ── 3. Create journal_entry_lines (Debits and Credits) ─────────────────────
    op.create_table(
        "journal_entry_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("entry_id", sa.String(36), sa.ForeignKey("journal_entries.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("account_id", sa.String(36), sa.ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False, index=True),
        sa.Column("debit", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("credit", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint("debit >= 0", name="ck_journal_line_debit_positive"),
        sa.CheckConstraint("credit >= 0", name="ck_journal_line_credit_positive"),
        sa.CheckConstraint("(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)", name="ck_journal_line_either_debit_or_credit"),
    )

    # ── 4. Add costing fields to stock_ledger_entries ──────────────────────────
    op.add_column("stock_ledger_entries", sa.Column("unit_cost", sa.Numeric(14, 4), nullable=False, server_default="0.0000"))
    op.add_column("stock_ledger_entries", sa.Column("total_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))

    # ── 5. Add manufacturing costing fields to production_orders ───────────────
    op.add_column("production_orders", sa.Column("planned_material_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("actual_material_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("actual_labor_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("actual_overhead_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("total_actual_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("wip_balance", sa.Numeric(14, 2), nullable=False, server_default="0.00"))
    op.add_column("production_orders", sa.Column("unit_manufacturing_cost", sa.Numeric(14, 4), nullable=False, server_default="0.0000"))

    # ── 6. Add costing fields to production_order_materials ────────────────────
    op.add_column("production_order_materials", sa.Column("unit_cost", sa.Numeric(14, 4), nullable=False, server_default="0.0000"))
    op.add_column("production_order_materials", sa.Column("total_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"))

    # ── 7. Create custody_settlements table ────────────────────────────────────
    op.create_table(
        "custody_settlements",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("settlement_number", sa.String(64), unique=True, nullable=False, index=True),
        sa.Column("custody_account_id", sa.String(36), sa.ForeignKey("cash_accounts.id"), nullable=False, index=True),
        sa.Column("original_custody_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("approved_expenses_amount", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("returned_cash_amount", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("remaining_unsettled_amount", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.CheckConstraint("status IN ('pending', 'approved', 'rejected')", name="ck_custody_settlement_status"),
    )

    # ── 8. Seed Core Chart of Accounts ────────────────────────────────────────
    accounts_table = sa.table(
        "accounts",
        sa.column("id", sa.String),
        sa.column("code", sa.String),
        sa.column("name_ar", sa.String),
        sa.column("account_type", sa.String),
        sa.column("is_active", sa.Boolean),
    )

    seed_accounts = [
        {"id": str(uuid.uuid4()), "code": "1010", "name_ar": "الخزنة المركزية الرئيسية", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "1020", "name_ar": "عهد نقدية للموظفين والمصروفات", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "1030", "name_ar": "حساب بنك المصنع", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "1100", "name_ar": "العملاء وحسابات المدينين", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "1210", "name_ar": "مخزون خامات ومستلزمات الإنتاج", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "1220", "name_ar": "إنتاج تحت التشغيل (WIP)", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "1230", "name_ar": "مخزون المنتجات التامة", "account_type": "asset", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "2100", "name_ar": "الموردون وحسابات الدائنين", "account_type": "liability", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "3000", "name_ar": "رأس المال ورصيد افتتاحي", "account_type": "equity", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "4100", "name_ar": "إيرادات مبيعات منتجات تامة", "account_type": "revenue", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "4200", "name_ar": "إيرادات تشغيلية وخدمية أخرى", "account_type": "revenue", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "5100", "name_ar": "تكلفة البضاعة المباعة (COGS)", "account_type": "expense", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "5200", "name_ar": "أجور ومصروفات تصنيع مباشرة", "account_type": "expense", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "5300", "name_ar": "مصروفات صيانة وتشغيل المكان", "account_type": "expense", "is_active": True},
        {"id": str(uuid.uuid4()), "code": "5400", "name_ar": "مصروفات إدارية وعمومية", "account_type": "expense", "is_active": True},
    ]
    op.bulk_insert(accounts_table, seed_accounts)


def downgrade() -> None:
    op.drop_table("custody_settlements")
    op.drop_column("production_order_materials", "total_cost")
    op.drop_column("production_order_materials", "unit_cost")
    op.drop_column("production_orders", "unit_manufacturing_cost")
    op.drop_column("production_orders", "wip_balance")
    op.drop_column("production_orders", "total_actual_cost")
    op.drop_column("production_orders", "actual_overhead_cost")
    op.drop_column("production_orders", "actual_labor_cost")
    op.drop_column("production_orders", "actual_material_cost")
    op.drop_column("production_orders", "planned_material_cost")
    op.drop_column("stock_ledger_entries", "total_cost")
    op.drop_column("stock_ledger_entries", "unit_cost")
    op.drop_table("journal_entry_lines")
    op.drop_table("journal_entries")
    op.drop_table("accounts")
