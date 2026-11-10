"""Payroll pay types (monthly / daily wage) and itemized incentives & deductions.

- employees: pay_type (monthly|daily) and daily_rate.
- payroll_runs: snapshot of pay type, rate, work days and employee name at preparation time,
  so later edits to the employee file never change earlier payroll sheets.
- payroll_run_items: incentive / deduction lines entered explicitly per run, storing the
  calculation method, inputs and resulting amount.

Revision ID: 20261109_0019
Revises: 20261109_0018
Create Date: 2026-11-09
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261109_0019"
down_revision: Union[str, Sequence[str], None] = "20261109_0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("employees", sa.Column("pay_type", sa.String(16), nullable=False, server_default="monthly"))
    op.add_column("employees", sa.Column("daily_rate", sa.Numeric(14, 2), nullable=True))
    op.create_check_constraint("ck_employees_pay_type", "employees", "pay_type in ('monthly', 'daily')")

    op.add_column("payroll_runs", sa.Column("pay_type", sa.String(16), nullable=False, server_default="monthly"))
    op.add_column("payroll_runs", sa.Column("rate_amount", sa.Numeric(14, 2), nullable=False, server_default="0"))
    op.add_column("payroll_runs", sa.Column("work_days", sa.Numeric(6, 2), nullable=True))
    op.add_column("payroll_runs", sa.Column("employee_name_snapshot", sa.String(128), nullable=True))
    # الكشوف السابقة: لقطة الأجر = الأساسي المسجل فيها (لم تكن هناك يومية قبل هذا الترحيل)
    op.execute("UPDATE payroll_runs SET rate_amount = base_amount")
    op.execute(
        "UPDATE payroll_runs r SET employee_name_snapshot = e.name FROM employees e WHERE e.id = r.employee_id"
    )

    op.create_table(
        "payroll_run_items",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("payroll_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("label", sa.String(128), nullable=False),
        sa.Column("calc_method", sa.String(16), nullable=False),
        sa.Column("quantity", sa.Numeric(10, 2), nullable=True),
        sa.Column("value", sa.Numeric(14, 2), nullable=False),
        sa.Column("percent_base", sa.Numeric(14, 2), nullable=True),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("kind in ('incentive', 'deduction')", name="ck_payroll_items_kind"),
        sa.CheckConstraint("calc_method in ('fixed', 'percent', 'quantity')", name="ck_payroll_items_method"),
        sa.CheckConstraint("amount >= 0", name="ck_payroll_items_amount_nonnegative"),
    )
    op.create_index("ix_payroll_run_items_run_id", "payroll_run_items", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_payroll_run_items_run_id", table_name="payroll_run_items")
    op.drop_table("payroll_run_items")
    op.drop_column("payroll_runs", "employee_name_snapshot")
    op.drop_column("payroll_runs", "work_days")
    op.drop_column("payroll_runs", "rate_amount")
    op.drop_column("payroll_runs", "pay_type")
    op.drop_constraint("ck_employees_pay_type", "employees", type_="check")
    op.drop_column("employees", "daily_rate")
    op.drop_column("employees", "pay_type")
