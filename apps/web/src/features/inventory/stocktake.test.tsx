import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StocktakeView } from './StocktakeView';
import { StocktakeDetailView } from './StocktakeDetailView';
import { CreateStocktakeModal } from './CreateStocktakeModal';
import * as stocktakeApi from './stocktakeApi';
import * as productionApi from '@/features/production/productionApi';
import * as catalogApi from '@/features/catalog/catalogApi';
import { AuthProvider } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';

const mockHasPermission = vi.fn((_perm: string) => true);

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: mockHasPermission,
    roles: ['general_manager'],
    user: { id: 'test-user', email: 'test@qemma.com' },
    authMode: 'local_dev',
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

vi.mock('./stocktakeApi', () => ({
  fetchStocktakeSessions: vi.fn(),
  fetchStocktakeSession: vi.fn(),
  fetchStocktakeLines: vi.fn(),
  createStocktakeSession: vi.fn(),
  startStocktakeCounting: vi.fn(),
  recordStocktakeCounts: vi.fn(),
  submitStocktakeForReview: vi.fn(),
  reviewStocktakeSession: vi.fn(),
  approveStocktakeSession: vi.fn(),
  postStocktakeAdjustments: vi.fn(),
  cancelStocktakeSession: vi.fn(),
  fetchStocktakeAudit: vi.fn(),
  fetchStocktakeLedgerEntries: vi.fn(),
}));

vi.mock('@/features/production/productionApi', () => ({
  fetchWarehouses: vi.fn(),
}));

vi.mock('@/features/catalog/catalogApi', () => ({
  fetchCatalogItems: vi.fn(),
}));

const mockWarehouses: productionApi.Warehouse[] = [
  { id: 'wh-1', code: 'main_raw_materials', name_ar: 'مخزن الخامات الرئيسي', is_active: true },
  { id: 'wh-2', code: 'finished_goods', name_ar: 'مخزن المنتجات التامة', is_active: true },
];

const mockCatalogItems: catalogApi.CatalogItem[] = [
  {
    id: 'item-1',
    code: 'FAB-COTTON-01',
    name_ar: 'قماش قطن معالج',
    item_type: 'raw_material',
    unit_id: 'u-1',
    is_active: true,
    is_consumable: true,
    classification_status: 'confirmed',
    reorder_level: 10,
    attributes: {},
    approval_status: 'approved',
    created_at: '2026-10-01T00:00:00Z',
  },
  {
    id: 'item-2',
    code: 'THR-POLY-02',
    name_ar: 'خيط بوليستر',
    item_type: 'raw_material',
    unit_id: 'u-2',
    is_active: true,
    is_consumable: true,
    classification_status: 'confirmed',
    reorder_level: 5,
    attributes: {},
    approval_status: 'approved',
    created_at: '2026-10-01T00:00:00Z',
  },
];

const mockDraftSession: stocktakeApi.StocktakeSession = {
  id: 'stk-001',
  session_number: 'STK-20261102-0001',
  warehouse_id: 'wh-1',
  warehouse_name_ar: 'مخزن الخامات الرئيسي',
  status: 'draft',
  scope_type: 'full_warehouse',
  description: 'جرد ربع سنوي دوري',
  total_lines: 2,
  counted_lines: 0,
  shortage_lines: 0,
  surplus_lines: 0,
  exact_lines: 0,
  net_variance_cost: 0,
  created_by: 'user-wh',
  created_at: '2026-11-02T10:00:00Z',
  lines: [
    {
      id: 'line-1',
      session_id: 'stk-001',
      item_id: 'item-1',
      item_code: 'FAB-COTTON-01',
      item_name_ar: 'قماش قطن معالج',
      unit_id: 'u-1',
      unit_name_ar: 'متر',
      book_quantity: 100,
      counted_quantity: null,
      variance_quantity: null,
      variance_type: 'pending',
      unit_cost: 50,
      total_variance_cost: 0,
      needs_recount: false,
      history: [],
    },
    {
      id: 'line-2',
      session_id: 'stk-001',
      item_id: 'item-2',
      item_code: 'THR-POLY-02',
      item_name_ar: 'خيط بوليستر',
      unit_id: 'u-2',
      unit_name_ar: 'بكرة',
      book_quantity: 50,
      counted_quantity: null,
      variance_quantity: null,
      variance_type: 'pending',
      unit_cost: 20,
      total_variance_cost: 0,
      needs_recount: false,
      history: [],
    },
  ],
};

const mockCountingSession: stocktakeApi.StocktakeSession = {
  ...mockDraftSession,
  status: 'counting',
  counting_started_at: '2026-11-02T10:15:00Z',
};

const mockUnderReviewSession: stocktakeApi.StocktakeSession = {
  ...mockDraftSession,
  status: 'under_review',
  counted_lines: 2,
  shortage_lines: 1,
  surplus_lines: 1,
  net_variance_cost: -300,
  submitted_at: '2026-11-02T11:00:00Z',
  lines: [
    {
      ...mockDraftSession.lines![0],
      counted_quantity: 90,
      variance_quantity: -10,
      variance_type: 'shortage',
      total_variance_cost: -500,
      last_counted_by: 'counter-1',
      last_counted_at: '2026-11-02T10:30:00Z',
    },
    {
      ...mockDraftSession.lines![1],
      counted_quantity: 60,
      variance_quantity: 10,
      variance_type: 'surplus',
      total_variance_cost: 200,
      last_counted_by: 'counter-1',
      last_counted_at: '2026-11-02T10:35:00Z',
    },
  ],
};

const mockApprovedSession: stocktakeApi.StocktakeSession = {
  ...mockUnderReviewSession,
  status: 'approved',
  reviewer_id: 'gm-user',
  review_decision: 'approve',
  reviewed_at: '2026-11-02T12:00:00Z',
};

describe('Stocktake & Inventory Adjustments Frontend Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(productionApi.fetchWarehouses).mockResolvedValue(mockWarehouses);
    vi.mocked(catalogApi.fetchCatalogItems).mockResolvedValue(mockCatalogItems);
    vi.mocked(stocktakeApi.fetchStocktakeSessions).mockResolvedValue([mockDraftSession]);
    vi.mocked(stocktakeApi.fetchStocktakeSession).mockResolvedValue(mockDraftSession);
    vi.mocked(stocktakeApi.fetchStocktakeAudit).mockResolvedValue([]);
    vi.mocked(stocktakeApi.fetchStocktakeLedgerEntries).mockResolvedValue([]);
  });

  it('renders stocktake sessions list with summary KPIs and table', async () => {
    render(
      <AuthProvider>
        <StocktakeView />
      </AuthProvider>
    );

    expect(screen.getByText('الجرد والتسويات المخزنية')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('STK-20261102-0001')).toBeInTheDocument();
      expect(screen.getAllByText('مخزن الخامات الرئيسي').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('مسودة').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('+ فتح جلسة جرد جديدة')).toBeInTheDocument();
    });
  });

  it('opens creation modal, validates, and creates new stocktake session', async () => {
    vi.mocked(stocktakeApi.createStocktakeSession).mockResolvedValue({
      ...mockDraftSession,
      id: 'stk-new-99',
      session_number: 'STK-20261102-0099',
    });

    const handleSuccess = vi.fn();
    const handleClose = vi.fn();

    render(
      <AuthProvider>
        <CreateStocktakeModal
          isOpen={true}
          onClose={handleClose}
          onSuccess={handleSuccess}
        />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('فتح جلسة جرد مخزني جديدة')).toBeInTheDocument();
      expect(screen.getByText('المخزن المراد جرده *')).toBeInTheDocument();
    });

    // Submit form
    const submitBtn = screen.getByText('فتح الجلسة وتثبيت اللقطة');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(stocktakeApi.createStocktakeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          warehouse_id: 'wh-1',
          scope_type: 'full_warehouse',
        })
      );
      expect(handleSuccess).toHaveBeenCalled();
      expect(handleClose).toHaveBeenCalled();
    });
  });

  it('renders detail view and allows warehouse manager to start counting and input actual counts', async () => {
    vi.mocked(stocktakeApi.fetchStocktakeSession).mockResolvedValue(mockCountingSession);
    vi.mocked(stocktakeApi.recordStocktakeCounts).mockResolvedValue({
      ...mockCountingSession,
      counted_lines: 1,
    });

    render(
      <AuthProvider>
        <StocktakeDetailView
          sessionId="stk-001"
          onBack={vi.fn()}
        />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/جلسة الجرد: STK-20261102-0001/)).toBeInTheDocument();
      expect(screen.getByText('جارٍ العد الفعلي')).toBeInTheDocument();
      expect(screen.getByText('FAB-COTTON-01')).toBeInTheDocument();
      expect(screen.getByText('THR-POLY-02')).toBeInTheDocument();
    });

    // Enter count for line 1
    const inputs = screen.getAllByPlaceholderText('أدخل الكمية...');
    expect(inputs.length).toBe(2);

    fireEvent.change(inputs[0], { target: { value: '95' } });

    // Click "نافد (0)" for line 2 to distinguish zero from uncounted
    const zeroButtons = screen.getAllByTitle('تحديد رصيد نافد (0.0)');
    fireEvent.click(zeroButtons[1]);

    // Save counts
    const saveBtn = screen.getByText('حفظ مسودة العد');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(stocktakeApi.recordStocktakeCounts).toHaveBeenCalledWith(
        'stk-001',
        expect.objectContaining({
          counts: expect.arrayContaining([
            { line_id: 'line-1', counted_quantity: 95 },
            { line_id: 'line-2', counted_quantity: 0 },
          ]),
        })
      );
    });
  });

  it('enforces maker-checker review and approval flow for under_review sessions', async () => {
    vi.mocked(stocktakeApi.fetchStocktakeSession).mockResolvedValue(mockUnderReviewSession);
    vi.mocked(stocktakeApi.approveStocktakeSession).mockResolvedValue(mockApprovedSession);

    render(
      <AuthProvider>
        <StocktakeDetailView
          sessionId="stk-001"
          onBack={vi.fn()}
        />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('قيد المراجعة والاعتماد')).toBeInTheDocument();
      expect(screen.getByText('اعتماد نتائج الجرد')).toBeInTheDocument();
      expect(screen.getByText('طلب إعادة عد')).toBeInTheDocument();
      expect(screen.getByText('عجز مخزني')).toBeInTheDocument();
      expect(screen.getByText('زيادة مخزنية')).toBeInTheDocument();
    });

    // Approve session
    const approveBtn = screen.getByText('اعتماد نتائج الجرد');
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(stocktakeApi.approveStocktakeSession).toHaveBeenCalledWith('stk-001', expect.any(String));
    });
  });

  it('opens posting confirmation modal on approved session and passes Idempotency-Key', async () => {
    vi.mocked(stocktakeApi.fetchStocktakeSession).mockResolvedValue(mockApprovedSession);
    vi.mocked(stocktakeApi.postStocktakeAdjustments).mockResolvedValue({
      session_id: 'stk-001',
      session_number: 'STK-20261102-0001',
      status: 'posted',
      adjustments_created: 2,
      shortage_count: 1,
      surplus_count: 1,
      exact_count: 0,
      ledger_entry_ids: ['led-1', 'led-2'],
      message: 'تم ترحيل التسويات بنجاح',
    });

    render(
      <AuthProvider>
        <StocktakeDetailView
          sessionId="stk-001"
          onBack={vi.fn()}
        />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('معتمد للترحيل')).toBeInTheDocument();
      expect(screen.getByText('ترحيل التسويات للأستاذ')).toBeInTheDocument();
    });

    // Click posting button
    fireEvent.click(screen.getByText('ترحيل التسويات للأستاذ'));

    // Posting modal should open with warning
    expect(screen.getByText('تأكيد ترحيل التسويات المخزنية للأستاذ')).toBeInTheDocument();
    expect(screen.getByText(/سيتم إنشاء قيود أستاذ مخزنية دائمة غير قابلة للتعديل أو المسح/)).toBeInTheDocument();

    // Confirm post
    const confirmBtn = screen.getByText('تأكيد الترحيل النهائي');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(stocktakeApi.postStocktakeAdjustments).toHaveBeenCalledWith(
        'stk-001',
        expect.any(Object),
        expect.stringMatching(/^stk-post-stk-001-/)
      );
    });
  });

  it('renders API error banner cleanly without fake mockup fallbacks', async () => {
    vi.mocked(stocktakeApi.fetchStocktakeSessions).mockRejectedValue(
      new ApiError('فشل الاتصال بقاعدة البيانات لعمليات الجرد.')
    );

    render(
      <AuthProvider>
        <StocktakeView />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('فشل الاتصال بقاعدة البيانات لعمليات الجرد.')).toBeInTheDocument();
    });
  });
});
