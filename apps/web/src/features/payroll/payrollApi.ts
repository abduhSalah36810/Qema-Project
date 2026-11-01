/**
 * واجهة استدعاء خدمات الرواتب والموارد البشرية (Payroll API Client)
 */
import { apiClient } from '@/lib/api';

export interface Employee {
  id: string;
  code: string;
  name: string;
  department: string;
  job_title: string;
  base_salary: number;
  status: 'active' | 'inactive';
  hire_date?: string;
}

export interface EmployeeCreate {
  code: string;
  name: string;
  department: string;
  job_title: string;
  base_salary: number;
}

export interface AttendanceRecord {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  attendance_date: string;
  status: 'present' | 'absent_permitted' | 'absent_unpermitted' | 'on_leave';
  delay_minutes: number;
  overtime_hours: number;
  notes: string;
  recorded_by: string;
  created_at: string;
}

export interface AttendanceCreate {
  employee_id: string;
  attendance_date: string;
  status: string;
  delay_minutes: number;
  overtime_hours: number;
  notes: string;
}

export interface PayPeriod {
  id: string;
  period_name: string;
  start_date: string;
  end_date: string;
  status: 'draft' | 'calculated' | 'paid' | 'closed';
  runs_count: number;
  total_net_amount: number;
}

export interface PayrollRun {
  id: string;
  period_id: string;
  employee_id: string;
  employee_name: string;
  employee_code: string;
  department: string;
  base_amount: number;
  overtime_amount: number;
  bonus_amount: number;
  deductions_amount: number;
  advances_amount: number;
  net_amount: number;
  status: string;
  cash_document_id?: string;
  notes: string;
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
}

export const payrollApi = {
  listEmployees: () =>
    apiClient.request<Employee[]>('/api/v1/payroll/employees'),

  createEmployee: (data: EmployeeCreate) =>
    apiClient.request<Employee>('/api/v1/payroll/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  listAttendance: (employee_id?: string) => {
    const params = employee_id ? `?employee_id=${encodeURIComponent(employee_id)}` : '';
    return apiClient.request<AttendanceRecord[]>(`/api/v1/payroll/attendance${params}`);
  },

  recordAttendance: (data: AttendanceCreate) =>
    apiClient.request<AttendanceRecord>('/api/v1/payroll/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  listPeriods: () =>
    apiClient.request<PayPeriod[]>('/api/v1/payroll/periods'),

  createPeriod: (data: { period_name: string; start_date: string; end_date: string }) =>
    apiClient.request<PayPeriod>('/api/v1/payroll/periods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  calculatePeriod: (period_id: string) =>
    apiClient.request<PayrollPeriodDetail>(`/api/v1/payroll/periods/${period_id}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),

  getPeriodRuns: (period_id: string) =>
    apiClient.request<PayrollPeriodDetail>(`/api/v1/payroll/periods/${period_id}/runs`),

  disbursePeriod: (period_id: string) =>
    apiClient.request<PayrollPeriodDetail>(`/api/v1/payroll/periods/${period_id}/disburse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
};
