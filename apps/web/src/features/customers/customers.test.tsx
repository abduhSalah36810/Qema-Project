import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomersView } from './CustomersView';
import { createCustomer, fetchCustomerAccount, fetchCustomers } from './customersApi';

vi.mock('./customersApi', () => ({
  fetchCustomers: vi.fn(),
  fetchCustomerAccount: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

const rows = [{
  id: 'customer-1', code: 'CUS-001', name: 'عميل تجريبي', phone: '01000000000',
  city: 'القاهرة', address: 'العنوان', status: 'active' as const,
  created_at: '2026-10-24T10:00:00Z',
}];

describe('CustomersView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchCustomers).mockResolvedValue(rows);
    vi.mocked(fetchCustomerAccount).mockResolvedValue({ customer: rows[0], orders: [] });
  });

  it('loads database customers and opens their profile', async () => {
    render(<CustomersView />);
    expect(await screen.findByText('عميل تجريبي')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /عميل تجريبي/i }));
    expect(screen.getAllByText('CUS-001')).toHaveLength(2);
    expect(screen.getByText('الطلبات والتصنيع والتسليمات والمدفوعات')).toBeInTheDocument();
  });

  it('creates a customer through the API and reloads the directory', async () => {
    vi.mocked(createCustomer).mockResolvedValue(rows[0]);
    render(<CustomersView />);
    fireEvent.click(await screen.findByRole('button', { name: /تسجيل عميل/i }));
    fireEvent.change(screen.getByLabelText('كود العميل'), { target: { value: 'CUS-002' } });
    fireEvent.change(screen.getByLabelText('اسم العميل'), { target: { value: 'عميل جديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ بيانات العميل' }));
    await waitFor(() => expect(createCustomer).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUS-002', name: 'عميل جديد' })));
    expect(fetchCustomers).toHaveBeenCalledTimes(2);
  });
});
