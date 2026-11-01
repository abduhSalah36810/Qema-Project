import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import require_permission
from app.db.session import get_db
from app.modules.finance.models import CashAccount, CashDocument, CashLedgerEntry
from app.modules.production.models import (
    Employee,
    EmployeeAttendance,
    PayPeriod,
    PayrollRun,
    utc_now,
)
from app.modules.production.payroll_schemas import (
    AttendanceCreate,
    AttendanceRead,
    EmployeeCreate,
    EmployeeRead,
    EmployeeUpdate,
    PayPeriodCreate,
    PayPeriodRead,
    PayrollPeriodDetailRead,
    PayrollRunRead,
)

router = APIRouter(prefix="/payroll", tags=["payroll"])


# ─── 1. إدارة ملفات العاملين ────────────────────────────────────────────────

@router.get("/employees", response_model=List[EmployeeRead])
async def list_employees(
    department: Optional[str] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Employee).order_by(Employee.name)
    if department:
        stmt = stmt.where(Employee.department == department)
    if status_filter:
        stmt = stmt.where(Employee.status == status_filter)
    rows = (await db.scalars(stmt)).all()
    return [
        EmployeeRead(
            id=e.id, code=e.code, name=e.name, department=e.department,
            job_title=e.job_title, base_salary=e.base_salary, status=e.status,
            hire_date=e.hire_date,
        )
        for e in rows
    ]


@router.post("/employees", response_model=EmployeeRead, status_code=status.HTTP_201_CREATED)
async def create_employee(
    data: EmployeeCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.scalar(select(Employee.id).where(Employee.code == data.code.strip()))
    if existing:
        raise HTTPException(status_code=409, detail="كود الموظف مستخدم من قبل.")

    employee = Employee(
        id=str(uuid.uuid4()),
        code=data.code.strip(),
        name=data.name.strip(),
        department=data.department.strip(),
        job_title=data.job_title.strip(),
        base_salary=data.base_salary,
        status="active",
        hire_date=utc_now(),
    )
    db.add(employee)
    await db.commit()
    await db.refresh(employee)
    return EmployeeRead(
        id=employee.id, code=employee.code, name=employee.name, department=employee.department,
        job_title=employee.job_title, base_salary=employee.base_salary, status=employee.status,
        hire_date=employee.hire_date,
    )


@router.patch("/employees/{employee_id}", response_model=EmployeeRead)
async def update_employee(
    employee_id: str,
    data: EmployeeUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    employee = await db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود.")

    if data.name is not None:
        employee.name = data.name.strip()
    if data.department is not None:
        employee.department = data.department.strip()
    if data.job_title is not None:
        employee.job_title = data.job_title.strip()
    if data.base_salary is not None:
        employee.base_salary = data.base_salary
    if data.status is not None:
        employee.status = data.status

    await db.commit()
    await db.refresh(employee)
    return EmployeeRead(
        id=employee.id, code=employee.code, name=employee.name, department=employee.department,
        job_title=employee.job_title, base_salary=employee.base_salary, status=employee.status,
        hire_date=employee.hire_date,
    )


# ─── 2. سجل الحضور والغياب اليدوي ──────────────────────────────────────────

@router.get("/attendance", response_model=List[AttendanceRead])
async def list_attendance(
    employee_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(EmployeeAttendance).options(selectinload(EmployeeAttendance.employee)).order_by(EmployeeAttendance.attendance_date.desc())
    if employee_id:
        stmt = stmt.where(EmployeeAttendance.employee_id == employee_id)
    rows = (await db.scalars(stmt.limit(500))).all()
    return [
        AttendanceRead(
            id=r.id, employee_id=r.employee_id, employee_name=r.employee.name if r.employee else "",
            employee_code=r.employee.code if r.employee else "", attendance_date=r.attendance_date,
            status=r.status, delay_minutes=r.delay_minutes, overtime_hours=r.overtime_hours,
            notes=r.notes, recorded_by=r.recorded_by, created_at=r.created_at,
        )
        for r in rows
    ]


@router.post("/attendance", response_model=AttendanceRead, status_code=status.HTTP_201_CREATED)
async def record_attendance(
    data: AttendanceCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    employee = await db.get(Employee, data.employee_id)
    if not employee or employee.status != "active":
        raise HTTPException(status_code=404, detail="الموظف غير موجود أو غير نشط.")

    record = EmployeeAttendance(
        id=str(uuid.uuid4()),
        employee_id=employee.id,
        attendance_date=data.attendance_date,
        status=data.status,
        delay_minutes=data.delay_minutes,
        overtime_hours=data.overtime_hours,
        notes=data.notes.strip(),
        recorded_by=current_user.id,
        created_at=utc_now(),
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return AttendanceRead(
        id=record.id, employee_id=employee.id, employee_name=employee.name,
        employee_code=employee.code, attendance_date=record.attendance_date,
        status=record.status, delay_minutes=record.delay_minutes, overtime_hours=record.overtime_hours,
        notes=record.notes, recorded_by=record.recorded_by, created_at=record.created_at,
    )


# ─── 3. فترات وحساب كشوف المرتبات ──────────────────────────────────────────

@router.get("/periods", response_model=List[PayPeriodRead])
async def list_pay_periods(
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    periods = (await db.scalars(select(PayPeriod).order_by(PayPeriod.start_date.desc()))).all()
    output = []
    for p in periods:
        runs_stats = (await db.execute(
            select(func.count(PayrollRun.id), func.coalesce(func.sum(PayrollRun.net_amount), 0))
            .where(PayrollRun.period_id == p.id)
        )).first()
        count, total = runs_stats if runs_stats else (0, 0.0)
        output.append(PayPeriodRead(
            id=p.id, period_name=p.period_name, start_date=p.start_date,
            end_date=p.end_date, status=p.status, runs_count=int(count or 0),
            total_net_amount=float(total or 0.0),
        ))
    return output


@router.post("/periods", response_model=PayPeriodRead, status_code=status.HTTP_201_CREATED)
async def create_pay_period(
    data: PayPeriodCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    period = PayPeriod(
        id=str(uuid.uuid4()),
        period_name=data.period_name.strip(),
        start_date=data.start_date,
        end_date=data.end_date,
        status="draft",
    )
    db.add(period)
    await db.commit()
    await db.refresh(period)
    return PayPeriodRead(
        id=period.id, period_name=period.period_name, start_date=period.start_date,
        end_date=period.end_date, status=period.status, runs_count=0, total_net_amount=0.0,
    )


@router.post("/periods/{period_id}/calculate", response_model=PayrollPeriodDetailRead)
async def calculate_period_payroll(
    period_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    """احتساب كشف الرواتب للفترة الزمنية لجميع العاملين النشطين استناداً إلى الحضور وساعات الإضافي والأساسي."""
    period = await db.get(PayPeriod, period_id)
    if not period:
        raise HTTPException(status_code=404, detail="فترة الرواتب غير موجودة.")
    if period.status in ("paid", "closed"):
        raise HTTPException(status_code=409, detail="لا يمكن إعادة احتساب كشف فترة تم صرفها أو إغلاقها.")

    # جلب جميع العاملين النشطين
    employees = (await db.scalars(select(Employee).where(Employee.status == "active"))).all()

    # مسح الحسابات السابقة للمسودة إذا كانت draft
    existing_runs = (await db.scalars(select(PayrollRun).where(PayrollRun.period_id == period.id))).all()
    for run in existing_runs:
        await db.delete(run)
    await db.flush()

    # احتساب كل عامل
    for emp in employees:
        # جلب الحضور خلال الفترة
        attendances = (await db.scalars(
            select(EmployeeAttendance).where(
                EmployeeAttendance.employee_id == emp.id,
                EmployeeAttendance.attendance_date >= period.start_date,
                EmployeeAttendance.attendance_date <= period.end_date,
            )
        )).all()

        total_overtime_hours = sum(a.overtime_hours for a in attendances)
        unpermitted_absences = sum(1 for a in attendances if a.status == "absent_unpermitted")
        total_delay_minutes = sum(a.delay_minutes for a in attendances)

        # معدل الساعة التقديري = (الأساسي / 30 يوم / 8 ساعات)
        hourly_rate = round(emp.base_salary / 240.0, 2) if emp.base_salary > 0 else 25.0
        daily_rate = round(emp.base_salary / 30.0, 2) if emp.base_salary > 0 else 200.0

        overtime_amount = round(total_overtime_hours * hourly_rate * 1.5, 2)
        absence_deductions = round(unpermitted_absences * daily_rate, 2)
        delay_deductions = round((total_delay_minutes / 60.0) * hourly_rate, 2)
        total_deductions = absence_deductions + delay_deductions

        bonus_amount = 0.0
        advances_amount = 0.0
        net_amount = max(0.0, round(emp.base_salary + overtime_amount + bonus_amount - total_deductions - advances_amount, 2))

        run = PayrollRun(
            id=str(uuid.uuid4()),
            period_id=period.id,
            employee_id=emp.id,
            base_amount=emp.base_salary,
            overtime_amount=overtime_amount,
            bonus_amount=bonus_amount,
            deductions_amount=total_deductions,
            advances_amount=advances_amount,
            net_amount=net_amount,
            status="draft",
            notes=f"إضافي: {total_overtime_hours} ساعة | غياب غير مصرح: {unpermitted_absences} يوم | تأخير: {total_delay_minutes} دقيقة",
        )
        db.add(run)

    await db.commit()

    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


@router.get("/periods/{period_id}/runs", response_model=PayrollPeriodDetailRead)
async def get_period_payroll_details(
    period_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    period = await db.get(PayPeriod, period_id)
    if not period:
        raise HTTPException(status_code=404, detail="فترة الرواتب غير موجودة.")

    runs = (await db.scalars(
        select(PayrollRun).options(selectinload(PayrollRun.employee))
        .where(PayrollRun.period_id == period.id)
    )).all()

    run_reads = [
        PayrollRunRead(
            id=r.id, period_id=r.period_id, employee_id=r.employee_id,
            employee_name=r.employee.name if r.employee else "",
            employee_code=r.employee.code if r.employee else "",
            department=r.employee.department if r.employee else "",
            base_amount=r.base_amount, overtime_amount=r.overtime_amount,
            bonus_amount=r.bonus_amount, deductions_amount=r.deductions_amount,
            advances_amount=r.advances_amount, net_amount=r.net_amount,
            status=r.status, cash_document_id=r.cash_document_id, notes=r.notes,
        )
        for r in runs
    ]

    total_base = sum(r.base_amount for r in runs)
    total_overtime = sum(r.overtime_amount for r in runs)
    total_bonus = sum(r.bonus_amount for r in runs)
    total_deductions = sum(r.deductions_amount for r in runs)
    total_advances = sum(r.advances_amount for r in runs)
    total_net = sum(r.net_amount for r in runs)

    period_read = PayPeriodRead(
        id=period.id, period_name=period.period_name, start_date=period.start_date,
        end_date=period.end_date, status=period.status, runs_count=len(runs),
        total_net_amount=total_net,
    )

    return PayrollPeriodDetailRead(
        period=period_read,
        runs=run_reads,
        total_base=round(total_base, 2),
        total_overtime=round(total_overtime, 2),
        total_bonus=round(total_bonus, 2),
        total_deductions=round(total_deductions, 2),
        total_advances=round(total_advances, 2),
        total_net=round(total_net, 2),
    )


# ─── 4. اعتماد وصرف كشف الرواتب وربط الخزينة ────────────────────────────────

@router.post("/periods/{period_id}/disburse", response_model=PayrollPeriodDetailRead)
async def disburse_period_payroll(
    period_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:manage")),
    db: AsyncSession = Depends(get_db),
):
    """اعتماد صرف كشف رواتب الفترة وتوليد سند صرف نقدي معتمد في الخزينة الرئيسية."""
    period = await db.get(PayPeriod, period_id)
    if not period:
        raise HTTPException(status_code=404, detail="فترة الرواتب غير موجودة.")
    if period.status in ("paid", "closed"):
        raise HTTPException(status_code=409, detail="تم صرف هذه الفترة بالفعل.")

    runs = (await db.scalars(select(PayrollRun).where(PayrollRun.period_id == period.id).with_for_update())).all()
    if not runs:
        raise HTTPException(status_code=422, detail="لا توجد كشوف محسوبة في هذه الفترة. احسب الكشف أولاً.")

    total_net = sum(r.net_amount for r in runs)
    if total_net <= 0:
        raise HTTPException(status_code=422, detail="إجمالي صافي الرواتب يجب أن يكون أكبر من صفر.")

    # تحديد حساب الخزنة الرئيسية
    treasury = await db.scalar(select(CashAccount).where(CashAccount.account_type == "treasury", CashAccount.is_active.is_(True)))
    if not treasury:
        raise HTTPException(status_code=503, detail="حساب الخزنة الرئيسية غير مهيأ.")

    # فحص الرصيد النقدي بالخزنة ومنع الصرف عند عدم الكفاية
    treasury_balance = await db.scalar(
        select(func.coalesce(func.sum(CashLedgerEntry.amount), 0)).where(CashLedgerEntry.account_id == treasury.id)
    )
    if Decimal(str(treasury_balance)) < Decimal(str(total_net)):
        raise HTTPException(status_code=409, detail=f"رصيد الخزنة غير كافٍ لصرف الرواتب. المتاح: {treasury_balance}، المطلوب: {total_net}.")

    # إنشاء مستند صرف نقدي معتمد
    doc_id = str(uuid.uuid4())
    cash_doc = CashDocument(
        id=doc_id,
        document_number=f"CSH-PAY-{period.period_name.replace(' ', '_')}-{uuid.uuid4().hex[:6].upper()}",
        document_type="expense",
        from_account_id=treasury.id,
        to_account_id=None,
        amount=Decimal(str(round(total_net, 2))),
        description=f"صرف كشف مرتبات فترة {period.period_name} لعدد {len(runs)} عامل",
        occurred_at=datetime.now(timezone.utc),
        source_system="payroll",
        source_reference=period.id,
        status="approved",
        created_by=current_user.id,
        approved_by=current_user.id,
        approved_at=datetime.now(timezone.utc),
    )
    db.add(cash_doc)

    # إنشاء قيد حركة سالبة في دفتر الخزينة
    db.add(CashLedgerEntry(
        id=str(uuid.uuid4()),
        document_id=doc_id,
        account_id=treasury.id,
        amount=-Decimal(str(round(total_net, 2))),
        created_by=current_user.id,
    ))

    # تحديث حالة الرواتب والفترة
    for r in runs:
        r.status = "paid"
        r.cash_document_id = doc_id
    period.status = "paid"

    await db.commit()

    return await get_period_payroll_details(period_id, current_user=current_user, db=db)

