"""Operational integrity: partial supplier receipts, line discounts, treasury-approved
customer collections, per-item finished-goods receipts, production material
reconciliation, bucket-aware stocktake lines, explicit payroll amounts, and
append-only cash/journal ledgers.

Revision ID: 20261108_0017
Revises: 20261106_0016
Create Date: 2026-11-08
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261108_0017"
down_revision: Union[str, Sequence[str], None] = "20261106_0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Supplier invoices: line discounts, partial receipts, receipt documents ──
    op.add_column(
        "supplier_invoice_lines",
        sa.Column("discount_amount", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
    )
    op.create_check_constraint(
        "ck_supplier_invoice_line_discount_nonnegative", "supplier_invoice_lines", "discount_amount >= 0"
    )
    op.drop_constraint("ck_supplier_invoice_status", "supplier_invoices", type_="check")
    op.create_check_constraint(
        "ck_supplier_invoice_status",
        "supplier_invoices",
        "status in ('awaiting_receipt', 'partially_received', 'received', 'cancelled')",
    )
    op.create_table(
        "supplier_receipts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("receipt_number", sa.String(64), nullable=False, unique=True),
        sa.Column("invoice_id", sa.String(36), sa.ForeignKey("supplier_invoices.id"), nullable=False, index=True),
        sa.Column("received_by", sa.String(64), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("total_cost", sa.Numeric(14, 2), nullable=False, server_default="0.00"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
    )

    # ── 2. Customer collections go through treasury approval ─────────────────
    op.add_column(
        "customer_payments",
        sa.Column("status", sa.String(32), nullable=False, server_default="approved"),
    )
    op.add_column(
        "customer_payments",
        sa.Column("cash_document_id", sa.String(36), sa.ForeignKey("cash_documents.id"), nullable=True),
    )
    op.create_check_constraint(
        "ck_customer_payments_status", "customer_payments", "status in ('pending', 'approved', 'rejected')"
    )

    # ── 3. Finished goods are received per production order item ──────────────
    op.add_column(
        "production_order_items",
        sa.Column("received_quantity", sa.Float(), nullable=False, server_default="0"),
    )
    op.add_column(
        "production_order_items",
        sa.Column("rejected_quantity", sa.Float(), nullable=False, server_default="0"),
    )

    # ── 4. Production material reconciliation documents ──────────────────────
    op.create_table(
        "production_material_reconciliations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("reconciliation_number", sa.String(64), nullable=False, unique=True),
        sa.Column("order_id", sa.String(36), sa.ForeignKey("production_orders.id"), nullable=False, index=True),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
    )
    op.create_table(
        "production_material_reconciliation_lines",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "reconciliation_id", sa.String(36),
            sa.ForeignKey("production_material_reconciliations.id"), nullable=False, index=True,
        ),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("catalog_items.id"), nullable=False),
        sa.Column("unit_id", sa.String(36), sa.ForeignKey("units.id"), nullable=False),
        sa.Column("consumed_quantity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("returned_quantity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("scrapped_quantity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint(
            "consumed_quantity >= 0 AND returned_quantity >= 0 AND scrapped_quantity >= 0",
            name="ck_material_reconciliation_line_nonnegative",
        ),
    )

    # ── 5. Stocktake lines are counted per ownership bucket ───────────────────
    op.add_column("stocktake_lines", sa.Column("bucket_reference", sa.String(128), nullable=True))

    # ── 6. Payroll: exact money and one run per employee per period ──────────
    op.alter_column("employees", "base_salary", type_=sa.Numeric(14, 2), postgresql_using="round(base_salary::numeric, 2)")
    for column in ("base_amount", "overtime_amount", "bonus_amount", "deductions_amount", "advances_amount", "net_amount"):
        op.alter_column("payroll_runs", column, type_=sa.Numeric(14, 2), postgresql_using=f"round({column}::numeric, 2)")
    op.create_unique_constraint("uq_payroll_runs_period_employee", "payroll_runs", ["period_id", "employee_id"])
    op.create_check_constraint(
        "ck_pay_periods_status", "pay_periods", "status in ('draft', 'calculated', 'submitted', 'paid', 'closed')"
    )
    op.create_check_constraint("ck_pay_periods_dates", "pay_periods", "end_date > start_date")

    # ── 7. Cash ledger and journal lines are append-only ─────────────────────
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION trg_financial_ledger_append_only()
            RETURNS TRIGGER AS $$
            BEGIN
                RAISE EXCEPTION 'السجلات المالية المعتمدة غير قابلة للتعديل أو المسح؛ استخدم مستند عكس (% is append-only)', TG_TABLE_NAME;
            END;
            $$ LANGUAGE plpgsql;
            """
        )
    )
    for table in ("cash_ledger_entries", "journal_entry_lines"):
        op.execute(
            sa.text(
                f"""
                CREATE TRIGGER trg_{table}_append_only
                BEFORE UPDATE OR DELETE ON {table}
                FOR EACH ROW
                EXECUTE FUNCTION trg_financial_ledger_append_only();
                """
            )
        )


def downgrade() -> None:
    for table in ("cash_ledger_entries", "journal_entry_lines"):
        op.execute(sa.text(f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table};"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS trg_financial_ledger_append_only();"))

    op.drop_constraint("ck_pay_periods_dates", "pay_periods", type_="check")
    op.drop_constraint("ck_pay_periods_status", "pay_periods", type_="check")
    op.drop_constraint("uq_payroll_runs_period_employee", "payroll_runs", type_="unique")
    for column in ("base_amount", "overtime_amount", "bonus_amount", "deductions_amount", "advances_amount", "net_amount"):
        op.alter_column("payroll_runs", column, type_=sa.Float())
    op.alter_column("employees", "base_salary", type_=sa.Float())

    op.drop_column("stocktake_lines", "bucket_reference")
    op.drop_table("production_material_reconciliation_lines")
    op.drop_table("production_material_reconciliations")
    op.drop_column("production_order_items", "rejected_quantity")
    op.drop_column("production_order_items", "received_quantity")

    op.drop_constraint("ck_customer_payments_status", "customer_payments", type_="check")
    op.drop_column("customer_payments", "cash_document_id")
    op.drop_column("customer_payments", "status")

    op.drop_table("supplier_receipts")
    op.drop_constraint("ck_supplier_invoice_status", "supplier_invoices", type_="check")
    op.create_check_constraint(
        "ck_supplier_invoice_status", "supplier_invoices", "status in ('awaiting_receipt', 'received', 'cancelled')"
    )
    op.drop_constraint("ck_supplier_invoice_line_discount_nonnegative", "supplier_invoice_lines", type_="check")
    op.drop_column("supplier_invoice_lines", "discount_amount")
