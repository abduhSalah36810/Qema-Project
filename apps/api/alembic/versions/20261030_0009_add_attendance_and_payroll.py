"""Add employee attendance tracking and detailed payroll run breakdown."""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0009"
down_revision: Union[str, Sequence[str], None] = "20261030_0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. تحديث جدول الموظفين
    op.add_column("employees", sa.Column("base_salary", sa.Float(), nullable=False, server_default="0.0"))

    # 2. إنشاء جدول الحضور والغياب اليدوي
    op.create_table(
        "employee_attendance",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("employee_id", sa.String(36), sa.ForeignKey("employees.id"), nullable=False),
        sa.Column("attendance_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("delay_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("overtime_hours", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("recorded_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("status in ('present', 'late', 'absent_permitted', 'absent_unpermitted')", name="ck_attendance_status"),
    )
    op.create_index("ix_employee_attendance_employee_id", "employee_attendance", ["employee_id"])
    op.create_index("ix_employee_attendance_date", "employee_attendance", ["attendance_date"])

    # 3. تحديث جدول كشف الرواتب
    op.add_column("payroll_runs", sa.Column("base_amount", sa.Float(), nullable=False, server_default="0.0"))
    op.add_column("payroll_runs", sa.Column("overtime_amount", sa.Float(), nullable=False, server_default="0.0"))
    op.add_column("payroll_runs", sa.Column("bonus_amount", sa.Float(), nullable=False, server_default="0.0"))
    op.add_column("payroll_runs", sa.Column("deductions_amount", sa.Float(), nullable=False, server_default="0.0"))
    op.add_column("payroll_runs", sa.Column("advances_amount", sa.Float(), nullable=False, server_default="0.0"))
    op.add_column("payroll_runs", sa.Column("status", sa.String(32), nullable=False, server_default="draft"))
    op.add_column("payroll_runs", sa.Column("cash_document_id", sa.String(36), sa.ForeignKey("cash_documents.id"), nullable=True))
    op.create_index("ix_payroll_runs_period_id", "payroll_runs", ["period_id"])
    op.create_index("ix_payroll_runs_employee_id", "payroll_runs", ["employee_id"])


def downgrade() -> None:
    op.drop_index("ix_payroll_runs_employee_id", table_name="payroll_runs")
    op.drop_index("ix_payroll_runs_period_id", table_name="payroll_runs")
    op.drop_column("payroll_runs", "cash_document_id")
    op.drop_column("payroll_runs", "status")
    op.drop_column("payroll_runs", "advances_amount")
    op.drop_column("payroll_runs", "deductions_amount")
    op.drop_column("payroll_runs", "bonus_amount")
    op.drop_column("payroll_runs", "overtime_amount")
    op.drop_column("payroll_runs", "base_amount")

    op.drop_index("ix_employee_attendance_date", table_name="employee_attendance")
    op.drop_index("ix_employee_attendance_employee_id", table_name="employee_attendance")
    op.drop_table("employee_attendance")

    op.drop_column("employees", "base_salary")

