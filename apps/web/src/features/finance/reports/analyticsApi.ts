/**
 * واجهة التحليلات المالية: فترات بالتقويم (تُفسَّر بتوقيت القاهرة في الخادم) ومقارنة بالفترة السابقة.
 */
import { apiClient } from '@/lib/api';
import { REPORT_OPTIONS } from '../financeApi';

export interface Period {
  from: string; // YYYY-MM-DD
  to: string;
}

export type PeriodPreset = 'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'last_30' | 'custom';

export const PRESET_LABELS: Record<PeriodPreset, string> = {
  this_month: 'هذا الشهر',
  last_month: 'الشهر السابق',
  this_quarter: 'هذا الربع',
  this_year: 'هذه السنة',
  last_30: 'آخر 30 يوماً',
  custom: 'فترة مخصصة',
};

/** توقيت المرجع للخادم (analytics.py يحسب حدود الفترات بتقويم القاهرة). */
const CAIRO_TZ = 'Africa/Cairo';

const pad = (n: number) => String(n).padStart(2, '0');

/** تاريخ اليوم بتقويم القاهرة بصيغة YYYY-MM-DD بمعزل عن توقيت متصفح المستخدم. */
export function cairoToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** إزاحة شهرية على مركّبات التاريخ (y و m 1-based) دون المرور بتوقيت المتصفح. */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const zeroBased = m - 1 + delta;
  return { y: y + Math.floor(zeroBased / 12), m: ((zeroBased % 12) + 12) % 12 + 1 };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** جمع/طرح أيام على تاريخ ISO بحساب UTC صرف (لا انزياح بتوقيت المتصفح). */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * حدود الفترة المسبقة بتقويم القاهرة (مطابقة للخادم) لا بتوقيت متصفح المستخدم،
 * حتى لا تنزاح الفترات قرب منتصف الليل وحدود الشهر في المناطق الزمنية الأخرى.
 */
export function presetPeriod(preset: Exclude<PeriodPreset, 'custom'>, now = new Date()): Period {
  const today = cairoToday(now);
  const [y, m] = today.split('-').map(Number);
  switch (preset) {
    case 'last_month': {
      const start = shiftMonth(y, m, -1);
      return { from: `${start.y}-${pad(start.m)}-01`, to: `${start.y}-${pad(start.m)}-${pad(daysInMonth(start.y, start.m))}` };
    }
    case 'this_quarter': {
      const startMonth = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${y}-${pad(startMonth)}-01`, to: today };
    }
    case 'this_year':
      return { from: `${y}-01-01`, to: today };
    case 'last_30':
      return { from: addDays(today, -29), to: today };
    default:
      return { from: `${y}-${pad(m)}-01`, to: today };
  }
}

export function periodQuery(p: Period): string {
  return `date_from=${encodeURIComponent(p.from)}&date_to=${encodeURIComponent(p.to)}`;
}

export function formatPeriod(p: { date_from: string; date_to: string } | Period | null | undefined): string {
  if (!p) return '—';
  const from = 'from' in p ? p.from : p.date_from;
  const to = 'to' in p ? p.to : p.date_to;
  const f = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' });
  return from === to ? f(from) : `${f(from)} – ${f(to)}`;
}

export const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export function monthLabel(ym: string, withYear = false): string {
  const [y, m] = ym.split('-').map(Number);
  return withYear ? `${MONTHS_AR[m - 1]} ${y}` : MONTHS_AR[m - 1];
}

export interface Kpi {
  key: string;
  label: string;
  value: number;
  previous: number;
  change_pct: number | null;
}

export interface MonthlyPoint {
  month: string;
  inflows: number;
  outflows: number;
  sales: number;
  cogs: number;
  operating_expenses: number;
  payroll: number;
  net_cash: number;
  gross_profit: number;
}

export interface OverviewReport {
  period: { date_from: string; date_to: string };
  previous_period: { date_from: string; date_to: string };
  kpis: Kpi[];
  position: { treasury_balance: number; custody_balance: number; receivables: number; receivables_overdue_90: number; payables: number };
  monthly: MonthlyPoint[];
  expense_breakdown: Array<{ category: string; amount: number; percentage: number }>;
  gross_margin_pct: number | null;
}

export interface AgingRow {
  party_id: string;
  code: string;
  name: string;
  phone: string;
  oldest_days: number;
  '0_30': number;
  '31_60': number;
  '61_90': number;
  '90_plus': number;
  total: number;
}

export interface AgingReport {
  party: 'customers' | 'suppliers';
  as_of: string;
  buckets: Array<{ key: '0_30' | '31_60' | '61_90' | '90_plus'; label: string }>;
  rows: AgingRow[];
  totals: Record<'0_30' | '31_60' | '61_90' | '90_plus' | 'total', number>;
}

export interface SalesGroupRow {
  key: string;
  label: string;
  quantity: number;
  net_sales: number;
  avg_price: number;
  orders_count: number;
  share_pct: number;
}

export interface SalesReport {
  period: { date_from: string; date_to: string };
  summary: {
    net_sales: number;
    quantity: number;
    avg_price: number;
    returns_value: number;
    customers_count: number;
    orders_value: number;
    discounts: number;
    discount_pct: number;
  };
  by_customer: SalesGroupRow[];
  by_model: SalesGroupRow[];
  by_size: SalesGroupRow[];
}

export interface ProfitRow {
  product_id: string;
  code: string;
  name: string;
  quantity: number;
  net_sales: number;
  cogs: number;
  gross_profit: number;
  margin_pct: number | null;
  unit_price: number;
  unit_cost: number;
}

export interface ProfitabilityReport {
  period: { date_from: string; date_to: string };
  rows: ProfitRow[];
  totals: { net_sales: number; cogs: number; gross_profit: number; margin_pct: number | null };
  note: string;
}

export interface PayrollCostReport {
  monthly: Array<{ month: string; total: number; headcount: number; sales: number; ratio_to_sales_pct: number | null; departments: Record<string, number> }>;
  departments: Array<{ department: string; total: number; share_pct: number }>;
  total: number;
}

export interface LossesReport {
  period: { date_from: string; date_to: string };
  total_loss: number;
  stocktake_surplus: number;
  defects_count: number;
  by_type: Array<{ type: string; value: number; share_pct: number }>;
  items: Array<{ type: string; item_code: string; item_name: string; unit: string; quantity: number; value: number }>;
}

export interface StockHealthRow {
  item_id: string;
  code: string;
  name: string;
  unit: string;
  balance: number;
  value: number;
  last_movement: string | null;
  idle_days: number | null;
  reorder_level?: number;
  shortfall?: number;
}

export interface StockHealthReport {
  idle_days: number;
  slow_moving: StockHealthRow[];
  below_reorder: StockHealthRow[];
  totals: { slow_value: number; slow_count: number; below_count: number };
}

const base = '/api/v1/reports/analytics';

export const analyticsApi = {
  overview: (p: Period) => apiClient.request<OverviewReport>(`${base}/overview?${periodQuery(p)}`, REPORT_OPTIONS),
  aging: (party: 'customers' | 'suppliers') => apiClient.request<AgingReport>(`${base}/aging?party=${party}`, REPORT_OPTIONS),
  sales: (p: Period) => apiClient.request<SalesReport>(`${base}/sales?${periodQuery(p)}`, REPORT_OPTIONS),
  profitability: (p: Period) => apiClient.request<ProfitabilityReport>(`${base}/model-profitability?${periodQuery(p)}`, REPORT_OPTIONS),
  payroll: (months = 12) => apiClient.request<PayrollCostReport>(`${base}/payroll-cost?months=${months}`, REPORT_OPTIONS),
  losses: (p: Period) => apiClient.request<LossesReport>(`${base}/losses?${periodQuery(p)}`, REPORT_OPTIONS),
  stockHealth: (idleDays = 60) => apiClient.request<StockHealthReport>(`${base}/stock-health?idle_days=${idleDays}`, REPORT_OPTIONS),
};
