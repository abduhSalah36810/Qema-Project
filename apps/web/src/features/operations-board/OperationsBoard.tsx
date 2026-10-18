import { WorkflowPipeline } from './components/WorkflowPipeline';
import { BatchGrid } from './components/BatchGrid';
import { DeliveryList } from './components/DeliveryList';
import { AlertPanel } from './components/AlertPanel';
import {
  DEMO_FLOW_STEPS,
  DEMO_BATCHES,
  DEMO_DELIVERIES,
  DEMO_ALERTS,
  DEMO_TODAY_ACTIVITY,
} from './mockData';

export function OperationsBoard() {
  return (
    <>
      {/* ── مقدمة الوردية ──────────────────────────────── */}
      <section className="intro" aria-label="مقدمة الوردية">
        <div>
          <div className="intro__kicker">الأحد · ١٨ أكتوبر ٢٠٢٦</div>
          <h1 className="intro__title">صورة الوردية</h1>
          <p className="intro__sub">
            متابعة تدفق الشغل من استلام الخامات إلى تجهيز طلبات العملاء.
          </p>
        </div>
        <div className="intro__tools">
          <div className="shift-badge">
            <span className="shift-badge__label">الوردية الحالية</span>
            الصباحية · ٨:٠٠ ص – ٤:٠٠ م
          </div>
          <button className="btn">كل المخازن ⌄</button>
          <button className="btn btn--primary">＋ بدء دفعة إنتاج</button>
        </div>
      </section>

      {/* ── خط مراحل التشغيل ────────────────────────────── */}
      <WorkflowPipeline steps={DEMO_FLOW_STEPS} />

      {/* ── المحتوى الرئيسي ─────────────────────────────── */}
      <section className="layout" aria-label="لوحة التشغيل">
        {/* العمود الرئيسي */}
        <div className="column">
          <BatchGrid batches={DEMO_BATCHES} />
          <DeliveryList deliveries={DEMO_DELIVERIES} />
        </div>

        {/* الشريط الجانبي */}
        <aside className="column">
          <AlertPanel
            title="تحتاج قرارك"
            subtitle="تنبيهات مؤثرة على سير الوردية"
            items={DEMO_ALERTS}
            count={DEMO_ALERTS.length}
            showAction
            actionLabel="مراجعة التنبيهات ←"
          />

          <div className="note-block" role="note">
            <strong>اقتراح متابعة</strong>
            <br />
            صرف خامة الجينز للدفعة د/٢٥١ متوقف لحين مراجعة الرصيد.
          </div>

          <AlertPanel
            title="ملخص حركة اليوم"
            subtitle="ما تم إنجازه حتى الآن"
            items={DEMO_TODAY_ACTIVITY}
          />
        </aside>
      </section>

      {/* ── تذييل ──────────────────────────────────────── */}
      <div className="footer-line" role="contentinfo">
        <span>لوحة تشغيل تجريبية · البيانات للعرض فقط</span>
        <span>آخر تحديث تجريبي: ١٠:٤٥ ص</span>
      </div>
    </>
  );
}
