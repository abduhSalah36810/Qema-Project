import { useEffect, useState, useCallback } from 'react';
import { MetricCardsRow } from './components/MetricCardsRow';
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
  type MetricCard,
  type BatchRow,
} from './mockData';
import { reportsApi, type SummaryReport } from '../reports/reportsApi';
import { apiClient, ApiError } from '@/lib/api';
import type { ProductionOrder } from '../production/productionApi';

export function OperationsBoard() {

  // ─── 1. حالة مؤشرات الأداء الحية (KPIs) ───────────────────────────────────
  const [summaryReport, setSummaryReport] = useState<SummaryReport | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>('جارٍ الاتصال...');

  // ─── 2. حالة أوامر التشغيل والدفعات (Batches) ─────────────────────────────
  const [orders, setOrders] = useState<ProductionOrder[] | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  // ─── 3. خيار المعاينة البصرية التجريبية عند الرغبة ─────────────────────────
  const [showDemoPreview, setShowDemoPreview] = useState(false);

  // تحميل المؤشرات الحية من reportsApi
  const loadKpis = useCallback(async () => {
    setMetricsLoading(true);
    setMetricsError(null);
    try {
      const report = await reportsApi.getSummary('monthly');
      setSummaryReport(report);
      setLastSync(
        new Date(report.generated_at).toLocaleTimeString('ar-EG', {
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    } catch (err: unknown) {
      const message =
        err instanceof ApiError && err.status === 403
          ? 'تم رفض الوصول: يتطلب عرض مؤشرات التشغيل صلاحية (reports:view).'
          : err instanceof ApiError
          ? err.message
          : 'تعذر الاتصال بالخادم لتحميل المؤشرات التشغيلية.';
      setMetricsError(message);
      setSummaryReport(null);
      setLastSync('فشل المزامنة');
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  // تحميل أوامر التشغيل الفعلية
  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const data = await apiClient.request<ProductionOrder[]>('/api/v1/production/orders');
      setOrders(data);
    } catch (err: unknown) {
      const message =
        err instanceof ApiError && err.status === 403
          ? 'صلاحية غير كافية لاستعراض أوامر التشغيل (production:orders:view).'
          : err instanceof ApiError
          ? err.message
          : 'تعذر الاتصال بالخادم لتحميل أوامر التشغيل.';
      setOrdersError(message);
      setOrders(null);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKpis();
    void loadOrders();
  }, [loadKpis, loadOrders]);

  // تحويل تقرير الـ API إلى كروت المؤشرات التشغيلية والمالية مع ضمان عدم اختراع أرقام
  const operationalCards: MetricCard[] = summaryReport
    ? [
        {
          id: 'kpi-raw-materials',
          title: 'أصناف الخامات النشطة',
          value: `${summaryReport.inventory.raw_material_distinct_items.toLocaleString('ar-EG')} صنفًا`,
          sub: 'بالمخزن الرئيسي للخامات والمستلزمات',
          badge: 'متاح للتشغيل',
          badgeVariant: 'info',
          icon: '🧵',
        },
        {
          id: 'kpi-active-orders',
          title: 'أوامر التشغيل النشطة',
          value: `${summaryReport.production.active_orders.toLocaleString('ar-EG')} أمر`,
          sub: `المكتمل خلال الفترة: ${summaryReport.production.completed_orders_period.toLocaleString('ar-EG')} أمر`,
          badge: summaryReport.production.active_orders > 0 ? 'تعمل الآن' : 'لا توجد أوامر',
          badgeVariant: summaryReport.production.active_orders > 0 ? 'success' : 'info',
          icon: '⚡',
        },
        {
          id: 'kpi-finished-goods',
          title: 'المنتجات التامة الجاهزة',
          value: `${summaryReport.inventory.finished_goods_distinct_items.toLocaleString('ar-EG')} صنفًا`,
          sub: 'بمخزن المنتج التام والتجهيز',
          badge: 'جاهز للتسليم',
          badgeVariant: 'info',
          icon: '📦',
        },
      ]
    : [];

  const financialCards: MetricCard[] = summaryReport
    ? [
        {
          id: 'kpi-treasury-balance',
          title: 'إجمالي السيولة النقدية',
          value: `${(summaryReport.treasury.balance + summaryReport.treasury.petty_cash_total).toLocaleString('ar-EG', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ج.م`,
          sub: `خزينة: ${summaryReport.treasury.balance.toLocaleString('ar-EG', {
            minimumFractionDigits: 2,
          })} ج.م · عهد: ${summaryReport.treasury.petty_cash_total.toLocaleString('ar-EG', {
            minimumFractionDigits: 2,
          })} ج.م`,
          badge: 'نقدية فعلية حاضرة',
          badgeVariant:
            summaryReport.treasury.balance + summaryReport.treasury.petty_cash_total > 0
              ? 'success'
              : 'warning',
          icon: '💰',
        },
        {
          id: 'kpi-net-cash-flow',
          title: 'صافي التدفق النقدي للفترة',
          value: `${summaryReport.treasury.net_period >= 0 ? '+' : ''}${summaryReport.treasury.net_period.toLocaleString(
            'ar-EG',
            {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }
          )} ج.م`,
          sub: `مقبوضات: +${summaryReport.treasury.revenues_period.toLocaleString('ar-EG', {
            minimumFractionDigits: 2,
          })} · مدفوعات: -${summaryReport.treasury.expenses_period.toLocaleString('ar-EG', {
            minimumFractionDigits: 2,
          })}`,
          badge: 'أساس نقدي (Cash Basis)',
          badgeVariant: summaryReport.treasury.net_period >= 0 ? 'success' : 'warning',
          icon: '📊',
        },
        {
          id: 'kpi-supplier-payables',
          title: 'مستحقات فواتير الموردين',
          value: `${summaryReport.payables.supplier_payables.toLocaleString('ar-EG', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ج.م`,
          sub: 'أرصدة فواتير خامات مستحقة السداد',
          badge: 'التزامات موردين',
          badgeVariant: summaryReport.payables.supplier_payables > 0 ? 'warning' : 'info',
          icon: '📄',
        },
      ]
    : [];

  // تحويل أوامر التشغيل الفعلية إلى أسطر جدول الدفعات
  const mappedBatches: BatchRow[] = (orders || []).map((o) => {
    const completedStages = (o.stage_events || []).filter((s) => s.status === 'completed').length;
    const totalStages = Math.max(5, (o.stage_events || []).length || 5);
    const progress = Math.round((completedStages / totalStages) * 100);

    return {
      id: o.id,
      batchCode: o.order_number,
      line: o.assigned_to || 'خط التشغيل العام',
      productName: o.product_name_ar || 'أمر تشغيل إنتاجي',
      dotColor: progress >= 80 ? 'teal' : progress >= 40 ? 'olive' : 'sand',
      doneCount: Math.round((o.target_quantity * progress) / 100),
      targetCount: o.target_quantity,
      progressPercent: progress,
      progressVariant: progress < 50 ? 'amber' : undefined,
      supervisorName: o.created_by || 'مشرف الوردية',
      supervisorRole: 'إدارة الإنتاج',
      status: o.status === 'in_progress' ? 'active' : o.status === 'pending' ? 'wait' : 'active',
      statusLabel:
        o.status === 'in_progress'
          ? 'قيد التنفيذ'
          : o.status === 'completed'
          ? 'مكتمل'
          : o.status === 'pending'
          ? 'بانتظار البدء'
          : o.status,
    };
  });

  // إذا تم اختيار وضع المعاينة التجريبية صراحة
  const displayedBatches = showDemoPreview ? DEMO_BATCHES : mappedBatches;
  const displayedDeliveries = showDemoPreview ? DEMO_DELIVERIES : [];

  return (
    <>
      {/* ── شريط التحكم في المعاينة التجريبية الشفافة ──────────── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          padding: '0.65rem 1.25rem',
          borderRadius: '10px',
          marginBottom: '1rem',
          fontSize: '0.88rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ fontSize: '1.1rem' }}>🏭</span>
          <span>
            <strong>لوحة متابعة تشغيل المصنع</strong> — مزامنة حية مع قواعد بيانات الخادم
          </span>
          <span
            style={{
              fontSize: '0.78rem',
              backgroundColor: '#f1f5f9',
              color: '#475569',
              padding: '0.2rem 0.5rem',
              borderRadius: '4px',
            }}
          >
            آخر مزامنة: {lastSync}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={showDemoPreview}
              onChange={(e) => setShowDemoPreview(e.target.checked)}
            />
            <span style={{ color: '#64748b', fontSize: '0.82rem' }}>عرض نماذج المعاينة التجريبية</span>
          </label>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              void loadKpis();
              void loadOrders();
            }}
            style={{ padding: '0.3rem 0.75rem', fontSize: '0.82rem' }}
          >
            ↻ تحديث اللوحة
          </button>
        </div>
      </div>

      {/* تنبيه إذا كانت المعاينة التجريبية مفعلة */}
      {showDemoPreview && (
        <div
          className="warehouse-alert"
          style={{
            backgroundColor: '#fffbeb',
            borderColor: '#fde68a',
            color: '#92400e',
            marginBottom: '1rem',
            textAlign: 'right',
            fontSize: '0.86rem',
          }}
        >
          <strong>🔶 تنبيه المعاينة البصرية:</strong> تعرض اللوحة حالياً نماذج بيانات تجريبية (Mock Demo)
          للدفعات والتسليمات لأغراض العرض التوضيحي. هذه البيانات غير مرتبطة بقاعدة بيانات المصنع.
        </div>
      )}

      {/* ── 1. المؤشرات التشغيلية الحية ────────────────────────── */}
      <MetricCardsRow
        sectionTitle="المؤشرات التشغيلية للمصنع"
        metrics={operationalCards}
        loading={metricsLoading}
        error={metricsError}
        onRetry={() => void loadKpis()}
      />

      {/* ── 2. مؤشرات السيولة والتدفق النقدي (الأساس النقدي) ────── */}
      <MetricCardsRow
        sectionTitle="مؤشرات السيولة النقدية والتدفقات (الأساس النقدي - Cash Basis)"
        metrics={financialCards}
        loading={metricsLoading}
        error={metricsError}
        onRetry={() => void loadKpis()}
      />

      {/* ── 3. خط مراحل التشغيل ────────────────────────────────── */}
      <WorkflowPipeline steps={DEMO_FLOW_STEPS} />

      {/* ── 4. المحتوى الرئيسي: الدفعات والتسليمات والتنبيهات ─── */}
      <section className="layout" aria-label="لوحة التشغيل">
        {/* العمود الرئيسي: الدفعات والتسليمات */}
        <div className="column">
          <BatchGrid
            batches={displayedBatches}
            loading={ordersLoading}
            error={ordersError}
            onRetry={() => void loadOrders()}
            isDemo={showDemoPreview}
          />
          <DeliveryList
            deliveries={displayedDeliveries}
            loading={false}
            isDemo={showDemoPreview}
          />
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
            <strong>قاعدة الشفافية والاعتماد</strong>
            يتم استعراض مؤشرات التشغيل والنقدية مباشرة من دفاتر الأستاذ الفعلية، ولا تُحوّل أخطاء الاتصال إلى أصفار.
          </div>

          <AlertPanel
            title="ملخص حركة اليوم"
            subtitle="سجل العمليات المنجزة بالوردية"
            items={DEMO_TODAY_ACTIVITY}
          />
        </aside>
      </section>

      {/* ── تذييل اللوحة ────────────────────────────────────────── */}
      <div className="footer-line" role="contentinfo">
        <span>مصنع القمة للملابس · نظام إدارة الإنتاج والمخازن ERP</span>
        <span>حالة المزامنة: {lastSync}</span>
      </div>
    </>
  );
}
