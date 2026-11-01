import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OperationsBoard } from './OperationsBoard';
import { reportsApi, type SummaryReport } from '../reports/reportsApi';
import { apiClient, ApiError } from '@/lib/api';
import { AuthProvider } from '@/features/auth/AuthContext';
import type { ProductionOrder } from '../production/productionApi';

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

const mockOrders: ProductionOrder[] = [
  {
    id: 'ord-1',
    order_number: 'PRD-2026-001',
    product_id: 'p-1',
    product_name_ar: 'قميص أكسفورد كلاسيك',
    variant_id: 'v-1',
    variant_info: 'مقاس 42 أبيض',
    target_quantity: 200,
    season: 'صيف 2026',
    status: 'in_progress',
    created_by: 'أحمد محمود',
    assigned_to: 'خط التشغيل 1',
    created_at: '2026-10-28T08:00:00Z',
    notes: 'عاجل',
    materials: [],
    stage_events: [
      { id: 'se-1', stage_name: 'cutting', status: 'completed', actor_id: 'u-1', actor_name: 'عامل 1', timestamp: '2026-10-28T10:00:00Z', notes: '' },
      { id: 'se-2', stage_name: 'finishing', status: 'in_progress', actor_id: 'u-2', actor_name: 'عامل 2', timestamp: '2026-10-29T10:00:00Z', notes: '' },
    ],
  },
  {
    id: 'ord-2',
    order_number: 'PRD-2026-002',
    product_id: 'p-2',
    product_name_ar: 'بنطلون جبردين كاجوال',
    variant_id: 'v-2',
    variant_info: 'مقاس 34 كحلي',
    target_quantity: 150,
    season: 'صيف 2026',
    status: 'materials_dispatched',
    created_by: 'محمد علي',
    assigned_to: 'خط التشغيل 2',
    created_at: '2026-10-29T09:00:00Z',
    notes: '',
    materials: [],
    stage_events: [],
  },
];

describe('OperationsBoard Critical Data Integrity & Dashboard Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiClient, 'request').mockResolvedValue([]);
  });

  it('renders loading state without displaying fake demo figures during initial load', async () => {
    vi.mocked(reportsApi.getSummary).mockReturnValue(new Promise(() => {}));

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    // Operational & Financial section titles are present
    expect(screen.getByText('المؤشرات التشغيلية للمصنع')).toBeInTheDocument();
    expect(screen.getByText(/مؤشرات السيولة النقدية والتدفقات/i)).toBeInTheDocument();

    // Verify it does NOT display demo figures
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
      // Total available cash (85400 + 9200 = 94600) — appears in KPI card and CashFlowChart
      const cashStr = (94600).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getAllByText(new RegExp(cashStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
      // Net cash flow
      const netStr = (77000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getAllByText(new RegExp(netStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
      // Supplier payables
      const payStr = (42000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      expect(screen.getAllByText(new RegExp(payStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
    });

    // Terminology check
    expect(screen.getByText(/إجمالي السيولة النقدية المتاحة/i)).toBeInTheDocument();
    expect(screen.getByText(/المقبوضات التشغيلية للفترة/i)).toBeInTheDocument();
    expect(screen.getByText(/صافي التدفق النقدي للفترة/i)).toBeInTheDocument();
  });

  it('renders visual CashFlowChart and ProductionPipelineChart driven by actual API data', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryReport);
    vi.spyOn(apiClient, 'request').mockResolvedValueOnce(mockOrders);

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    await waitFor(() => {
      // CashFlowChart is rendered
      expect(screen.getByText(/ميزان التدفق النقدي التشغيلي والسيولة/i)).toBeInTheDocument();
      expect(screen.getByText(/مقارنة مؤشرات التدفق للفترة/i)).toBeInTheDocument();
      // ProductionPipelineChart is rendered
      expect(screen.getByText(/خط سير مراحل الإنتاج والتشغيل الحي/i)).toBeInTheDocument();
      // Order batches mapped properly
      expect(screen.getByText('PRD-2026-001 · خط التشغيل 1')).toBeInTheDocument();
      expect(screen.getByText('قميص أكسفورد كلاسيك')).toBeInTheDocument();
    });
  });

  it('dynamically derives operational alerts from real orders and payables', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryReport);
    vi.spyOn(apiClient, 'request').mockResolvedValueOnce(mockOrders);

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    await waitFor(() => {
      // Alert derived from order with materials_dispatched
      expect(screen.getByText(/أمر تم صرف خاماتها بانتظار استلام الورشة/i)).toBeInTheDocument();
      // Alert derived from supplier payables > 0
      expect(screen.getByText(/مستحقات فواتير خامات تستوجب السداد/i)).toBeInTheDocument();
    });
  });

  it('renders reassuring empty states when orders and alerts are clear without fake mock arrays', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce({
      ...mockSummaryReport,
      payables: { supplier_payables: 0 },
    });
    vi.spyOn(apiClient, 'request').mockResolvedValueOnce([]); // No orders

    render(
      <AuthProvider>
        <OperationsBoard />
      </AuthProvider>
    );

    await waitFor(() => {
      // Reassuring empty state in alert panel
      expect(screen.getByText(/لا توجد تنبيهات تشغيلية حرجة أو متأخرات معلقة للوردية الحالية/i)).toBeInTheDocument();
      // Clean empty state in batches grid
      expect(screen.getByText(/لا توجد دفعات تشغيل نشطة على خط الإنتاج حالياً/i)).toBeInTheDocument();
      // Clean empty state in deliveries
      expect(screen.getByText(/لا توجد تسليمات قادمة مستحقة خلال الأيام المقبلة/i)).toBeInTheDocument();
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
      expect(screen.getAllByText(new RegExp(cashStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
      // Orders section shows isolated error with retry
      expect(screen.getByText(/تعذر استرجاع أوامر التشغيل:/i)).toBeInTheDocument();
    });
  });
});
