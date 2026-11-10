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
