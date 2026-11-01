import { useEffect, useState } from 'react';
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
  type MetricCard,
} from './mockData';
import { reportsApi } from '../reports/reportsApi';

export function OperationsBoard() {
  const [metrics, setMetrics] = useState<MetricCard[]>(DEMO_METRICS);
  const [lastSync, setLastSync] = useState<string>('جارٍ الاتصال...');

  useEffect(() => {
    let isMounted = true;
    async function loadLiveData() {
      try {
        const report = await reportsApi.getSummary('monthly');
        if (!isMounted || !report) return;

        setMetrics([
          {
            id: 'm-1',
            title: 'رصيد الخامات النشطة',
            value: `${report.inventory.raw_material_distinct_items} صنفًا`,
            sub: 'بالمخزن الرئيسي للخامات',
            badge: 'متاح للتشغيل',
            badgeVariant: 'info',
            icon: '🧵',
          },
          {
            id: 'm-2',
            title: 'الدفعات قيد التشغيل',
            value: `${report.production.active_orders} دفعة`,
            sub: 'أوامر تشغيل نشطة في خط الإنتاج',
            badge: 'تعمل الآن',
            badgeVariant: report.production.active_orders > 0 ? 'success' : 'info',
            icon: '⚡',
          },
          {
            id: 'm-3',
            title: 'المنتج التام الجاهز',
            value: `${report.inventory.finished_goods_distinct_items} صنفًا`,
            sub: 'بمخزن المنتج التام والتجهيز',
            badge: 'جاهز للتسليم',
            badgeVariant: 'info',
            icon: '📦',
          },
          {
            id: 'm-4',
            title: 'رصيد الخزينة المتاح',
            value: `${report.treasury.balance.toLocaleString('ar-EG')} ج.م`,
            sub: `العهد اليومية: ${report.treasury.petty_cash_total.toLocaleString('ar-EG')} ج.م`,
            badge: 'السيولة',
            badgeVariant: report.treasury.balance > 0 ? 'success' : 'warning',
            icon: '💰',
          },
        ]);
        setLastSync(new Date(report.generated_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }));
      } catch {
        if (isMounted) {
          setLastSync('بيانات العرض التجريبي (Offline)');
        }
      }
    }
    void loadLiveData();
    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <>
      {/* ── كروت المؤشرات العلوية الأربعة ──────────────── */}
      <MetricCardsRow metrics={metrics} />

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
        <span>آخر مزامنة: {lastSync}</span>
      </div>
    </>
  );
}
