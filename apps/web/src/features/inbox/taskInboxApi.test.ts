import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { fetchInboxTasks } from './taskInboxApi';

const dispatchedOrder = {
  id: 'ord-1',
  order_number: 'PO-1',
  status: 'materials_dispatched',
  product_name_ar: 'جلابية',
  target_quantity: 10,
  created_at: '2026-11-09T08:00:00Z',
  pending_transfer_dispatched_by: 'user-dispatcher',
};

function mockOrders() {
  return vi.spyOn(apiClient, 'request').mockImplementation(async (path: string) => {
    if (path.startsWith('/api/v1/production/orders')) return [dispatchedOrder] as never;
    return [] as never;
  });
}

describe('صندوق المهام: فصل الصارف عن المستلم', () => {
  afterEach(() => vi.restoreAllMocks());

  const gmPermissions = ['production:orders:view', 'warehouse:dispatch', 'production:wip:receive'];

  it('من صرف الخامات يرى متابعة بانتظار الطرف الآخر لا مهمة تأكيد استلام', async () => {
    mockOrders();
    const { tasks } = await fetchInboxTasks(gmPermissions, 'user-dispatcher');
    expect(tasks.map((t) => t.id)).toEqual(['po-wip-waiting-ord-1']);
    expect(tasks[0].awaitingOther).toBe(true);
    expect(tasks[0].actionLabel).toBe('عرض الأمر');
  });

  it('مستخدم آخر يملك صلاحية استلام الورشة يرى مهمة التأكيد', async () => {
    mockOrders();
    const { tasks } = await fetchInboxTasks(gmPermissions, 'another-user');
    expect(tasks.map((t) => t.id)).toEqual(['po-wip-ord-1']);
    expect(tasks[0].awaitingOther).toBeUndefined();
  });

  it('مرتجع ورشة بالطريق: مهمة فحص لأمين المخزن، ومتابعة فقط لمن سجّله', async () => {
    vi.spyOn(apiClient, 'request').mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/production/orders')) {
        return [{
          ...dispatchedOrder, status: 'receipt_completed', pending_transfer_dispatched_by: null,
          returns_awaiting_receipt: 1, returns_pending_declared_by: ['user-pm'],
          returns_awaiting_resolution: 1, returns_pending_received_by: ['user-wh'],
        }] as never;
      }
      return [] as never;
    });
    const wh = await fetchInboxTasks(['production:orders:view', 'warehouse:dispatch', 'warehouse:returns:receive'], 'user-wh');
    expect(wh.tasks.map((t) => t.id).sort()).toEqual(['po-return-receive-ord-1', 'po-return-resolution-waiting-ord-1']);
    expect(wh.tasks.find((t) => t.id === 'po-return-resolution-waiting-ord-1')?.awaitingOther).toBe(true);

    const pm = await fetchInboxTasks(['production:orders:view', 'production:returns:resolve', 'production:orders:manage', 'production:orders:close'], 'user-pm');
    // الإغلاق محجوب بالمرتجعات المعلقة فلا يظهر كمهمة
    expect(pm.tasks.map((t) => t.id).sort()).toEqual(['po-return-resolve-ord-1', 'po-return-waiting-ord-1']);
  });

  it('من لا يملك صلاحية استلام الورشة لا تظهر له مهمة تنفيذية', async () => {
    mockOrders();
    const { tasks } = await fetchInboxTasks(['production:orders:view', 'warehouse:dispatch'], 'another-user');
    expect(tasks).toEqual([]);
  });
});

describe('صندوق المهام: مطالبات عجز استلام الخامات (Phase 4.5 / T2)', () => {
  afterEach(() => vi.restoreAllMocks());

  const pendingClaim = {
    id: 'claim-1',
    claim_number: 'CLM-2026-A1B2C3',
    order_id: 'ord-1',
    order_number: 'PO-1',
    item_name_ar: 'قماش قطن',
    item_code: 'FAB',
    unit_name_ar: 'متر',
    discrepancy_quantity: 5,
    total_cost: 60,
    status: 'pending_investigation',
    claimed_by: 'user-receiver',
    claimed_at: '2026-11-15T08:00:00Z',
    claim_notes: 'عجز عند استلام الورشة',
  };

  function mockClaimSource() {
    return vi.spyOn(apiClient, 'request').mockImplementation(async (path: string) => {
      if (path.includes('/production/discrepancy-claims')) return [pendingClaim] as never;
      return [] as never;
    });
  }

  it('أمين المخزن (صاحب warehouse:claims:resolve) يرى مهمة حسم المطالبة لمطالبة أثبتها غيره', async () => {
    mockClaimSource();
    const { tasks } = await fetchInboxTasks(['production:orders:view', 'warehouse:claims:resolve'], 'user-wh');
    expect(tasks.map((t) => t.id)).toEqual(['claim-resolve-claim-1']);
    expect(tasks[0].category).toBe('warehouse');
    expect(tasks[0].priority).toBe('high');
    expect(tasks[0].actionNavId).toBe('production-claims');
    expect(tasks[0].awaitingOther).toBeUndefined();
  });

  it('مثبت العجز (منشئ المطالبة) لا يرى مهمة حسم بل متابعة فقط (Maker-Checker)', async () => {
    mockClaimSource();
    const { tasks } = await fetchInboxTasks(['production:orders:view', 'warehouse:claims:resolve'], 'user-receiver');
    expect(tasks.map((t) => t.id)).toEqual(['claim-waiting-claim-1']);
    expect(tasks[0].awaitingOther).toBe(true);
    expect(tasks[0].nextRole).toBe('أمين المخزن أو المدير العام');
  });

  it('مدير الإنتاج (بلا صلاحية الحسم) يرى مهمة متابعة بلا إجراء حسم', async () => {
    mockClaimSource();
    const { tasks } = await fetchInboxTasks(['production:orders:view', 'production:stages:manage'], 'user-pm');
    expect(tasks.map((t) => t.id)).toEqual(['claim-follow-claim-1']);
    expect(tasks[0].awaitingOther).toBe(true);
    expect(tasks[0].description).toContain('تمنع إغلاق الأمر');
  });

  it('مهمة واحدة فقط لكل مطالبة لكل مستخدم (لا تكرار)', async () => {
    mockClaimSource();
    const { tasks } = await fetchInboxTasks(['production:orders:view', 'warehouse:claims:resolve'], 'user-wh');
    expect(tasks.filter((t) => t.referenceDoc === 'CLM-2026-A1B2C3')).toHaveLength(1);
  });

  it('مطالبة محسومة (تمرر الخادم فلتر pending فقط) لا تُشتق منها مهمة', async () => {
    vi.spyOn(apiClient, 'request').mockImplementation(async (path: string) => {
      if (path.includes('/production/discrepancy-claims')) {
        return [{ ...pendingClaim, status: 'accepted_transit_loss' }] as never;
      }
      return [] as never;
    });
    const { tasks } = await fetchInboxTasks(['production:orders:view', 'warehouse:claims:resolve'], 'user-wh');
    expect(tasks).toEqual([]);
  });
});
