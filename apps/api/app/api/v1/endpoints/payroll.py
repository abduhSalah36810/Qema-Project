"""
الرواتب — نظام أجر شهري أو يومية، وبنود حوافز وخصومات يُدخلها المدير المالي صراحة في كل فترة.
─────────────────────────────────────────────────────────────────────────────
القواعد:
1. الأجر الأساسي في الكشف: الشهري = الراتب الأساسي، اليومية = أجر اليوم × أيام العمل الفعلية المدخلة للفترة.
   تُحفظ لقطة نظام الأجر وقيمته وقت الإعداد؛ تعديل ملف الموظف لا يغير الكشوف السابقة.
2. الحوافز والخصومات بنود تُضاف يدوياً لكل موظف في الفترة (مبلغ ثابت، نسبة من الأساسي، أو كمية × قيمة الوحدة).
   لا يُطبَّق أي بند تلقائياً، ولا تُفرض قيمة افتراضية لمجرد وجود نوع البند.
   إجمالي المستحقات = الأساسي + الإضافي + الحوافز؛ إجمالي الخصومات = بنود الخصم + السلف؛ الصافي = الفرق.
2. سجل الحضور مرجع للمراجعة فقط ويظهر ملخصه بجوار كل موظف.
3. الصرف: "تقديم للصرف" يُنشئ مستند صرف واحد معلقاً في الخزينة؛ الاعتماد من شاشة الخزينة
   بواسطة مستخدم آخر هو ما يخصم النقدية ويجعل الفترة "مصروفة". لا يمكن صرف فترة مرتين.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.auth import AuthenticatedUser
from app.core.permissions import get_user_roles, require_permission
from app.db.session import get_db
from app.modules.finance.models import CashDocument
from app.modules.finance.schemas import CashDocumentCreate
from app.modules.finance.service import cash_account_balance, create_cash_document, finalize_cash_document, get_main_treasury
from app.modules.production.models import (
    Employee,
    EmployeeAttendance,
    PayPeriod,
    PayPeriodEvent,
    PayrollRun,
    PayrollRunItem,
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
    ITEM_CATEGORIES,
    PayrollCalculateRequest,
    PayrollItemCreate,
    PayrollItemRead,
    PayrollPeriodDetailRead,
    PayrollRunRead,
    PayrollWorkDaysUpdate,
)

router = APIRouter(prefix="/payroll", tags=["payroll"])
CENT = Decimal("0.01")
EDITABLE_PERIOD_STATUSES = ("draft", "calculated")


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(CENT)


def _employee_read(e: Employee) -> EmployeeRead:
    return EmployeeRead(
        id=e.id, code=e.code, name=e.name, department=e.department,
        job_title=e.job_title, pay_type=e.pay_type if e.pay_type in ("monthly", "daily") else "monthly",
        base_salary=float(e.base_salary or 0),
        daily_rate=float(e.daily_rate) if isinstance(e.daily_rate, (int, float, Decimal)) else None, status=e.status,
        hire_date=e.hire_date,
    )


def _compute_net(run: PayrollRun) -> Decimal:
    return (
        _money(run.base_amount) + _money(run.overtime_amount) + _money(run.bonus_amount)
        - _money(run.deductions_amount) - _money(run.advances_amount)
    )


def _run_base(run: PayrollRun) -> Decimal:
    """الأجر الأساسي للفترة من لقطة الكشف: الشهري = الراتب، اليومية = أجر اليوم × أيام العمل المدخلة."""
    rate = _money(run.rate_amount)
    if run.pay_type == "daily":
        days = Decimal(str(run.work_days or 0))
        return (rate * days).quantize(CENT)
    return rate


def _item_amount(method: str, value: Decimal, quantity: Decimal | None, base: Decimal) -> Decimal:
    if method == "fixed":
        return _money(value)
    if method == "percent":
        return (base * Decimal(str(value)) / Decimal("100")).quantize(CENT)
    return (Decimal(str(value)) * Decimal(str(quantity or 0))).quantize(CENT)


def _recompute_run(run: PayrollRun, employee_name: str = "") -> None:
    """
    يعيد حساب الأساسي وبنود النسبة والإجماليات. عند وجود بنود، الحوافز والخصومات = مجموع البنود
    (البنود هي مصدر القيم)؛ الكشوف القديمة بلا بنود تحتفظ بقيمها المعتمدة كما هي.
    """
    run.base_amount = _run_base(run)
    items = list(run.items or [])
    if items:
        for item in items:
            if item.calc_method == "percent":
                item.percent_base = run.base_amount
                item.amount = _item_amount("percent", item.value, None, run.base_amount)
        run.bonus_amount = sum((_money(i.amount) for i in items if i.kind == "incentive"), Decimal("0.00"))
        run.deductions_amount = sum((_money(i.amount) for i in items if i.kind == "deduction"), Decimal("0.00"))
    net = _compute_net(run)
    if net < 0:
        who = f" للموظف {employee_name}" if employee_name else ""
        raise HTTPException(status_code=422, detail=f"الصافي الناتج{who} سالب ({net}); الخصومات أكبر من المستحقات.")
    run.net_amount = net


# ─── 1. ملفات العاملين ────────────────────────────────────────────────────────

@router.get("/employees", response_model=List[EmployeeRead])
async def list_employees(
    department: Optional[str] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Employee).order_by(Employee.name)
    if department:
        stmt = stmt.where(Employee.department == department)
    if status_filter:
        stmt = stmt.where(Employee.status == status_filter)
    return [_employee_read(e) for e in (await db.scalars(stmt)).all()]


@router.post("/employees", response_model=EmployeeRead, status_code=status.HTTP_201_CREATED)
async def create_employee(
    data: EmployeeCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:manage")),
    db: AsyncSession = Depends(get_db),
):
    if await db.scalar(select(Employee.id).where(Employee.code == data.code.strip())):
        raise HTTPException(status_code=409, detail="كود الموظف مستخدم من قبل.")
    employee = Employee(
        id=str(uuid.uuid4()), code=data.code.strip(), name=data.name.strip(),
        department=data.department.strip(), job_title=data.job_title.strip(),
        pay_type=data.pay_type,
        base_salary=_money(data.base_salary) if data.pay_type == "monthly" else Decimal("0.00"),
        daily_rate=_money(data.daily_rate) if data.pay_type == "daily" else None,
        status="active", hire_date=utc_now(),
    )
    db.add(employee)
    await db.commit()
    await db.refresh(employee)
    return _employee_read(employee)


@router.patch("/employees/{employee_id}", response_model=EmployeeRead)
async def update_employee(
    employee_id: str,
    data: EmployeeUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:manage")),
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
    if data.pay_type is not None:
        employee.pay_type = data.pay_type
    if data.base_salary is not None:
        employee.base_salary = _money(data.base_salary)
    if data.daily_rate is not None:
        employee.daily_rate = _money(data.daily_rate)
    if employee.pay_type == "daily" and (employee.daily_rate is None or employee.daily_rate <= 0):
        raise HTTPException(status_code=422, detail="أدخل قيمة أجر اليوم لموظف اليومية.")
    if data.status is not None:
        employee.status = data.status
    await db.commit()
    await db.refresh(employee)
    return _employee_read(employee)


# ─── 2. سجل الحضور (مرجع للمراجعة) ────────────────────────────────────────────

def _attendance_read(r: EmployeeAttendance, employee: Employee | None) -> AttendanceRead:
    return AttendanceRead(
        id=r.id, employee_id=r.employee_id, employee_name=employee.name if employee else "",
        employee_code=employee.code if employee else "", attendance_date=r.attendance_date,
        status=r.status, delay_minutes=r.delay_minutes, overtime_hours=r.overtime_hours,
        notes=r.notes, recorded_by=r.recorded_by, created_at=r.created_at,
    )


@router.get("/attendance", response_model=List[AttendanceRead])
async def list_attendance(
    employee_id: Optional[str] = Query(default=None),
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:view")),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(EmployeeAttendance).options(selectinload(EmployeeAttendance.employee)).order_by(EmployeeAttendance.attendance_date.desc())
    if employee_id:
        stmt = stmt.where(EmployeeAttendance.employee_id == employee_id)
    rows = (await db.scalars(stmt.limit(500))).all()
    return [_attendance_read(r, r.employee) for r in rows]


@router.post("/attendance", response_model=AttendanceRead, status_code=status.HTTP_201_CREATED)
async def record_attendance(
    data: AttendanceCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:manage")),
    db: AsyncSession = Depends(get_db),
):
    employee = await db.get(Employee, data.employee_id)
    if not employee or employee.status != "active":
        raise HTTPException(status_code=404, detail="الموظف غير موجود أو غير نشط.")
    day = data.attendance_date.date()
    duplicate = await db.scalar(select(EmployeeAttendance.id).where(
        EmployeeAttendance.employee_id == employee.id,
        func.date(EmployeeAttendance.attendance_date) == day,
    ))
    if duplicate:
        raise HTTPException(status_code=409, detail=f"تم تسجيل حضور هذا الموظف ليوم {day.isoformat()} من قبل.")
    record = EmployeeAttendance(
        id=str(uuid.uuid4()), employee_id=employee.id, attendance_date=data.attendance_date,
        status=data.status, delay_minutes=data.delay_minutes, overtime_hours=data.overtime_hours,
        notes=data.notes.strip(), recorded_by=current_user.id, created_at=utc_now(),
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return _attendance_read(record, employee)


# ─── 3. فترات وكشوف الرواتب ───────────────────────────────────────────────────

@router.get("/periods", response_model=List[PayPeriodRead])
async def list_pay_periods(
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:view")),
    db: AsyncSession = Depends(get_db),
):
    periods = (await db.scalars(select(PayPeriod).order_by(PayPeriod.start_date.desc()))).all()
    output = []
    for p in periods:
        count, total = (await db.execute(
            select(func.count(PayrollRun.id), func.coalesce(func.sum(PayrollRun.net_amount), 0))
            .where(PayrollRun.period_id == p.id)
        )).first() or (0, 0)
        output.append(PayPeriodRead(
            id=p.id, period_name=p.period_name, start_date=p.start_date, end_date=p.end_date,
            status=p.status, runs_count=int(count or 0), total_net_amount=float(total or 0),
        ))
    return output


@router.post("/periods", response_model=PayPeriodRead, status_code=status.HTTP_201_CREATED)
async def create_pay_period(
    data: PayPeriodCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:manage")),
    db: AsyncSession = Depends(get_db),
):
    if data.end_date <= data.start_date:
        raise HTTPException(status_code=422, detail="تاريخ نهاية الفترة يجب أن يكون بعد تاريخ البداية.")
    overlapping = await db.scalar(select(PayPeriod.period_name).where(
        and_(PayPeriod.start_date < data.end_date, PayPeriod.end_date > data.start_date)
    ))
    if overlapping:
        raise HTTPException(status_code=409, detail=f"الفترة تتداخل مع فترة رواتب قائمة ({overlapping}).")
    period = PayPeriod(
        id=str(uuid.uuid4()), period_name=data.period_name.strip(),
        start_date=data.start_date, end_date=data.end_date, status="draft",
    )
    db.add(period)
    await db.commit()
    await db.refresh(period)
    return PayPeriodRead(
        id=period.id, period_name=period.period_name, start_date=period.start_date,
        end_date=period.end_date, status=period.status, runs_count=0, total_net_amount=0.0,
    )


def _record_period_event(db: AsyncSession, period_id: str, action: str, actor_id: str, details: str = "") -> None:
    """سجل append-only لمن أعد كشف الرواتب أو عدّله أو قدّمه للصرف (أساس Maker-Checker على مصدر الكشف)."""
    db.add(PayPeriodEvent(
        id=str(uuid.uuid4()), period_id=period_id, action=action, actor_id=actor_id,
        details=details[:2000], created_at=datetime.now(timezone.utc),
    ))


async def _locked_period(db: AsyncSession, period_id: str) -> PayPeriod:
    period = await db.scalar(select(PayPeriod).where(PayPeriod.id == period_id).with_for_update())
    if not period:
        raise HTTPException(status_code=404, detail="فترة الرواتب غير موجودة.")
    return period


@router.post("/periods/{period_id}/calculate", response_model=PayrollPeriodDetailRead)
async def calculate_period_payroll(
    period_id: str,
    data: PayrollCalculateRequest = PayrollCalculateRequest(),
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:calculate")),
    db: AsyncSession = Depends(get_db),
):
    """
    إعداد كشف الفترة للموظفين المحددين (أو كل النشطين): سطر لكل موظف بلقطة نظام أجره وقيمته الحالية.
    الحوافز والخصومات وأيام عمل اليومية تُدخل صراحة بعد الإعداد؛ لا يُطبَّق أي بند تلقائياً.
    إعادة الإعداد تُحدّث لقطة الأجر وتحافظ على البنود وأيام العمل المدخلة.
    """
    period = await _locked_period(db, period_id)
    if period.status not in EDITABLE_PERIOD_STATUSES:
        raise HTTPException(status_code=409, detail="لا يمكن تعديل كشف فترة قُدمت للصرف أو صُرفت.")

    stmt = select(Employee).where(Employee.status == "active")
    if data.employee_ids is not None:
        if not data.employee_ids:
            raise HTTPException(status_code=422, detail="اختر موظفاً واحداً على الأقل لإعداد الكشف.")
        stmt = stmt.where(Employee.id.in_(data.employee_ids))
    employees = (await db.scalars(stmt)).all()
    if data.employee_ids is not None and len(employees) != len(set(data.employee_ids)):
        raise HTTPException(status_code=422, detail="أحد الموظفين المحددين غير موجود أو غير نشط.")
    existing = {run.employee_id: run for run in (await db.scalars(
        select(PayrollRun).options(selectinload(PayrollRun.items))
        .where(PayrollRun.period_id == period.id).with_for_update(of=PayrollRun)
    )).all()}
    selected_ids = {emp.id for emp in employees}
    if data.employee_ids is not None:
        # من أُزيل من الاختيار يُحذف سطره من كشف الفترة غير المقدم (مع بنوده)
        for employee_id, stale in list(existing.items()):
            if employee_id not in selected_ids:
                await db.delete(stale)
                existing.pop(employee_id)
    for emp in employees:
        attendance = (await db.scalars(select(EmployeeAttendance).where(
            EmployeeAttendance.employee_id == emp.id,
            EmployeeAttendance.attendance_date >= period.start_date,
            EmployeeAttendance.attendance_date <= period.end_date,
        ))).all()
        summary = (
            f"مرجع الحضور: أيام مسجلة {len(attendance)} | غياب بدون إذن {sum(1 for a in attendance if a.status == 'absent_unpermitted')}"
            f" | تأخير {sum(a.delay_minutes for a in attendance)} دقيقة | ساعات إضافي {sum(a.overtime_hours for a in attendance):g}"
        )
        run = existing.get(emp.id)
        if run is None:
            run = PayrollRun(
                id=str(uuid.uuid4()), period_id=period.id, employee_id=emp.id,
                overtime_amount=Decimal("0.00"), bonus_amount=Decimal("0.00"),
                deductions_amount=Decimal("0.00"), advances_amount=Decimal("0.00"),
                status="draft", notes=summary, items=[],
            )
            db.add(run)
        else:
            adjustments = run.notes.split(" || ", 1)[1] if " || " in (run.notes or "") else ""
            run.notes = summary + (f" || {adjustments}" if adjustments else "")
        run.pay_type = emp.pay_type or "monthly"
        run.rate_amount = _money(emp.daily_rate if run.pay_type == "daily" else emp.base_salary)
        run.employee_name_snapshot = emp.name
        _recompute_run(run, emp.name)
    period.status = "calculated"
    _record_period_event(db, period.id, "calculate", current_user.id, f"إعداد كشف الفترة {period.period_name}")
    await db.commit()
    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


class PayrollRunAdjust(BaseModel):
    """قيم صريحة معتمدة لموظف في الفترة (لا يحسبها النظام)."""
    overtime_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2)
    bonus_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2, description="بدلات وحوافز معتمدة")
    deductions_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2, description="استقطاعات معتمدة")
    advances_amount: Decimal = Field(default=Decimal("0.00"), ge=0, max_digits=14, decimal_places=2, description="سلف مستردة")
    reason: str = Field(min_length=3, max_length=1000, description="سبب/مرجع اعتماد القيم")


@router.patch("/periods/{period_id}/runs/{run_id}", response_model=PayrollPeriodDetailRead)
async def adjust_payroll_run(
    period_id: str,
    run_id: str,
    data: PayrollRunAdjust,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:calculate")),
    db: AsyncSession = Depends(get_db),
):
    period = await _locked_period(db, period_id)
    if period.status not in EDITABLE_PERIOD_STATUSES:
        raise HTTPException(status_code=409, detail="لا يمكن تعديل كشف فترة قُدمت للصرف أو صُرفت.")
    run = await db.scalar(
        select(PayrollRun).options(selectinload(PayrollRun.items))
        .where(PayrollRun.id == run_id, PayrollRun.period_id == period.id).with_for_update(of=PayrollRun)
    )
    if not run:
        raise HTTPException(status_code=404, detail="سطر الراتب غير موجود في هذه الفترة.")
    if run.items:
        raise HTTPException(status_code=409, detail="هذا الكشف يُدار ببنود الحوافز والخصومات؛ عدّل البنود بدل القيم الإجمالية.")
    run.overtime_amount = data.overtime_amount
    run.bonus_amount = data.bonus_amount
    run.deductions_amount = data.deductions_amount
    run.advances_amount = data.advances_amount
    net = _compute_net(run)
    if net < 0:
        raise HTTPException(status_code=422, detail=f"الصافي الناتج سالب ({net}); الاستقطاعات والسلف أكبر من المستحق.")
    run.net_amount = net
    base_note = (run.notes or "").split(" || ", 1)[0]
    run.notes = f"{base_note} || تعديل بواسطة {current_user.id}: {data.reason.strip()}"
    _record_period_event(db, period_id, "adjust", current_user.id, f"تعديل كشف موظف ({run.id}): {data.reason.strip()}")
    await db.commit()
    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


@router.get("/periods/{period_id}/runs", response_model=PayrollPeriodDetailRead)
async def get_period_payroll_details(
    period_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:view")),
    db: AsyncSession = Depends(get_db),
):
    period = await db.get(PayPeriod, period_id)
    if not period:
        raise HTTPException(status_code=404, detail="فترة الرواتب غير موجودة.")
    runs = (await db.scalars(
        select(PayrollRun).options(selectinload(PayrollRun.employee), selectinload(PayrollRun.items))
        .where(PayrollRun.period_id == period.id)
    )).all()
    runs = sorted(runs, key=lambda r: (r.employee_name_snapshot or (r.employee.name if r.employee else "")))
    category_totals: dict[str, Decimal] = {}
    run_reads = []
    for r in runs:
        for item in r.items:
            category_totals[item.category] = category_totals.get(item.category, Decimal("0.00")) + _money(item.amount)
        gross = _money(r.base_amount) + _money(r.overtime_amount) + _money(r.bonus_amount)
        run_reads.append(PayrollRunRead(
            id=r.id, period_id=r.period_id, employee_id=r.employee_id,
            employee_name=r.employee_name_snapshot or (r.employee.name if r.employee else ""),
            employee_code=r.employee.code if r.employee else "",
            department=r.employee.department if r.employee else "",
            pay_type=r.pay_type or "monthly", rate_amount=float(r.rate_amount or 0),
            work_days=float(r.work_days) if r.work_days is not None else None,
            base_amount=float(r.base_amount), overtime_amount=float(r.overtime_amount),
            bonus_amount=float(r.bonus_amount), deductions_amount=float(r.deductions_amount),
            advances_amount=float(r.advances_amount),
            gross_amount=float(gross),
            total_deductions=float(_money(r.deductions_amount) + _money(r.advances_amount)),
            net_amount=float(r.net_amount),
            status=r.status, cash_document_id=r.cash_document_id, notes=r.notes,
            items=[_item_read(i) for i in r.items],
        ))

    def total(attr: str) -> float:
        return float(sum((_money(getattr(r, attr)) for r in runs), Decimal("0.00")))

    return PayrollPeriodDetailRead(
        period=PayPeriodRead(
            id=period.id, period_name=period.period_name, start_date=period.start_date,
            end_date=period.end_date, status=period.status, runs_count=len(runs),
            total_net_amount=total("net_amount"),
        ),
        runs=run_reads,
        total_base=total("base_amount"),
        total_overtime=total("overtime_amount"),
        total_bonus=total("bonus_amount"),
        total_deductions=total("deductions_amount"),
        total_advances=total("advances_amount"),
        total_net=total("net_amount"),
        total_gross=total("base_amount") + total("overtime_amount") + total("bonus_amount"),
        category_totals={k: float(v) for k, v in category_totals.items()},
    )


def _item_read(i: PayrollRunItem) -> PayrollItemRead:
    return PayrollItemRead(
        id=i.id, kind=i.kind, category=i.category, label=i.label, calc_method=i.calc_method,
        quantity=float(i.quantity) if i.quantity is not None else None, value=float(i.value),
        percent_base=float(i.percent_base) if i.percent_base is not None else None,
        amount=float(i.amount), notes=i.notes, created_by=i.created_by, created_at=i.created_at,
    )


async def _editable_run(db: AsyncSession, period_id: str, run_id: str) -> tuple[PayPeriod, PayrollRun]:
    period = await _locked_period(db, period_id)
    if period.status not in EDITABLE_PERIOD_STATUSES:
        raise HTTPException(status_code=409, detail="لا يمكن تعديل كشف فترة قُدمت للصرف أو صُرفت.")
    run = await db.scalar(
        select(PayrollRun).options(selectinload(PayrollRun.items), selectinload(PayrollRun.employee))
        .where(PayrollRun.id == run_id, PayrollRun.period_id == period.id).with_for_update(of=PayrollRun)
    )
    if not run:
        raise HTTPException(status_code=404, detail="سطر الراتب غير موجود في هذه الفترة.")
    return period, run


def _run_name(run: PayrollRun) -> str:
    return run.employee_name_snapshot or (run.employee.name if run.employee else "")


@router.post("/periods/{period_id}/runs/{run_id}/items", response_model=PayrollPeriodDetailRead, status_code=status.HTTP_201_CREATED)
async def add_payroll_item(
    period_id: str,
    run_id: str,
    data: PayrollItemCreate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:calculate")),
    db: AsyncSession = Depends(get_db),
):
    """إضافة حافز أو خصم صريح لكشف موظف في الفترة؛ يُحفظ مع طريقة حسابه وقيمه والمبلغ الناتج."""
    period, run = await _editable_run(db, period_id, run_id)
    if not run.items and (_money(run.bonus_amount) > 0 or _money(run.deductions_amount) > 0):
        raise HTTPException(
            status_code=409,
            detail="لهذا الموظف قيم حوافز/استقطاعات إجمالية مُدخلة بالطريقة السابقة. صفّرها أولاً ثم أضف البنود.",
        )
    spec = ITEM_CATEGORIES[data.category]
    base = _run_base(run)
    if data.calc_method == "percent" and base <= 0:
        raise HTTPException(status_code=422, detail="لا يمكن حساب نسبة قبل تحديد الأجر الأساسي (أدخل أيام عمل اليومية أولاً).")
    amount = _item_amount(data.calc_method, data.value, data.quantity, base)
    item = PayrollRunItem(
        id=str(uuid.uuid4()), run_id=run.id, kind=spec["kind"], category=data.category,
        label=data.label.strip() or spec["label"], calc_method=data.calc_method,
        quantity=data.quantity if data.calc_method == "quantity" else None, value=data.value,
        percent_base=base if data.calc_method == "percent" else None, amount=amount,
        notes=data.notes.strip(), created_by=current_user.id, created_at=utc_now(),
    )
    run.items.append(item)
    try:
        _recompute_run(run, _run_name(run))
    except HTTPException:
        run.items.remove(item)  # لا يبقى البند المرفوض في الجلسة
        _recompute_run(run, _run_name(run))
        raise
    _record_period_event(
        db, period.id, "adjust", current_user.id,
        f"إضافة بند ({item.label}) بمبلغ {amount} لكشف {_run_name(run)}",
    )
    await db.commit()
    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


@router.delete("/periods/{period_id}/runs/{run_id}/items/{item_id}", response_model=PayrollPeriodDetailRead)
async def remove_payroll_item(
    period_id: str,
    run_id: str,
    item_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:calculate")),
    db: AsyncSession = Depends(get_db),
):
    """حذف بند من كشف فترة لم تُقدم للصرف بعد (مسودة إعداد، ويُسجل الحذف في أحداث الفترة)."""
    period, run = await _editable_run(db, period_id, run_id)
    item = next((i for i in run.items if i.id == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="البند غير موجود في هذا الكشف.")
    run.items.remove(item)
    try:
        _recompute_run(run, _run_name(run))
    except HTTPException:
        run.items.append(item)
        _recompute_run(run, _run_name(run))
        raise
    _record_period_event(
        db, period.id, "adjust", current_user.id,
        f"حذف بند ({item.label}) بمبلغ {item.amount} من كشف {_run_name(run)}",
    )
    await db.commit()
    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


@router.patch("/periods/{period_id}/runs/{run_id}/work-days", response_model=PayrollPeriodDetailRead)
async def set_run_work_days(
    period_id: str,
    run_id: str,
    data: PayrollWorkDaysUpdate,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:calculate")),
    db: AsyncSession = Depends(get_db),
):
    """أيام العمل الفعلية لموظف اليومية في الفترة؛ الأساسي = أجر اليوم × الأيام (وتُعاد بنود النسبة عليه)."""
    period, run = await _editable_run(db, period_id, run_id)
    if run.pay_type != "daily":
        raise HTTPException(status_code=422, detail="أيام العمل تُدخل لموظفي اليومية فقط.")
    previous_days = run.work_days
    run.work_days = data.work_days
    try:
        _recompute_run(run, _run_name(run))
    except HTTPException:
        run.work_days = previous_days
        _recompute_run(run, _run_name(run))
        raise
    _record_period_event(db, period.id, "adjust", current_user.id, f"أيام عمل {_run_name(run)}: {data.work_days}")
    await db.commit()
    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


# ─── 4. تقديم الكشف للصرف عبر الخزينة ─────────────────────────────────────────

@router.post("/periods/{period_id}/disburse", response_model=PayrollPeriodDetailRead)
async def submit_period_for_payment(
    period_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:disburse")),
    db: AsyncSession = Depends(get_db),
):
    """
    تقديم كشف الفترة للصرف: يُنشئ مستند صرف واحد معلقاً بإجمالي الصافي في شاشة الخزينة.
    النقدية لا تُخصم إلا عند اعتماد المستند من مستخدم آخر، وعندها تصبح الفترة "مصروفة".
    القفل على الفترة + المرجع الفريد للمستند يمنعان تقديم أو صرف الفترة مرتين.
    """
    period = await _locked_period(db, period_id)
    if period.status in ("submitted", "paid", "closed"):
        raise HTTPException(status_code=409, detail="تم تقديم هذه الفترة للصرف أو صرفها بالفعل.")
    if period.status != "calculated":
        raise HTTPException(status_code=422, detail="أعد إعداد كشف الفترة ومراجعته قبل تقديمه للصرف.")
    runs = (await db.scalars(select(PayrollRun).where(PayrollRun.period_id == period.id).with_for_update())).all()
    if not runs:
        raise HTTPException(status_code=422, detail="لا توجد كشوف في هذه الفترة. أعد إعداد الكشف أولاً.")
    total_net = sum((_money(r.net_amount) for r in runs), Decimal("0.00"))
    if total_net <= 0:
        raise HTTPException(status_code=422, detail="إجمالي صافي الرواتب يجب أن يكون أكبر من صفر.")

    treasury = await get_main_treasury(db)
    available = await cash_account_balance(db, treasury.id)
    if available < total_net:
        raise HTTPException(status_code=409, detail=f"رصيد الخزنة غير كافٍ لصرف الرواتب. المتاح: {available:.2f}، المطلوب: {total_net:.2f}.")

    document = await create_cash_document(
        db,
        CashDocumentCreate(
            document_type="expense",
            from_account_id=treasury.id,
            amount=total_net,
            description=f"صرف كشف مرتبات فترة {period.period_name} لعدد {len(runs)} موظف",
            occurred_at=datetime.now(timezone.utc),
            source_system="payroll",
            source_reference=period.id,
        ),
        current_user.id,
        allow_system_source=True,
        commit=False,
    )
    for run in runs:
        run.status = "submitted"
        run.cash_document_id = document.id
    period.status = "submitted"
    _record_period_event(db, period.id, "submit_for_disbursement", current_user.id, f"سند الصرف {document.document_number}")
    # المدير المالي: الصرف يُعتمد فوراً وتصبح الفترة «مصروفة»؛ غيره ينتظر اعتماد الخزينة
    await finalize_cash_document(db, document, current_user.id, await get_user_roles(current_user, db=db))
    db.expire_all()
    return await get_period_payroll_details(period_id, current_user=current_user, db=db)


# ─── 5. تقارير الكشف وتصديره ──────────────────────────────────────────────────

PAY_TYPE_AR = {"monthly": "شهري", "daily": "يومية"}
CALC_METHOD_AR = {"fixed": "مبلغ ثابت", "percent": "نسبة من الأساسي", "quantity": "عدد × قيمة الوحدة"}


@router.get("/periods/{period_id}/export.xlsx")
async def export_period_xlsx(
    period_id: str,
    current_user: AuthenticatedUser = Depends(require_permission("finance:payroll:view")),
    db: AsyncSession = Depends(get_db),
):
    """تصدير كشف الفترة إلى Excel: ورقة الملخص لكل موظف وإجماليات البنود، وورقة تفصيل البنود."""
    from fastapi.responses import Response

    from app.core.xlsx import build_xlsx
    from app.modules.production.payroll_schemas import ITEM_CATEGORIES as CATS

    detail = await get_period_payroll_details(period_id, current_user=current_user, db=db)
    period = detail.period
    summary_rows: list[list] = [
        [f"كشف رواتب: {period.period_name}", f"من {period.start_date:%Y-%m-%d} إلى {period.end_date:%Y-%m-%d}"],
        [],
        ["الكود", "الموظف", "نظام الأجر", "أجر الشهر / اليوم", "أيام العمل", "الأساسي", "الحوافز", "إضافي",
         "إجمالي المستحقات", "الخصومات", "السلف", "إجمالي الخصومات", "الصافي"],
    ]
    for r in detail.runs:
        summary_rows.append([
            r.employee_code, r.employee_name, PAY_TYPE_AR.get(r.pay_type, r.pay_type), r.rate_amount,
            r.work_days if r.pay_type == "daily" else "", r.base_amount, r.bonus_amount, r.overtime_amount,
            r.gross_amount, r.deductions_amount, r.advances_amount, r.total_deductions, r.net_amount,
        ])
    total_row = len(summary_rows)
    summary_rows.append([
        "", "الإجمالي", "", "", "", detail.total_base, detail.total_bonus, detail.total_overtime,
        detail.total_gross, detail.total_deductions, detail.total_advances,
        detail.total_deductions + detail.total_advances, detail.total_net,
    ])
    summary_rows += [[], ["إجمالي البنود حسب النوع", "المبلغ"]]
    cat_header = len(summary_rows) - 1
    for category, spec in CATS.items():
        if category in detail.category_totals:
            summary_rows.append([spec["label"], detail.category_totals[category]])

    item_rows: list[list] = [["الكود", "الموظف", "النوع", "البند", "طريقة الحساب", "العدد", "القيمة / النسبة", "أساس النسبة", "المبلغ", "ملاحظات"]]
    for r in detail.runs:
        for i in r.items:
            item_rows.append([
                r.employee_code, r.employee_name, "حافز" if i.kind == "incentive" else "خصم", i.label,
                CALC_METHOD_AR.get(i.calc_method, i.calc_method), i.quantity if i.quantity is not None else "",
                i.value, i.percent_base if i.percent_base is not None else "", i.amount, i.notes,
            ])

    content = build_xlsx([
        ("ملخص الفترة", summary_rows, [0, 2, total_row, cat_header]),
        ("تفصيل البنود", item_rows, [0]),
    ])
    filename = f"payroll-{period.start_date:%Y-%m}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
