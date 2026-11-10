import { ReactNode, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import { fetchCustomers, Customer } from '@/features/customers/customersApi';
import {
  financeApi,
  REPORT_OPTIONS,
  errorMessage,
  formatMoney,
  toNumber,
  cashSourceLabel,
  AccountsReceivableReport,
  AccountsPayableReport,
  CashFlowReport,
  CogsReport,
  CustodyReconciliationReport,
  CustomerStatementReport,
  ExpenseAnalysisReport,
  InventoryValuationReport,
  Supplier,
  SupplierStatementReport,
  SUPPLIER_INVOICE_STATUS_LABELS,
  WipValuationReport,
} from './financeApi';
import {
  analyticsApi,
  formatPeriod,
  monthLabel,
  periodQuery,
  presetPeriod,
  type AgingReport,
  type AgingRow,
  type LossesReport,
  type OverviewReport,
  type PayrollCostReport,
  type Period,
  type PeriodPreset,
  type ProfitabilityReport,
  type ProfitRow,
  type SalesGroupRow,
  type SalesReport,
  type StockHealthReport,
  type StockHealthRow,
} from './reports/analyticsApi';
import {
  AgingStack,
  DataTable,
  HBarList,
  KpiCard,
  KpiGrid,
  LoadState,
  MonthlyBars,
  Panel,
  PeriodBar,
  SERIES,
  fmtNum,
  fmtPct,
  type Column,
} from './reports/reportUi';

/* ═══ تعريف التقارير ومجموعاتها ═══════════════════════════════════════════ */

type ReportId =
  | 'overview'
  | 'cash_flow' | 'expense_analysis' | 'custody_recon' | 'payroll_cost'
  | 'aging_customers' | 'aging_suppliers' | 'accounts_receivable' | 'accounts_payable' | 'customer_statement' | 'supplier_statement'
  | 'sales_analysis' | 'model_profitability' | 'cogs'
  | 'inventory_valuation' | 'wip_valuation' | 'stock_health' | 'losses';

interface ReportDef { id: ReportId; label: string; usesPeriod: boolean; isNew?: boolean }
interface GroupDef { id: string; label: string; reports: ReportDef[] }

const GROUPS: GroupDef[] = [
  { id: 'overview', label: 'نظرة عامة', reports: [{ id: 'overview', label: 'لوحة المؤشرات', usesPeriod: true, isNew: true }] },
  {
    id: 'treasury', label: 'الخزينة والمصروفات', reports: [
      { id: 'cash_flow', label: 'حركة الخزينة', usesPeriod: true },
      { id: 'expense_analysis', label: 'تحليل المصروفات', usesPeriod: true },
      { id: 'custody_recon', label: 'مطابقة العهد', usesPeriod: false },
      { id: 'payroll_cost', label: 'تكلفة الرواتب', usesPeriod: false, isNew: true },
    ],
  },
  {
    id: 'parties', label: 'العملاء والموردون', reports: [
      { id: 'aging_customers', label: 'أعمار ديون العملاء', usesPeriod: false, isNew: true },
      { id: 'aging_suppliers', label: 'أعمار مستحقات الموردين', usesPeriod: false, isNew: true },
      { id: 'accounts_receivable', label: 'مديونيات العملاء', usesPeriod: false },
      { id: 'accounts_payable', label: 'مستحقات الموردين', usesPeriod: false },
      { id: 'customer_statement', label: 'كشف حساب عميل', usesPeriod: false },
      { id: 'supplier_statement', label: 'كشف حساب مورد', usesPeriod: false },
    ],
  },
  {
    id: 'sales', label: 'المبيعات والربحية', reports: [
      { id: 'sales_analysis', label: 'تحليل المبيعات', usesPeriod: true, isNew: true },
      { id: 'model_profitability', label: 'ربحية الموديلات', usesPeriod: true, isNew: true },
      { id: 'cogs', label: 'تكلفة البضاعة المسلمة', usesPeriod: true },
    ],
  },
  {
    id: 'stock', label: 'المخزون والتكلفة', reports: [
      { id: 'inventory_valuation', label: 'تقييم المخزون', usesPeriod: false },
      { id: 'wip_valuation', label: 'تحت التشغيل', usesPeriod: false },
      { id: 'stock_health', label: 'الراكد وحد الطلب', usesPeriod: false, isNew: true },
      { id: 'losses', label: 'الهالك والعجز', usesPeriod: true, isNew: true },
    ],
  },
];

const ALL_REPORTS = GROUPS.flatMap((g) => g.reports.map((r) => ({ ...r, group: g.id })));

function resolveInitialReport(tab: string): ReportId {
  const aliases: Record<string, ReportId> = {
    inventory: 'inventory_valuation', ar: 'accounts_receivable', receivables: 'accounts_receivable',
    ap: 'accounts_payable', payables: 'accounts_payable', summary: 'overview',
  };
  if (aliases[tab]) return aliases[tab];
  return (ALL_REPORTS.find((r) => r.id === tab)?.id ?? 'overview') as ReportId;
}

const CUSTOMER_ORDER_STATUS: Record<string, string> = { open: 'مفتوح', partially_delivered: 'تسليم جزئي', delivered: 'مُسلم', cancelled: 'ملغى' };

/* ═══ أدوات تحميل ═══════════════════════════════════════════════════════════ */

function useLoad<T>(loader: () => Promise<T>, deps: unknown[], fallback: string, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    loader()
      .then((res) => { if (alive) setData(res); })
      .catch((err: unknown) => { if (alive) { setData(null); setError(errorMessage(err, fallback)); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [...deps, nonce, enabled]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

const balanceTone = (v: unknown) => (toNumber(v) > 0 ? 'bad' : 'good');

/* ═══ الصفحة ═══════════════════════════════════════════════════════════════ */

export interface FinancialReportsViewProps {
  initialTab?: string;
}

export function FinancialReportsView({ initialTab = 'overview' }: FinancialReportsViewProps) {
  const [report, setReport] = useState<ReportId>(resolveInitialReport(initialTab));
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [period, setPeriod] = useState<Period>(presetPeriod('this_month'));
  const [statementCustomer, setStatementCustomer] = useState('');
  const [statementSupplier, setStatementSupplier] = useState('');

  const def = ALL_REPORTS.find((r) => r.id === report)!;
  const group = GROUPS.find((g) => g.id === def.group)!;

  const openCustomer = (id: string) => { setStatementCustomer(id); setReport('customer_statement'); };
  const openSupplier = (id: string) => { setStatementSupplier(id); setReport('supplier_statement'); };

  let body: ReactNode = null;
  switch (report) {
    case 'overview': body = <OverviewSection period={period} onOpen={setReport} />; break;
    case 'cash_flow': body = <CashFlowSection period={period} />; break;
    case 'expense_analysis': body = <ExpenseSection period={period} />; break;
    case 'custody_recon': body = <CustodySection />; break;
    case 'payroll_cost': body = <PayrollSection />; break;
    case 'aging_customers': body = <AgingSection party="customers" onOpen={openCustomer} />; break;
    case 'aging_suppliers': body = <AgingSection party="suppliers" onOpen={openSupplier} />; break;
    case 'accounts_receivable': body = <ReceivablesSection onOpen={openCustomer} />; break;
    case 'accounts_payable': body = <PayablesSection onOpen={openSupplier} />; break;
    case 'customer_statement': body = <CustomerStatementSection customerId={statementCustomer} onChange={setStatementCustomer} />; break;
    case 'supplier_statement': body = <SupplierStatementSection supplierId={statementSupplier} onChange={setStatementSupplier} />; break;
    case 'sales_analysis': body = <SalesSection period={period} onOpenCustomer={openCustomer} />; break;
    case 'model_profitability': body = <ProfitabilitySection period={period} />; break;
    case 'cogs': body = <CogsSection period={period} />; break;
    case 'inventory_valuation': body = <InventorySection />; break;
    case 'wip_valuation': body = <WipSection />; break;
    case 'stock_health': body = <StockHealthSection />; break;
    case 'losses': body = <LossesSection period={period} />; break;
  }

  return (
    <section className="warehouse-page rh" dir="rtl" aria-labelledby="fin-reports-title">
      <header className="rh-head">
        <div>
          <span className="rh-eyebrow">التقارير المالية والتشغيلية</span>
          <h2 id="fin-reports-title">التقارير والتحليلات</h2>
          <p>مؤشرات الأداء، الخزينة، العملاء والموردون، المبيعات والربحية، والمخزون — من نفس الدفاتر المعتمدة في النظام.</p>
        </div>
        <div className="rh-head__actions no-print">
          <button type="button" className="btn btn--secondary" onClick={() => window.print()}>طباعة / حفظ PDF</button>
        </div>
      </header>

      <nav className="rh-groups no-print" aria-label="أقسام التقارير">
        {GROUPS.map((g) => (
          <button key={g.id} type="button" aria-pressed={g.id === group.id} onClick={() => setReport(g.reports[0].id)}>{g.label}</button>
        ))}
      </nav>

      {group.reports.length > 1 && (
        <div className="rh-subnav no-print" role="tablist" aria-label={group.label}>
          {group.reports.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={r.id === report} aria-pressed={r.id === report} onClick={() => setReport(r.id)}>
              {r.label}{r.isNew && <span className="rh-new">جديد</span>}
            </button>
          ))}
        </div>
      )}

      <div className="rh-toolbar">
        {def.usesPeriod ? (
          <>
            <PeriodBar preset={preset} period={period} onChange={(p, next) => { setPreset(p); setPeriod(next); }} />
            <span className="rh-period-note">الفترة: <strong>{formatPeriod(period)}</strong></span>
          </>
        ) : (
          <span className="rh-period-note">هذا التقرير يعرض <strong>الأرصدة حتى اليوم</strong> ولا يتأثر باختيار الفترة.</span>
        )}
      </div>

      <h2 className="rh-print-title">{def.label}{def.usesPeriod ? ` — ${formatPeriod(period)}` : ''}</h2>
      {body}
    </section>
  );
}

/* ═══ نظرة عامة ═════════════════════════════════════════════════════════════ */

const KPI_DIRECTION: Record<string, 'up' | 'down' | 'neutral'> = {
  sales: 'up', cogs: 'neutral', gross_profit: 'up', operating_expenses: 'down', payroll: 'neutral',
  operating_result: 'up', collections: 'up', supplier_payments: 'neutral', net_cash: 'up',
};

function OverviewSection({ period, onOpen }: { period: Period; onOpen: (r: ReportId) => void }) {
  const { data, loading, error, reload } = useLoad<OverviewReport>(() => analyticsApi.overview(period), [period.from, period.to], 'تعذر تحميل لوحة المؤشرات.');
  if (!data || !Array.isArray(data.kpis) || !data.position) return <LoadState loading={loading} error={error} onRetry={reload} empty={Boolean(data)} />;
  const k = (key: string) => data.kpis.find((x) => x.key === key);
  const kpi = (key: string, extra?: Partial<Parameters<typeof KpiCard>[0]>) => {
    const item = k(key);
    if (!item) return null;
    return <KpiCard key={key} label={item.label} value={formatMoney(item.value)} change={item.change_pct} goodWhen={KPI_DIRECTION[key]} {...extra} />;
  };
  return (
    <>
      <p className="rh-period-note">المقارنة مع الفترة السابقة بنفس الطول: {formatPeriod(data.previous_period)}</p>
      <KpiGrid>
        {kpi('sales', { emphasis: true })}
        {kpi('gross_profit', { emphasis: true, hint: data.gross_margin_pct !== null ? `هامش مجمل الربح ${fmtPct(data.gross_margin_pct)}` : undefined })}
        {kpi('operating_result', { hint: 'مبيعات − تكلفة − مصروفات − رواتب (مؤشر تقريبي وليس قائمة دخل رسمية)' })}
        {kpi('net_cash')}
      </KpiGrid>
      <KpiGrid>
        {kpi('collections')}
        {kpi('supplier_payments')}
        {kpi('operating_expenses')}
        {kpi('payroll')}
        {kpi('cogs')}
      </KpiGrid>

      <Panel title="الموقف الحالي" subtitle="أرصدة اليوم بغض النظر عن الفترة">
        <KpiGrid>
          <KpiCard label="رصيد الخزنة الرئيسية" value={formatMoney(data.position.treasury_balance)} />
          <KpiCard label="أرصدة العهد" value={formatMoney(data.position.custody_balance)} />
          <KpiCard label="مديونيات العملاء" value={formatMoney(data.position.receivables)}
            hint={data.position.receivables_overdue_90 > 0 ? `منها ${formatMoney(data.position.receivables_overdue_90)} أقدم من 90 يوماً` : 'لا ديون أقدم من 90 يوماً'} />
          <KpiCard label="مستحقات الموردين" value={formatMoney(data.position.payables)} />
        </KpiGrid>
        <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="md-link" onClick={() => onOpen('aging_customers')}>أعمار ديون العملاء ←</button>
          <button type="button" className="md-link" onClick={() => onOpen('aging_suppliers')}>أعمار مستحقات الموردين ←</button>
        </div>
      </Panel>

      <div className="rh-grid2">
        <Panel title="المقبوضات والمدفوعات شهرياً" subtitle="آخر 12 شهراً، بدون التحويلات الداخلية بين الخزنة والعهد">
          <MonthlyBars data={data.monthly ?? []} ariaLabel="المقبوضات والمدفوعات شهرياً"
            series={[{ key: 'inflows', label: 'المقبوضات', color: SERIES.blue }, { key: 'outflows', label: 'المدفوعات', color: SERIES.orange }]} />
        </Panel>
        <Panel title="توزيع المصروفات" subtitle={`خلال ${formatPeriod(period)}`}>
          <HBarList rows={(data.expense_breakdown ?? []).map((e) => ({ label: e.category, value: e.amount, pct: e.percentage }))} />
        </Panel>
      </div>
      <Panel title="المبيعات وتكلفتها شهرياً" subtitle="صافي المبيعات المسلمة مقابل تكلفة البضاعة المسلمة">
        <MonthlyBars data={data.monthly ?? []} ariaLabel="المبيعات وتكلفتها شهرياً"
          series={[{ key: 'sales', label: 'صافي المبيعات', color: SERIES.blue }, { key: 'cogs', label: 'تكلفة البضاعة المسلمة', color: SERIES.orange }]} />
      </Panel>
    </>
  );
}

/* ═══ الخزينة والمصروفات ═══════════════════════════════════════════════════ */

function CashFlowSection({ period }: { period: Period }) {
  const { data, loading, error, reload } = useLoad<CashFlowReport>(
    () => apiClient.request<CashFlowReport>(`/api/v1/reports/cash-flow?${periodQuery(period)}`, REPORT_OPTIONS), [period.from, period.to], 'تعذر تحميل حركة الخزينة.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Item = NonNullable<CashFlowReport['items']>[number];
  const columns: Column<Item>[] = [
    { key: 'number', label: 'رقم المستند', kind: 'code' },
    { key: 'type', label: 'النوع', render: (r) => <span className={`rh-pill rh-pill--${r.type === 'income' ? 'good' : r.type === 'expense' ? 'bad' : 'muted'}`}>{r.type === 'income' ? 'قبض' : r.type === 'expense' ? 'صرف' : 'تحويل داخلي'}</span>, value: (r) => r.type },
    { key: 'category', label: 'التصنيف', value: (r) => (r.category === 'other' ? 'تحويل داخلي' : r.category) },
    { key: 'amount', label: 'المبلغ', kind: 'money', render: (r) => <strong style={{ color: r.type === 'income' ? '#166534' : r.type === 'expense' ? '#991b1b' : '#475569' }}>{r.type === 'income' ? '+ ' : r.type === 'expense' ? '− ' : '⇄ '}{formatMoney(r.amount)}</strong> },
    { key: 'description', label: 'البيان', wrap: true },
    { key: 'occurred_at', label: 'التاريخ', kind: 'date' },
  ];
  const s = data.summary;
  return (
    <>
      <KpiGrid>
        <KpiCard label="إجمالي المقبوضات" value={formatMoney(s?.total_inflows)} emphasis />
        <KpiCard label="إجمالي المدفوعات" value={formatMoney(s?.total_outflows)} />
        <KpiCard label="صافي الحركة" value={formatMoney(s?.net_cash_flow)} />
        <KpiCard label="تحصيلات العملاء" value={formatMoney(s?.customer_collections)} />
        <KpiCard label="مدفوعات الموردين" value={formatMoney(s?.supplier_payments)} />
        <KpiCard label="مصروفات تشغيلية" value={formatMoney(s?.operating_expenses)} />
      </KpiGrid>
      <Panel title="المستندات النقدية المعتمدة" subtitle="التحويلات الداخلية (⇄) لا تدخل في المقبوضات أو المدفوعات.">
        <DataTable rows={data.items ?? []} columns={columns} rowKey={(r) => r.id} exportName="حركة-الخزينة"
          searchPlaceholder="ابحث برقم المستند أو البيان" emptyText="لا توجد حركات معتمدة في الفترة." />
      </Panel>
    </>
  );
}

function ExpenseSection({ period }: { period: Period }) {
  const { data, loading, error, reload } = useLoad<ExpenseAnalysisReport>(
    () => apiClient.request<ExpenseAnalysisReport>(`/api/v1/reports/expense-analysis?${periodQuery(period)}`, REPORT_OPTIONS), [period.from, period.to], 'تعذر تحميل تحليل المصروفات.');
  const overview = useLoad<OverviewReport>(() => analyticsApi.overview(period), [period.from, period.to], 'تعذر تحميل التصنيفات.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const cats = (data.categories ?? []).map((c) => ({ label: c.category === 'other' ? 'مستندات يدوية' : cashSourceLabel(c.category), value: toNumber(c.amount), pct: toNumber(c.percentage) }));
  return (
    <>
      <KpiGrid>
        <KpiCard label="إجمالي المصروفات المعتمدة" value={formatMoney(data.total_expenses)} emphasis />
        <KpiCard label="عدد المستندات" value={fmtNum(data.items_count)} />
      </KpiGrid>
      <div className="rh-grid2">
        <Panel title="حسب التصنيف" subtitle="التصنيف المسجل في بيان سند الصرف">
          {overview.data ? <HBarList rows={overview.data.expense_breakdown.map((e) => ({ label: e.category, value: e.amount, pct: e.percentage }))} />
            : <LoadState loading={overview.loading} error={overview.error} />}
        </Panel>
        <Panel title="حسب المصدر">
          <HBarList rows={cats} />
        </Panel>
      </div>
    </>
  );
}

function CustodySection() {
  const { data, loading, error, reload } = useLoad<CustodyReconciliationReport>(() => financeApi.getCustodyReconciliationReport(), [], 'تعذر تحميل مطابقة العهد.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Acc = NonNullable<CustodyReconciliationReport['accounts']>[number];
  const columns: Column<Acc>[] = [
    { key: 'name', label: 'العهدة' },
    { key: 'account_number', label: 'رقم الحساب', kind: 'code' },
    { key: 'status', label: 'الحالة' },
    { key: 'original_amount', label: 'التمويل', kind: 'money', sum: true },
    { key: 'approved_expenses', label: 'المصروفات', kind: 'money', sum: true },
    { key: 'returned_to_treasury', label: 'المردود للخزنة', kind: 'money', sum: true },
    { key: 'current_balance', label: 'الرصيد الحالي', kind: 'money', sum: true },
    { key: 'is_balanced', label: 'المطابقة', value: (r) => (r.is_balanced ? 'متطابقة' : 'يوجد فارق'), render: (r) => <span className={`rh-pill rh-pill--${r.is_balanced ? 'good' : 'bad'}`}>{r.is_balanced ? 'متطابقة' : 'يوجد فارق'}</span> },
  ];
  const t = data.totals;
  return (
    <>
      <KpiGrid>
        <KpiCard label="إجمالي تمويل العهد" value={formatMoney(t?.original_amount)} />
        <KpiCard label="المصروفات المعتمدة" value={formatMoney(t?.approved_expenses)} />
        <KpiCard label="المردود للخزنة" value={formatMoney(t?.returned_cash)} />
        <KpiCard label="المتبقي غير المسوى" value={formatMoney(t?.remaining_unsettled)} emphasis />
      </KpiGrid>
      <Panel title="العهد وأرصدتها">
        <DataTable rows={data.accounts ?? []} columns={columns} rowKey={(r) => r.account_id} exportName="مطابقة-العهد" searchPlaceholder="ابحث باسم العهدة" emptyText="لا توجد عهد." />
      </Panel>
    </>
  );
}

function PayrollSection() {
  const [months, setMonths] = useState(12);
  const { data, loading, error, reload } = useLoad<PayrollCostReport>(() => analyticsApi.payroll(months), [months], 'تعذر تحميل تكلفة الرواتب.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const withPay = data.monthly.filter((m) => m.total > 0);
  const avg = withPay.length ? data.total / withPay.length : 0;
  const last = [...data.monthly].reverse().find((m) => m.total > 0);
  type M = PayrollCostReport['monthly'][number];
  const columns: Column<M>[] = [
    { key: 'month', label: 'الشهر', value: (r) => r.month, render: (r) => monthLabel(r.month, true) },
    { key: 'headcount', label: 'عدد الكشوف', kind: 'number', sum: true },
    { key: 'total', label: 'صافي الرواتب', kind: 'money', sum: true },
    { key: 'sales', label: 'صافي المبيعات', kind: 'money', sum: true },
    { key: 'ratio_to_sales_pct', label: 'نسبة الرواتب للمبيعات', kind: 'pct' },
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard label={`إجمالي الرواتب (آخر ${fmtNum(months)} شهراً)`} value={formatMoney(data.total)} emphasis />
        <KpiCard label="متوسط الشهر" value={formatMoney(avg)} />
        <KpiCard label="نسبة آخر شهر للمبيعات" value={fmtPct(last?.ratio_to_sales_pct ?? null)} hint={last ? monthLabel(last.month, true) : 'لا توجد رواتب مصروفة'} />
      </KpiGrid>
      <div className="rh-grid2">
        <Panel title="الرواتب والمبيعات شهرياً" subtitle="الرواتب المعتمدة صرفها، حسب شهر نهاية الفترة"
          actions={<select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="عدد الأشهر"><option value={6}>آخر 6 أشهر</option><option value={12}>آخر 12 شهراً</option><option value={24}>آخر 24 شهراً</option></select>}>
          <MonthlyBars data={data.monthly} ariaLabel="الرواتب والمبيعات شهرياً"
            series={[{ key: 'sales', label: 'صافي المبيعات', color: SERIES.blue }, { key: 'total', label: 'الرواتب', color: SERIES.orange }]} />
        </Panel>
        <Panel title="حسب القسم">
          <HBarList rows={data.departments.map((d) => ({ label: d.department === 'production' ? 'الإنتاج' : d.department, value: d.total, pct: d.share_pct }))} />
        </Panel>
      </div>
      <Panel title="التفاصيل الشهرية">
        <DataTable rows={[...data.monthly].reverse()} columns={columns} rowKey={(r) => r.month} exportName="تكلفة-الرواتب" />
      </Panel>
    </>
  );
}

/* ═══ العملاء والموردون ═══════════════════════════════════════════════════ */

function AgingSection({ party, onOpen }: { party: 'customers' | 'suppliers'; onOpen: (id: string) => void }) {
  const { data, loading, error, reload } = useLoad<AgingReport>(() => analyticsApi.aging(party), [party], 'تعذر تحميل أعمار الديون.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const who = party === 'customers' ? 'العميل' : 'المورد';
  const columns: Column<AgingRow>[] = [
    { key: 'name', label: who, render: (r) => <><strong>{r.name}</strong><br /><small style={{ color: '#94a3b8' }}>{r.code}</small></>, value: (r) => r.name },
    ...data.buckets.map((b) => ({ key: b.key, label: b.label, kind: 'money' as const, sum: true })),
    { key: 'total', label: 'الإجمالي', kind: 'money', sum: true, render: (r) => <strong>{formatMoney(r.total)}</strong> },
    { key: 'oldest_days', label: 'أقدم رصيد', kind: 'number', render: (r) => <span className={`rh-pill rh-pill--${r.oldest_days > 90 ? 'bad' : r.oldest_days > 60 ? 'warn' : 'muted'}`}>{fmtNum(r.oldest_days)} يوم</span> },
  ];
  const over90 = toNumber(data.totals['90_plus']);
  return (
    <>
      <KpiGrid>
        <KpiCard label={party === 'customers' ? 'إجمالي مديونيات العملاء' : 'إجمالي مستحقات الموردين'} value={formatMoney(data.totals.total)} emphasis />
        <KpiCard label="حتى 30 يوماً" value={formatMoney(data.totals['0_30'])} />
        <KpiCard label="أقدم من 60 يوماً" value={formatMoney(toNumber(data.totals['61_90']) + over90)} />
        <KpiCard label="أقدم من 90 يوماً" value={formatMoney(over90)} hint={data.totals.total ? `${fmtPct((over90 / data.totals.total) * 100)} من الإجمالي` : undefined} />
      </KpiGrid>
      <Panel title="التوزيع حسب العمر" subtitle={party === 'customers'
        ? 'كل تسليم دين بتاريخه، والتحصيلات والمرتجعات تُخصم من الأقدم أولاً.'
        : 'المستحق عن الكميات المستلمة لكل فاتورة بعمر تاريخ الفاتورة.'}>
        <AgingStack buckets={data.buckets} totals={data.totals} />
      </Panel>
      <Panel title={`حسب ${who}`} subtitle={`اضغط على ${who} لفتح كشف حسابه.`}>
        <DataTable rows={data.rows} columns={columns} rowKey={(r) => r.party_id} onRowClick={(r) => onOpen(r.party_id)} rowTitle="فتح كشف الحساب"
          exportName={party === 'customers' ? 'أعمار-ديون-العملاء' : 'أعمار-مستحقات-الموردين'} searchPlaceholder={`ابحث باسم ${who} أو الكود`}
          emptyText={party === 'customers' ? 'لا توجد مديونيات على العملاء.' : 'لا توجد مستحقات للموردين.'} />
      </Panel>
    </>
  );
}

function ReceivablesSection({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, loading, error, reload } = useLoad<AccountsReceivableReport>(() => financeApi.getAccountsReceivableReport(), [], 'تعذر تحميل مديونيات العملاء.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Row = NonNullable<AccountsReceivableReport['customers']>[number];
  const columns: Column<Row>[] = [
    { key: 'code', label: 'الكود', kind: 'code' },
    { key: 'name', label: 'العميل' },
    { key: 'orders_count', label: 'الطلبات', kind: 'number', sum: true },
    { key: 'total_ordered', label: 'قيمة الطلبات', kind: 'money', sum: true },
    { key: 'total_invoiced', label: 'قيمة التسليمات', kind: 'money', sum: true },
    { key: 'total_paid', label: 'تحصيلات معتمدة', kind: 'money', sum: true },
    { key: 'pending_payments', label: 'تحصيلات معلقة', kind: 'money', sum: true },
    { key: 'balance_due', label: 'الرصيد المستحق', kind: 'money', sum: true, render: (r) => <span className={`rh-pill rh-pill--${balanceTone(r.balance_due)}`}>{formatMoney(r.balance_due)}{toNumber(r.balance_due) < 0 ? ' (دائن)' : ''}</span> },
  ];
  const s = data.summary;
  return (
    <>
      <KpiGrid>
        <KpiCard label="عدد العملاء" value={fmtNum(s?.total_customers)} />
        <KpiCard label="قيمة التسليمات (بعد الخصم والمرتجعات)" value={formatMoney(s?.total_invoiced)} />
        <KpiCard label="التحصيلات المعتمدة" value={formatMoney(s?.total_collected)} />
        <KpiCard label="صافي المديونية" value={formatMoney(s?.total_receivables)} emphasis />
      </KpiGrid>
      <Panel title="العملاء" subtitle="اضغط على العميل لفتح كشف حسابه.">
        <DataTable rows={data.customers ?? []} columns={columns} rowKey={(r) => r.customer_id} onRowClick={(r) => onOpen(r.customer_id)} rowTitle="فتح كشف الحساب"
          exportName="مديونيات-العملاء" searchPlaceholder="ابحث باسم العميل أو الكود" emptyText="لا يوجد عملاء بعد." />
      </Panel>
    </>
  );
}

function PayablesSection({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, loading, error, reload } = useLoad<AccountsPayableReport>(() => financeApi.getAccountsPayableReport(), [], 'تعذر تحميل مستحقات الموردين.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Row = NonNullable<AccountsPayableReport['suppliers']>[number];
  const columns: Column<Row>[] = [
    { key: 'code', label: 'الكود', kind: 'code' },
    { key: 'name', label: 'المورد' },
    { key: 'invoices_count', label: 'الفواتير', kind: 'number', sum: true },
    { key: 'total_invoiced', label: 'قيمة الفواتير', kind: 'money', sum: true },
    { key: 'total_received', label: 'المستلم فعلياً', kind: 'money', sum: true },
    { key: 'total_paid', label: 'مدفوع معتمد', kind: 'money', sum: true },
    { key: 'pending_payments', label: 'دفعات معلقة', kind: 'money', sum: true },
    { key: 'balance_due', label: 'الرصيد المستحق', kind: 'money', sum: true, render: (r) => <span className={`rh-pill rh-pill--${balanceTone(r.balance_due)}`}>{formatMoney(r.balance_due)}</span> },
  ];
  const s = data.summary;
  return (
    <>
      <KpiGrid>
        <KpiCard label="عدد الموردين" value={fmtNum(s?.total_suppliers)} />
        <KpiCard label="قيمة الفواتير" value={formatMoney(s?.total_invoiced)} />
        <KpiCard label="قيمة المستلم فعلياً" value={formatMoney(s?.total_received)} />
        <KpiCard label="المدفوع المعتمد" value={formatMoney(s?.total_paid)} />
        <KpiCard label="صافي المستحق للموردين" value={formatMoney(s?.total_payables)} emphasis />
      </KpiGrid>
      <Panel title="الموردون" subtitle="اضغط على المورد لفتح كشف حسابه.">
        <DataTable rows={data.suppliers ?? []} columns={columns} rowKey={(r) => r.supplier_id} onRowClick={(r) => onOpen(r.supplier_id)} rowTitle="فتح كشف الحساب"
          exportName="مستحقات-الموردين" searchPlaceholder="ابحث باسم المورد أو الكود" emptyText="لا يوجد موردون بعد." />
      </Panel>
    </>
  );
}

function CustomerStatementSection({ customerId, onChange }: { customerId: string; onChange: (id: string) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [listError, setListError] = useState('');
  useEffect(() => {
    fetchCustomers().then(setCustomers).catch((err: unknown) => setListError(errorMessage(err, 'تعذر تحميل قائمة العملاء.')));
  }, []);
  const stmt = useLoad<CustomerStatementReport>(() => financeApi.getCustomerStatement(customerId), [customerId], 'تعذر تحميل كشف حساب العميل.', Boolean(customerId));
  type Row = NonNullable<CustomerStatementReport['orders']>[number];
  const columns: Column<Row>[] = [
    { key: 'order_number', label: 'رقم الطلب', kind: 'code' },
    { key: 'status', label: 'الحالة', value: (r) => CUSTOMER_ORDER_STATUS[r.status] ?? r.status },
    { key: 'total_amount', label: 'الإجمالي بعد الخصم', kind: 'money', sum: true },
    { key: 'delivered_value', label: 'المُسلم', kind: 'money', sum: true },
    { key: 'returned_value', label: 'المرتجع', kind: 'money', sum: true },
    { key: 'paid_amount', label: 'محصل معتمد', kind: 'money', sum: true },
    { key: 'pending_payments', label: 'محصل معلق', kind: 'money', sum: true },
    { key: 'balance_due', label: 'المستحق', kind: 'money', sum: true },
    { key: 'remaining_on_order', label: 'المتبقي على الطلب', kind: 'money', sum: true },
  ];
  const t = stmt.data?.totals;
  return (
    <Panel title="كشف حساب عميل" actions={
      <select value={customerId} onChange={(e) => onChange(e.target.value)} aria-label="اختر العميل">
        <option value="">— اختر العميل —</option>
        {customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
      </select>
    }>
      {listError && <div className="rh-state rh-state--error">{listError}</div>}
      {!customerId ? <div className="rh-state">اختر عميلاً لعرض كشف حسابه، أو اضغط على عميل في تقرير المديونيات أو أعمار الديون.</div>
        : !stmt.data ? <LoadState loading={stmt.loading} error={stmt.error} onRetry={stmt.reload} /> : (
          <>
            <KpiGrid>
              <KpiCard label="قيمة الطلبات" value={formatMoney(t?.total_ordered)} />
              <KpiCard label="قيمة التسليمات" value={formatMoney(t?.total_invoiced)} />
              <KpiCard label="المرتجعات" value={formatMoney(t?.total_returned)} />
              <KpiCard label="تحصيلات معتمدة" value={formatMoney(t?.total_paid)} />
              <KpiCard label={toNumber(t?.balance_due) < 0 ? 'رصيد دائن للعميل' : 'الرصيد المستحق'} value={formatMoney(Math.abs(toNumber(t?.balance_due)))} emphasis />
            </KpiGrid>
            <DataTable rows={stmt.data.orders ?? []} columns={columns} rowKey={(r) => r.order_id} exportName="كشف-حساب-عميل" emptyText="لا توجد طلبات." />
          </>
        )}
    </Panel>
  );
}

function SupplierStatementSection({ supplierId, onChange }: { supplierId: string; onChange: (id: string) => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [listError, setListError] = useState('');
  useEffect(() => {
    financeApi.getSuppliers().then(setSuppliers).catch((err: unknown) => setListError(errorMessage(err, 'تعذر تحميل قائمة الموردين.')));
  }, []);
  const stmt = useLoad<SupplierStatementReport>(() => financeApi.getSupplierStatement(supplierId), [supplierId], 'تعذر تحميل كشف حساب المورد.', Boolean(supplierId));
  type Row = NonNullable<SupplierStatementReport['invoices']>[number];
  const columns: Column<Row>[] = [
    { key: 'internal_number', label: 'الرقم الداخلي', kind: 'code' },
    { key: 'invoice_number', label: 'رقم فاتورة المورد' },
    { key: 'invoice_date', label: 'التاريخ', kind: 'date' },
    { key: 'status', label: 'الحالة', value: (r) => SUPPLIER_INVOICE_STATUS_LABELS[r.status] ?? r.status },
    { key: 'invoice_total', label: 'قيمة الفاتورة', kind: 'money', sum: true },
    { key: 'received_value', label: 'قيمة المستلم', kind: 'money', sum: true },
    { key: 'paid_total', label: 'مدفوع معتمد', kind: 'money', sum: true },
    { key: 'pending_payments', label: 'دفعات معلقة', kind: 'money', sum: true },
    { key: 'balance_due', label: 'المستحق', kind: 'money', sum: true },
  ];
  const t = stmt.data?.totals;
  return (
    <Panel title="كشف حساب مورد" actions={
      <select value={supplierId} onChange={(e) => onChange(e.target.value)} aria-label="اختر المورد">
        <option value="">— اختر المورد —</option>
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
      </select>
    }>
      {listError && <div className="rh-state rh-state--error">{listError}</div>}
      {!supplierId ? <div className="rh-state">اختر مورداً لعرض كشف حسابه، أو اضغط على مورد في تقرير المستحقات أو الأعمار.</div>
        : !stmt.data ? <LoadState loading={stmt.loading} error={stmt.error} onRetry={stmt.reload} /> : (
          <>
            <KpiGrid>
              <KpiCard label="قيمة الفواتير" value={formatMoney(t?.total_invoiced)} />
              <KpiCard label="قيمة المستلم" value={formatMoney(t?.total_received)} />
              <KpiCard label="مدفوع معتمد" value={formatMoney(t?.total_paid)} />
              <KpiCard label="الرصيد المستحق" value={formatMoney(t?.balance_due)} emphasis />
            </KpiGrid>
            <DataTable rows={stmt.data.invoices ?? []} columns={columns} rowKey={(r) => r.invoice_id} exportName="كشف-حساب-مورد" emptyText="لا توجد فواتير." />
          </>
        )}
    </Panel>
  );
}

/* ═══ المبيعات والربحية ════════════════════════════════════════════════════ */

function SalesSection({ period, onOpenCustomer }: { period: Period; onOpenCustomer: (id: string) => void }) {
  const [dim, setDim] = useState<'by_customer' | 'by_model' | 'by_size'>('by_customer');
  const { data, loading, error, reload } = useLoad<SalesReport>(() => analyticsApi.sales(period), [period.from, period.to], 'تعذر تحميل تحليل المبيعات.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const dimLabel = { by_customer: 'العميل', by_model: 'الموديل', by_size: 'الموديل والمقاس' }[dim];
  const rows = data[dim];
  const columns: Column<SalesGroupRow>[] = [
    { key: 'label', label: dimLabel },
    { key: 'quantity', label: 'الكمية (قطعة)', kind: 'number', sum: true },
    { key: 'net_sales', label: 'صافي المبيعات', kind: 'money', sum: true },
    { key: 'avg_price', label: 'متوسط سعر القطعة', kind: 'money' },
    { key: 'orders_count', label: 'عدد الطلبات', kind: 'number' },
    { key: 'share_pct', label: 'النسبة من المبيعات', kind: 'pct' },
  ];
  const s = data.summary;
  return (
    <>
      <KpiGrid>
        <KpiCard label="صافي المبيعات المسلمة" value={formatMoney(s.net_sales)} emphasis />
        <KpiCard label="القطع المسلمة" value={fmtNum(s.quantity)} />
        <KpiCard label="متوسط سعر القطعة" value={formatMoney(s.avg_price)} />
        <KpiCard label="الخصومات على طلبات الفترة" value={formatMoney(s.discounts)} hint={`${fmtPct(s.discount_pct)} من قيمة الطلبات`} />
        <KpiCard label="المرتجعات" value={formatMoney(s.returns_value)} />
      </KpiGrid>
      <Panel title={`الأعلى مبيعاً حسب ${dimLabel}`} actions={
        <div className="rh-segment" role="group" aria-label="التحليل حسب">
          <button type="button" aria-pressed={dim === 'by_customer'} onClick={() => setDim('by_customer')}>العملاء</button>
          <button type="button" aria-pressed={dim === 'by_model'} onClick={() => setDim('by_model')}>الموديلات</button>
          <button type="button" aria-pressed={dim === 'by_size'} onClick={() => setDim('by_size')}>المقاسات</button>
        </div>
      }>
        <HBarList rows={rows.map((r) => ({ key: r.key, label: r.label, value: r.net_sales, pct: r.share_pct }))}
          onSelect={dim === 'by_customer' ? onOpenCustomer : undefined} />
        <DataTable rows={rows} columns={columns} rowKey={(r) => r.key} exportName={`تحليل-المبيعات-${dimLabel}`} searchPlaceholder={`ابحث باسم ${dimLabel}`}
          emptyText="لا توجد تسليمات في هذه الفترة." />
      </Panel>
    </>
  );
}

function ProfitabilitySection({ period }: { period: Period }) {
  const { data, loading, error, reload } = useLoad<ProfitabilityReport>(() => analyticsApi.profitability(period), [period.from, period.to], 'تعذر تحميل ربحية الموديلات.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const columns: Column<ProfitRow>[] = [
    { key: 'name', label: 'الموديل', render: (r) => <><strong>{r.name}</strong><br /><small style={{ color: '#94a3b8' }}>{r.code}</small></>, value: (r) => r.name },
    { key: 'quantity', label: 'الكمية', kind: 'number', sum: true },
    { key: 'unit_price', label: 'متوسط سعر البيع', kind: 'money' },
    { key: 'unit_cost', label: 'تكلفة القطعة', kind: 'money' },
    { key: 'net_sales', label: 'صافي المبيعات', kind: 'money', sum: true },
    { key: 'cogs', label: 'التكلفة', kind: 'money', sum: true },
    { key: 'gross_profit', label: 'مجمل الربح', kind: 'money', sum: true },
    { key: 'margin_pct', label: 'الهامش', kind: 'pct', render: (r) => <span className={`rh-pill rh-pill--${r.margin_pct === null ? 'muted' : r.margin_pct < 0 ? 'bad' : r.margin_pct < 15 ? 'warn' : 'good'}`}>{fmtPct(r.margin_pct)}</span> },
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard label="صافي المبيعات" value={formatMoney(data.totals.net_sales)} />
        <KpiCard label="تكلفة البضاعة المسلمة" value={formatMoney(data.totals.cogs)} />
        <KpiCard label="مجمل الربح" value={formatMoney(data.totals.gross_profit)} emphasis />
        <KpiCard label="هامش مجمل الربح" value={fmtPct(data.totals.margin_pct)} />
      </KpiGrid>
      <div className="rh-note">{data.note}</div>
      <Panel title="الربحية حسب الموديل" subtitle="الهامش: أحمر = خسارة، أصفر = أقل من 15٪، أخضر = 15٪ فأكثر.">
        <DataTable rows={data.rows} columns={columns} rowKey={(r) => r.product_id} exportName="ربحية-الموديلات" searchPlaceholder="ابحث باسم الموديل"
          emptyText="لا توجد مبيعات مسلمة في هذه الفترة." />
      </Panel>
    </>
  );
}

function CogsSection({ period }: { period: Period }) {
  const { data, loading, error, reload } = useLoad<CogsReport>(
    () => apiClient.request<CogsReport>(`/api/v1/reports/cogs?${periodQuery(period)}`, REPORT_OPTIONS), [period.from, period.to], 'تعذر تحميل تكلفة البضاعة المسلمة.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Row = NonNullable<CogsReport['entries']>[number];
  const columns: Column<Row>[] = [
    { key: 'delivery_number', label: 'سند التسليم', kind: 'code' },
    { key: 'delivered_at', label: 'التاريخ', kind: 'date' },
    { key: 'item_name_ar', label: 'المنتج', wrap: true },
    { key: 'quantity', label: 'الكمية', kind: 'number', sum: true },
    { key: 'unit_cost', label: 'تكلفة الوحدة', kind: 'money' },
    { key: 'total_cogs', label: 'الإجمالي', kind: 'money', sum: true },
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard label="إجمالي التكلفة" value={formatMoney(data.total_cogs)} emphasis />
        <KpiCard label="عدد الحركات" value={fmtNum(data.items_count)} hint={toNumber(data.items_count) > 100 ? 'الجدول يعرض أحدث 100 حركة' : undefined} />
      </KpiGrid>
      <Panel title="حركات صرف المنتج التام للعملاء">
        <DataTable rows={(data.entries ?? []).map((e, i) => ({ ...e, _k: `${e.delivery_number}-${i}` }))} columns={columns as Column<Row & { _k: string }>[]}
          rowKey={(r) => r._k} exportName="تكلفة-البضاعة-المسلمة" searchPlaceholder="ابحث بسند التسليم أو المنتج" emptyText="لا توجد حركات تسليم مسجلة بتكلفة." />
      </Panel>
    </>
  );
}

/* ═══ المخزون والتكلفة ═════════════════════════════════════════════════════ */

function InventorySection() {
  const { data, loading, error, reload } = useLoad<InventoryValuationReport>(() => financeApi.getInventoryValuationReport(), [], 'تعذر تحميل تقييم المخزون.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Wh = NonNullable<InventoryValuationReport['warehouses']>[string];
  type Item = NonNullable<Wh['items']>[number];
  const columns: Column<Item>[] = [
    { key: 'item_code', label: 'الكود', kind: 'code' },
    { key: 'item_name_ar', label: 'الصنف', wrap: true },
    { key: 'quantity', label: 'الكمية', kind: 'number' },
    { key: 'unit_name_ar', label: 'الوحدة' },
    { key: 'wac_unit_cost', label: 'متوسط التكلفة', kind: 'money' },
    { key: 'total_valuation', label: 'القيمة', kind: 'money', sum: true },
  ];
  const whs = Object.entries(data.warehouses ?? {});
  return (
    <>
      <KpiGrid>
        <KpiCard label="إجمالي قيمة المخزون" value={formatMoney(data.grand_total_valuation)} emphasis />
        {whs.map(([code, wh]) => <KpiCard key={code} label={wh.warehouse_name_ar} value={formatMoney(wh.total_valuation)} />)}
      </KpiGrid>
      {whs.map(([code, wh]) => (
        <Panel key={code} title={wh.warehouse_name_ar} subtitle="بمتوسط التكلفة المرجح">
          <DataTable rows={wh.items ?? []} columns={columns} rowKey={(r) => r.item_id} exportName={`تقييم-${wh.warehouse_name_ar}`} searchPlaceholder="ابحث باسم الصنف أو الكود" emptyText="لا يوجد رصيد في هذا المخزن." />
        </Panel>
      ))}
    </>
  );
}

function WipSection() {
  const { data, loading, error, reload } = useLoad<WipValuationReport>(() => financeApi.getWipValuationReport(), [], 'تعذر تحميل تقييم تحت التشغيل.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Row = NonNullable<WipValuationReport['orders']>[number];
  const columns: Column<Row>[] = [
    { key: 'order_number', label: 'رقم الأمر', kind: 'code' },
    { key: 'product_name', label: 'المنتج' },
    { key: 'target_quantity', label: 'الكمية', kind: 'number', sum: true },
    { key: 'material_cost', label: 'تكلفة الخامات', kind: 'money', sum: true },
    { key: 'total_actual_cost', label: 'إجمالي التكلفة', kind: 'money', sum: true },
    { key: 'unit_manufacturing_cost', label: 'تكلفة القطعة', kind: 'money' },
    { key: 'wip_balance', label: 'الرصيد المتبقي', kind: 'money', sum: true },
  ];
  const t = data.totals;
  return (
    <>
      <KpiGrid>
        <KpiCard label="أوامر قيد التشغيل" value={fmtNum(t?.active_orders_count)} />
        <KpiCard label="تكلفة الخامات المنصرفة" value={formatMoney(t?.total_materials_cost)} />
        <KpiCard label="رصيد تحت التشغيل" value={formatMoney(t?.total_wip_balance)} emphasis />
      </KpiGrid>
      <Panel title="الأوامر قيد التشغيل">
        <DataTable rows={data.orders ?? []} columns={columns} rowKey={(r) => r.order_id} exportName="تحت-التشغيل" searchPlaceholder="ابحث برقم الأمر أو المنتج" emptyText="لا توجد أوامر قيد التشغيل." />
      </Panel>
    </>
  );
}

function StockHealthSection() {
  const [idle, setIdle] = useState(60);
  const { data, loading, error, reload } = useLoad<StockHealthReport>(() => analyticsApi.stockHealth(idle), [idle], 'تعذر تحميل حالة المخزون.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  const slowCols: Column<StockHealthRow>[] = [
    { key: 'code', label: 'الكود', kind: 'code' },
    { key: 'name', label: 'الصنف', wrap: true },
    { key: 'balance', label: 'الرصيد', kind: 'number', render: (r) => `${fmtNum(r.balance, 3)} ${r.unit}` },
    { key: 'value', label: 'القيمة التقريبية', kind: 'money', sum: true },
    { key: 'last_movement', label: 'آخر حركة', kind: 'date' },
    { key: 'idle_days', label: 'أيام بلا حركة', kind: 'number' },
  ];
  const belowCols: Column<StockHealthRow>[] = [
    { key: 'code', label: 'الكود', kind: 'code' },
    { key: 'name', label: 'الصنف', wrap: true },
    { key: 'balance', label: 'الرصيد', kind: 'number', render: (r) => `${fmtNum(r.balance, 3)} ${r.unit}` },
    { key: 'reorder_level', label: 'حد إعادة الطلب', kind: 'number' },
    { key: 'shortfall', label: 'النقص عن الحد', kind: 'number', render: (r) => <span className="rh-pill rh-pill--bad">{fmtNum(r.shortfall, 3)} {r.unit}</span> },
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard label={`أصناف راكدة (أكثر من ${fmtNum(idle)} يوماً)`} value={fmtNum(data.totals.slow_count)} />
        <KpiCard label="قيمة المخزون الراكد" value={formatMoney(data.totals.slow_value)} emphasis />
        <KpiCard label="أصناف تحت حد الطلب" value={fmtNum(data.totals.below_count)} />
      </KpiGrid>
      <Panel title="أصناف تحت حد إعادة الطلب" subtitle="مخزن الخامات الرئيسي. يُضبط حد الطلب من دليل الأصناف.">
        <DataTable rows={data.below_reorder} columns={belowCols} rowKey={(r) => r.item_id} exportName="تحت-حد-الطلب" searchPlaceholder="ابحث باسم الصنف" emptyText="لا توجد أصناف تحت حد الطلب." />
      </Panel>
      <Panel title="المخزون الراكد" subtitle="أصناف لها رصيد ولم تتحرك منذ المدة المختارة."
        actions={<select value={idle} onChange={(e) => setIdle(Number(e.target.value))} aria-label="مدة الركود"><option value={30}>30 يوماً</option><option value={60}>60 يوماً</option><option value={90}>90 يوماً</option><option value={180}>180 يوماً</option></select>}>
        <DataTable rows={data.slow_moving} columns={slowCols} rowKey={(r) => r.item_id} exportName="المخزون-الراكد" searchPlaceholder="ابحث باسم الصنف" emptyText="لا توجد أصناف راكدة." />
      </Panel>
    </>
  );
}

function LossesSection({ period }: { period: Period }) {
  const { data, loading, error, reload } = useLoad<LossesReport>(() => analyticsApi.losses(period), [period.from, period.to], 'تعذر تحميل الهالك والعجز.');
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  type Row = LossesReport['items'][number] & { _k: string };
  const columns: Column<Row>[] = [
    { key: 'type', label: 'النوع' },
    { key: 'item_code', label: 'الكود', kind: 'code' },
    { key: 'item_name', label: 'الصنف', wrap: true },
    { key: 'quantity', label: 'الكمية', kind: 'number', render: (r) => `${fmtNum(r.quantity, 3)} ${r.unit}` },
    { key: 'value', label: 'القيمة', kind: 'money', sum: true },
  ];
  return (
    <>
      <KpiGrid>
        <KpiCard label="إجمالي الهالك والعجز" value={formatMoney(data.total_loss)} emphasis />
        <KpiCard label="زيادات الجرد" value={formatMoney(data.stocktake_surplus)} hint="تُعرض للمقارنة ولا تُخصم من الإجمالي" />
        <KpiCard label="عيوب الإنتاج المسجلة" value={fmtNum(data.defects_count)} />
      </KpiGrid>
      <div className="rh-grid2">
        <Panel title="حسب النوع">
          <HBarList rows={data.by_type.map((t) => ({ label: t.type, value: t.value, pct: t.share_pct }))} />
        </Panel>
        <Panel title="التفاصيل حسب الصنف">
          <DataTable rows={data.items.map((r, i) => ({ ...r, _k: `${r.type}-${r.item_code}-${i}` }))} columns={columns} rowKey={(r) => r._k}
            exportName="الهالك-والعجز" searchPlaceholder="ابحث باسم الصنف" emptyText="لا يوجد هالك أو عجز في هذه الفترة." pageSize={10} />
        </Panel>
      </div>
    </>
  );
}
