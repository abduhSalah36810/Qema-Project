import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IncomeStatementView } from './IncomeStatementView';
import { BalanceSheetView } from './BalanceSheetView';
import { AccountStatementsView } from './AccountStatementsView';
import { ManagementReportsView } from './ManagementReportsView';
import { financeApi, type ProfitAndLossReport, type BalanceSheetReport } from '../financeApi';

const pnlReport: ProfitAndLossReport = {
  period_days: null,
  period: { date_from: '2026-11-01', date_to: '2026-11-30' },
  revenues: {
    items: [
      { code: '4100', name_ar: 'مبيعات منتجات تامة', debit: 0, credit: 100000, net_amount: 100000 },
    ],
    total_revenue: 100000,
  },
  cost_of_goods_sold: {
    items: [
      { code: '5100', name_ar: 'تكلفة البضاعة المباعة', debit: 60000, credit: 0, net_amount: 60000 },
    ],
    total_cogs: 60000,
  },
  gross_profit: 40000,
  gross_profit_margin_pct: 40,
  operating_expenses: {
    items: [
      { code: '5400', name_ar: 'مصروفات عمومية وإدارية', debit: 15000, credit: 0, net_amount: 15000 },
    ],
    total_expenses: 15000,
  },
  net_income: 25000,
  net_profit_margin_pct: 25,
};

const balanceSheetReport: BalanceSheetReport = {
  is_balanced: true,
  difference: 0,
  opening_balance: {
    is_set: true,
    accounting_start_date: '2026-01-01',
    journal_entry_number: 'JE-OPENING-01',
  },
  assets: {
    current_assets: [
      { code: '1010', name_ar: 'الخزينة الرئيسية', amount: 50000 },
      { code: '1100', name_ar: 'العملاء والمدينين', amount: 30000 },
      { code: '1210', name_ar: 'مخزون الخامات', amount: 20000 },
    ],
    total_assets: 100000,
  },
  liabilities: {
    current_liabilities: [
      { code: '2000', name_ar: 'مستحقات الموردين', amount: 25000 },
    ],
    total_liabilities: 25000,
  },
  equity: {
    equity_items: [
      { code: '3000', name_ar: 'رأس المال المدفوع', amount: 50000 },
      { code: '3100', name_ar: 'الأرباح والخسائر المرحلة', amount: 25000 },
    ],
    total_equity: 75000,
  },
  total_liabilities_and_equity: 100000,
};

describe('Reports Architecture & UI Refinement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(financeApi, 'getProfitAndLossReport').mockResolvedValue(pnlReport);
    vi.spyOn(financeApi, 'getBalanceSheet').mockResolvedValue(balanceSheetReport);
    vi.spyOn(financeApi, 'getAccounts').mockResolvedValue([
      { id: 'acc-1', name: 'الخزينة الرئيسية', account_number: '1010', account_type: 'treasury', balance: '50000', is_active: true, parent_account_id: null },
    ]);
  });

  describe('1. IncomeStatementView (قائمة الدخل)', () => {
    it('renders with correct title, internal tabs, and print button', async () => {
      render(<IncomeStatementView />);
      expect(screen.getByRole('heading', { level: 2, name: 'قائمة الدخل' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'طباعة / حفظ PDF' })).toBeInTheDocument();

      // Check all 5 internal tabs + الكل
      expect(screen.getByRole('tab', { name: 'الكل' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'ملخص قائمة الدخل' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'الإيرادات' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'تكلفة المبيعات' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'المصروفات' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'صافي الربح' })).toBeInTheDocument();

      // Data appears
      expect(await screen.findByText('مبيعات منتجات تامة')).toBeInTheDocument();
      expect(screen.getByText('تكلفة البضاعة المباعة')).toBeInTheDocument();
      expect(screen.getByText('مصروفات عمومية وإدارية')).toBeInTheDocument();

      // Switch to Revenues tab
      fireEvent.click(screen.getByRole('tab', { name: 'الإيرادات' }));
      expect(screen.getByText('مبيعات منتجات تامة')).toBeInTheDocument();

      // Switch to Profit tab
      fireEvent.click(screen.getByRole('tab', { name: 'صافي الربح' }));
      expect(screen.getByText('تحليل صافي الربح وهوامش التشغيل')).toBeInTheDocument();
    });
  });

  describe('2. BalanceSheetView (الميزانية العمومية)', () => {
    it('renders with correct title, internal sections, opening balance status, and print button', async () => {
      render(<BalanceSheetView />);
      expect(screen.getByRole('heading', { level: 2, name: 'الميزانية العمومية' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'طباعة / حفظ PDF' })).toBeInTheDocument();

      // Check tabs
      expect(screen.getByRole('tab', { name: 'الكل' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'ملخص الميزانية' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'الأصول' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'الالتزامات' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'حقوق الملكية' })).toBeInTheDocument();

      // Opening balance banner and accounts data
      expect(await screen.findByText(/القيد الافتتاحي معتمد ومثبت في النظام/)).toBeInTheDocument();
      expect(screen.getByText('الخزينة الرئيسية')).toBeInTheDocument();
      expect(screen.getByText('مستحقات الموردين')).toBeInTheDocument();
      expect(screen.getByText('رأس المال المدفوع')).toBeInTheDocument();
    });
  });

  describe('3. AccountStatementsView (كشوف الحسابات)', () => {
    it('renders centralized statement types for customer, supplier, employee, treasury, custody, and gl', async () => {
      render(<AccountStatementsView />);
      expect(screen.getByRole('heading', { level: 2, name: 'كشوف الحسابات' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'طباعة / حفظ PDF' })).toBeInTheDocument();

      // Check all 6 statement types
      expect(screen.getByRole('tab', { name: 'كشف حساب عميل' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'كشف حساب مورد' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'كشف حساب موظف' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'كشف حساب خزينة' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'كشف حساب عهدة' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'كشف حساب الأستاذ العام' })).toBeInTheDocument();

      // Default is customer statement
      expect(screen.getByText('اختر عميلاً لعرض كشف حسابه، أو اضغط على عميل في تقرير المديونيات أو أعمار الديون.')).toBeInTheDocument();

      // Switch to GL statement
      fireEvent.click(screen.getByRole('tab', { name: 'كشف حساب الأستاذ العام' }));
      expect(screen.getByText(/يمكنك فحص دفتر الأستاذ العام وتفاصيل أي حساب بالنقر مباشرة/)).toBeInTheDocument();
    });
  });

  describe('4. ManagementReportsView (تقارير الإدارة)', () => {
    it('renders the four exact management report groups without "جديد" badges', async () => {
      render(<ManagementReportsView />);
      expect(screen.getByRole('heading', { level: 2, name: 'تقارير الإدارة' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'طباعة / حفظ PDF' })).toBeInTheDocument();

      // Check the 4 exact groups
      expect(screen.getByRole('button', { name: 'الخزينة والمصروفات' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'العملاء والموردون' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'المبيعات والربحية' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'المخزون والتكلفة' })).toBeInTheDocument();

      // Ensure NO "جديد" badges exist
      expect(screen.queryByText('جديد')).not.toBeInTheDocument();

      // Check treasury reports
      expect(screen.getByRole('tab', { name: 'حركة الخزينة' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'المقبوضات والمدفوعات' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'المصروفات' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'تكلفة الرواتب' })).toBeInTheDocument();

      // Switch to Customers & Suppliers group
      fireEvent.click(screen.getByRole('button', { name: 'العملاء والموردون' }));
      expect(screen.getByRole('tab', { name: 'أعمار ديون العملاء' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'مديونيات العملاء' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'مستحقات الموردين' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'أعمار مستحقات الموردين' })).toBeInTheDocument();

      // Customer statement & supplier statement are not duplicated here
      expect(screen.queryByRole('tab', { name: 'كشف حساب عميل' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'كشف حساب مورد' })).not.toBeInTheDocument();

      // Switch to Inventory & Cost group
      fireEvent.click(screen.getByRole('button', { name: 'المخزون والتكلفة' }));
      expect(screen.getByRole('tab', { name: 'تقييم المخزون' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'تحت التشغيل' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'المخزون الراكد' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'حد الطلب' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'الهالك والعجز' })).toBeInTheDocument();
    });
  });
});

