/**
 * واجهة استدعاء خدمات الرواتب (Payroll API Client)
 * ─────────────────────────────────────────────────────────────────────────────
 * الصلاحيات في الخادم:
 * - العرض: finance:payroll:view
 * - الموظفون والحضور والفترات: finance:payroll:manage
 * - إعداد الكشف وتعديل القيم: finance:payroll:calculate
 * - التقديم للصرف (سند معلق في الخزينة): finance:payroll:disburse
 * نظام الأجر: شهري (راتب أساسي) أو يومية (أجر اليوم × أيام العمل المدخلة للفترة).
 * الحوافز والخصومات بنود يُدخلها المدير المالي صراحة لكل موظف في الفترة؛ لا يُطبَّق أي بند تلقائياً.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { apiClient } from '@/lib/api';

export type AttendanceStatus = 'present' | 'late' | 'absent_permitted' | 'absent_unpermitted';
export type PayType = 'monthly' | 'daily';
export type CalcMethod = 'fixed' | 'percent' | 'quantity';
export type ItemCategory =
  | 'incentive_fixed'
  | 'incentive_percent'
  | 'incentive_other'
  | 'absence_permitted'
  | 'absence_unpermitted'
  | 'late_hours'
  | 'penalty'
  | 'other_deduction';

export interface PayrollItem {
  id: string;
  kind: 'incentive' | 'deduction';
  category: ItemCategory;
  label: string;
  calc_method: CalcMethod;
  quantity: number | null;
  value: number;
  percent_base: number | null;
  amount: number;
  notes: string;
  created_by: string;
  created_at: string;
}

export interface PayrollItemCreate {
  category: ItemCategory;
  calc_method: CalcMethod;
  value: string;
  quantity?: string;
  label?: string;
  notes?: string;
}
export type PayPeriodStatus = 'draft' | 'calculated' | 'submitted' | 'paid' | 'closed';

export interface Employee {
  id: string;
  code: string;
  name: string;
  department: string;
  job_title: string;
  pay_type: PayType;
  base_salary: number;
  daily_rate: number | null;
  status: 'active' | 'inactive';
  hire_date?: string;
}

export interface EmployeeCreate {
  code: string;
  name: string;
  department: string;
  job_title: string;
  pay_type: PayType;
  base_salary: number;
  daily_rate?: number | null;
}

export interface AttendanceRecord {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  attendance_date: string;
  status: AttendanceStatus;
  delay_minutes: number;
  overtime_hours: number;
  notes: string;
  recorded_by: string;
  created_at: string;
}

export interface AttendanceCreate {
  employee_id: string;
  /** تاريخ اليوم بصيغة YYYY-MM-DD */
  attendance_date: string;
  status: AttendanceStatus;
  delay_minutes: number;
  overtime_hours: number;
  notes: string;
}

export interface PayPeriod {
  id: string;
  period_name: string;
  start_date: string;
  end_date: string;
  status: PayPeriodStatus;
  runs_count: number;
  total_net_amount: number;
}

export interface PayPeriodCreate {
  period_name: string;
  /** YYYY-MM-DD */
  start_date: string;
  /** YYYY-MM-DD */
  end_date: string;
}

export interface PayrollRun {
  id: string;
  period_id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  department: string;
  pay_type: PayType;
  rate_amount: number;
  work_days: number | null;
  base_amount: number;
  overtime_amount: number;
  bonus_amount: number;
  deductions_amount: number;
  advances_amount: number;
  gross_amount: number;
  total_deductions: number;
  net_amount: number;
  status: string;
  cash_document_id?: string | null;
  notes: string;
  items: PayrollItem[];
}

/** قيم صريحة معتمدة لموظف في الفترة: PATCH /payroll/periods/{pid}/runs/{rid} */
export interface PayrollRunAdjust {
  overtime_amount: string;
  /** البدلات والحوافز المعتمدة */
  bonus_amount: string;
  deductions_amount: string;
  advances_amount: string;
  reason: string;
}

export interface PayrollPeriodDetail {
  period: PayPeriod;
  runs: PayrollRun[];
  total_base: number;
  total_overtime: number;
  total_bonus: number;
  total_deductions: number;
  total_advances: number;
  total_net: number;
  total_gross: number;
  category_totals: Partial<Record<ItemCategory, number>>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** تحويل تاريخ اليوم YYYY-MM-DD إلى قيمة datetime يقبلها الخادم */
function toDateTime(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00` : day;
}

export const payrollApi = {
  listEmployees: () =>
    apiClient.request<Employee[]>('/api/v1/payroll/employees'),

  createEmployee: (data: EmployeeCreate) =>
    apiClient.request<Employee>('/api/v1/payroll/employees', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),

  updateEmployee: (employeeId: string, data: Partial<EmployeeCreate> & { status?: Employee['status'] }) =>
    apiClient.request<Employee>(`/api/v1/payroll/employees/${encodeURIComponent(employeeId)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    }),

  listAttendance: (employee_id?: string) => {
    const params = employee_id ? `?employee_id=${encodeURIComponent(employee_id)}` : '';
    return apiClient.request<AttendanceRecord[]>(`/api/v1/payroll/attendance${params}`);
  },

  recordAttendance: (data: AttendanceCreate) =>
    apiClient.request<AttendanceRecord>('/api/v1/payroll/attendance', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...data, attendance_date: toDateTime(data.attendance_date) }),
    }),

  listPeriods: () =>
    apiClient.request<PayPeriod[]>('/api/v1/payroll/periods'),

  createPeriod: (data: PayPeriodCreate) =>
    apiClient.request<PayPeriod>('/api/v1/payroll/periods', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        period_name: data.period_name,
        start_date: toDateTime(data.start_date),
        end_date: toDateTime(data.end_date),
      }),
    }),

  /** إعداد كشف الفترة للموظفين المحددين (أو كل النشطين): لقطة نظام الأجر فقط، بلا حوافز أو خصومات تلقائية */
  calculatePeriod: (period_id: string, employee_ids?: string[]) =>
    apiClient.request<PayrollPeriodDetail>(`/api/v1/payroll/periods/${encodeURIComponent(period_id)}/calculate`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(employee_ids ? { employee_ids } : {}),
    }),

  addItem: (period_id: string, run_id: string, data: PayrollItemCreate) =>
    apiClient.request<PayrollPeriodDetail>(
      `/api/v1/payroll/periods/${encodeURIComponent(period_id)}/runs/${encodeURIComponent(run_id)}/items`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data) }
    ),

  removeItem: (period_id: string, run_id: string, item_id: string) =>
    apiClient.request<PayrollPeriodDetail>(
      `/api/v1/payroll/periods/${encodeURIComponent(period_id)}/runs/${encodeURIComponent(run_id)}/items/${encodeURIComponent(item_id)}`,
      { method: 'DELETE' }
    ),

  setWorkDays: (period_id: string, run_id: string, work_days: string) =>
    apiClient.request<PayrollPeriodDetail>(
      `/api/v1/payroll/periods/${encodeURIComponent(period_id)}/runs/${encodeURIComponent(run_id)}/work-days`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ work_days }) }
    ),

  /** تنزيل كشف الفترة كملف Excel (ورقة ملخص + ورقة تفصيل البنود) */
  downloadPeriodXlsx: async (period_id: string, filename: string) => {
    const base = apiClient.getBaseUrl() || '';
    const url = `${base.replace(/\/$/, '')}/api/v1/payroll/periods/${encodeURIComponent(period_id)}/export.xlsx`;
    const token = apiClient.getAccessToken();
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
      let message = `تعذر تنزيل الملف (${response.status})`;
      try {
        const data = (await response.json()) as { detail?: string };
        if (data?.detail) message = data.detail;
      } catch {
        // ليس JSON
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  },

  getPeriodRuns: (period_id: string) =>
    apiClient.request<PayrollPeriodDetail>(`/api/v1/payroll/periods/${encodeURIComponent(period_id)}/runs`),

  adjustRun: (period_id: string, run_id: string, data: PayrollRunAdjust) =>
    apiClient.request<PayrollPeriodDetail>(
      `/api/v1/payroll/periods/${encodeURIComponent(period_id)}/runs/${encodeURIComponent(run_id)}`,
      {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(data),
      }
    ),

  /** تقديم الكشف للصرف: يُنشئ مستند صرف معلقاً في الخزينة؛ لا تُخصم النقدية إلا بعد اعتماده */
  submitPeriodForPayment: (period_id: string) =>
    apiClient.request<PayrollPeriodDetail>(`/api/v1/payroll/periods/${encodeURIComponent(period_id)}/disburse`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    }),
};
