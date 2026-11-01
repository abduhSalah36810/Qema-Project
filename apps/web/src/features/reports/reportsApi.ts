/**
 * واجهة استدعاء خدمات التقارير (Reports API Client)
 */
import { apiClient } from '@/lib/api';

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

export const reportsApi = {
  getSummary: (period: string = 'monthly') =>
    apiClient.request<SummaryReport>(`/api/v1/reports/summary?period=${encodeURIComponent(period)}`),

  getInventoryReport: (warehouse_code?: string) => {
    const params = warehouse_code ? `?warehouse_code=${encodeURIComponent(warehouse_code)}` : '';
    return apiClient.request<{ items: unknown[]; total_items: number }>(`/api/v1/reports/inventory${params}`);
  },

  getFinancialReport: (since_days: number = 30) =>
    apiClient.request<unknown>(`/api/v1/reports/financial?since_days=${since_days}`),
};
