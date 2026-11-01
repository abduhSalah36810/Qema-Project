import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OperationsBoard } from './OperationsBoard';
import { reportsApi, type SummaryReport } from '../reports/reportsApi';
import { apiClient, ApiError } from '@/lib/api';
import { AuthProvider } from '@/features/auth/AuthContext';

vi.mock('../reports/reportsApi', () => ({
  reportsApi: {
    getSummary: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

const mockSummaryReport: SummaryReport = {
  period: 'monthly',
  generated_at: '2026-11-01T15:30:00Z',
  treasury: {
    balance: 85400,
    petty_cash_total: 9200,
    revenues_period: 175000,
    expenses_period: 98000,
    net_period: 77000,
  },
  production: {
    active_orders: 3,
    completed_orders_period: 7,
  },
  inventory: {
    raw_material_distinct_items: 64,
    finished_goods_distinct_items: 18,
  },
  payables: {
    supplier_payables: 42000,
  },
};

describe('OperationsBoard Critical Data Integrity & Dashboard Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiClient, 'request').mockResolvedValue([]);
  });

  it('renders loading state without displaying fake demo figures during initial load', async () => {
    // Keep promise pending
    vi.mocked(reportsApi.getSummary).mockReturnValue(new Promise(() => {}));

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    // Operational & Financial section titles are present
    expect(screen.getByText('المؤشرات التشغيلية للمصنع')).toBeInTheDocument();
    expect(screen.getByText(/مؤشرات السيولة النقدية والتدفقات/i)).toBeInTheDocument();

    // Verify it does NOT display demo figures (e.g. 124 صنفًا or 514 قطعة)
    expect(screen.queryByText('١٢٤ صنفًا')).not.toBeInTheDocument();
    expect(screen.queryByText('٥١٤ قطعة')).not.toBeInTheDocument();
  });

  it('renders live KPI figures populated from server response with Egyptian currency and counts', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryReport);

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    await waitFor(() => {
      // Raw materials count
      expect(screen.getByText(new RegExp(`${(64).toLocaleString('ar-EG')} صنفًا`))).toBeInTheDocument();
      // Active production orders
      expect(screen.getByText(new RegExp(`${(3).toLocaleString('ar-EG')} أمر`))).toBeInTheDocument();
      // Finished goods count
      expect(screen.getByText(new RegExp(`${(18).toLocaleString('ar-EG')} صنفًا`))).toBeInTheDocument();
      // Total available cash (85400 + 9200 = 94600)
      const cashStr = (94600).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getByText(new RegExp(cashStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
      // Net cash flow
      const netStr = (77000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getByText(new RegExp(netStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
      // Supplier payables
      const payStr = (42000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getByText(new RegExp(payStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    });
  });

  it('strictly displays error state on API failure and NEVER falls back to demo metrics or zeros', async () => {
    vi.mocked(reportsApi.getSummary).mockRejectedValueOnce(
      new ApiError('فشل الاتصال بقاعدة البيانات', { status: 500, isNetworkError: true })
    );

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    await waitFor(() => {
      // Error alerts are rendered
      const errorElements = screen.getAllByRole('alert');
      expect(errorElements.length).toBeGreaterThan(0);
      expect(screen.getAllByText(/تعذر تحميل المؤشرات الحية:/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/لا يتم عرض بيانات تجريبية بديلة/i).length).toBeGreaterThan(0);
      // Retry buttons are provided
      expect(screen.getAllByRole('button', { name: /إعادة المحاولة/i }).length).toBeGreaterThan(0);
    });

    // Verify that demo numbers are NOT shown as actual data
    expect(screen.queryByText('١٢٤ صنفًا')).not.toBeInTheDocument();
    expect(screen.queryByText('٥١٤ قطعة')).not.toBeInTheDocument();

    // Now test retry
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryReport);
    fireEvent.click(screen.getAllByRole('button', { name: /إعادة المحاولة/i })[0]);

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`${(64).toLocaleString('ar-EG')} صنفًا`))).toBeInTheDocument();
    });
  });

  it('preserves KPI cards when orders fetch fails independently', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryReport);
    vi.spyOn(apiClient, 'request').mockRejectedValueOnce(
      new ApiError('خطأ في استرجاع أوامر التشغيل', { status: 500 })
    );

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    await waitFor(() => {
      // KPIs are preserved and rendered successfully!
      expect(screen.getByText(new RegExp(`${(64).toLocaleString('ar-EG')} صنفًا`))).toBeInTheDocument();
      const cashStr = (94600).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getByText(new RegExp(cashStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
      // Orders section shows isolated error with retry
      expect(screen.getByText(/تعذر استرجاع أوامر التشغيل:/i)).toBeInTheDocument();
    });
  });
});
