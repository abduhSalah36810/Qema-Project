import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiscrepancyClaimsView } from './DiscrepancyClaimsView';
import { OrderDetailModal } from './OrderDetailModal';
import {
  PROVISIONAL_FALLBACK_ORDERS,
  PROVISIONAL_FALLBACK_PRODUCTS,
  ProductionOrder,
  TransferDiscrepancyClaimRead,
} from './productionApi';
import * as productionApi from './productionApi';
import { ApiError } from '@/lib/api';

const grantedPermissions = new Set<string>();
const mockHasPermission = vi.fn((perm: string) => grantedPermissions.has(perm));
// معرّف المستخدم الحالي قابل للتغيير لاختبار Maker-Checker (لا يجوز لمن أثبت العجز حسمه)
let mockUserId = 'user-wh';

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: mockHasPermission,
    roles: [],
    user: { id: mockUserId, email: 'test@qemma.com' },
  }),
}));

const pendingClaim: TransferDiscrepancyClaimRead = {
  id: 'claim-1',
  claim_number: 'CLM-2026-A1B2C3',
  transfer_id: 'trf-1',
  transfer_number: 'TRF-2026-0001',
  transfer_line_id: 'trf-line-9',
  order_id: 'ord-1',
  order_number: 'PO-2026-0001',
  item_id: 'it-fab',
  item_name_ar: 'قماش قطن',
  item_code: 'FAB',
  unit_id: 'u-m',
  unit_name_ar: 'متر',
  dispatched_quantity: 50,
  received_quantity: 45,
  discrepancy_quantity: 5,
  unit_cost: 12,
  total_cost: 60,
  status: 'pending_investigation',
  status_ar: 'معلقة · بانتظار مراجعة وحسم أمين المخزن',
  claimed_by: 'user-receiver',
  claimed_at: '2026-11-15T08:00:00Z',
  claim_notes: 'عجز عند استلام الورشة',
  resolved_by: null,
  resolved_at: null,
  resolution_notes: '',
  created_at: '2026-11-15T08:00:00Z',
};

const resolvedClaim: TransferDiscrepancyClaimRead = {
  ...pendingClaim,
  status: 'accepted_transit_loss',
  status_ar: 'معتمدة · عجز نقل وفقد مبرر',
  resolved_by: 'user-wh',
  resolved_at: '2026-11-15T10:00:00Z',
  resolution_notes: 'فرق ميزان النقل مثبت بالسجل',
};

const claimViewMocks = (claims: TransferDiscrepancyClaimRead[], orders: ProductionOrder[] = []) => {
  vi.spyOn(productionApi, 'fetchDiscrepancyClaims').mockResolvedValue(claims);
  vi.spyOn(productionApi, 'fetchOrders').mockResolvedValue(orders);
  vi.spyOn(productionApi, 'fetchProducts').mockResolvedValue(PROVISIONAL_FALLBACK_PRODUCTS);
  vi.spyOn(productionApi, 'fetchTemplates').mockResolvedValue([]);
  vi.spyOn(productionApi, 'fetchCatalogItems').mockResolvedValue([]);
};

const orderMetaMocks = (order: ProductionOrder) => {
  vi.spyOn(productionApi, 'fetchOrderDiscrepancyClaims').mockResolvedValue([pendingClaim]);
  vi.spyOn(productionApi, 'fetchOrderWipSummary').mockResolvedValue({
    order_id: order.id, order_number: order.order_number, status: order.status, target_quantity: order.target_quantity,
    total_received_goods: 0, goods_receipt_status: 'none', stages_completed: false, pending_transfers_count: 0,
    unresolved_discrepancies_count: 1, net_wip_balance: 60, can_close: false,
    blocking_reasons: ['يوجد 1 طلب مراجعة عجز استلام خامات بالورشة بانتظار حسم أمين المخزن.'],
    materials: [],
  });
  vi.spyOn(productionApi, 'fetchProductionOrderById').mockResolvedValue(order);
};

describe('مطالبات عجز استلام الخامات (Phase 4.5 / T2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantedPermissions.clear();
    mockUserId = 'user-wh';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T2.1 تعرض المطالبات المعلقة في القائمة مع رقم المطالبة والأمر والفرق والحالة', async () => {
    claimViewMocks([pendingClaim]);
    render(<DiscrepancyClaimsView />);

    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    expect(screen.getByText('PO-2026-0001')).toBeInTheDocument();
    expect(screen.getByText(/قماش قطن/)).toBeInTheDocument();
    expect(screen.getAllByText(/معلقة/).length).toBeGreaterThan(0);
    // الفرق 5 يظهر في عمود الفرق (بالأرقام العربية-الهندية كما في باقي الواجهة)
    expect(screen.getAllByText('٥').length).toBeGreaterThan(0);
    // مقدم المطالبة (جهة الاستلام) والتاريخ والملاحظات
    expect(screen.getByText('user-receiver')).toBeInTheDocument();
    expect(screen.getByText(/عجز عند استلام الورشة/)).toBeInTheDocument();
  });

  it('T2.2 تعرض تفاصيل المطالبة بالفرق بين المرسل والمستلم وسياق التحويل', async () => {
    claimViewMocks([pendingClaim]);
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));

    expect(screen.getByRole('dialog', { name: /تفاصيل المطالبة/ })).toBeInTheDocument();
    expect(screen.getAllByText('٥٠').length).toBeGreaterThan(0); // المرسل
    expect(screen.getAllByText('٤٥').length).toBeGreaterThan(0); // المستلم
    expect(screen.getByText('TRF-2026-0001')).toBeInTheDocument();
    expect(screen.getByText(/تكلفة الفرق/i)).toBeInTheDocument();
  });

  it('T2.3 تظهر المطالبة المعلقة داخل تفاصيل أمر التشغيل (تبويب التسوية)', async () => {
    const order = PROVISIONAL_FALLBACK_ORDERS[0];
    orderMetaMocks(order);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('production:orders:manage');
    render(<OrderDetailModal order={order} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} initialTab="wip" />);

    expect(await screen.findByText('CLM-2026-A1B2C3')).toBeInTheDocument();
    expect(screen.getByText(/مطالبات عجز استلام الخامات/)).toBeInTheDocument();
  });

  it('T2.4 يظهر تحذير منع الإغلاق ورابط فتح المطالبة داخل أمر التشغيل', async () => {
    const order = PROVISIONAL_FALLBACK_ORDERS[0];
    orderMetaMocks(order);
    grantedPermissions.add('production:orders:view');
    render(<OrderDetailModal order={order} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} initialTab="wip" />);

    expect((await screen.findAllByText(/يمنع الإغلاق/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/بانتظار حسم أمين المخزن/).length).toBeGreaterThan(0);
    // رابط فتح المطالبة
    const openBtn = screen.getAllByRole('button', { name: 'عرض التفاصيل' })[0];
    fireEvent.click(openBtn);
    expect(screen.getByRole('dialog', { name: /تفاصيل المطالبة/ })).toBeInTheDocument();
  });

  it('T2.5 مدير الإنتاج (بلا صلاحية الحسم) يرى المطالبة دون إجراءات الحسم', async () => {
    claimViewMocks([pendingClaim]);
    grantedPermissions.add('production:orders:view');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));

    // يرى الحالة وسياق التحقيق
    expect(screen.getByText(/الحسم من صلاحية أمين المخزن أو المدير العام فقط/)).toBeInTheDocument();
    // لا يرى نموذج الحسم أو زر التأكيد
    expect(screen.queryByLabelText('قرار الحسم *')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تأكيد الحسم نهائياً' })).not.toBeInTheDocument();
    // وتراه في القائمة بلا زر حسم مبدئي (زر العرض فقط)
    expect(screen.queryByRole('button', { name: /حسم/ })).not.toBeInTheDocument();
  });

  it('T2.6 أمين المخزن (صاحب warehouse:claims:resolve) يرى إجراءات الحسم ويصل للتأكيد النهائي', async () => {
    claimViewMocks([pendingClaim]);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));

    fireEvent.change(screen.getByLabelText('قرار الحسم *'), { target: { value: 'accepted_transit_loss' } });
    expect(screen.getByText(/أثر القرار المخزني/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/بيان وأسباب القرار/), { target: { value: 'فرق ميزان النقل مثبت بالسجل' } });
    fireEvent.click(screen.getByRole('button', { name: 'متابعة إلى التأكيد النهائي' }));

    // ملخص التأكيد بالكمية محل التسوية (بالأرقام العربية-الهندية)
    expect(screen.getByText(/تأكيد نهائي قبل إرسال القرار/)).toBeInTheDocument();
    expect(screen.getByText(/الكمية محل التسوية/)).toBeInTheDocument();
    expect(screen.getByText(/٥ متر/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تأكيد الحسم نهائياً' })).toBeInTheDocument();
  });

  it('T2.7 المدير العام (بصلاحياته الكاملة) يرى إجراءات الحسم أيضاً', async () => {
    claimViewMocks([pendingClaim]);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    grantedPermissions.add('production:orders:manage');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));

    expect(screen.getByLabelText('قرار الحسم *')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'متابعة إلى التأكيد النهائي' })).toBeInTheDocument();
  });

  it('T2.8 منشئ المطالبة (مثبت العجز) لا يستطيع حسمها حتى لو امتلك صلاحية الحسم', async () => {
    claimViewMocks([pendingClaim]);
    mockUserId = 'user-receiver'; // مطابق لـ claimed_by
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));

    expect(screen.getByText(/لا يجوز لمن أثبت العجز بالورشة أن يحسم مطالبته بنفسه/)).toBeInTheDocument();
    expect(screen.queryByLabelText('قرار الحسم *')).not.toBeInTheDocument();
  });

  it('T2.9 لا تُعرض إلا القرارات الثلاثة المدعومة في الخادم', async () => {
    claimViewMocks([pendingClaim]);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));

    const select = screen.getByLabelText('قرار الحسم *') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(values).toEqual(['accepted_transit_loss', 'accepted_measurement_error', 'rejected_under_carrier_liability']);
  });

  it('T2.10 بعد نجاح الحسم تُحدث حالة المطالبة في القائمة دون إعادة إنشاء', async () => {
    const resolveSpy = vi.spyOn(productionApi, 'resolveDiscrepancyClaimApi').mockResolvedValue(resolvedClaim);
    // الجلب الأول يُرجع المطالبة معلقة، والجلب الخلفي بعد الحسم يُرجعها محسومة (اتساق مع الخادم)
    vi.spyOn(productionApi, 'fetchDiscrepancyClaims')
      .mockResolvedValueOnce([pendingClaim])
      .mockResolvedValue([resolvedClaim]);
    vi.spyOn(productionApi, 'fetchOrders').mockResolvedValue([]);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    fireEvent.change(screen.getByLabelText('قرار الحسم *'), { target: { value: 'accepted_transit_loss' } });
    fireEvent.change(screen.getByLabelText(/بيان وأسباب القرار/), { target: { value: 'فرق ميزان النقل مثبت بالسجل' } });
    fireEvent.click(screen.getByRole('button', { name: 'متابعة إلى التأكيد النهائي' }));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحسم نهائياً' }));

    await waitFor(() => expect(resolveSpy).toHaveBeenCalledTimes(1));
    // الحسم يمر عبر endpoint الخادم فقط (تسوية claim_settlement والأرصدة خادمية)
    expect(resolveSpy.mock.calls[0][0]).toBe('claim-1');
    expect(resolveSpy.mock.calls[0][1]).toEqual({ decision: 'accepted_transit_loss', resolution_notes: 'فرق ميزان النقل مثبت بالسجل' });
    expect(typeof resolveSpy.mock.calls[0][2]).toBe('string');
    // الشارة تتحول إلى معتمدة · عجز نقل دون فقدان القائمة
    await waitFor(() => expect(screen.getAllByText('معتمدة · عجز نقل').length).toBeGreaterThan(0));
  });

  it('T2.11 يُعرض فشل الخادم (409 حسم مسبق/فصل مسؤوليات) للمستخدم دون فقدان النموذج', async () => {
    vi.spyOn(productionApi, 'resolveDiscrepancyClaimApi').mockRejectedValue(
      new ApiError('تم البت في هذا الطلب مسبقاً ولا يمكن تعديله.'),
    );
    claimViewMocks([pendingClaim]);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    fireEvent.change(screen.getByLabelText('قرار الحسم *'), { target: { value: 'accepted_transit_loss' } });
    fireEvent.change(screen.getByLabelText(/بيان وأسباب القرار/), { target: { value: 'فرق ميزان النقل مثبت بالسجل' } });
    fireEvent.click(screen.getByRole('button', { name: 'متابعة إلى التأكيد النهائي' }));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الحسم نهائياً' }));

    await waitFor(() => expect(screen.getByText(/تم البت في هذا الطلب مسبقاً/)).toBeInTheDocument());
    // لا يزال النموذج متاحاً للمراجعة بعد الفشل
    expect(screen.getByLabelText('قرار الحسم *')).toBeInTheDocument();
  });

  it('T2.12 يمنع تكرار إرسال الحسم (زر معطل أثناء المعالجة)', async () => {
    vi.spyOn(productionApi, 'resolveDiscrepancyClaimApi').mockImplementation(() => new Promise(() => undefined));
    claimViewMocks([pendingClaim]);
    grantedPermissions.add('production:orders:view');
    grantedPermissions.add('warehouse:claims:resolve');
    render(<DiscrepancyClaimsView />);
    await waitFor(() => expect(screen.getByText('CLM-2026-A1B2C3')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    fireEvent.change(screen.getByLabelText('قرار الحسم *'), { target: { value: 'accepted_transit_loss' } });
    fireEvent.change(screen.getByLabelText(/بيان وأسباب القرار/), { target: { value: 'فرق ميزان النقل مثبت بالسجل' } });
    fireEvent.click(screen.getByRole('button', { name: 'متابعة إلى التأكيد النهائي' }));

    const confirmBtn = screen.getByRole('button', { name: 'تأكيد الحسم نهائياً' });
    fireEvent.click(confirmBtn);
    expect(screen.getByText(/جاري إرسال القرار…/)).toBeInTheDocument();
    // محاولة ثانية أثناء المعالجة: الزر معطل فلا يُرسل مرتين
    fireEvent.click(confirmBtn);
    expect(productionApi.resolveDiscrepancyClaimApi).toHaveBeenCalledTimes(1);
  });

  it('T2.13 يُظهر خطأ تحميل القائمة مع زر إعادة المحاولة', async () => {
    vi.spyOn(productionApi, 'fetchDiscrepancyClaims').mockRejectedValue(new ApiError('تعذر الاتصال بالخادم'));
    vi.spyOn(productionApi, 'fetchOrders').mockResolvedValue([]);
    render(<DiscrepancyClaimsView />);

    await waitFor(() => expect(screen.getByText(/تعذر الاتصال بالخادم/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
  });
});
