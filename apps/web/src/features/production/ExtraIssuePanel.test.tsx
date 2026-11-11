import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialogProvider } from '@/components/feedback/DialogProvider';
import * as inventoryApi from '@/features/inventory/inventoryApi';
import * as productionApi from './productionApi';
import { ExtraIssuePanel } from './ExtraIssuePanel';

const RAW = { id: 'wh-raw', code: 'main_raw_materials', name_ar: 'مخزن الخامات', is_active: true };
const balance = (id: string, name: string, qty: number): inventoryApi.StockBalance => ({
  item_id: id, item_code: id.toUpperCase(), item_name_ar: name, unit_id: 'u-m', unit_name_ar: 'متر',
  warehouse_id: RAW.id, warehouse_code: RAW.code, warehouse_name_ar: RAW.name_ar, balance: qty, is_established: true,
});

const pendingIssue: productionApi.WarehouseTransfer = {
  id: 'tr-x1', transfer_number: 'TRX-2026-AAA111', order_id: 'ord-1', source_warehouse_id: RAW.id,
  destination_warehouse_id: 'wh-wip', status: 'in_transit', dispatched_at: '2026-11-11T08:00:00Z',
  dispatched_by: 'usr-wh', notes: 'صرف إضافي: إصلاح عيوب', received_at: null, received_by: null,
  lines: [{ id: 'l1', item_id: 'fab', item_name_ar: 'قماش', item_code: 'FAB', unit_id: 'u-m', unit_name_ar: 'متر', dispatched_quantity: 10, received_quantity: 0, discrepancy_quantity: 0, notes: '' }],
};

function renderPanel(props: Partial<React.ComponentProps<typeof ExtraIssuePanel>> = {}) {
  const onChanged = vi.fn();
  render(
    <DialogProvider>
      <ExtraIssuePanel
        orderId="ord-1"
        orderStatus="in_production"
        currentUserId="usr-wh"
        canDispatch
        canReceive={false}
        onChanged={onChanged}
        {...props}
      />
    </DialogProvider>,
  );
  return onChanged;
}

describe('ExtraIssuePanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(productionApi, 'fetchWarehouses').mockResolvedValue([RAW]);
    vi.spyOn(inventoryApi, 'fetchStockBalances').mockResolvedValue([balance('fab', 'قماش', 40), balance('btn', 'زرار', 5)]);
  });

  it('warehouse manager validates lines before posting and confirms before the stock leaves', async () => {
    vi.spyOn(productionApi, 'fetchOrderExtraIssues').mockResolvedValue([]);
    const create = vi.spyOn(productionApi, 'createExtraIssueApi').mockResolvedValue({ ...pendingIssue });
    const onChanged = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /صرف إضافي/ }));
    await screen.findByRole('option', { name: /قماش/ });

    // بلا سبب
    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الصرف' }));
    expect(await screen.findByText(/اكتب سبب الصرف الإضافي/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/إصلاح عيوب القص/), { target: { value: 'إصلاح عيوب' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'الخامة' }), { target: { value: 'fab' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'الكمية' }), { target: { value: '41' } });
    expect(screen.getByText(/أكبر من المتاح/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الصرف' }));
    expect(await screen.findByText(/راجع سطور الخامات/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'الكمية' }), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'ترحيل الصرف' }));
    expect(await screen.findByText(/سيُخصم من مخزن الخامات فوراً/)).toBeInTheDocument();
    const postButtons = screen.getAllByRole('button', { name: 'ترحيل الصرف' });
    fireEvent.click(postButtons[postButtons.length - 1]); // زر التأكيد في نافذة الحوار

    await waitFor(() => expect(create).toHaveBeenCalledWith(
      'ord-1',
      { reason: 'إصلاح عيوب', lines: [{ item_id: 'fab', quantity: 10, notes: '' }] },
      expect.any(String),
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('dispatcher cannot receive own issue and cannot start another while one is in transit', async () => {
    vi.spyOn(productionApi, 'fetchOrderExtraIssues').mockResolvedValue([pendingIssue]);
    renderPanel({ canReceive: true });
    expect(await screen.findByText('TRX-2026-AAA111')).toBeInTheDocument();
    expect(screen.getByText(/بالطريق · بانتظار استلام الورشة/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /صرف إضافي/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تأكيد استلام الورشة' })).not.toBeInTheDocument();
    expect(screen.getByText(/صرفت هذه الخامات بنفسك/)).toBeInTheDocument();
  });

  it('production manager records the actual received quantity with a confirmation', async () => {
    vi.spyOn(productionApi, 'fetchOrderExtraIssues').mockResolvedValue([pendingIssue]);
    const receive = vi.spyOn(productionApi, 'receiveExtraIssueApi').mockResolvedValue({ ...pendingIssue, status: 'received_confirmed' });
    renderPanel({ currentUserId: 'usr-pm', canDispatch: false, canReceive: true });

    const input = await screen.findByRole('spinbutton', { name: 'المستلم من قماش' });
    fireEvent.change(input, { target: { value: '9' } });
    // الفرق (9 − 10) يظهر قبل الإرسال
    expect(input.closest('tr')!.lastElementChild!.textContent).toMatch(/١/);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد استلام الورشة' }));
    fireEvent.click(await screen.findByRole('button', { name: 'تأكيد الاستلام' }));
    await waitFor(() => expect(receive).toHaveBeenCalledWith(
      'ord-1', 'tr-x1', { received_lines: [{ item_id: 'fab', received_quantity: 9, notes: '' }] }, expect.any(String),
    ));
  });

  it('hides the issue form once the order left production', async () => {
    vi.spyOn(productionApi, 'fetchOrderExtraIssues').mockResolvedValue([]);
    renderPanel({ orderStatus: 'receipt_completed' });
    expect(await screen.findByText('لا يوجد صرف إضافي لهذا الأمر.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /صرف إضافي/ })).not.toBeInTheDocument();
  });

  it('hides the issue form once finished goods receipt has started', async () => {
    vi.spyOn(productionApi, 'fetchOrderExtraIssues').mockResolvedValue([]);
    renderPanel({ finishedGoodsStarted: true });
    expect(await screen.findByText(/بدأ استلام المنتج التام لهذا الأمر/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /صرف إضافي/ })).not.toBeInTheDocument();
  });
});
