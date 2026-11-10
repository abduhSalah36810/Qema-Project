  import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FinancialReportsView } from '../FinancialReportsView';
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

describe('Reports hub', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(analyticsApi, 'overview').mockResolvedValue(overview);
    vi.spyOn(analyticsApi, 'aging').mockResolvedValue(aging);
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
