from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field


class EmployeeCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    department: str = Field(default="production", max_length=64)
    job_title: str = Field(default="", max_length=64)
    base_salary: float = Field(default=0.0, ge=0)


class EmployeeUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=128)
    department: Optional[str] = Field(default=None, max_length=64)
    job_title: Optional[str] = Field(default=None, max_length=64)
    base_salary: Optional[float] = Field(default=None, ge=0)
    status: Optional[str] = Field(default=None, pattern="^(active|inactive)$")


class EmployeeRead(BaseModel):
    id: str
    code: str
    name: str
    department: str
    job_title: str
    base_salary: float
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


class PayrollRunRead(BaseModel):
    id: str
    period_id: str
    employee_id: str
    employee_name: str
    employee_code: str
    department: str
    base_amount: float
    overtime_amount: float
    bonus_amount: float
    deductions_amount: float
    advances_amount: float
    net_amount: float
    status: str
    cash_document_id: Optional[str] = None
    notes: str


class PayrollPeriodDetailRead(BaseModel):
    period: PayPeriodRead
    runs: List[PayrollRunRead]
    total_base: float
    total_overtime: float
    total_bonus: float
    total_deductions: float
    total_advances: float
    total_net: float

