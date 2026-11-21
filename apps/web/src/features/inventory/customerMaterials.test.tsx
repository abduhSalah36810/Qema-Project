import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CustomerMaterialsView } from './CustomerMaterialsView';

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (perm: string) =>
      ['inventory:view', 'suppliers:receive', 'warehouse:dispatch'].includes(perm),
    user: { id: 'usr-1', username: 'warehouse_officer', role: 'warehouse_manager' },
  }),
}));

vi.mock('@/features/customers/customersApi', () => ({
  fetchCustomers: vi.fn().mockResolvedValue([
    { id: 'cust-1', name: 'عميل الأمانة التجريبي', code: 'CUST-001', status: 'active' },
  ]),
}));

vi.mock('@/features/production/productionApi', () => ({
  fetchCustomerMaterialBalances: vi.fn().mockResolvedValue([
    {
      customer_id: 'cust-1',
      customer_name: 'عميل الأمانة التجريبي',
      item_id: 'mat-1',
      item_code: 'FAB-COT-01',
      item_name_ar: 'قماش قطن 100% سنغل',
      unit_name: 'متر',
      total_received: 500,
      total_consumed: 300,
      total_wasted: 10,
      total_returned: 40,
      current_balance: 150,
    },
  ]),
  fetchCustomerMaterialReceipts: vi.fn().mockResolvedValue([
    {
      id: 'rec-1',
      receipt_number: 'CMR-2026-0001',
      customer_id: 'cust-1',
      customer_name: 'عميل الأمانة التجريبي',
      received_date: '2026-11-20',
      received_by: 'أمين المخزن',
      status: 'received',
      notes: 'أثواب واردة أمانة',
      lines: [
        {
          id: 'line-1',
          item_id: 'mat-1',
          item_code: 'FAB-COT-01',
          item_name_ar: 'قماش قطن 100% سنغل',
          unit_name: 'متر',
          quantity_received: 500,
          quantity_consumed: 300,
          quantity_wasted: 10,
          quantity_returned: 40,
          quantity_remaining: 150,
        },
      ],
    },
  ]),
  fetchCatalogItems: vi.fn().mockResolvedValue([
    { id: 'mat-1', code: 'FAB-COT-01', name_ar: 'قماش قطن 100% سنغل', unit_id: 'unit-1', unit_name_ar: 'متر', is_active: true, item_type: 'raw_material' },
  ]),
  createCustomerMaterialReceipt: vi.fn().mockResolvedValue({ id: 'rec-2' }),
  createCustomerMaterialReturn: vi.fn().mockResolvedValue({ id: 'ret-1' }),
}));

describe('CustomerMaterialsView — Warehouse Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders customer materials custody balances and tabs for warehouse staff', async () => {
    render(<CustomerMaterialsView />);

    expect(screen.getByText(/أمانات خامات العملاء/)).toBeInTheDocument();
    expect(screen.getByText(/أرصدة الخامات المتاحة/)).toBeInTheDocument();
    expect(screen.getByText(/سجل سندات الاستلام/)).toBeInTheDocument();
    expect(screen.getByText(/سند استلام خامات أمانة جديد/)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('عميل الأمانة التجريبي')).toBeInTheDocument();
      expect(screen.getByText('FAB-COT-01')).toBeInTheDocument();
      expect(screen.getByText('قماش قطن 100% سنغل')).toBeInTheDocument();
    });
  });
});
