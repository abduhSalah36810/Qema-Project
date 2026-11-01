import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '@/App';
import { apiClient } from '@/lib/api';

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signOut: vi.fn(),
    },
  },
}));

vi.mock('@/features/production/productionApi', () => ({
  fetchCatalogItems: vi.fn().mockResolvedValue([]),
  fetchWarehouses: vi.fn().mockResolvedValue([
    { id: 'wh-1', code: 'main_raw_materials', name_ar: 'مخزن الخامات الرئيسي', is_active: true },
    { id: 'wh-2', code: 'finished_goods', name_ar: 'مخزن المنتجات التامة', is_active: true },
  ]),
  fetchProductionOrders: vi.fn().mockResolvedValue([]),
  fetchProductionTemplates: vi.fn().mockResolvedValue([]),
  fetchProducts: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/features/inventory/inventoryApi', () => ({
  fetchStockBalances: vi.fn().mockResolvedValue([]),
  fetchStockLedger: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/features/customers/customersApi', () => ({
  fetchCustomers: vi.fn().mockResolvedValue([]),
  fetchCustomerAccount: vi.fn().mockResolvedValue({ customer: null, orders: [] }),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

vi.mock('@/features/payroll/payrollApi', () => ({
  payrollApi: {
    listEmployees: vi.fn().mockResolvedValue([]),
    listAttendance: vi.fn().mockResolvedValue([]),
    listPeriods: vi.fn().mockResolvedValue([]),
    getPeriodRuns: vi.fn().mockResolvedValue(null),
    calculatePeriod: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@/features/reports/reportsApi', () => ({
  reportsApi: {
    getSummary: vi.fn().mockResolvedValue({
      period: 'monthly',
      generated_at: new Date().toISOString(),
      treasury: { balance: 50000, petty_cash_total: 5000, revenues_period: 120000, expenses_period: 80000, net_period: 40000 },
      production: { active_orders: 2, completed_orders_period: 4 },
      inventory: { raw_material_distinct_items: 15, finished_goods_distinct_items: 8 },
      payables: { supplier_payables: 25000 },
    }),
    getInventoryReport: vi.fn().mockResolvedValue({ items: [], total_items: 0 }),
    getFinancialReport: vi.fn().mockResolvedValue({}),
  },
}));

describe('Navigation and Sidebar Restructuring Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({
      status: 'ok',
      app: 'qemma-erp',
      version: '0.1.0',
    });
    vi.spyOn(apiClient, 'request').mockResolvedValue([]);
  });

  it('renders dropdown groups for Warehouses and Finance in Sidebar', async () => {
    render(<App />);

    const nav = screen.getByRole('navigation', { name: 'شريط التنقل الرئيسي' });
    expect(nav).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /^المخازن/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^المالية/ })).toBeInTheDocument();

    // Verify sub-items inside Warehouses
    expect(screen.getByRole('button', { name: 'مخزن الخامات والمستلزمات' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'الماكينات والمعدات' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'مخزن المنتجات التامة' })).toBeInTheDocument();

    // Verify sub-items inside Finance
    expect(screen.getByRole('button', { name: 'الخزنة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'الإيرادات' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'المصروفات' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'العهد المالية' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'العملاء' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'الموردون' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'المدفوعات والتحصيلات' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'الرواتب المالية' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'التقارير المالية' })).toBeInTheDocument();
  });

  it('toggles dropdown visibility when group headers are clicked', async () => {
    render(<App />);

    const warehousesGroupHeader = screen.getByRole('button', { name: /^المخازن/ });
    expect(warehousesGroupHeader).toHaveAttribute('aria-expanded', 'true');

    // Click to collapse
    fireEvent.click(warehousesGroupHeader);
    expect(warehousesGroupHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'مخزن الخامات والمستلزمات' })).not.toBeInTheDocument();

    // Click to expand again
    fireEvent.click(warehousesGroupHeader);
    expect(warehousesGroupHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'مخزن الخامات والمستلزمات' })).toBeInTheDocument();
  });

  it('navigates to Machinery view and displays Phase 4 operational status', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'الماكينات والمعدات' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'الماكينات ومعدات التشغيل' })).toBeInTheDocument();
    });
    expect(screen.getByText(/حالة الوحدة: قيد التطوير الهيكلي \(المرحلة الرابعة\)/i)).toBeInTheDocument();
  });

  it('navigates to Finished Goods warehouse view', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'مخزن المنتجات التامة' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'مخزن المنتجات التامة' })).toBeInTheDocument();
    });
    expect(screen.getByText(/المعمارية المعتمدة: التكويد المعياري الموحد/i)).toBeInTheDocument();
  });

  it('navigates to Catalog Management view under Warehouses', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'دليل الأصناف والتصنيفات' }));

    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { name: 'دليل الأصناف والتصنيفات وخطوط الاستخدام' });
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  it('navigates to Finance sub-pages: Treasury, Revenues, Expenses, Custody, Suppliers, Reports', async () => {
    render(<App />);

    // 1. Treasury
    fireEvent.click(screen.getByRole('button', { name: 'الخزنة' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'الخزنة الرئيسية والحسابات النقدية' })).toBeInTheDocument();
    });

    // 2. Revenues
    fireEvent.click(screen.getByRole('button', { name: 'الإيرادات' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'الإيرادات التشغيلية' })).toBeInTheDocument();
    });

    // 3. Expenses
    fireEvent.click(screen.getByRole('button', { name: 'المصروفات' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'المصروفات التشغيلية' })).toBeInTheDocument();
    });

    // 4. Custody
    fireEvent.click(screen.getByRole('button', { name: 'العهد المالية' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'العهد المالية المؤقتة' })).toBeInTheDocument();
    });

    // 5. Customers
    fireEvent.click(screen.getByRole('button', { name: 'العملاء' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'إدارة العملاء' })).toBeInTheDocument();
    });

    // 6. Suppliers
    fireEvent.click(screen.getByRole('button', { name: 'الموردون' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'الموردون وفواتير الخامات' })).toBeInTheDocument();
    });

    // 7. Payments & Collections
    fireEvent.click(screen.getByRole('button', { name: 'المدفوعات والتحصيلات' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'المدفوعات والتحصيلات' })).toBeInTheDocument();
    });

    // 8. Financial Reports
    fireEvent.click(screen.getByRole('button', { name: 'التقارير المالية' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: 'التقارير المالية ومؤشرات الأداء' })).toBeInTheDocument();
    });

    // 9. Warehouse Inventory Reports
    fireEvent.click(screen.getByRole('button', { name: 'تقرير أرصدة المخزون' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /تقرير أرصدة المخزون/i })).toBeInTheDocument();
    });
  });

  it('hides financial reports from sidebar when authenticated as warehouse_manager', async () => {
    // Generate base64 JWT payload with warehouse_manager role
    const payload = btoa(JSON.stringify({ sub: 'wh-user-1', email: 'warehouse@qemma.com', role: 'warehouse_manager' }));
    const mockToken = `header.${payload}.sig`;

    vi.spyOn(apiClient, 'getAccessToken').mockReturnValue(mockToken);
    vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({ id: 'wh-user-1', email: 'warehouse@qemma.com' });

    // Mock supabase session with warehouse_manager token
    const supabaseMock = await import('@/lib/supabase');
    vi.spyOn(supabaseMock.supabase!.auth, 'getSession').mockResolvedValue({
      data: {
        session: {
          access_token: mockToken,
          token_type: 'bearer',
          user: { id: 'wh-user-1', email: 'warehouse@qemma.com' } as any,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        } as any,
      },
      error: null,
    });

    render(<App />);

    await waitFor(() => {
      // Warehouse manager CAN see inventory reports link
      expect(screen.getByRole('button', { name: 'تقرير أرصدة المخزون' })).toBeInTheDocument();
      // Warehouse manager CANNOT see finance reports link in sidebar
      expect(screen.queryByRole('button', { name: 'التقارير المالية' })).not.toBeInTheDocument();
    });
  });
});


