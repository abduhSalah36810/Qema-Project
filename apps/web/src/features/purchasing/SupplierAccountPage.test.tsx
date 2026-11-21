import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SupplierAccountPage } from './SupplierAccountPage';
import { financeApi } from '@/features/finance/financeApi';

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'fin@qemma.local', roles: ['finance_manager'] },
    roles: ['finance_manager'],
    hasPermission: () => true,
  }),
}));

const mockSupplier = {
  id: 'sup-1',
  code: 'SUP-001',
  name: 'مورد النسيج الحديث',
  phone: '01012345678',
  address: 'المحلة الكبرى',
  is_active: true,
};

const mockInvoices = [
  {
    id: 'inv-1',
    internal_number: 'PINV-001',
    supplier_id: 'sup-1',
    supplier_name: 'مورد النسيج الحديث',
    invoice_number: 'INV-2026-01',
    invoice_date: '2026-11-01',
    invoice_total: 10000,
    paid_total: 4000,
    status: 'received',
    notes: 'فاتورة قماش قطن',
    lines: [],
    received_value: 10000,
    payable_balance: 6000,
  },
];

const mockStatement = {
  supplier: { id: 'sup-1', code: 'SUP-001', name: 'مورد النسيج الحديث', phone: '01012345678' },
  totals: {
    total_invoiced: 10000,
    total_received: 10000,
    total_paid: 4000,
    pending_payments: 0,
    balance_due: 6000,
  },
  invoices: [
    {
      invoice_id: 'inv-1',
      internal_number: 'PINV-001',
      invoice_number: 'INV-2026-01',
      invoice_date: '2026-11-01',
      status: 'received',
      invoice_total: 10000,
      received_value: 10000,
      paid_total: 4000,
      pending_payments: 0,
      balance_due: 6000,
      remaining_on_invoice: 6000,
    },
  ],
};

const mockUnallocated = [
  {
    cash_document_id: 'pay-unalloc-1',
    document_number: 'CD-001',
    document_type: 'supplier_payment',
    occurred_at: '2026-11-10',
    total_amount: 2500,
    allocated_amount: 0,
    unallocated_amount: 2500,
    description: 'دفعة تحت الحساب',
  },
];

describe('SupplierAccountPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(financeApi, 'getSupplierInvoices').mockResolvedValue(mockInvoices as any);
    vi.spyOn(financeApi, 'getSupplierStatement').mockResolvedValue(mockStatement as any);
    vi.spyOn(financeApi, 'getSupplierUnallocatedPayments').mockResolvedValue(mockUnallocated as any);
  });

  it('renders supplier details, KPI summaries, and unallocated payments banner', async () => {
    render(<SupplierAccountPage supplier={mockSupplier} onBack={vi.fn()} />);

    expect(await screen.findByText('مورد النسيج الحديث')).toBeInTheDocument();
    expect(screen.getByText('SUP-001')).toBeInTheDocument();
    expect(screen.getByText(/المحلة الكبرى/)).toBeInTheDocument();

    // Unallocated alert
    expect(screen.getByText(/يوجد رصيد دفعات نقدية معلقة غير مخصصة/)).toBeInTheDocument();

    // Invoice row
    expect(screen.getByText('INV-2026-01')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'سداد دفعة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تخصيص دفعة معلقة' })).toBeInTheDocument();
  });

  it('switches to statement tab and displays statement invoices', async () => {
    render(<SupplierAccountPage supplier={mockSupplier} onBack={vi.fn()} />);

    expect(await screen.findByText('INV-2026-01')).toBeInTheDocument();

    const statementTab = screen.getByRole('tab', { name: 'كشف الحساب' });
    fireEvent.click(statementTab);

    expect(await screen.findByText('PINV-001')).toBeInTheDocument();
  });

  it('opens allocation modal and submits payment allocation', async () => {
    const allocateSpy = vi.spyOn(financeApi, 'allocateSupplierPayment').mockResolvedValue({} as any);

    render(<SupplierAccountPage supplier={mockSupplier} onBack={vi.fn()} />);

    expect(await screen.findByText('INV-2026-01')).toBeInTheDocument();

    const allocBtn = screen.getByRole('button', { name: 'تخصيص دفعة معلقة' });
    fireEvent.click(allocBtn);

    expect(screen.getByText('تخصيص دفعة معلقة على الفاتورة')).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: 'تأكيد التخصيص' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(allocateSpy).toHaveBeenCalledWith(
        'inv-1',
        expect.objectContaining({
          cash_document_id: 'pay-unalloc-1',
        })
      );
    });
  });
});
