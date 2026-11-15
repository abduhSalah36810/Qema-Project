import { ReactNode, useState } from 'react';
import {
  formatPeriod,
  presetPeriod,
  type Period,
  type PeriodPreset,
} from './analyticsApi';
import {
  PeriodBar,
} from './reportUi';
import {
  CashFlowSection,
  ExpenseSection,
  PayrollSection,
  AgingSection,
  ReceivablesSection,
  PayablesSection,
  SalesSection,
  ProfitabilitySection,
  CogsSection,
  InventorySection,
  WipSection,
  StockHealthSection,
  LossesSection,
  OverviewSection,
} from '../FinancialReportsView';

export type ManagementGroupId = 'treasury' | 'parties' | 'sales' | 'stock';

export type ManagementReportId =
  | 'cash_flow'
  | 'inflows_outflows'
  | 'expense_analysis'
  | 'payroll_cost'
  | 'aging_customers'
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'aging_suppliers'
  | 'sales_analysis'
  | 'model_profitability'
  | 'cogs'
  | 'inventory_valuation'
  | 'wip_valuation'
  | 'stock_health_slow'
  | 'stock_health_reorder'
  | 'losses';

interface ReportMeta {
  id: ManagementReportId;
  label: string;
  usesPeriod: boolean;
}

interface GroupMeta {
  id: ManagementGroupId;
  label: string;
  reports: ReportMeta[];
}

const MANAGEMENT_GROUPS: GroupMeta[] = [
  {
    id: 'treasury',
    label: 'الخزينة والمصروفات',
    reports: [
      { id: 'cash_flow', label: 'حركة الخزينة', usesPeriod: true },
      { id: 'inflows_outflows', label: 'المقبوضات والمدفوعات', usesPeriod: true },
      { id: 'expense_analysis', label: 'المصروفات', usesPeriod: true },
      { id: 'payroll_cost', label: 'تكلفة الرواتب', usesPeriod: false },
    ],
  },
  {
    id: 'parties',
    label: 'العملاء والموردون',
    reports: [
      { id: 'aging_customers', label: 'أعمار ديون العملاء', usesPeriod: false },
      { id: 'accounts_receivable', label: 'مديونيات العملاء', usesPeriod: false },
      { id: 'accounts_payable', label: 'مستحقات الموردين', usesPeriod: false },
      { id: 'aging_suppliers', label: 'أعمار مستحقات الموردين', usesPeriod: false },
    ],
  },
  {
    id: 'sales',
    label: 'المبيعات والربحية',
    reports: [
      { id: 'sales_analysis', label: 'تحليل المبيعات', usesPeriod: true },
      { id: 'model_profitability', label: 'ربحية الموديلات', usesPeriod: true },
      { id: 'cogs', label: 'تكلفة البضائع المسلّمة', usesPeriod: true },
    ],
  },
  {
    id: 'stock',
    label: 'المخزون والتكلفة',
    reports: [
      { id: 'inventory_valuation', label: 'تقييم المخزون', usesPeriod: false },
      { id: 'wip_valuation', label: 'تحت التشغيل', usesPeriod: false },
      { id: 'stock_health_slow', label: 'المخزون الراكد', usesPeriod: false },
      { id: 'stock_health_reorder', label: 'حد الطلب', usesPeriod: false },
      { id: 'losses', label: 'الهالك والعجز', usesPeriod: true },
    ],
  },
];

const ALL_MANAGEMENT_REPORTS = MANAGEMENT_GROUPS.flatMap((g) =>
  g.reports.map((r) => ({ ...r, groupId: g.id }))
);

export function ManagementReportsView({ initialReport = 'cash_flow' }: { initialReport?: ManagementReportId }) {
  const [reportId, setReportId] = useState<ManagementReportId>(initialReport);
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [period, setPeriod] = useState<Period>(presetPeriod('this_month'));

  const currentReport = ALL_MANAGEMENT_REPORTS.find((r) => r.id === reportId) || ALL_MANAGEMENT_REPORTS[0];
  const currentGroup = MANAGEMENT_GROUPS.find((g) => g.id === currentReport.groupId) || MANAGEMENT_GROUPS[0];

  const handleGroupSelect = (group: GroupMeta) => {
    setReportId(group.reports[0].id);
  };

  let body: ReactNode = null;
  switch (reportId) {
    case 'cash_flow':
      body = <CashFlowSection period={period} />;
      break;
    case 'inflows_outflows':
      body = <OverviewSection period={period} onOpen={() => {}} />;
      break;
    case 'expense_analysis':
      body = <ExpenseSection period={period} />;
      break;
    case 'payroll_cost':
      body = <PayrollSection />;
      break;
    case 'aging_customers':
      body = <AgingSection party="customers" onOpen={() => {}} />;
      break;
    case 'accounts_receivable':
      body = <ReceivablesSection onOpen={() => {}} />;
      break;
    case 'accounts_payable':
      body = <PayablesSection onOpen={() => {}} />;
      break;
    case 'aging_suppliers':
      body = <AgingSection party="suppliers" onOpen={() => {}} />;
      break;
    case 'sales_analysis':
      body = <SalesSection period={period} onOpenCustomer={() => {}} />;
      break;
    case 'model_profitability':
      body = <ProfitabilitySection period={period} />;
      break;
    case 'cogs':
      body = <CogsSection period={period} />;
      break;
    case 'inventory_valuation':
      body = <InventorySection />;
      break;
    case 'wip_valuation':
      body = <WipSection />;
      break;
    case 'stock_health_slow':
    case 'stock_health_reorder':
      body = <StockHealthSection />;
      break;
    case 'losses':
      body = <LossesSection period={period} />;
      break;
    default:
      body = <CashFlowSection period={period} />;
      break;
  }

  return (
    <section className="warehouse-page rh" dir="rtl" aria-labelledby="management-reports-title">
      <header className="rh-head">
        <div>
          <span className="rh-eyebrow">التقارير والرقابة · مؤشرات وتحليلات الإدارة</span>
          <h2 id="management-reports-title">تقارير الإدارة</h2>
          <p>التقارير التحليلية والتشغيلية لمتابعة الخزينة والمصروفات، العملاء والموردين، المبيعات والربحية، والمخزون والتكلفة.</p>
        </div>
        <div className="rh-head__actions no-print">
          <button type="button" className="btn btn--secondary" onClick={() => window.print()}>
            طباعة / حفظ PDF
          </button>
        </div>
      </header>

      <nav className="rh-groups no-print" aria-label="أقسام تقارير الإدارة">
        {MANAGEMENT_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            aria-pressed={g.id === currentGroup.id}
            onClick={() => handleGroupSelect(g)}
          >
            {g.label}
          </button>
        ))}
      </nav>

      <div className="rh-subnav no-print" role="tablist" aria-label={currentGroup.label}>
        {currentGroup.reports.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={r.id === reportId}
            aria-pressed={r.id === reportId}
            onClick={() => setReportId(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="rh-toolbar">
        {currentReport.usesPeriod ? (
          <>
            <PeriodBar
              preset={preset}
              period={period}
              onChange={(p, next) => {
                setPreset(p);
                setPeriod(next);
              }}
            />
            <span className="rh-period-note">
              الفترة: <strong>{formatPeriod(period)}</strong>
            </span>
          </>
        ) : (
          <span className="rh-period-note">
            هذا التقرير يعرض <strong>الأرصدة حتى اليوم</strong> ولا يتأثر باختيار الفترة.
          </span>
        )}
      </div>

      <h2 className="rh-print-title">
        مصنع القمة للملابس — تقارير الإدارة: {currentReport.label}
        {currentReport.usesPeriod ? ` (${formatPeriod(period)})` : ' (الأرصدة حتى اليوم)'}
      </h2>

      {body}
    </section>
  );
}

