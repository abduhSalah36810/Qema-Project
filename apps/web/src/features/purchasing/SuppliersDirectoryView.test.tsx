import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SuppliersDirectoryView } from './SuppliersDirectoryView';
import { financeApi } from '@/features/finance/financeApi';

vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'fin@qemma.local', roles: ['finance_manager'] },
    roles: ['finance_manager'],
    hasPermission: () => true,
  }),
}));

const mockSuppliers = [
  {
    id: 'sup-1',
    code: 'SUP-001',
    name: 'مورد النسيج الحديث',
    phone: '01012345678',
    address: 'المحلة الكبرى',
    is_active: true,
  },
  {
    id: 'sup-2',
    code: 'SUP-002',
    name: 'شركة الأزرار المتحدة',
    phone: '01198765432',
    address: 'شبرا الخيمة',
    is_active: false,
  },
];

describe('SuppliersDirectoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(financeApi, 'getSuppliers').mockResolvedValue(mockSuppliers as any);
    vi.spyOn(financeApi, 'getSupplierInvoices').mockResolvedValue([]);
    vi.spyOn(financeApi, 'getSupplierStatement').mockResolvedValue(null as any);
    vi.spyOn(financeApi, 'getSupplierUnallocatedPayments').mockResolvedValue([]);
  });

  it('renders suppliers list with stats and allows searching', async () => {
    render(<SuppliersDirectoryView />);

    expect(await screen.findByText('مورد النسيج الحديث')).toBeInTheDocument();
    expect(screen.getByText('شركة الأزرار المتحدة')).toBeInTheDocument();
    expect(screen.getByText('SUP-001')).toBeInTheDocument();
    expect(screen.getByText('SUP-002')).toBeInTheDocument();

    // Stats
    expect(screen.getByText('إجمالي الموردين')).toBeInTheDocument();

    // Search filter
    const searchInput = screen.getByLabelText('بحث في الموردين');
    fireEvent.change(searchInput, { target: { value: 'النسيج' } });

    expect(screen.getByText('مورد النسيج الحديث')).toBeInTheDocument();
    expect(screen.queryByText('شركة الأزرار المتحدة')).not.toBeInTheDocument();
  });

  it('navigates to SupplierAccountPage when clicking on a supplier and returns back', async () => {
    render(<SuppliersDirectoryView />);

    expect(await screen.findByText('مورد النسيج الحديث')).toBeInTheDocument();

    const detailButtons = screen.getAllByRole('button', { name: /كشف الحساب والتفاصيل/ });
    fireEvent.click(detailButtons[0]);

    // Should now be on SupplierAccountPage
    expect(await screen.findByRole('button', { name: '‹ العودة إلى قائمة الموردين' })).toBeInTheDocument();

    // Click back button
    fireEvent.click(screen.getByRole('button', { name: '‹ العودة إلى قائمة الموردين' }));

    // Should be back to directory
    expect(await screen.findByLabelText('بحث في الموردين')).toBeInTheDocument();
  });

  it('opens create supplier modal and submits new supplier', async () => {
    const createSpy = vi.spyOn(financeApi, 'createSupplier').mockResolvedValue({
      id: 'sup-new',
      code: 'SUP-NEW',
      name: 'مورد الخيوط الذهبية',
      phone: '01234567890',
      address: 'العاشر من رمضان',
      is_active: true,
    } as any);

    render(<SuppliersDirectoryView />);

    expect(await screen.findByText('مورد النسيج الحديث')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '＋ تسجيل مورد جديد' }));

    expect(screen.getByRole('heading', { level: 3, name: 'تسجيل مورد جديد' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('مثال: شركة النسيج الحديث'), {
      target: { value: 'مورد الخيوط الذهبية' },
    });
    fireEvent.change(screen.getByPlaceholderText('01xxxxxxxxx'), {
      target: { value: '01234567890' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'حفظ المورد' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'مورد الخيوط الذهبية',
          phone: '01234567890',
        })
      );
    });
  });
});
