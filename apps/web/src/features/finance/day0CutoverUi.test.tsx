import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OpeningLockStatusCard } from './OpeningLockStatusCard';
import { financeApi, type AccountingLockStatusRead, type CashDocument } from './financeApi';
import { TreasuryView } from './TreasuryView';

// Mock useAuth
const mockUseAuth = vi.fn();
vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

describe('Day-0 Cutover UI Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('OpeningLockStatusCard', () => {
    const mockUnlockedStatus: AccountingLockStatusRead = {
      is_locked: false,
      lock_type: 'opening_balances',
      current_action: null,
      latest_reason: null,
      latest_performed_by: null,
      latest_performed_at: null,
      history: [],
    };

    const mockLockedStatus: AccountingLockStatusRead = {
      is_locked: true,
      lock_type: 'opening_balances',
      current_action: 'lock',
      latest_reason: 'ترحيل القيد الافتتاحي',
      latest_performed_by: 'gm-user-1',
      latest_performed_at: '2026-01-01T10:00:00Z',
      history: [
        {
          id: 'audit-1',
          lock_type: 'opening_balances',
          is_locked: true,
          action: 'lock',
          performed_by: 'gm-user-1',
          reason: 'ترحيل القيد الافتتاحي',
          performed_at: '2026-01-01T10:00:00Z',
        },
      ],
    };

    it('renders unlocked status and GM manual lock button', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'gm-1', email: 'gm@example.com' },
        roles: ['general_manager'],
        hasPermission: () => true,
      });

      const onReload = vi.fn();
      render(<OpeningLockStatusCard lockStatus={mockUnlockedStatus} onReload={onReload} />);

      expect(screen.getByText(/حالة قفل الأرصدة الافتتاحية/)).toBeInTheDocument();
      expect(screen.getByText(/مفتوح/)).toBeInTheDocument();

      const lockBtn = screen.getByRole('button', { name: /قفل يدوي للأرصدة/ });
      expect(lockBtn).toBeInTheDocument();

      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const lockSpy = vi.spyOn(financeApi, 'lockOpeningBalances').mockResolvedValue({
        is_locked: true,
        message: 'تم قفل الأرصدة الافتتاحية بنجاح',
      });

      fireEvent.click(lockBtn);
      await waitFor(() => {
        expect(lockSpy).toHaveBeenCalledWith({ reason: 'قفل يدوي من المدير العام' });
        expect(onReload).toHaveBeenCalled();
      });
    });

    it('hides manual lock button for non-GM users when unlocked', () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'fm-1', email: 'fm@example.com' },
        roles: ['finance_manager'],
        hasPermission: () => true,
      });

      render(<OpeningLockStatusCard lockStatus={mockUnlockedStatus} onReload={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /قفل يدوي للأرصدة/ })).not.toBeInTheDocument();
    });

    it('renders locked status and allows FM to request unlock with reason', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'fm-1', email: 'fm@example.com' },
        roles: ['finance_manager'],
        hasPermission: () => true,
      });

      const onReload = vi.fn();
      render(<OpeningLockStatusCard lockStatus={mockLockedStatus} onReload={onReload} />);

      expect(screen.getByText(/مقفل/)).toBeInTheDocument();
      expect(screen.getByText(/سجل أحداث القفل وفك القفل/)).toBeInTheDocument();
      expect(screen.getByText(/ترحيل القيد الافتتاحي/)).toBeInTheDocument();

      const requestBtn = screen.getByRole('button', { name: /طلب فك القفل/ });
      fireEvent.click(requestBtn);

      expect(screen.getByText(/طلب فك قفل الأرصدة الافتتاحية/)).toBeInTheDocument();
      const textarea = screen.getByPlaceholderText(/اكتب سبب طلب تعديل الأرصدة الافتتاحية/);
      fireEvent.change(textarea, { target: { value: 'إعادة ضبط فواتير موردين ناقصة' } });

      const submitSpy = vi.spyOn(financeApi, 'requestUnlockOpeningBalances').mockResolvedValue({
        status: 'pending',
        request_id: 'req-1',
        message: 'تم تقديم طلب فك القفل',
      });

      fireEvent.click(screen.getByRole('button', { name: /إرسال طلب فك القفل/ }));
      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledWith({ reason: 'إعادة ضبط فواتير موردين ناقصة' });
        expect(onReload).toHaveBeenCalled();
      });
    });

    it('enforces Maker-Checker: disables unlock approval if GM is the requester', () => {
      const pendingUnlockStatus: AccountingLockStatusRead = {
        is_locked: true,
        lock_type: 'opening_balances',
        current_action: 'unlock_request',
        latest_reason: 'خطأ في رصيد البنك',
        latest_performed_by: 'gm-1',
        latest_performed_at: '2026-01-02T10:00:00Z',
        history: [],
      };

      mockUseAuth.mockReturnValue({
        user: { id: 'gm-1', email: 'gm@example.com' },
        roles: ['general_manager'],
        hasPermission: () => true,
      });

      render(<OpeningLockStatusCard lockStatus={pendingUnlockStatus} onReload={vi.fn()} />);

      expect(screen.getByText(/يوجد طلب فك قفل معلق/)).toBeInTheDocument();
      expect(screen.getByText(/أنت مقدم هذا الطلب — يجب أن يعتمده مدير عام آخر/)).toBeInTheDocument();
      const approveBtn = screen.getByRole('button', { name: /اعتماد فك القفل/ });
      expect(approveBtn).toBeDisabled();
    });

    it('allows a different GM to approve unlock', async () => {
      const pendingUnlockStatus: AccountingLockStatusRead = {
        is_locked: true,
        lock_type: 'opening_balances',
        current_action: 'unlock_request',
        latest_reason: 'تعديل رأس المال',
        latest_performed_by: 'fm-user',
        latest_performed_at: '2026-01-02T10:00:00Z',
        history: [],
      };

      mockUseAuth.mockReturnValue({
        user: { id: 'gm-2', email: 'gm2@example.com' },
        roles: ['general_manager'],
        hasPermission: () => true,
      });

      const onReload = vi.fn();
      render(<OpeningLockStatusCard lockStatus={pendingUnlockStatus} onReload={onReload} />);

      const approveBtn = screen.getByRole('button', { name: /اعتماد فك القفل/ });
      expect(approveBtn).not.toBeDisabled();

      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const approveSpy = vi.spyOn(financeApi, 'approveUnlockOpeningBalances').mockResolvedValue({
        is_locked: false,
        message: 'تم فك قفل الأرصدة الافتتاحية بنجاح',
      });

      fireEvent.click(approveBtn);
      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalled();
        expect(onReload).toHaveBeenCalled();
      });
    });
  });

  describe('TreasuryView Prepayment & Filters', () => {
    it('renders prepayment badge on supplier payment and shows GM/FM filters', async () => {
      mockUseAuth.mockReturnValue({
        user: { id: 'gm-1', email: 'gm@example.com' },
        roles: ['general_manager'],
        hasPermission: () => true,
      });

      vi.spyOn(financeApi, 'getAccounts').mockResolvedValue([
        {
          id: '00000000-0000-0000-0000-000000000001',
          account_type: 'treasury',
          account_number: 'TREASURY-MAIN',
          name: 'الخزينة الرئيسية',
          parent_account_id: null,
          balance: '50000',
          is_active: true,
        },
      ]);

      const mockDocs: CashDocument[] = [
        {
          id: 'doc-prepay-1',
          document_number: 'CASH-PAY-001',
          document_type: 'expense',
          amount: '6000',
          from_account_id: '00000000-0000-0000-0000-000000000001',
          to_account_id: null,
          status: 'approved',
          source_system: 'purchasing',
          description: 'دفعة نقدية لفاتورة مورد',
          supplier_name: 'شركة النسيج الذهبي',
          is_prepayment: true,
          invoice_total: 10000,
          received_value: 4000,
          is_auto_posted: true,
          occurred_at: '2026-01-01T12:00:00Z',
          created_by: 'fm-1',
          approved_by: null,
          rejection_reason: null,
        },
      ];

      const getDocsSpy = vi.spyOn(financeApi, 'getCashDocuments').mockResolvedValue(mockDocs);

      render(<TreasuryView />);

      await waitFor(() => {
        expect(screen.getByText(/قيود مرحلة آلياً فقط/)).toBeInTheDocument();
        expect(screen.getByText(/دفعات مقدمة فقط/)).toBeInTheDocument();
      });

      // Verify prepayment text
      expect(screen.getByText(/دفعة مقدمة: المستلم/)).toBeInTheDocument();
      expect(screen.getByText(/مُرحَّل آلياً/)).toBeInTheDocument();

      // Click filter button
      const prepayFilterBtn = screen.getByRole('button', { name: /دفعات مقدمة فقط/ });
      fireEvent.click(prepayFilterBtn);

      await waitFor(() => {
        expect(getDocsSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            prepayment_only: true,
          })
        );
      });
    });
  });
});
