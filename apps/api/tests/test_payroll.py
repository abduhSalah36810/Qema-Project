"""اختبارات وحدة كشوف المرتبات."""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.db.base  # noqa: F401


def _uid():
    return str(uuid.uuid4())


def _make_employee(base_salary=3000.0):
    emp = MagicMock()
    emp.id = _uid()
    emp.code = f"EMP-{uuid.uuid4().hex[:4].upper()}"
    emp.name = "أحمد علي"
    emp.department = "الإنتاج"
    emp.job_title = "عامل"
    emp.base_salary = Decimal(str(base_salary))
    emp.status = "active"
    emp.hire_date = datetime(2024, 1, 1, tzinfo=timezone.utc)
    return emp


def _make_period(status="draft"):
    from datetime import date
    p = MagicMock()
    p.id = _uid()
    p.period_name = "أكتوبر 2026"
    p.start_date = date(2026, 10, 1)
    p.end_date = date(2026, 10, 31)
    p.status = status
    return p


def _make_treasury(balance=50000.0):
    acc = MagicMock()
    acc.id = _uid()
    acc.account_type = "treasury"
    acc.is_active = True
    return acc, Decimal(str(balance))


@pytest.mark.asyncio
async def test_create_employee_duplicate_code_raises_409():
    """لا يُقبل نفس كود الموظف مرتين."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.payroll import create_employee
    from app.modules.production.payroll_schemas import EmployeeCreate

    db = AsyncMock()
    db.scalar = AsyncMock(return_value=_uid())  # existing employee

    user = MagicMock()
    user.id = _uid()

    payload = EmployeeCreate(
        code="EMP-001", name="محمد", department="الإنتاج",
        job_title="عامل", base_salary=Decimal("2500"),
    )
    with pytest.raises(HTTPException) as exc:
        await create_employee(data=payload, current_user=user, db=db)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_create_employee_success():
    """إنشاء موظف جديد بنجاح."""
    from app.api.v1.endpoints.payroll import create_employee
    from app.modules.production.payroll_schemas import EmployeeCreate

    mock_emp = _make_employee(2800)

    db = AsyncMock()
    db.scalar = AsyncMock(return_value=None)  # no duplicate
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.refresh = AsyncMock(side_effect=lambda obj: None)

    user = MagicMock()
    user.id = _uid()

    payload = EmployeeCreate(
        code="EMP-NEW", name="فاطمة", department="القص",
        job_title="قاصة", base_salary=Decimal("2800"),
    )

    with patch("app.api.v1.endpoints.payroll.Employee") as MockEmp:
        with patch("app.api.v1.endpoints.payroll.select") as mock_select:
            mock_select.return_value = MagicMock()  # avoid real SQLAlchemy select
            db.scalar = AsyncMock(return_value=None)
            MockEmp.return_value = mock_emp
            result = await create_employee(data=payload, current_user=user, db=db)
    assert result is not None


@pytest.mark.asyncio
async def test_disburse_payroll_insufficient_treasury_raises_409():
    """يجب رفض الصرف إذا كان رصيد الخزينة أقل من إجمالي الرواتب."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.payroll import disburse_period_payroll

    period = _make_period(status="draft")
    treasury, treasury_balance = _make_treasury(balance=100.0)  # رصيد صغير جداً

    run1 = MagicMock()
    run1.net_amount = Decimal("5000")
    run1.id = _uid()

    db = AsyncMock()
    call_count = 0

    async def mock_get(model, pk):
        return period

    async def mock_scalar(stmt):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return treasury  # treasury account
        return Decimal("100.0")  # treasury balance — insufficient

    db.get = AsyncMock(side_effect=mock_get)
    db.scalar = AsyncMock(side_effect=mock_scalar)
    db.scalars = AsyncMock()
    db.scalars.return_value.all = MagicMock(return_value=[run1])

    user = MagicMock()
    user.id = _uid()

    with pytest.raises(HTTPException) as exc:
        await disburse_period_payroll(period_id=period.id, current_user=user, db=db)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_calculate_period_already_paid_raises_409():
    """لا يمكن إعادة حساب فترة تم صرفها."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.payroll import calculate_period_payroll

    period = _make_period(status="paid")

    db = AsyncMock()
    db.get = AsyncMock(return_value=period)

    user = MagicMock()
    user.id = _uid()

    with pytest.raises(HTTPException) as exc:
        await calculate_period_payroll(period_id=period.id, current_user=user, db=db)
    assert exc.value.status_code == 409
