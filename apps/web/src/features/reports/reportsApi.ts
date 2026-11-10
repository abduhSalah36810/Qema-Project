/**
 * واجهة استدعاء خدمات التقارير (Reports API Client)
 * ─────────────────────────────────────────────────────────────────────────────
 * تغطي:
 * 1. الملخص التشغيلي والسيولة GET /api/v1/reports/summary (reports:view)
 * 2. تقرير أرصدة المخزون GET /api/v1/reports/inventory (inventory:view)
 * 3. التقرير المالي وحركات النقدية GET /api/v1/reports/financial (finance:reports:view)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { apiClient } from '@/lib/api';

export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface SummaryReport {
  period: string;
  generated_at: string;
  treasury: {
    balance: number;
    petty_cash_total: number;
    revenues_period: number;
    expenses_period: number;
    net_period: number;
  };
  production: {
    active_orders: number;
    completed_orders_period: number;
  };
  inventory: {
    raw_material_distinct_items: number;
    finished_goods_distinct_items: number;
  };
  payables: {
    supplier_payables: number;
  };
}

export interface InventoryReportItem {
  item_id: string;
  item_code: string;
  item_name_ar: string;
  warehouse_id: string;
  warehouse_name: string;
  balance: number;
  low_stock: boolean;
}

export interface InventoryReport {
  items: InventoryReportItem[];
  total_items: number;
}

export interface FinancialDocument {
  id: string;
  number: string;
  amount: number;
  description: string | null;
  occurred_at: string | null;
}

export interface FinancialReport {
  since_days: number;
  since: string;
  revenues: {
    total: number;
    count: number;
    documents: FinancialDocument[];
  };
  expenses: {
    total: number;
    count: number;
    documents: FinancialDocument[];
  };
  net: number;
}

export const reportsApi = {
  /**
   * استرجاع الملخص التشغيلي والسيولة
   */
  getSummary: (period: ReportPeriod | string = 'monthly') =>
    apiClient.request<SummaryReport>(`/api/v1/reports/summary?period=${encodeURIComponent(period)}`),

  /**
   * استرجاع تقرير أرصدة الأصناف بالمخازن
   */
  getInventoryReport: (warehouse_code?: string) => {
    const params = warehouse_code && warehouse_code !== 'all' ? `?warehouse_code=${encodeURIComponent(warehouse_code)}` : '';
    return apiClient.request<InventoryReport>(`/api/v1/reports/inventory${params}`);
  },

  /**
   * استرجاع التقرير المالي وسجلات المقبوضات والمصروفات النقدية
   */
  getFinancialReport: (since_days: number = 30) =>
    apiClient.request<FinancialReport>(`/api/v1/reports/financial?since_days=${since_days}`),
};
