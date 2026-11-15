import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DemandPoolView } from './DemandPoolView';
import {
  DemandPoolItemRead,
  DemandMaterialsPreviewResponse,
  ProductionOrderDemandRead,
} from './productionApi';
import * as productionApi from './productionApi';
import { ApiError } from '@/lib/api';

const grantedPermissions = new Set<string>();
const mockHasPermission = vi.fn((perm: string) => grantedPermissions.has(perm));

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: mockHasPermission,
    roles: [],
    user: { id: 'user-pm', email: 'test@qemma.com' },
  }),
}));

const poolLineA: DemandPoolItemRead = {
  customer_order_line_id: 'line-a',
  customer_order_id: 'co-1',
  customer_order_number: 'CO-2026-0001',
  customer_id: 'cust-1',
  customer_name: 'عميل الأمانة',
  product_id: 'prod-01',
  product_name: 'نصف ياقة مع أساور',
  variant_id: 'v-56-s',
  numeric_size: 56,
  letter_size: 'L',
  season: 'summer',
  variant_label: 'مقاس 56',
  ordered_quantity: 100,
  planned_quantity: 40,
  unplanned_quantity: 60,
  order_date: '2026-11-01T00:00:00Z',
  expected_delivery_at: '2026-12-01T00:00:00Z',
};

// نفس الموديل + نفس المقاس (متوافق)
const poolLineB: DemandPoolItemRead = {
  ...poolLineA,
  customer_order_line_id: 'line-b',
  customer_order_id: 'co-2',
  customer_order_number: 'CO-2026-0002',
  customer_name: 'عميل التوزيع',
  ordered_quantity: 50,
  planned_quantity: 0,
  unplanned_quantity: 50,
};

// مقاس مختلف (غير متوافق مع مجموعة line-a)
const poolLineC: DemandPoolItemRead = {
  ...poolLineA,
  customer_order_line_id: 'line-c',
  customer_order_id: 'co-3',
  customer_order_number: 'CO-2026-0003',
  customer_name: 'عميل الشمال',
  variant_id: 'v-58-s',
  numeric_size: 58,
  variant_label: 'مقاس 58',
  ordered_quantity: 30,
  planned_quantity: 0,
  unplanned_quantity: 30,
};

const previewResponse: DemandMaterialsPreviewResponse = {
  product_id: 'prod-01',
  product_name: 'نصف ياقة مع أساور',
  variant_id: 'v-56-s',
  variant_label: 'مقاس 56',
  total_target_quantity: 85,
  template_version_id: 'bom-1',
  customer_shares: [
    { customer_id: 'cust-1', customer_name: 'عميل الأمانة', customer_order_id: 'co-1', customer_order_number: 'CO-2026-0001', customer_order_line_id: 'line-a', allocated_quantity: 60, percentage: 70.59 },
    { customer_id: 'cust-2', customer_name: 'عميل التوزيع', customer_order_id: 'co-2', customer_order_number: 'CO-2026-0002', customer_order_line_id: 'line-b', allocated_quantity: 25, percentage: 29.41 },
  ],
  materials: [
    { item_id: 'it-fab', item_code: 'FAB', item_name_ar: 'قماش قطن', unit_id: 'u-m', unit_name_ar: 'متر', quantity_per_piece: 1.8, required_quantity: 153, available_quantity: 120, shortage_quantity: 33, is_sufficient: false },
    { item_id: 'it-btn', item_code: 'BTN', item_name_ar: 'كباسين', unit_id: 'u-p', unit_name_ar: 'قطعة', quantity_per_piece: 6, required_quantity: 510, available_quantity: 600, shortage_quantity: 0, is_sufficient: true },
  ],
  all_materials_available: false,
};

const createdOrder = {
  ...{ id: 'ord-agg', order_number: 'PO-2026-0100', product_name_ar: 'نصف ياقة مع أساور', target_quantity: 85, variant_info: 'مقاس 56', season: 'summer', status: 'draft', materials: [], stage_events: [] },
} as unknown as import('./productionApi').ProductionOrder;

const createdDemands: ProductionOrderDemandRead[] = [
  { id: 'dem-1', production_order_id: 'ord-agg', customer_order_line_id: 'line-a', customer_order_id: 'co-1', customer_order_number: 'CO-2026-0001', customer_id: 'cust-1', customer_name: 'عميل الأمانة', product_id: 'prod-01', variant_id: 'v-56-s', allocated_quantity: 60, fulfilled_quantity: 0, remaining_quantity: 60, fulfillment_pct: 0, notes: '', created_at: '2026-11-15T08:00:00Z' },
  { id: 'dem-2', production_order_id: 'ord-agg', customer_order_line_id: 'line-b', customer_order_id: 'co-2', customer_order_number: 'CO-2026-0002', customer_id: 'cust-2', customer_name: 'عميل التوزيع', product_id: 'prod-01', variant_id: 'v-56-s', allocated_quantity: 25, fulfilled_quantity: 0, remaining_quantity: 25, fulfillment_pct: 0, notes: '', created_at: '2026-11-15T08:00:00Z' },
];

const poolMocks = (pool: DemandPoolItemRead[] = [poolLineA, poolLineB, poolLineC]) => {
  vi.spyOn(productionApi, 'fetchDemandPool').mockResolvedValue(pool);
};

describe('سلة طلبات العملاء غير المخططة — Demand Pool (Phase 4.5 / T3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermissions.clear();
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('production:orders:create');
    grantedPermissions.add('production:orders:manage');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T3.1 تعرض البنود غير المخططة مع المتبقي لكل بند', async () => {
    poolMocks();
    render(<DemandPoolView />);

    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());
    expect(screen.getByText('عميل الأمانة')).toBeInTheDocument();
    // المتبقي غير المخطط: 60 و50 و30 (بالأرقام العربية-الهندية)
    expect(screen.getAllByText('٦٠').length).toBeGreaterThan(0);
    expect(screen.getAllByText('٥٠').length).toBeGreaterThan(0);
    // رأس التجميع
    expect(screen.getAllByText('مقاس 56').length).toBeGreaterThan(0);
  });

  it('T3.2 تمنع اختيار بنود غير متوافقة (موديل أو مقاس مختلف) مع بند مختار', async () => {
    poolMocks();
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());

    // اختيار بند مقاس 56
    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0001'), { target: { value: '60' } });
    // بنود مقاس 58 معطلة (غير متوافقة)
    expect(screen.getByLabelText('تخصيص من CO-2026-0003')).toBeDisabled();
    expect(screen.getByText(/غير متوافق مع الاختيار/)).toBeInTheDocument();
    // البند المتوافق (نفس الموديل والمقاس) يبقى متاحاً
    expect(screen.getByLabelText('تخصيص من CO-2026-0002')).toBeEnabled();
  });

  it('T3.3 تقيّد التخصيص بسقف المتبقي غير المخطط', async () => {
    poolMocks();
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());

    const input = screen.getByLabelText('تخصيص من CO-2026-0001');
    fireEvent.change(input, { target: { value: '90' } }); // المتبقي 60
    // القيمة تُقص عند السقف 60 محلياً
    expect((input as HTMLInputElement).value).toBe('60');
  });

  it('T3.4 المعاينة تعرض حصص العملاء واحتياج الخامات والعجز', async () => {
    const previewSpy = vi.spyOn(productionApi, 'previewDemandAggregation').mockResolvedValue(previewResponse);
    poolMocks();
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0001'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0002'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /معاينة الخامات والحصص/ }));

    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    expect(previewSpy.mock.calls[0][0]).toEqual([
      { customer_order_line_id: 'line-a', allocated_quantity: 60 },
      { customer_order_line_id: 'line-b', allocated_quantity: 25 },
    ]);
    expect(screen.getByRole('table', { name: /حصص العملاء/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /احتياج الخامات/ })).toBeInTheDocument();
    expect(screen.getByText('عجز')).toBeInTheDocument();
    expect(screen.getByText(/يوجد عجز في خامات الأمر المجمع/)).toBeInTheDocument();
  });

  it('T3.5 زر إنشاء الأمر المجمع يظهر لصاحب production:orders:create فقط', async () => {
    poolMocks();
    const { unmount } = render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /إنشاء أمر تشغيل مجمع/ })).toBeInTheDocument();
    unmount();

    // مستخدم بقراءة فقط (مثل صاحب customers:orders:view)
    grantedPermissions.clear();
    grantedPermissions.add('production:orders:view');
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /إنشاء أمر تشغيل مجمع/ })).not.toBeInTheDocument();
  });

  it('T3.6 بعد نجاح التجميع يعرض الأمر المنشأ وتخصيصات عملائه', async () => {
    const createSpy = vi.spyOn(productionApi, 'createAggregatedOrderApi').mockResolvedValue(createdOrder);
    vi.spyOn(productionApi, 'fetchOrderDemands').mockResolvedValue(createdDemands);
    poolMocks();
    render(<DemandPoolView onOpenOrder={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0001'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0002'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /إنشاء أمر تشغيل مجمع/ }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0].items).toEqual([
      { customer_order_line_id: 'line-a', allocated_quantity: 60 },
      { customer_order_line_id: 'line-b', allocated_quantity: 25 },
    ]);
    expect(typeof createSpy.mock.calls[0][1]).toBe('string');
    // الأمر المنشأ بتخصيصات العملاء
    expect(await screen.findByText(/تم إنشاء أمر التشغيل المجمع PO-2026-0100/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /تخصيصات العملاء/ })).toBeInTheDocument();
    expect(screen.getAllByText('عميل التوزيع').length).toBeGreaterThan(0);
    // بعد النجاح تُعاد قراءة السلة (تختفي الكميات المخططة الآن)
    await waitFor(() => expect(productionApi.fetchDemandPool).toHaveBeenCalledTimes(2));
  });

  it('T3.7 تجاوز المتبقي عند الخادم يعرض رسالة 409 كما هي', async () => {
    vi.spyOn(productionApi, 'createAggregatedOrderApi').mockRejectedValue(
      new ApiError('الكمية المخصصة (90) للطلب CO-2026-0001 تتجاوز الكمية المتبقية غير المخططة (60).'),
    );
    poolMocks();
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0001'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /إنشاء أمر تشغيل مجمع/ }));

    await waitFor(() => expect(screen.getByText(/تتجاوز الكمية المتبقية غير المخططة/)).toBeInTheDocument());
  });

  it('T3.8 فشل المعاينة (نموذج/مقاس غير متوافق خادمياً) يظهر رسالة الخادم', async () => {
    vi.spyOn(productionApi, 'previewDemandAggregation').mockRejectedValue(
      new ApiError('تجميع الطلبات يتطلب تطابق الموديل والمقاس لكافة بنود الطلبات المختارة في أمر تشغيل موحد.'),
    );
    poolMocks();
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('تخصيص من CO-2026-0001'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /معاينة الخامات والحصص/ }));

    await waitFor(() => expect(screen.getByText(/تطابق الموديل والمقاس/)).toBeInTheDocument());
  });

  it('T3.9 صاحب customers:orders:view فقط يرى السلة للقراءة (مصدر الحقيقة نفسه)', async () => {
    grantedPermissions.clear();
    grantedPermissions.add('customers:orders:view');
    poolMocks();
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText('CO-2026-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /إنشاء أمر تشغيل مجمع/ })).not.toBeInTheDocument();
  });

  it('T3.10 فشل تحميل السلة يظهر مع زر إعادة المحاولة', async () => {
    vi.spyOn(productionApi, 'fetchDemandPool').mockRejectedValue(new ApiError('تعذر الاتصال بالخادم'));
    render(<DemandPoolView />);
    await waitFor(() => expect(screen.getByText(/تعذر الاتصال بالخادم/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
  });

  it('T3.11 من دون صلاحية قراءة لا تُعرض السلة إطلاقاً', () => {
    grantedPermissions.clear();
    render(<DemandPoolView />);
    expect(screen.getByText(/لا تملك صلاحية عرض سلة طلبات العملاء/)).toBeInTheDocument();
  });
});
