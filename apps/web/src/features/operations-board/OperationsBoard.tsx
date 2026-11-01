import { useEffect, useState, useCallback, useMemo } from 'react';
import { MetricCardsRow } from './components/MetricCardsRow';
import { BatchGrid } from './components/BatchGrid';
import { DeliveryList } from './components/DeliveryList';
import { AlertPanel } from './components/AlertPanel';
import { CashFlowChart } from './components/CashFlowChart';
import { ProductionPipelineChart } from './components/ProductionPipelineChart';
import type { MetricCard, BatchRow, AlertItem, DeliveryRow } from './mockData';
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

  // تحويل تقرير الـ API إلى كروت المؤشرات التشغيلية
  const operationalCards: MetricCard[] = useMemo(() => {
    if (!summaryReport) return [];
    return [
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
    ];
  }, [summaryReport]);

  // تحويل تقرير الـ API إلى كروت المؤشرات المالية والنقدية (أساس نقدي صارم)
  const financialCards: MetricCard[] = useMemo(() => {
    if (!summaryReport) return [];
    const totalLiquidity = summaryReport.treasury.balance + summaryReport.treasury.petty_cash_total;
    return [
      {
        id: 'kpi-treasury-balance',
        title: 'إجمالي السيولة النقدية المتاحة',
        value: `${totalLiquidity.toLocaleString('ar-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} ج.م`,
        sub: `خزينة: ${summaryReport.treasury.balance.toLocaleString('ar-EG', {
          minimumFractionDigits: 2,
        })} ج.م · عهد: ${summaryReport.treasury.petty_cash_total.toLocaleString('ar-EG', {
          minimumFractionDigits: 2,
        })} ج.م`,
        badge: 'نقدية فعلية حاضرة',
        badgeVariant: totalLiquidity > 0 ? 'success' : 'warning',
        icon: '💰',
      },
      {
        id: 'kpi-revenues-period',
        title: 'المقبوضات التشغيلية للفترة',
        value: `+${summaryReport.treasury.revenues_period.toLocaleString('ar-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} ج.م`,
        sub: 'تحصيلات نقدية فعلية معتمدة بالخزينة',
        badge: 'أساس نقدي',
        badgeVariant: 'success',
        icon: '📥',
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
        badge: summaryReport.treasury.net_period >= 0 ? 'فائض نقدي' : 'عجز نقدي',
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
    ];
  }, [summaryReport]);

  // تحويل أوامر التشغيل الفعلية إلى أسطر جدول الدفعات
  const mappedBatches: BatchRow[] = useMemo(() => {
    return (orders || []).map((o) => {
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
            : o.status === 'completed' || o.status === 'receipt_completed'
            ? 'مكتمل'
            : o.status === 'pending' || o.status === 'draft'
            ? 'بانتظار البدء'
            : o.status === 'materials_dispatched'
            ? 'خامات منصرفة'
            : o.status === 'manufacturing_completed'
            ? 'تم التصنيع'
            : o.status,
      };
    });
  }, [orders]);

  // اشتقاق تنبيهات تشغيلية حقيقية ديناميكية من واقع البيانات الخادمية
  const operationalAlerts: AlertItem[] = useMemo(() => {
    const alerts: AlertItem[] = [];
    const orderList = orders || [];

    // 1. أوامر تم صرف خاماتها وبانتظار تأكيد الاستلام بمخزن التشغيل (WIP)
    const dispatched = orderList.filter((o) => o.status === 'materials_dispatched');
    if (dispatched.length > 0) {
      alerts.push({
        id: 'alert-dispatched',
        iconVariant: 'amber',
        iconChar: '⚠️',
        title: `${dispatched.length.toLocaleString('ar-EG')} أمر تم صرف خاماتها بانتظار استلام الورشة`,
        subtitle: `الأوامر: ${dispatched.map((o) => o.order_number).slice(0, 3).join('، ')}${
          dispatched.length > 3 ? '...' : ''
        }`,
        value: 'تأكيد استلام WIP',
        valueVariant: 'amber',
      });
    }

    // 2. أوامر أتمت مراحل التصنيع وبانتظار استلام المنتج التام
    const mfgDone = orderList.filter((o) => o.status === 'manufacturing_completed');
    if (mfgDone.length > 0) {
      alerts.push({
        id: 'alert-mfg-done',
        iconVariant: 'blue',
        iconChar: '📦',
        title: `${mfgDone.length.toLocaleString('ar-EG')} أمر أتمت التصنيع وبانتظار فحص واستلام التام`,
        subtitle: `الأوامر: ${mfgDone.map((o) => o.order_number).slice(0, 3).join('، ')}`,
        value: 'جاهز للاستلام',
      });
    }

    // 3. أوامر استلمت بالمخزن التام وبانتظار الإغلاق النهائي الآمن
    const readyToClose = orderList.filter((o) => o.status === 'receipt_completed');
    if (readyToClose.length > 0) {
      alerts.push({
        id: 'alert-ready-to-close',
        iconVariant: 'green',
        iconChar: '🔒',
        title: `${readyToClose.length.toLocaleString('ar-EG')} أمر جاهز للإغلاق النهائي وتسوية WIP`,
        subtitle: `الأوامر: ${readyToClose.map((o) => o.order_number).slice(0, 3).join('، ')}`,
        value: 'جاهز للإغلاق',
      });
    }

    // 4. فواتير موردين مستحقة
    if (summaryReport && summaryReport.payables.supplier_payables > 0) {
      alerts.push({
        id: 'alert-payables',
        iconVariant: 'red',
        iconChar: '📄',
        title: 'مستحقات فواتير خامات تستوجب السداد',
        subtitle: 'التزامات موردين قائمة بانتظار سداد مالي معتمد',
        value: `${summaryReport.payables.supplier_payables.toLocaleString('ar-EG', {
          minimumFractionDigits: 2,
        })} ج.م`,
        valueVariant: 'amber',
      });
    }

    return alerts;
  }, [orders, summaryReport]);

  // اشتقاق ملخص حركة النشاط الحقيقي للوردية الحالية
  const todayActivityItems: AlertItem[] = useMemo(() => {
    const items: AlertItem[] = [];
    const orderList = orders || [];

    const activeCount = orderList.filter((o) => o.status === 'in_progress').length;
    items.push({
      id: 'act-active',
      iconVariant: 'blue',
      iconChar: '⚡',
      title: 'أوامر جارية على خط الإنتاج',
      subtitle: 'تتابع مراحل التشغيل والقص والتشطيب',
      value: `${activeCount.toLocaleString('ar-EG')} أمر`,
    });

    if (summaryReport) {
      items.push({
        id: 'act-completed-period',
        iconVariant: 'green',
        iconChar: '✓',
        title: 'الأوامر المكتملة بالفترة الحالية',
        subtitle: 'أتمت كافة مراحل التصنيع والتسليم التام',
        value: `${summaryReport.production.completed_orders_period.toLocaleString('ar-EG')} أمر`,
      });
    }

    const totalPieces = orderList.reduce((acc, o) => acc + (o.target_quantity || 0), 0);
    if (totalPieces > 0) {
      items.push({
        id: 'act-total-pieces',
        iconVariant: 'green',
        iconChar: '👕',
        title: 'إجمالي القطع المجدولة بالدفعات',
        subtitle: 'حجم الإنتاج الإجمالي لجميع الأوامر المسجلة',
        value: `${totalPieces.toLocaleString('ar-EG')} قطعة`,
      });
    }

    items.push({
      id: 'act-sync-status',
      iconVariant: 'blue',
      iconChar: '🔄',
      title: 'حالة الربط مع خادم PostgreSQL',
      subtitle: 'مزامنة قيود اليومية ودفاتر الأستاذ',
      value: lastSync,
      valueVariant: 'muted',
    });

    return items;
  }, [orders, summaryReport, lastSync]);

  // لا توجد بيانات تسليم وهمية — استعراض قائمة فارغة نظيفة عند عدم وجود تسليمات مسجلة
  const realDeliveries: DeliveryRow[] = [];

  return (
    <>
      {/* ── شريط التحكم والمزامنة المعتمد للإنتاج ──────────── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          padding: '0.75rem 1.25rem',
          borderRadius: '10px',
          marginBottom: '1rem',
          fontSize: '0.88rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.03)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '1.2rem' }}>🏭</span>
          <span>
            <strong>لوحة متابعة تشغيل المصنع التنفيذية</strong> — مزامنة حية مع قواعد بيانات الخادم
          </span>
          <span
            style={{
              fontSize: '0.78rem',
              backgroundColor: '#f1f5f9',
              color: '#475569',
              padding: '0.2rem 0.55rem',
              borderRadius: '4px',
              border: '1px solid #e2e8f0',
            }}
          >
            آخر مزامنة: {lastSync}
          </span>
          <span
            style={{
              fontSize: '0.75rem',
              backgroundColor: '#ecfdf5',
              color: '#065f46',
              padding: '0.2rem 0.55rem',
              borderRadius: '4px',
              border: '1px solid #a7f3d0',
              fontWeight: 600,
            }}
          >
            ✓ بيانات تشغيلية معتمدة
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              void loadKpis();
              void loadOrders();
            }}
            style={{
              padding: '0.4rem 0.85rem',
              fontSize: '0.84rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <span>↻</span>
            <span>تحديث شامل للوحة</span>
          </button>
        </div>
      </div>

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

      {/* ── 3. الرسم البياني للتدفق النقدي والسيولة ─────────────── */}
      {summaryReport && (
        <CashFlowChart
          revenues={summaryReport.treasury.revenues_period}
          expenses={summaryReport.treasury.expenses_period}
          net={summaryReport.treasury.net_period}
          treasuryBalance={summaryReport.treasury.balance}
          pettyCashTotal={summaryReport.treasury.petty_cash_total}
          periodLabel="الفترة الشهرية الحالية"
          loading={metricsLoading}
        />
      )}

      {/* ── 4. خط مراحل التشغيل وسير الإنتاج الحي ───────────────── */}
      <ProductionPipelineChart orders={orders} loading={ordersLoading} />

      {/* ── 5. المحتوى الرئيسي: الدفعات والتسليمات والتنبيهات ─── */}
      <section className="layout" aria-label="لوحة التشغيل">
        {/* العمود الرئيسي: الدفعات والتسليمات */}
        <div className="column">
          <BatchGrid
            batches={mappedBatches}
            loading={ordersLoading}
            error={ordersError}
            onRetry={() => void loadOrders()}
          />

          <DeliveryList
            deliveries={realDeliveries}
            loading={false}
          />
        </div>

        {/* الشريط الجانبي الداخلي: التنبيهات وحركة اليوم */}
        <aside className="column">
          <AlertPanel
            title="تحتاج قرارك"
            subtitle="تنبيهات تشغيلية تؤثر على سير الوردية"
            items={operationalAlerts}
            count={operationalAlerts.length}
            emptyMessage="✓ جميع العمليات منتظمة: لا توجد تنبيهات تشغيلية حرجة أو متأخرات معلقة للوردية الحالية."
          />

          <div className="note-block" role="note">
            <strong>قاعدة الشفافية والاعتماد المالي</strong>
            يتم استعراض مؤشرات التشغيل والنقدية مباشرة من دفاتر الأستاذ الفعلية، ولا تُحوّل أخطاء الاتصال إلى أصفار، كما يُستبعد أي رقم تجريبي غير معتمد.
          </div>

          <AlertPanel
            title="ملخص حركة اليوم"
            subtitle="سجل العمليات المنجزة بالوردية"
            items={todayActivityItems}
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
