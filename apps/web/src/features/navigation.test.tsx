import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import App from '@/App';
import { apiClient, ApiError } from '@/lib/api';

// جلسة Supabase قابلة للتبديل لكل اختبار (بدون بيانات اعتماد حقيقية)
const sessionState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: sessionState.current }, error: null }),
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
      treasury: null,
      production: { active_orders: 2, completed_orders_period: 4 },
      inventory: { raw_material_distinct_items: 15, finished_goods_distinct_items: 8 },
      payables: null,
    }),
    getInventoryReport: vi.fn().mockResolvedValue({ items: [], total_items: 0 }),
    getFinancialReport: vi.fn().mockResolvedValue({}),
  },
}));

/**
 * نسخة اختبارية من مصفوفة الأدوار في الخادم (apps/api/app/core/permissions.py ROLE_PERMISSIONS_MAP)
 * تُستخدم فقط لبناء استجابات GET /api/v1/auth/me الواقعية في الاختبارات.
 */
const SERVER_ROLE_PERMISSIONS: Record<string, string[]> = {
  general_manager: [
    'catalog:categories:manage', 'catalog:item:approve', 'catalog:item:create', 'catalog:item:deactivate',
    'catalog:item:manage_revisions', 'catalog:item:reactivate', 'catalog:item:reject',
    'catalog:item:request_revision', 'catalog:item:submit', 'catalog:item:update', 'catalog:view',
    'customers:deliveries:manage', 'customers:manage', 'customers:orders:create', 'customers:view',
    'finance:cash:approve', 'finance:cash:create', 'finance:cash:manage', 'finance:cash:view',
    'finance:expenses:manage', 'finance:payments:manage', 'finance:payroll:calculate',
    'finance:payroll:disburse', 'finance:payroll:manage', 'finance:payroll:view', 'finance:reports:view',
    'inventory:stocktake:approve', 'inventory:stocktake:cancel', 'inventory:stocktake:count',
    'inventory:stocktake:create', 'inventory:stocktake:post', 'inventory:stocktake:review',
    'inventory:stocktake:submit', 'inventory:stocktake:view', 'inventory:view', 'pricing:manage',
    'production:orders:close', 'production:orders:create', 'production:orders:manage',
    'production:orders:view', 'production:returns:resolve', 'production:stages:manage',
    'production:templates:manage', 'production:wip:receive', 'reports:view', 'suppliers:invoices:create',
    'suppliers:manage', 'suppliers:payments:request', 'suppliers:payments:request_full_balance',
    'suppliers:receive', 'suppliers:view', 'warehouse:dispatch', 'warehouse:finished_goods:receive',
    'warehouse:returns:receive',
  ],
  warehouse_manager: [
    'catalog:categories:manage', 'catalog:item:create', 'catalog:item:request_revision',
    'catalog:item:submit', 'catalog:item:update', 'catalog:view', 'customers:deliveries:manage',
    'inventory:stocktake:cancel', 'inventory:stocktake:count', 'inventory:stocktake:create',
    'inventory:stocktake:submit', 'inventory:stocktake:view', 'inventory:view', 'production:orders:view',
    'suppliers:invoices:create', 'suppliers:manage', 'suppliers:payments:request_full_balance',
    'suppliers:receive', 'suppliers:view', 'warehouse:dispatch', 'warehouse:finished_goods:receive',
    'warehouse:returns:receive',
  ],
  production_manager: [
    'catalog:view', 'inventory:view', 'production:orders:close', 'production:orders:create',
    'production:orders:manage', 'production:orders:view', 'production:returns:resolve',
    'production:stages:manage', 'production:templates:manage', 'production:wip:receive', 'reports:view',
  ],
  finance_manager: [
    'catalog:view', 'customers:manage', 'customers:orders:create', 'customers:view', 'finance:cash:approve',
    'finance:cash:create', 'finance:cash:manage', 'finance:cash:view', 'finance:expenses:manage',
    'finance:payments:manage', 'finance:payroll:calculate', 'finance:payroll:disburse',
    'finance:payroll:manage', 'finance:payroll:view', 'finance:reports:view', 'pricing:manage',
    'reports:view', 'suppliers:manage', 'suppliers:payments:request',
    'suppliers:payments:request_full_balance', 'suppliers:view',
  ],
};

function signInAs(role: string | null, permissions?: string[]) {
  const email = role ? `${role}@example.test` : 'no-role@example.test';
  sessionState.current = {
    access_token: `test-token-${role ?? 'none'}`,
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: `usr-${role ?? 'none'}`, email },
  } as unknown as Session;
  vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({
    id: `usr-${role ?? 'none'}`,
    email,
    roles: role ? [role] : [],
    permissions: permissions ?? (role ? SERVER_ROLE_PERMISSIONS[role] : []),
  });
}

function headerTitle(): string {
  return document.querySelector('.top-header__title')?.textContent ?? '';
}

async function renderSignedIn(role: string) {
  signInAs(role);
  render(<App />);
  await screen.findByRole('button', { name: /الرئيسية · مهامي/ });
  await waitFor(() => expect(screen.queryByText('جاري تحميل الصلاحيات')).not.toBeInTheDocument());
}

describe('Navigation gated by server permissions (GET /api/v1/auth/me)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.current = null;
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', app: 'qemma-erp', version: '0.1.0' });
    vi.spyOn(apiClient, 'request').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.setAccessToken(null);
  });

  it('shows no privileged navigation or screens when signed out (fail closed)', async () => {
    render(<App />);

    expect(await screen.findByText('سجّل الدخول لعرض شاشات المصنع')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^المخازن/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^المالية/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'لوحة التشغيل' })).not.toBeInTheDocument();
  });

  it('renders Warehouses and Finance groups with the real sub-items for the general manager', async () => {
    await renderSignedIn('general_manager');

    expect(screen.getByRole('navigation', { name: 'شريط التنقل الرئيسي' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^المخازن/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^المالية/ })).toBeInTheDocument();

    // القائمة مرتبة حسب دورة العمل: مشتريات ← مخازن ← تشغيل ← مبيعات ← مالية ← بيانات أساسية
    expect(screen.getByRole('button', { name: /^المشتريات/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^المبيعات/ })).toBeInTheDocument();
    for (const name of [
      'فواتير الشراء والاستلام',
      'مخزن الخامات',
      'مخزن المنتج التام',
      'أرصدة المخازن',
      'الجرد',
      'أوامر التشغيل',
      'العملاء وطلبات البيع',
      'تسليم طلبات العملاء',
      'الخزينة والاعتمادات',
      'سندات القبض والصرف',
      'العهد والمصروفات',
      'الرواتب',
      'التقارير',
      'الموردون والعملاء والموديلات',
      'دليل الخامات والأصناف',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('toggles dropdown visibility when group headers are clicked', async () => {
    await renderSignedIn('general_manager');

    const warehousesGroupHeader = screen.getByRole('button', { name: /^المخازن/ });
    expect(warehousesGroupHeader).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(warehousesGroupHeader);
    expect(warehousesGroupHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'مخزن الخامات' })).not.toBeInTheDocument();

    fireEvent.click(warehousesGroupHeader);
    expect(warehousesGroupHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'مخزن الخامات' })).toBeInTheDocument();
  });

  it('hides the unfinished Machinery page from the menu', async () => {
    await renderSignedIn('general_manager');
    expect(screen.queryByRole('button', { name: /الماكينات/ })).not.toBeInTheDocument();
  });

  it('navigates to Finished Goods warehouse view', async () => {
    await renderSignedIn('general_manager');

    fireEvent.click(screen.getByRole('button', { name: 'مخزن المنتج التام' }));

    await waitFor(() => {
      expect(headerTitle()).toBe('مخزن المنتجات التامة');
      expect(screen.getByRole('heading', { level: 2, name: 'مخزن المنتجات التامة' })).toBeInTheDocument();
    });
  });

  it('navigates to Catalog Management view under Warehouses', async () => {
    await renderSignedIn('general_manager');

    fireEvent.click(screen.getByRole('button', { name: 'دليل الخامات والأصناف' }));

    await waitFor(() => {
      expect(headerTitle()).toBe('دليل الأصناف والتصنيفات وخطوط الاستخدام');
    });
  });

  it('navigates through the Finance sub-pages and the inventory report', async () => {
    await renderSignedIn('general_manager');

    const steps: Array<[string, string]> = [
      ['الخزينة والاعتمادات', 'الخزينة والاعتمادات'],
      ['سندات القبض والصرف', 'سندات القبض والصرف'],
      ['العهد والمصروفات', 'العهد المالية المؤقتة'],
      ['العملاء وطلبات البيع', 'العملاء وطلبات البيع'],
      ['فواتير الشراء والاستلام', 'فواتير الشراء واستلام الخامات'],
      ['الرواتب', 'الرواتب والأجور المالية'],
      ['التقارير', 'التقارير المالية ومؤشرات السيولة'],
      ['أرصدة المخازن', 'تقرير حركة وأرصدة المخزون'],
      ['الموردون والعملاء والموديلات', 'البيانات الأساسية'],
    ];

    for (const [button, title] of steps) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      await waitFor(() => expect(headerTitle()).toBe(title));
    }
  });

  it('warehouse manager sees inventory report but not financial reports, payroll or treasury', async () => {
    await renderSignedIn('warehouse_manager');

    expect(screen.getByRole('button', { name: 'أرصدة المخازن' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'التقارير' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'الرواتب' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'الخزينة والاعتمادات' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /أمر تشغيل جديد/ })).not.toBeInTheDocument();
  });

  it('finance manager can reach payroll and treasury but not warehouse screens', async () => {
    await renderSignedIn('finance_manager');

    expect(screen.getByRole('button', { name: 'الخزينة والاعتمادات' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'مخزن الخامات' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'الرواتب' }));
    await waitFor(() => expect(headerTitle()).toBe('الرواتب والأجور المالية'));
    expect(await screen.findByRole('heading', { level: 2, name: 'العمال والمرتبات' })).toBeInTheDocument();
  });

  it('production manager sees production screens but no payroll or treasury', async () => {
    await renderSignedIn('production_manager');

    expect(screen.getByRole('button', { name: 'أوامر التشغيل' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /أمر تشغيل جديد/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'الرواتب' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'الخزينة والاعتمادات' })).not.toBeInTheDocument();
  });

  it('shows a clear Arabic message for an authenticated user without any permission', async () => {
    signInAs(null, []);
    render(<App />);

    expect(await screen.findByText('لا توجد صلاحيات مسندة لحسابك')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^المخازن/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^المالية/ })).not.toBeInTheDocument();
  });

  it('shows no privileged screens when /auth/me fails', async () => {
    signInAs('general_manager');
    vi.spyOn(apiClient, 'getAuthMe').mockRejectedValue(new ApiError('Network down', { isNetworkError: true }));
    render(<App />);

    expect(await screen.findByText('تعذر تأكيد الجلسة مع الخادم')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^المالية/ })).not.toBeInTheDocument();
  });
});
