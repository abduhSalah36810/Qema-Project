import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReportsView } from './ReportsView';
import { reportsApi, type SummaryReport, type FinancialReport, type InventoryReport } from './reportsApi';
import { AuthProvider } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';

vi.mock('./reportsApi', () => ({
  reportsApi: {
    getSummary: vi.fn(),
    getFinancialReport: vi.fn(),
    getInventoryReport: vi.fn(),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

const mockSummaryData: SummaryReport = {
  period: 'monthly',
  generated_at: '2026-11-01T12:00:00Z',
  treasury: {
    balance: 145000.5,
    petty_cash_total: 12500,
    revenues_period: 320000,
    expenses_period: 210000,
    net_period: 110000,
  },
  production: {
    active_orders: 5,
    completed_orders_period: 12,
  },
  inventory: {
    raw_material_distinct_items: 48,
    finished_goods_distinct_items: 14,
  },
  payables: {
    supplier_payables: 65000,
  },
};

const mockFinancialData: FinancialReport = {
  since_days: 30,
  since: '2026-10-01T12:00:00Z',
  revenues: {
    total: 320000,
    count: 2,
    documents: [
      {
        id: 'doc-rev-1',
        number: 'CSH-REC-2026-001',
        amount: 200000,
        description: 'دفعة نقدية من شركة الأمل',
        occurred_at: '2026-10-15T10:30:00Z',
      },
      {
        id: 'doc-rev-2',
        number: 'CSH-REC-2026-002',
        amount: 120000,
        description: 'تحصيل نقدي مبيعات محلات التوحيد',
        occurred_at: '2026-10-22T14:15:00Z',
      },
    ],
  },
  expenses: {
    total: 210000,
    count: 1,
    documents: [
      {
        id: 'doc-exp-1',
        number: 'CSH-PAY-2026-001',
        amount: 210000,
        description: 'سداد دفعة نقدية لمورد الأقمشة المصرية',
        occurred_at: '2026-10-18T11:00:00Z',
      },
    ],
  },
  net: 110000,
};

const mockInventoryData: InventoryReport = {
  total_items: 2,
  items: [
    {
      item_id: 'it-1',
      item_code: 'FAB-COTTON-01',
      item_name_ar: 'قماش قطن مصري 100%',
      warehouse_id: 'wh-1',
      warehouse_name: 'مخزن الخامات الرئيسي',
      balance: 450,
      low_stock: false,
    },
    {
      item_id: 'it-2',
      item_code: 'BTN-PEARL-18',
      item_name_ar: 'أزرار صدفية مقاس 18',
      warehouse_id: 'wh-1',
      warehouse_name: 'مخزن الخامات الرئيسي',
      balance: 0, // Real zero balance
      low_stock: true,
    },
  ],
};

function renderWithAuth(ui: React.ReactElement) {
  return render(<AuthProvider>{ui}</AuthProvider>);
}

describe('Reports Experience — Frontend Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Summary tab with correct cash-basis indicators (strictly not accounting revenue)', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryData);

    renderWithAuth(<ReportsView initialTab="summary" />);

    // Shows loading state initially
    expect(screen.getByText(/جاري استخراج وتجميع المؤشرات/i)).toBeInTheDocument();

    await waitFor(() => {
      // Must state cash-basis semantics
      expect(screen.getByText(/الأساس النقدي الفعلي/i)).toBeInTheDocument();
      expect(screen.getByText(/المقبوضات النقدية للفترة/i)).toBeInTheDocument();
      expect(screen.getByText(/صافي التدفق النقدي للفترة/i)).toBeInTheDocument();
      expect(screen.getByText(/إجمالي السيولة النقدية المتاحة/i)).toBeInTheDocument();
    });

    // Check numbers and currency formatting
    const revStr = (320000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const expStr = (210000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const netStr = (110000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const payStr = (65000).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const rawItemsStr = (48).toLocaleString('ar-EG');

    expect(screen.getAllByText(new RegExp(revStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(expStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(netStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(payStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(`${rawItemsStr} صنفًا`))).toBeInTheDocument();

    // Chart presence
    expect(screen.getByText(/ميزان التدفق النقدي التشغيلي والسيولة/i)).toBeInTheDocument();
  });

  it('switches period filter and triggers updated API request', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValue(mockSummaryData);

    renderWithAuth(<ReportsView initialTab="summary" />);

    await waitFor(() => {
      expect(screen.getByText(/الفترة النشطة:/i)).toBeInTheDocument();
    });

    // Click quarterly filter button
    fireEvent.click(screen.getByRole('button', { name: 'ربع سنوي' }));

    await waitFor(() => {
      expect(reportsApi.getSummary).toHaveBeenCalledWith('quarterly');
      expect(screen.getByText(/الربع سنوي/i)).toBeInTheDocument();
    });
  });

  it('renders error state with retry action when API request fails', async () => {
    vi.mocked(reportsApi.getSummary).mockRejectedValueOnce(
      new ApiError('فشل الاتصال بخادم التقارير', { status: 500, isNetworkError: true })
    );

    renderWithAuth(<ReportsView initialTab="summary" />);

    await waitFor(() => {
      expect(screen.getByText(/خطأ تحميل:/i)).toBeInTheDocument();
      expect(screen.getByText(/فشل الاتصال بخادم التقارير/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
    });

    // Retry should trigger another load
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryData);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    await waitFor(() => {
      expect(screen.getByText(/المقبوضات النقدية للفترة/i)).toBeInTheDocument();
    });
  });

  it('renders 403 access-denied state when user lacks permissions', async () => {
    vi.mocked(reportsApi.getSummary).mockRejectedValueOnce(
      new ApiError('Forbidden', { status: 403 })
    );

    renderWithAuth(<ReportsView initialTab="summary" />);

    await waitFor(() => {
      expect(screen.getByText(/خطأ صلاحية \(403\):/i)).toBeInTheDocument();
      expect(screen.getByText(/لا يملك صلاحية عرض الملخص التشغيلي/i)).toBeInTheDocument();
    });
  });

  it('renders Cash Documents Journal in Financial tab with tables and formatted currency', async () => {
    vi.mocked(reportsApi.getFinancialReport).mockResolvedValueOnce(mockFinancialData);

    renderWithAuth(<ReportsView initialTab="financial" />);

    await waitFor(() => {
      expect(screen.getByText(/إجمالي المقبوضات النقدية/i)).toBeInTheDocument();
      expect(screen.getByText(/CSH-REC-2026-001/i)).toBeInTheDocument();
      expect(screen.getByText(/دفعة نقدية من شركة الأمل/i)).toBeInTheDocument();
      expect(screen.getByText(/CSH-PAY-2026-001/i)).toBeInTheDocument();
      expect(screen.getByText(/سداد دفعة نقدية لمورد الأقمشة المصرية/i)).toBeInTheDocument();
      expect(screen.getByText(/ميزان المقبوضات والمصروفات النقدية/i)).toBeInTheDocument();
    });
  });

  it('filters financial documents by type (inflow vs outflow)', async () => {
    vi.mocked(reportsApi.getFinancialReport).mockResolvedValue(mockFinancialData);

    renderWithAuth(<ReportsView initialTab="financial" />);

    await waitFor(() => {
      expect(screen.getByText(/CSH-REC-2026-001/i)).toBeInTheDocument();
      expect(screen.getByText(/CSH-PAY-2026-001/i)).toBeInTheDocument();
    });

    // Filter by inflow only
    fireEvent.click(screen.getByRole('button', { name: 'مقبوضات فقط' }));
    expect(screen.getByText(/CSH-REC-2026-001/i)).toBeInTheDocument();
    expect(screen.queryByText(/CSH-PAY-2026-001/i)).not.toBeInTheDocument();

    // Filter by outflow only
    fireEvent.click(screen.getByRole('button', { name: 'مصروفات فقط' }));
    expect(screen.queryByText(/CSH-REC-2026-001/i)).not.toBeInTheDocument();
    expect(screen.getByText(/CSH-PAY-2026-001/i)).toBeInTheDocument();
  });

  it('renders Stock Balances in Inventory tab distinguishing real zero from missing data', async () => {
    vi.mocked(reportsApi.getInventoryReport).mockResolvedValueOnce(mockInventoryData);

    renderWithAuth(<ReportsView initialTab="inventory" />);

    await waitFor(() => {
      expect(screen.getByText(/FAB-COTTON-01/i)).toBeInTheDocument();
      expect(screen.getByText(/قماش قطن مصري 100%/i)).toBeInTheDocument();
      expect(screen.getByText((450).toLocaleString('ar-EG'))).toBeInTheDocument();
      expect(screen.getByText(/متاح للتشغيل/i)).toBeInTheDocument();

      // BTN-PEARL-18 has balance 0 and low_stock true
      expect(screen.getByText(/BTN-PEARL-18/i)).toBeInTheDocument();
      expect(screen.getByText((0).toLocaleString('ar-EG'))).toBeInTheDocument();
      expect(screen.getByText(/رصيد نافد أو حرج/i)).toBeInTheDocument();
      // Visual indicator present
      expect(screen.getByText(/مؤشر كفاية المخزون ونسبة الأصناف الحرجة/i)).toBeInTheDocument();
    });
  });

  it('triggers warehouse filter switch in Inventory tab', async () => {
    vi.mocked(reportsApi.getInventoryReport).mockResolvedValue(mockInventoryData);

    renderWithAuth(<ReportsView initialTab="inventory" />);

    await waitFor(() => {
      expect(screen.getByText(/المخزن المستهدف:/i)).toBeInTheDocument();
    });

    // Change warehouse dropdown
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'finished_goods' } });

    await waitFor(() => {
      expect(reportsApi.getInventoryReport).toHaveBeenCalledWith('finished_goods');
    });
  });

  it('displays empty state when financial report has no transactions', async () => {
    vi.mocked(reportsApi.getFinancialReport).mockResolvedValueOnce({
      since_days: 7,
      since: '2026-10-25T12:00:00Z',
      revenues: { total: 0, count: 0, documents: [] },
      expenses: { total: 0, count: 0, documents: [] },
      net: 0,
    });

    renderWithAuth(<ReportsView initialTab="financial" />);

    await waitFor(() => {
      expect(screen.getByText(/لا توجد سندات مقبوضات نقدية مسجلة/i)).toBeInTheDocument();
      expect(screen.getByText(/لا توجد سندات مدفوعات أو مصروفات نقدية مسجلة/i)).toBeInTheDocument();
    });
  });

  it('isolates tab failures so failure of financial report does not crash other tabs', async () => {
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryData);
    vi.mocked(reportsApi.getFinancialReport).mockRejectedValueOnce(
      new ApiError('خطأ في تحميل التقرير المالي', { status: 500 })
    );

    renderWithAuth(<ReportsView initialTab="summary" />);

    await waitFor(() => {
      expect(screen.getByText(/المقبوضات النقدية للفترة/i)).toBeInTheDocument();
    });

    // Switch to financial tab
    fireEvent.click(screen.getByRole('tab', { name: /المقبوضات والمصروفات النقدية/i }));

    await waitFor(() => {
      expect(screen.getByText(/خطأ تحميل:/i)).toBeInTheDocument();
      expect(screen.getByText(/خطأ في تحميل التقرير المالي/i)).toBeInTheDocument();
    });

    // Switch back to summary tab — remains functional!
    vi.mocked(reportsApi.getSummary).mockResolvedValueOnce(mockSummaryData);
    fireEvent.click(screen.getByRole('tab', { name: /الملخص التشغيلي والسيولة/i }));

    await waitFor(() => {
      expect(screen.getByText(/المقبوضات النقدية للفترة/i)).toBeInTheDocument();
    });
  });
});
