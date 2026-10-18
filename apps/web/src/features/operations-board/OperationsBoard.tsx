import { MetricCardsRow } from './components/MetricCardsRow';
import { WorkflowPipeline } from './components/WorkflowPipeline';
import { BatchGrid } from './components/BatchGrid';
import { DeliveryList } from './components/DeliveryList';
import { AlertPanel } from './components/AlertPanel';
import {
  DEMO_METRICS,
  DEMO_FLOW_STEPS,
  DEMO_BATCHES,
  DEMO_DELIVERIES,
  DEMO_ALERTS,
  DEMO_TODAY_ACTIVITY,
} from './mockData';

export function OperationsBoard() {
  return (
    <>
      {/* ── كروت المؤشرات العلوية الأربعة ──────────────── */}
      <MetricCardsRow metrics={DEMO_METRICS} />

      {/* ── خط مراحل التشغيل ────────────────────────────── */}
      <WorkflowPipeline steps={DEMO_FLOW_STEPS} />

      {/* ── المحتوى الرئيسي للوحة التشغيل ───────────────── */}
      <section className="layout" aria-label="لوحة التشغيل">
        {/* العمود الرئيسي: الدفعات والتسليمات */}
        <div className="column">
          <BatchGrid batches={DEMO_BATCHES} />
          <DeliveryList deliveries={DEMO_DELIVERIES} />
        </div>

        {/* الشريط الجانبي الداخلي: التنبيهات وحركة اليوم */}
        <aside className="column">
          <AlertPanel
            title="تحتاج قرارك"
            subtitle="تنبيهات مؤثرة على سير الوردية"
            items={DEMO_ALERTS}
            count={DEMO_ALERTS.length}
            showAction
            actionLabel="مراجعة جميع التنبيهات ←"
          />

          <div className="note-block" role="note">
            <strong>اقتراح متابعة الوردية</strong>
            صرف خامة الجينز للدفعة د/٢٥١ متوقف لحين مراجعة وتأكيد الرصيد المتاح.
          </div>

          <AlertPanel
            title="ملخص حركة اليوم"
            subtitle="سجل العمليات المنجزة بالوردية"
            items={DEMO_TODAY_ACTIVITY}
          />
        </aside>
      </section>

      {/* ── تذييل اللوحة ────────────────────────────────── */}
      <div className="footer-line" role="contentinfo">
        <span>مصنع القمة للملابس · نظام إدارة الإنتاج والمخازن ERP</span>
        <span>آخر مزامنة تجريبية: ١٠:٤٥ ص</span>
      </div>
    </>
  );
}
