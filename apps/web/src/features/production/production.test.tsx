import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProductionOrdersView } from './ProductionOrdersView';
import { NewOrderModal } from './NewOrderModal';
import { OrderDetailModal } from './OrderDetailModal';
import {
  PROVISIONAL_FALLBACK_PRODUCTS,
  PROVISIONAL_FALLBACK_ORDERS,
  ProductionOrder,
} from './productionApi';
import * as productionApi from './productionApi';
import * as bomApi from './bomApi';
import { ApiError } from '@/lib/api';

const grantedPermissions = new Set<string>();
const mockHasPermission = vi.fn((perm: string) => grantedPermissions.has(perm));

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: mockHasPermission,
    roles: [],
    user: { id: 'test-user', email: 'test@qemma.com' },
  }),
}));

const ALL_PRODUCTION_PERMISSIONS = [
  'production:orders:view',
  'production:orders:manage',
  'production:orders:create',
  'production:stages:manage',
  'warehouse:dispatch',
  'production:wip:receive',
  'warehouse:finished_goods:receive',
  'production:orders:close',
];

const multiItemOrder: ProductionOrder = {
  ...PROVISIONAL_FALLBACK_ORDERS[0],
  id: 'ord-multi',
  status: 'in_production',
  target_quantity: 30,
  items: [
    {
      id: 'item-56', product_id: 'prod-01', product_name_ar: 'نصف ياقة', variant_id: 'v-56', variant_info: 'مقاس 56',
      product_type: 'factory_brand', target_quantity: 10, season: 'summer', fabric_area: '', fabric_name: '', fabric_color: '',
      fabric_weight: '', notes: '', received_quantity: 4, rejected_quantity: 0,
    },
    {
      id: 'item-58', product_id: 'prod-01', product_name_ar: 'نصف ياقة', variant_id: 'v-58', variant_info: 'مقاس 58',
      product_type: 'private_label', customer_id: 'c-1', customer_name: 'عميل تجريبي', target_quantity: 20, season: 'summer',
      fabric_area: '', fabric_name: '', fabric_color: '', fabric_weight: '', notes: '', received_quantity: 0, rejected_quantity: 0,
    },
  ],
};

describe('Production Orders Feature — Frontend Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermissions.clear();
    ALL_PRODUCTION_PERMISSIONS.forEach((perm) => grantedPermissions.add(perm));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders operations flow banner with the five sequential stages', async () => {
    render(<ProductionOrdersView />);

    expect(screen.getByLabelText(/مراحل التصنيع وعدد الأوامر/i)).toBeInTheDocument();
    expect(screen.getByText('القص على الباترون')).toBeInTheDocument();
    expect(screen.getByText('التشطيب والخياطة')).toBeInTheDocument();
    expect(screen.getByText('تركيب الكبسولة والأزرار')).toBeInTheDocument();
    expect(screen.getByText('الكي والبخار')).toBeInTheDocument();
    expect(screen.getByText('التعبئة والتغليف')).toBeInTheDocument();
  });

  it('2. renders the production order step guide side panel', async () => {
    render(<ProductionOrdersView />);

    expect(screen.getByText('خطوات أمر التشغيل')).toBeInTheDocument();
    expect(screen.getByText('صرف الخامات')).toBeInTheDocument();
    expect(screen.getByText('استلام الخامات بالورشة')).toBeInTheDocument();
    expect(screen.getByText('استلام المنتج التام')).toBeInTheDocument();
    expect(screen.getByText('تسوية الخامات ثم الإغلاق')).toBeInTheDocument();
  });

  it('2b. shows the API error instead of fake sample orders when loading fails', async () => {
    vi.spyOn(productionApi, 'fetchOrders').mockRejectedValue(new ApiError('تعذر الاتصال بالخادم'));
    render(<ProductionOrdersView />);

    await waitFor(() => {
      expect(screen.queryByText(/PO-2026-0001/i)).not.toBeInTheDocument();
    });
  });

  it('3. filters orders by status and searches by order number', async () => {
    vi.spyOn(productionApi, 'fetchOrders').mockResolvedValue(PROVISIONAL_FALLBACK_ORDERS);
    vi.spyOn(productionApi, 'fetchProducts').mockResolvedValue(PROVISIONAL_FALLBACK_PRODUCTS);
    vi.spyOn(productionApi, 'fetchTemplates').mockResolvedValue([]);
    vi.spyOn(productionApi, 'fetchCatalogItems').mockResolvedValue([]);
    render(<ProductionOrdersView />);

    // فحص ظهور الأوامر التجريبية
    await waitFor(() => {
      expect(screen.getByText(/PO-2026-0001/i)).toBeInTheDocument();
    });

    // النقر على فلتر "مسودات"
    const draftsBtn = screen.getByRole('button', { name: /مسودات/i });
    fireEvent.click(draftsBtn);

    // التحقق من ظهور أمر المسودة PO-2026-0002 واختفاء أمر قيد التشغيل PO-2026-0001
    expect(screen.getByText(/PO-2026-0002/i)).toBeInTheDocument();
    expect(screen.queryByText(/PO-2026-0001/i)).not.toBeInTheDocument();
  });

  it('4. unified order computes requirements from size BOMs and shows shortage', async () => {
    const preview = vi.spyOn(bomApi, 'previewOrderRequirements').mockResolvedValue({
      lines: [{
        product_id: PROVISIONAL_FALLBACK_PRODUCTS[0].id, variant_id: PROVISIONAL_FALLBACK_PRODUCTS[0].variants[0].id,
        product_name: PROVISIONAL_FALLBACK_PRODUCTS[0].name_ar, variant_label: 'مقاس 56', quantity: 100,
        has_bom: true, bom_version_number: 2, issue: '', materials: [],
      }],
      materials: [{
        item_id: 'it-cuff', item_code: 'ACC-CUFF', item_name: 'أساور', unit_id: 'u-pc', unit_name: 'قطعة',
        required_quantity: 300, available_quantity: 250, dispatchable_quantity: 250, shortage_quantity: 50, item_active: true,
      }],
      can_create: true,
      has_shortage: true,
    });

    render(<NewOrderModal isOpen={true} onClose={vi.fn()} onOrderCreated={vi.fn()} products={PROVISIONAL_FALLBACK_PRODUCTS} />);
    expect(screen.getByText(/إنشاء أمر تشغيل جديد \(مسودة دفعة\)/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('موديل السطر 1'), { target: { value: PROVISIONAL_FALLBACK_PRODUCTS[0].id } });
    fireEvent.change(screen.getByLabelText('مقاس السطر 1'), { target: { value: PROVISIONAL_FALLBACK_PRODUCTS[0].variants[0].id } });
    fireEvent.change(screen.getByLabelText('كمية السطر 1'), { target: { value: '100' } });

    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(preview.mock.calls[preview.mock.calls.length - 1]?.[0]).toEqual([
      { product_id: PROVISIONAL_FALLBACK_PRODUCTS[0].id, variant_id: PROVISIONAL_FALLBACK_PRODUCTS[0].variants[0].id, quantity: 100 },
    ]);
    expect(await screen.findByText('أساور')).toBeInTheDocument();
    expect(screen.getByText(/مستلزمات إصدار/)).toBeInTheDocument();
    expect(screen.getByText(/يوجد عجز في بعض الخامات/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إنشاء أمر التشغيل' })).not.toBeDisabled();
  });

  it('blocks creating an order when a selected size has no BOM and lists it', async () => {
    vi.spyOn(bomApi, 'previewOrderRequirements').mockResolvedValue({
      lines: [{
        product_id: PROVISIONAL_FALLBACK_PRODUCTS[0].id, variant_id: PROVISIONAL_FALLBACK_PRODUCTS[0].variants[0].id,
        product_name: 'جلابية بلا مستلزمات', variant_label: 'مقاس 60', quantity: 10,
        has_bom: false, bom_version_number: null, issue: 'لا توجد مستلزمات', materials: [],
      }],
      materials: [],
      can_create: false,
      has_shortage: false,
    });
    render(<NewOrderModal isOpen={true} onClose={vi.fn()} onOrderCreated={vi.fn()} products={PROVISIONAL_FALLBACK_PRODUCTS} />);
    fireEvent.change(screen.getByLabelText('موديل السطر 1'), { target: { value: PROVISIONAL_FALLBACK_PRODUCTS[0].id } });
    fireEvent.change(screen.getByLabelText('مقاس السطر 1'), { target: { value: PROVISIONAL_FALLBACK_PRODUCTS[0].variants[0].id } });
    fireEvent.change(screen.getByLabelText('كمية السطر 1'), { target: { value: '10' } });
    expect(await screen.findByText(/مستلزمات التصنيع ناقصة/)).toBeInTheDocument();
    expect(screen.getByText(/جلابية بلا مستلزمات — مقاس 60/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إنشاء أمر التشغيل' })).toBeDisabled();
  });

  it('5. renders frozen material snapshot and enforces sequential stage progression in OrderDetailModal', () => {
    const mockOnClose = vi.fn();
    const mockOnUpdate = vi.fn();
    const testOrder: ProductionOrder = {
      ...PROVISIONAL_FALLBACK_ORDERS[0],
      stage_events: [
        {
          id: 'st-cut',
          stage_name: 'cutting',
          status: 'not_started',
          actor_id: 'u1',
          actor_name: 'محمد',
          timestamp: new Date().toISOString(),
          notes: '',
        },
        {
          id: 'st-fin',
          stage_name: 'finishing',
          status: 'not_started',
          actor_id: 'u1',
          actor_name: 'سعيد',
          timestamp: new Date().toISOString(),
          notes: '',
        },
      ],
    };

    render(
      <OrderDetailModal
        order={testOrder}
        isOpen={true}
        onClose={mockOnClose}
        onOrderUpdated={mockOnUpdate}
      />
    );

    // الأمر قيد التصنيع: الشاشة تفتح على خطوة المستخدم (المراحل)، وتبويب الخامات متاح بنقرة
    fireEvent.click(screen.getByText(/الخامات: الصرف والاستلام/i));
    expect(screen.getByText('قماش قطن مصري فاخر')).toBeInTheDocument();
    expect(screen.getByText('أزرار صدفية طبيعية')).toBeInTheDocument();

    // التبديل إلى تبويب مراحل التشغيل التتابعية
    const stagesTabBtn = screen.getByRole('button', { name: /^مراحل التصنيع$/ });
    fireEvent.click(stagesTabBtn);

    // مرحلة القص غير مكتملة، لذا يجب أن يكون زر بدء مرحلة التشطيب (المرحلة اللاحقة) معطلاً
    const startButtons = screen.getAllByRole('button', { name: /بدء المرحلة/i });
    expect(startButtons.length).toBeGreaterThan(0);
    // زر مرحلة القص متاح
    expect(startButtons[0]).not.toBeDisabled();
    // زر مرحلة التشطيب معطل لأن القص لم ينته بعد
    expect(startButtons[1]).toBeDisabled();
  });

  it('6. offers catalog material entry while a production order is still a draft', () => {
    const draft = { ...PROVISIONAL_FALLBACK_ORDERS[0], status: 'draft', materials: [] };
    render(
      <OrderDetailModal
        order={draft}
        isOpen={true}
        onClose={vi.fn()}
        onOrderUpdated={vi.fn()}
        catalogItems={[{
          id: 'item-new', code: 'THR-01', name_ar: 'خيط تشغيل', item_type: 'raw_material',
          unit_id: 'unit-spool', unit_name_ar: 'بكرة', is_consumable: true, is_active: true,
        }]}
      />
    );

    expect(screen.getByText('إضافة خامة إلى المسودة')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /خيط تشغيل · THR-01/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إضافة الصنف/ })).toBeInTheDocument();
  });

  it('7. requests a reason to reopen only the latest completed production stage', () => {
    const order = {
      ...PROVISIONAL_FALLBACK_ORDERS[0],
      stage_events: [
        { id: 'a', stage_name: 'cutting', status: 'completed', actor_id: 'u', actor_name: 'مشرف', timestamp: new Date().toISOString(), notes: '' },
        ...['finishing', 'snap_installation', 'ironing', 'packing'].map((stage, index) => ({
          id: `later-${index}`, stage_name: stage, status: 'not_started', actor_id: 'u', actor_name: 'مشرف', timestamp: new Date().toISOString(), notes: '',
        })),
      ],
    } as ProductionOrder;
    render(<OrderDetailModal order={order} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^مراحل التصنيع$/ }));
    expect(screen.getByLabelText(/سبب إعادة فتح المرحلة/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إعادة فتح المرحلة/i })).toBeInTheDocument();
  });

  it('8. disables stage buttons and explains why when the order is not in production', () => {
    const draft = { ...PROVISIONAL_FALLBACK_ORDERS[1] };
    render(<OrderDetailModal order={draft} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^مراحل التصنيع$/ }));
    expect(screen.getByText(/اصرف الخامات وأكد استلامها أولاً/)).toBeInTheDocument();
    screen.getAllByRole('button', { name: /بدء المرحلة/i }).forEach((button) => expect(button).toBeDisabled());
  });

  it('9. hides mutating actions from users without the permission (no fail-open)', () => {
    grantedPermissions.clear();
    grantedPermissions.add('production:orders:view');
    const draft = { ...PROVISIONAL_FALLBACK_ORDERS[1] };
    render(<OrderDetailModal order={draft} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /صرف الخامات/ })).not.toBeInTheDocument();
    expect(screen.queryByText('إضافة خامة إلى المسودة')).not.toBeInTheDocument();
  });

  it('10. validates WIP material receipt between 0 and dispatched quantity', () => {
    const dispatched: ProductionOrder = {
      ...PROVISIONAL_FALLBACK_ORDERS[0],
      status: 'materials_dispatched',
      materials: [{ ...PROVISIONAL_FALLBACK_ORDERS[0].materials[1], dispatched_quantity: 100, received_quantity: 0 }],
    };
    render(<OrderDetailModal order={dispatched} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    const input = screen.getByLabelText(/الكمية المستلمة أزرار صدفية طبيعية/);
    expect(input).toHaveValue(100);
    fireEvent.change(input, { target: { value: '120' } });
    expect(screen.getByText(/لا تتجاوز المنصرف \(100\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /تأكيد استلام الخامات/ })).toBeDisabled();
  });

  it('11. receives finished goods per order item with remaining as default and one idempotency key', async () => {
    const receiveSpy = vi.spyOn(productionApi, 'receiveFinishedGoodsApi').mockResolvedValue({
      order_id: 'ord-multi', order_number: 'PO', target_quantity: 30, received_quantity: 26, accepted_quantity: 26,
      rejected_quantity: 0, warehouse_name: 'مخزن', receipt_status: 'complete', confirmed_at: '', confirmed_by: '', notes: '',
    });
    vi.spyOn(productionApi, 'fetchProductionOrderById').mockResolvedValue({ ...multiItemOrder, status: 'receipt_completed' });
    const onUpdated = vi.fn();
    render(<OrderDetailModal order={multiItemOrder} isOpen={true} onClose={vi.fn()} onOrderUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole('button', { name: /^استلام المنتج التام/ }));

    expect(screen.getByLabelText(/الكمية السليمة نصف ياقة مقاس 56/)).toHaveValue(6);
    expect(screen.getByLabelText(/الكمية السليمة نصف ياقة مقاس 58/)).toHaveValue(20);

    fireEvent.click(screen.getByRole('button', { name: /تأكيد استلام المنتج التام/ }));
    await waitFor(() => expect(receiveSpy).toHaveBeenCalledTimes(1));
    const [orderId, payload, key] = receiveSpy.mock.calls[0];
    expect(orderId).toBe('ord-multi');
    expect(payload.lines).toEqual([
      { order_item_id: 'item-56', accepted_quantity: 6, rejected_quantity: 0 },
      { order_item_id: 'item-58', accepted_quantity: 20, rejected_quantity: 0 },
    ]);
    expect(typeof key).toBe('string');
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(await screen.findByText(/تم استلام 26 قطعة سليمة/)).toBeInTheDocument();
  });

  it('12. shows the backend Arabic error and no success when finished goods receipt fails', async () => {
    vi.spyOn(productionApi, 'receiveFinishedGoodsApi').mockRejectedValue(
      new ApiError('الكمية المستلمة للبند (58) تتجاوز الكمية المستهدفة له.', { status: 409 }),
    );
    render(<OrderDetailModal order={multiItemOrder} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^استلام المنتج التام/ }));
    fireEvent.click(screen.getByRole('button', { name: /تأكيد استلام المنتج التام/ }));
    expect(await screen.findByText(/تتجاوز الكمية المستهدفة له/)).toBeInTheDocument();
    expect(screen.queryByText(/تم استلام/)).not.toBeInTheDocument();
  });

  it('13. reconciles workshop materials with live remaining and validates against WIP balance', async () => {
    vi.spyOn(productionApi, 'fetchOrderWipSummary').mockResolvedValue({
      order_id: 'ord-multi', order_number: 'PO', status: 'in_production', target_quantity: 30, total_received_goods: 4,
      goods_receipt_status: 'partial', stages_completed: false, pending_transfers_count: 0, unresolved_discrepancies_count: 1,
      net_wip_balance: 50, can_close: false, blocking_reasons: ['لم تكتمل كافة مراحل الإنتاج الفنية (5 مراحل).'],
      materials: [{
        item_id: 'it-fab', item_code: 'FAB-1', item_name_ar: 'قماش قطن', unit_id: 'u', unit_name_ar: 'متر', planned_quantity: 50,
        dispatched_quantity: 50, received_quantity: 50, discrepancy_quantity: 0, in_transit_quantity: 0, current_wip_balance: 50, status: 'received_complete',
      }],
    });
    const reconcileSpy = vi.spyOn(productionApi, 'reconcileOrderMaterialsApi').mockResolvedValue({
      id: 'r1', reconciliation_number: 'MR-1', order_id: 'ord-multi', created_by: 'u', created_at: '', notes: '', lines: [],
    });
    vi.spyOn(productionApi, 'fetchProductionOrderById').mockResolvedValue(multiItemOrder);
    render(<OrderDetailModal order={multiItemOrder} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /التسوية والمرتجعات والإغلاق/ }));

    const consumed = await screen.findByLabelText('مستهلك قماش قطن');
    fireEvent.change(consumed, { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('مرتجع قماش قطن'), { target: { value: '15' } });
    expect(screen.getByText(/المجموع يتجاوز رصيد الورشة \(50\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /تسجيل تسوية الخامات/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('مرتجع قماش قطن'), { target: { value: '8' } });
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/لم تكتمل كافة مراحل الإنتاج/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إغلاق أمر التشغيل نهائياً/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /تسجيل تسوية الخامات/ }));
    await waitFor(() => expect(reconcileSpy).toHaveBeenCalledTimes(1));
    expect(reconcileSpy.mock.calls[0][1].lines).toEqual([
      { item_id: 'it-fab', consumed_quantity: 40, returned_quantity: 8, scrapped_quantity: 0, return_condition: 'good', notes: '' },
    ]);
    expect(typeof reconcileSpy.mock.calls[0][2]).toBe('string');
  });
});
