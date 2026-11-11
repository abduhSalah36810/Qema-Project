import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DialogProvider } from '@/components/feedback/DialogProvider';
import * as customersApi from './customersApi';
import { CustomerReturnsView } from './CustomerReturnsView';

const perms = vi.hoisted(() => new Set<string>());
vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (p: string) => perms.has(p), user: { id: 'usr-wh' } }),
}));

const delivery: customersApi.ReturnableDelivery = {
  delivery_id: 'del-1', delivery_number: 'DLV-1', delivered_at: '2026-11-10T10:00:00Z', order_id: 'ord-1', order_number: 'SO-1',
  customer_id: 'cus-1', customer_name: 'عميل أ', customer_code: 'C1',
  lines: [{ delivery_line_id: 'dl-1', product_name: 'جلابية', variant_info: 'مقاس 56', delivered_quantity: 10, returned_quantity: 4, returnable_quantity: 6 }],
};

const pendingReturn: customersApi.CustomerReturn = {
  id: 'ret-1', return_number: 'RET-1', delivery_id: 'del-1', order_id: 'ord-1', customer_id: 'cus-1', returned_at: '2026-11-11T09:00:00Z',
  reason: 'عيب خياطة', received_by: '', disposition: 'pending_inspection', created_by: 'usr-wh', inspection_notes: '',
  delivery_number: 'DLV-1', order_number: 'SO-1', customer_name: 'عميل أ', customer_code: 'C1',
  lines: [{ id: 'rl-1', delivery_line_id: 'dl-1', order_line_id: 'ol-1', product_name: 'جلابية', variant_info: 'مقاس 56', quantity: 5, notes: '', condition: 'damaged', restocked_quantity: 0, scrapped_quantity: 0 }],
};

const renderView = () => render(<DialogProvider><CustomerReturnsView /></DialogProvider>);
const lastButton = (name: string) => {
  const all = screen.getAllByRole('button', { name });
  return all[all.length - 1];
};

describe('CustomerReturnsView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    perms.clear();
    perms.add('customers:deliveries:manage');
  });

  it('records a return against a delivery, blocking quantities above what is returnable', async () => {
    vi.spyOn(customersApi, 'fetchCustomerReturns').mockResolvedValue([]);
    vi.spyOn(customersApi, 'fetchReturnableDeliveries').mockResolvedValue([delivery]);
    const record = vi.spyOn(customersApi, 'recordCustomerReturn').mockResolvedValue({ ...pendingReturn });
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: /تسجيل مرتجع/ }));
    fireEvent.click(await screen.findByRole('button', { name: /DLV-1/ }));

    const qty = screen.getByRole('spinbutton', { name: /الكمية المرتجعة من جلابية/ });
    fireEvent.change(qty, { target: { value: '7' } });
    expect(screen.getByText(/أكبر من المتاح للإرجاع/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/عيب خياطة في الياقة/), { target: { value: 'عيب خياطة' } });
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل المرتجع' }));
    expect(await screen.findByText(/راجع الكميات المعلَّمة/)).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();

    fireEvent.change(qty, { target: { value: '5' } });
    fireEvent.change(screen.getByRole('combobox', { name: /حالة جلابية/ }), { target: { value: 'damaged' } });
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل المرتجع' }));
    expect(await screen.findByText(/تدخل البضاعة «تحت الفحص»/)).toBeInTheDocument();
    fireEvent.click(lastButton('تسجيل المرتجع'));

    await waitFor(() => expect(record).toHaveBeenCalledWith('cus-1', 'ord-1', 'del-1', expect.objectContaining({
      reason: 'عيب خياطة',
      lines: [{ delivery_line_id: 'dl-1', quantity: 5, condition: 'damaged', notes: '' }],
    })));
    expect(await screen.findByText(/تم تسجيل المرتجع RET-1/)).toBeInTheDocument();
  });

  it('inspection splits each line into resalable and damaged that must add up', async () => {
    vi.spyOn(customersApi, 'fetchCustomerReturns').mockResolvedValue([pendingReturn]);
    const inspect = vi.spyOn(customersApi, 'inspectCustomerReturn').mockResolvedValue({ ...pendingReturn, disposition: 'partially_restocked' });
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'فحص المرتجع' }));
    const dialog = screen.getByRole('dialog', { name: 'فحص RET-1' });
    // تالف ظاهرياً: الافتراضي كله تالف
    expect((within(dialog).getByRole('spinbutton', { name: /التالف من/ }) as HTMLInputElement).value).toBe('5');

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /الصالح من/ }), { target: { value: '2' } });
    expect((within(dialog).getByRole('spinbutton', { name: /التالف من/ }) as HTMLInputElement).value).toBe('3');
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /التالف من/ }), { target: { value: '1' } });
    expect(within(dialog).getByText(/يجب أن يساوي/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتماد الفحص' }));
    expect(await screen.findByText(/راجع كميات الفحص/)).toBeInTheDocument();
    expect(inspect).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /التالف من/ }), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اعتماد الفحص' }));
    expect(await screen.findByText(/يعود ٢ قطعة للرصيد القابل للبيع، ويُعدم ٣ قطعة/)).toBeInTheDocument();
    fireEvent.click(lastButton('اعتماد الفحص'));
    await waitFor(() => expect(inspect).toHaveBeenCalledWith('cus-1', 'ret-1', {
      notes: '', lines: [{ return_line_id: 'rl-1', restocked_quantity: 2, scrapped_quantity: 3 }],
    }));
  });

  it('viewers without the delivery permission see history only', async () => {
    perms.clear();
    perms.add('customers:view');
    vi.spyOn(customersApi, 'fetchCustomerReturns').mockResolvedValue([pendingReturn]);
    renderView();
    expect(await screen.findByText('RET-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /تسجيل مرتجع/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'فحص المرتجع' })).not.toBeInTheDocument();
  });
});
