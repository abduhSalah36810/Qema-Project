import { ReportsView, type ReportTab } from '@/features/reports/ReportsView';

interface FinancialReportsViewProps {
  initialTab?: ReportTab;
}

export function FinancialReportsView({ initialTab = 'summary' }: FinancialReportsViewProps) {
  return <ReportsView initialTab={initialTab} />;
}
