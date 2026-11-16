import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FinancialReportsView } from '../FinancialReportsView';
import { financeApi, type ProfitAndLossReport, type BalanceSheetReport } from '../financeApi';
import { analyticsApi, cairoToday, presetPeriod, type AgingReport, type OverviewReport } from './analyticsApi';
import { DataTable } from './reportUi';

const months = Array.from({ length: 12 }, (_, i) => ({
  month: `2026-${String(i + 1).padStart(2, '0')}`, inflows: 1000 * i, outflows: 500 * i, sales: 800 * i, cogs: 300 * i,
  operating_expenses: 50, payroll: 100, net_cash: 500 * i, gross_profit: 500 * i,
}));

const overview: OverviewReport = {
  period: { date_from: '2026-11-01', date_to: '2026-11-10' },
  previous_period: { date_from: '2026-10-22', date_to: '2026-10-31' },
  kpis: [
    { key: 'sales', label: 'صافي المبيعات المسلمة', value: 12000, previous: 10000, change_pct: 20 },
    { key: 'gross_profit', label: 'مجمل الربح', value: 4000, previous: 5000, change_pct: -20 },
    { key: 'operating_result', label: 'الصافي التشغيلي (تقريبي)', value: 1000, previous: 0, change_pct: null },
    { key: 'net_cash', label: 'صافي الحركة النقدية', value: 3000, previous: 3000, change_pct: 0 },
    { key: 'collections', label: 'تحصيلات العملاء', value: 9000, previous: 8000, change_pct: 12.5 },
    { key: 'supplier_payments', label: 'مدفوعات الموردين', value: 2000, previous: 2000, change_pct: 0 },
    { key: 'operating_expenses', label: 'المصروفات التشغيلية', value: 600, previous: 500, change_pct: 20 },
    { key: 'payroll', label: 'الرواتب المصروفة', value: 1500, previous: 1500, change_pct: 0 },
    { key: 'cogs', label: 'تكلفة البضاعة المسلمة', value: 8000, previous: 5000, change_pct: 60 },
  ],
  position: { treasury_balance: 50000, custody_balance: 2000, receivables: 7000, receivables_overdue_90: 1000, payables: 3000 },
  monthly: months,
  expense_breakdown: [{ category: 'كهرباء', amount: 600, percentage: 100 }],
  gross_margin_pct: 33.3,
};

const aging: AgingReport = {
  party: 'customers',
  as_of: '2026-11-10',
  buckets: [
    { key: '0_30', label: 'حتى 30 يوماً' }, { key: '31_60', label: '31 – 60 يوماً' },
    { key: '61_90', label: '61 – 90 يوماً' }, { key: '90_plus', label: 'أكثر من 90 يوماً' },
  ],
  rows: [
    { party_id: 'c1', code: 'C1', name: 'عميل أ', phone: '', oldest_days: 10, '0_30': 1000, '31_60': 0, '61_90': 0, '90_plus': 0, total: 1000 },
    { party_id: 'c2', code: 'C2', name: 'عميل ب', phone: '', oldest_days: 120, '0_30': 0, '31_60': 0, '61_90': 500, '90_plus': 2500, total: 3000 },
  ],
  totals: { '0_30': 1000, '31_60': 0, '61_90': 500, '90_plus': 2500, total: 4000 },
};

const pnlReport: ProfitAndLossReport = {
  period_days: null,
  period: { date_from: '2026-11-01', date_to: '2026-11-10' },
  revenues: {
    items: [
      { code: '4100', name_ar: 'مبيعات منتجات تامة', debit: 0, credit: 50000, net_amount: 50000 },
      { code: '4200', name_ar: 'إيرادات أخرى', debit: 0, credit: 5000, net_amount: 5000 },
    ],
    total_revenue: 55000,
  },
  cost_of_goods_sold: {
    items: [
      { code: '5100', name_ar: 'تكلفة البضاعة المباعة', debit: 30000, credit: 0, net_amount: 30000 },
      { code: '5200', name_ar: 'أجور ومصروفات تصنيع مباشرة', debit: 4000, credit: 0, net_amount: 4000 },
    ],
    total_cogs: 34000,
  },
  gross_profit: 21000,
  gross_profit_margin_pct: 38.18,
  operating_expenses: {
    items: [{ code: '5400', name_ar: 'مصروفات إدارية وعمومية', debit: 6000, credit: 0, net_amount: 6000 }],
    total_expenses: 6000,
  },
  net_income: 15000,
  net_profit_margin_pct: 27.27,
};

describe('Reports hub', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(analyticsApi, 'overview').mockResolvedValue(overview);
    vi.spyOn(analyticsApi, 'aging').mockResolvedValue(aging);
    vi.spyOn(financeApi, 'getProfitAndLossReport').mockResolvedValue(pnlReport);
  });

  it('shows KPIs with the comparison to the previous period and the monthly charts', async () => {
    render(<FinancialReportsView initialTab="summary" />);
    expect(await screen.findByText('صافي المبيعات المسلمة')).toBeInTheDocument();
    // زيادة المبيعات «جيدة» وارتفاع المصروفات «سيئة»
    const salesCard = screen.getByText('صافي المبيعات المسلمة').closest('article')!;
    expect(within(salesCard).getByText(/زيادة/).closest('span')).toHaveClass('rh-kpi__delta--good');
    const expCard = screen.getByText('المصروفات التشغيلية').closest('article')!;
    expect(within(expCard).getByText(/زيادة/).closest('span')).toHaveClass('rh-kpi__delta--bad');
    expect(screen.getByText('لا توجد بيانات للمقارنة')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /شهرياً/ }).length).toBeGreaterThanOrEqual(2);
    expect(analyticsApi.overview).toHaveBeenCalledWith(presetPeriod('this_month'));
  });

  it('changing the period refetches with calendar dates', async () => {
    render(<FinancialReportsView initialTab="summary" />);
    await screen.findByText('صافي المبيعات المسلمة');
    fireEvent.click(screen.getByRole('button', { name: 'الشهر السابق' }));
    expect(analyticsApi.overview).toHaveBeenLastCalledWith(presetPeriod('last_month'));
  });

  it('aging report lists buckets with totals and opens the customer statement on click', async () => {
    render(<FinancialReportsView initialTab="aging_customers" />);
    expect(await screen.findByText('عميل ب')).toBeInTheDocument();
    expect(screen.getByText('هذا التقرير يعرض', { exact: false })).toBeInTheDocument();
    const footer = document.querySelector('.rh-table tfoot')!;
    expect(footer.textContent).toContain('الإجمالي');
    expect(footer.textContent).toContain('٤٬٠٠٠٫٠٠');
    fireEvent.click(screen.getByText('عميل ب'));
    expect(await screen.findByRole('combobox', { name: 'اختر العميل' })).toBeInTheDocument();
  });

  it('renders profit and loss report with period filter and account breakdown', async () => {
    render(<FinancialReportsView initialTab="profit_and_loss" />);
    expect(await screen.findByText('تفصيل قائمة الدخل من دفتر الأستاذ العام')).toBeInTheDocument();
    expect(screen.getByText('إجمالي الإيرادات')).toBeInTheDocument();
    expect(screen.getByText('صافي الدخل (الربح / الخسارة)')).toBeInTheDocument();
    expect(screen.getByText('مبيعات منتجات تامة')).toBeInTheDocument();
    expect(screen.getByText('إيرادات أخرى')).toBeInTheDocument();
    expect(screen.getByText('أجور ومصروفات تصنيع مباشرة')).toBeInTheDocument();
    expect(financeApi.getProfitAndLossReport).toHaveBeenCalledWith(presetPeriod('this_month'));

    fireEvent.click(screen.getByRole('button', { name: 'الشهر السابق' }));
    expect(financeApi.getProfitAndLossReport).toHaveBeenLastCalledWith(presetPeriod('last_month'));
  });

  it('drills down into underlying journal lines when clicking a P&L account row', async () => {
    vi.spyOn(financeApi, 'getProfitAndLossDrilldown').mockResolvedValue({
      account: { id: 'acc-1', code: '4100', name_ar: 'مبيعات منتجات تامة', account_type: 'revenue', nature: 'credit' },
      period: { date_from: '2026-11-01', date_to: '2026-11-10' },
      summary: { total_debit: 0, total_credit: 50000, net_amount: 50000, lines_count: 1 },
      lines: [
        {
          line_id: 'ln-1',
          entry_number: 'JE-100',
          entry_date: '2026-11-05T10:00:00Z',
          source_doc_type: 'customer_delivery',
          source_doc_id: 'del-1',
          description: 'تسليم عميل النور',
          debit: 0,
          credit: 50000,
          net_effect: 50000,
        },
      ],
    });

    render(<FinancialReportsView initialTab="profit_and_loss" />);
    expect(await screen.findByText('مبيعات منتجات تامة')).toBeInTheDocument();

    fireEvent.click(screen.getByText('مبيعات منتجات تامة'));
    expect(await screen.findByText('JE-100')).toBeInTheDocument();
    expect(screen.getByText('تسليم عميل النور')).toBeInTheDocument();
    expect(financeApi.getProfitAndLossDrilldown).toHaveBeenCalledWith('4100', presetPeriod('this_month'));
  });

  it('switches across unified account statements and loads treasury timeline', async () => {
    vi.spyOn(financeApi, 'getAccounts').mockResolvedValue([
      { id: 't1', account_number: 'CA-1', name: 'الخزينة الرئيسية', account_type: 'treasury', parent_account_id: null, is_active: true, balance: '5000.00' },
    ]);
    vi.spyOn(financeApi, 'getCashAccountStatement').mockResolvedValue({
      account: { id: 't1', account_number: 'CA-1', name: 'الخزينة الرئيسية', account_type: 'treasury', is_active: true },
      statement: {
        opening_balance: 1000,
        total_debit: 4000,
        total_credit: 0,
        closing_balance: 5000,
        transactions: [
          { date: '2026-11-05T10:00:00Z', type: 'سند قبض', reference: 'CSH-10', description: 'تحصيل مبيعات', debit: 4000, credit: 0, running_balance: 5000 },
        ],
      },
    });

    render(<FinancialReportsView initialTab="account_statements" />);
    expect(await screen.findByRole('tab', { name: 'كشف حركة الخزينة' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'كشف حساب مورد' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'كشف حساب عهدة' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'دفتر أستاذ عام' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'كشف حساب موظف' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'كشف حركة الخزينة' }));
    expect(await screen.findByText('CSH-10')).toBeInTheDocument();
    expect(screen.getByText('تحصيل مبيعات')).toBeInTheDocument();
  });

  it('renders balance sheet report with assets, liabilities, and equity breakdown', async () => {
    const bsReport: BalanceSheetReport = {
      assets: {
        current_assets: [
          { code: '1010', name_ar: 'الخزينة الرئيسية', amount: 40000 },
          { code: '1030', name_ar: 'حساب بنك المصنع', amount: 60000 },
        ],
        total_assets: 100000,
      },
      liabilities: {
        current_liabilities: [
          { code: '2100', name_ar: 'مستحقات الموردين', amount: 20000 },
        ],
        total_liabilities: 20000,
      },
      equity: {
        equity_items: [
          { code: '3000', name_ar: 'رأس المال المدفوع', amount: 80000 },
        ],
        total_equity: 80000,
      },
      total_liabilities_and_equity: 100000,
      difference: 0,
      is_balanced: true,
      opening_balance: {
        is_set: true,
        accounting_start_date: '2026-01-01',
        journal_entry_number: 'JE-OB-001',
      },
    };

    vi.spyOn(financeApi, 'getBalanceSheet').mockResolvedValue(bsReport);

    render(<FinancialReportsView initialTab="balance_sheet" />);
    expect(await screen.findByText('الأصول المتداولة (Assets)')).toBeInTheDocument();
    expect(screen.getByText('حساب بنك المصنع')).toBeInTheDocument();
    expect(screen.getByText('الخزينة الرئيسية')).toBeInTheDocument();
    expect(screen.getByText('مستحقات الموردين')).toBeInTheDocument();
    expect(screen.getByText('رأس المال المدفوع')).toBeInTheDocument();
    expect(screen.getByText(/متزنة \(الفرق 0.00 ج.م\)/)).toBeInTheDocument();
    expect(screen.getByText(/القيد الافتتاحي معتمد ومثبت في النظام/)).toBeInTheDocument();
  });

  it('shows opening balances setup banner and allows submitting balanced entry', async () => {
    const uninitBsReport: BalanceSheetReport = {
      assets: { current_assets: [], total_assets: 0 },
      liabilities: { current_liabilities: [], total_liabilities: 0 },
      equity: { equity_items: [], total_equity: 0 },
      total_liabilities_and_equity: 0,
      difference: 0,
      is_balanced: true,
      opening_balance: { is_set: false },
    };

    vi.spyOn(financeApi, 'getBalanceSheet').mockResolvedValue(uninitBsReport);
    const createSpy = vi.spyOn(financeApi, 'createOpeningBalances').mockResolvedValue({
      is_set: true,
      accounting_start_date: '2026-01-01',
      total_assets: 50000,
      total_liabilities_and_equity: 50000,
      is_balanced: true,
      details: {},
      message: 'تم ترحيل القيد بنجاح',
    });

    render(<FinancialReportsView initialTab="balance_sheet" />);
    expect(await screen.findByText(/لم يتم تثبيت القيد الافتتاحي للنظام بعد/)).toBeInTheDocument();

    const openBtn = screen.getByRole('button', { name: /تسجيل القيد الافتتاحي/ });
    fireEvent.click(openBtn);

    expect(screen.getByRole('dialog', { name: /تسجيل واعتماد القيد الافتتاحي/ })).toBeInTheDocument();

    // Inputs: treasury 50000, capital 50000 -> balanced
    const inputs = screen.getAllByRole('spinbutton');
    // inputs[0]: treasury, inputs[1]: bank, inputs[2]: capital
    fireEvent.change(inputs[0], { target: { value: '50000' } }); // treasury
    fireEvent.change(inputs[2], { target: { value: '50000' } }); // capital

    const reviewBtn = screen.getByRole('button', { name: /مراجعة وترحيل القيد الافتتاحي/ });
    expect(reviewBtn).not.toBeDisabled();
    fireEvent.click(reviewBtn);

    const confirmBtn = screen.getByRole('button', { name: /تأكيد الترحيل النهائي وإقفال الأرصدة/ });
    fireEvent.click(confirmBtn);

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accounting_start_date: '2026-01-01',
        treasury_balance: '50000',
        paid_in_capital: '50000',
      })
    );
  });
});

describe('DataTable', () => {
  const rows = [
    { id: '1', name: 'قماش', qty: 5 },
    { id: '2', name: 'زرار', qty: 20 },
    { id: '3', name: 'خيط', qty: 1 },
  ];
  const columns = [
    { key: 'name', label: 'الصنف' },
    { key: 'qty', label: 'الكمية', kind: 'number' as const, sum: true },
  ];

  it('sorts by column, searches, and totals the filtered rows', () => {
    render(<DataTable rows={rows} columns={columns} rowKey={(r) => r.id} searchPlaceholder="بحث" />);
    const firstCell = () => document.querySelector('.rh-table tbody tr td')!.textContent;
    fireEvent.click(screen.getByRole('button', { name: /الكمية/ }));
    expect(firstCell()).toBe('زرار');
    fireEvent.click(screen.getByRole('button', { name: /الكمية/ }));
    expect(firstCell()).toBe('خيط');
    expect(document.querySelector('.rh-table tfoot')!.textContent).toContain('٢٦');
    fireEvent.change(screen.getByRole('searchbox', { name: 'بحث' }), { target: { value: 'قماش' } });
    expect(document.querySelectorAll('.rh-table tbody tr')).toHaveLength(1);
    expect(document.querySelector('.rh-table tfoot')!.textContent).toContain('٥');
  });
});

describe('Cairo calendar period presets', () => {
  it('computes month and day boundaries using Africa/Cairo around UTC midnight', () => {
    // 2026-11-30T22:30:00Z is 2026-12-01 00:30 in Africa/Cairo (UTC+2)
    const utcNearMidnight = new Date('2026-11-30T22:30:00Z');
    expect(cairoToday(utcNearMidnight)).toBe('2026-12-01');
    expect(presetPeriod('this_month', utcNearMidnight)).toEqual({ from: '2026-12-01', to: '2026-12-01' });
    expect(presetPeriod('last_month', utcNearMidnight)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(presetPeriod('last_30', utcNearMidnight)).toEqual({ from: '2026-11-02', to: '2026-12-01' });
  });
});
