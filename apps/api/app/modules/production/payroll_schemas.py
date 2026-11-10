from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

PayType = Literal["monthly", "daily"]


class EmployeeCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    department: str = Field(default="production", max_length=64)
    job_title: str = Field(default="", max_length=64)
    # نظام الأجر: شهري (base_salary) أو يومية (daily_rate). لا توجد قيمة افتراضية تُفرض على الموظف.
    pay_type: PayType = "monthly"
    base_salary: float = Field(default=0.0, ge=0)
    daily_rate: Optional[float] = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_pay(self):
        if self.pay_type == "daily" and (self.daily_rate is None or self.daily_rate <= 0):
            raise ValueError("أدخل قيمة أجر اليوم لموظف اليومية.")
        return self


class EmployeeUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=128)
    department: Optional[str] = Field(default=None, max_length=64)
    job_title: Optional[str] = Field(default=None, max_length=64)
    pay_type: Optional[PayType] = None
    base_salary: Optional[float] = Field(default=None, ge=0)
    daily_rate: Optional[float] = Field(default=None, ge=0)
    status: Optional[str] = Field(default=None, pattern="^(active|inactive)$")


class EmployeeRead(BaseModel):
    id: str
    code: str
    name: str
    department: str
    job_title: str
    pay_type: PayType = "monthly"
    base_salary: float
    daily_rate: Optional[float] = None
    status: str
    hire_date: datetime


class AttendanceCreate(BaseModel):
    employee_id: str
    attendance_date: datetime
    status: str = Field(pattern="^(present|late|absent_permitted|absent_unpermitted)$")
    delay_minutes: int = Field(default=0, ge=0)
    overtime_hours: float = Field(default=0.0, ge=0)
    notes: str = Field(default="", max_length=1000)


class AttendanceRead(BaseModel):
    id: str
    employee_id: str
    employee_name: str
    employee_code: str
    attendance_date: datetime
    status: str
    delay_minutes: int
    overtime_hours: float
    notes: str
    recorded_by: str
    created_at: datetime


class PayPeriodCreate(BaseModel):
    period_name: str = Field(min_length=1, max_length=64)
    start_date: datetime
    end_date: datetime


class PayPeriodRead(BaseModel):
    id: str
    period_name: str
    start_date: datetime
    end_date: datetime
    status: str
    runs_count: int = 0
    total_net_amount: float = 0.0


class PayrollCalculateRequest(BaseModel):
    """إعداد الكشف لموظفين محددين؛ بدون قائمة = كل الموظفين النشطين."""
    employee_ids: Optional[List[str]] = Field(default=None, max_length=1000)


# ─── بنود الحوافز والخصومات ─────────────────────────────────────────────────

ItemCategory = Literal[
    "incentive_fixed",
    "incentive_percent",
    "incentive_other",
    "absence_permitted",
    "absence_unpermitted",
    "late_hours",
    "penalty",
    "other_deduction",
]
CalcMethod = Literal["fixed", "percent", "quantity"]

# نوع كل فئة وطرق الحساب المسموحة لها، واسمها الافتراضي بالعربية
ITEM_CATEGORIES: Dict[str, Dict] = {
    "incentive_fixed": {"kind": "incentive", "methods": ("fixed",), "label": "حافز بمبلغ ثابت"},
    "incentive_percent": {"kind": "incentive", "methods": ("percent",), "label": "حافز بنسبة من الأجر الأساسي"},
    "incentive_other": {"kind": "incentive", "methods": ("fixed", "quantity", "percent"), "label": "إضافة أخرى"},
    "absence_permitted": {"kind": "deduction", "methods": ("quantity", "fixed"), "label": "غياب بإذن"},
    "absence_unpermitted": {"kind": "deduction", "methods": ("quantity", "fixed"), "label": "غياب بدون إذن"},
    "late_hours": {"kind": "deduction", "methods": ("quantity", "fixed"), "label": "تأخير بالساعات"},
    "penalty": {"kind": "deduction", "methods": ("fixed", "percent"), "label": "غرامة / جزاء"},
    "other_deduction": {"kind": "deduction", "methods": ("fixed", "quantity", "percent"), "label": "خصم آخر"},
}


class PayrollItemCreate(BaseModel):
    category: ItemCategory
    calc_method: CalcMethod
    # fixed: المبلغ | percent: النسبة المئوية | quantity: قيمة الوحدة (اليوم/الساعة)
    value: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    quantity: Optional[Decimal] = Field(default=None, gt=0, max_digits=10, decimal_places=2)
    label: str = Field(default="", max_length=128)
    notes: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def validate_method(self):
        spec = ITEM_CATEGORIES[self.category]
        if self.calc_method not in spec["methods"]:
            raise ValueError("طريقة الحساب غير مناسبة لهذا البند.")
        if self.calc_method == "quantity" and self.quantity is None:
            raise ValueError("أدخل العدد (أيام أو ساعات) لحساب البند بالكمية.")
        if self.calc_method == "percent" and self.value > 100:
            raise ValueError("النسبة المئوية لا تتجاوز 100%.")
        if self.category in ("incentive_other", "other_deduction") and not self.label.strip():
            raise ValueError("اكتب اسم البند (مثال: بدل انتقال، خصم عهدة).")
        return self


class PayrollItemRead(BaseModel):
    id: str
    kind: str
    category: str
    label: str
    calc_method: str
    quantity: Optional[float] = None
    value: float
    percent_base: Optional[float] = None
    amount: float
    notes: str
    created_by: str
    created_at: datetime


class PayrollWorkDaysUpdate(BaseModel):
    work_days: Decimal = Field(ge=0, le=31, max_digits=6, decimal_places=2)


class PayrollRunRead(BaseModel):
    id: str
    period_id: str
    employee_id: str
    employee_name: str
    employee_code: str
    department: str
    pay_type: str = "monthly"
    rate_amount: float = 0.0
    work_days: Optional[float] = None
    base_amount: float
    overtime_amount: float
    bonus_amount: float
    deductions_amount: float
    advances_amount: float
    gross_amount: float = 0.0
    total_deductions: float = 0.0
    net_amount: float
    status: str
    cash_document_id: Optional[str] = None
    notes: str
    items: List[PayrollItemRead] = []


class PayrollPeriodDetailRead(BaseModel):
    period: PayPeriodRead
    runs: List[PayrollRunRead]
    total_base: float
    total_overtime: float
    total_bonus: float
    total_deductions: float
    total_advances: float
    total_net: float
    total_gross: float = 0.0
    # إجمالي كل فئة بند في الفترة (غياب بإذن، تأخير، غرامات…)
    category_totals: Dict[str, float] = {}
