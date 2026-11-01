import { useState, useEffect, useCallback } from 'react';
import {
  reportsApi,
  type SummaryReport,
  type FinancialReport,
  type InventoryReport,
  type ReportPeriod,
} from './reportsApi';
import { CashFlowChart } from '@/features/operations-board/components/CashFlowChart';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';

export type ReportTab = 'summary' | 'financial' | 'inventory';

interface ReportsViewProps {
  initialTab?: ReportTab;
}

export function ReportsView({ initialTab = 'summary' }: ReportsViewProps) {
  const { hasPermission, authMode } = useAuth();
  const [activeTab, setActiveTab] = useState<ReportTab>(initialTab);

  // ─── 1. حالة الملخص التشغيلي والسيولة (Summary) ──────────────────────────
  const [summaryData, setSummaryData] = useState<SummaryReport | null>(null);
  const [summaryPeriod, setSummaryPeriod] = useState<ReportPeriod>('monthly');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryIs403, setSummaryIs403] = useState(false);

  // ─── 2. حالة التقرير المالي وسندات النقدية (Financial) ───────────────────
  const [financialData, setFinancialData] = useState<FinancialReport | null>(null);
  const [financialSinceDays, setFinancialSinceDays] = useState<number>(30);
  const [financialDocType, setFinancialDocType] = useState<'all' | 'inflow' | 'outflow'>('all');
  const [financialLoading, setFinancialLoading] = useState(false);
  const [financialError, setFinancialError] = useState<string | null>(null);
  const [financialIs403, setFinancialIs403] = useState(false);

  // ─── 3. حالة تقرير أرصدة المخزون (Inventory) ──────────────────────────────
  const [inventoryData, setInventoryData] = useState<InventoryReport | null>(null);
  const [inventoryWarehouse, setInventoryWarehouse] = useState<string>('all');
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryIs403, setInventoryIs403] = useState(false);

  // ─── دوال التحميل المعزولة لكل تبويب ─────────────────────────────────────
  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    setSummaryIs403(false);
    try {
      const res = await reportsApi.getSummary(summaryPeriod);
      setSummaryData(res);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        setSummaryIs403(true);
        setSummaryError('تم رفض الوصول (403): حسابك لا يملك صلاحية عرض الملخص التشغيلي (reports:view).');
      } else {
        const msg = err instanceof ApiError ? err.message : 'تعذر تحميل الملخص التشغيلي والسيولة. يرجى التحقق من اتصال الخادم.';
        setSummaryError(msg);
      }
    } finally {
      setSummaryLoading(false);
    }
  }, [summaryPeriod]);

  const loadFinancial = useCallback(async () => {
    setFinancialLoading(true);
    setFinancialError(null);
    setFinancialIs403(false);
    try {
      const res = await reportsApi.getFinancialReport(financialSinceDays);
      setFinancialData(res);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        setFinancialIs403(true);
        setFinancialError('تم رفض الوصول (403): حسابك لا يملك صلاحية التقارير المالية (finance:reports:view).');
      } else {
        const msg = err instanceof ApiError ? err.message : 'تعذر تحميل التقرير المالي. يرجى التحقق من اتصال الخادم.';
        setFinancialError(msg);
      }
    } finally {
      setFinancialLoading(false);
    }
  }, [financialSinceDays]);

  const loadInventory = useCallback(async () => {
    setInventoryLoading(true);
    setInventoryError(null);
    setInventoryIs403(false);
    try {
      const res = await reportsApi.getInventoryReport(inventoryWarehouse);
      setInventoryData(res);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        setInventoryIs403(true);
        setInventoryError('تم رفض الوصول (403): حسابك لا يملك صلاحية فحص المخزون (inventory:view).');
      } else {
        const msg = err instanceof ApiError ? err.message : 'تعذر تحميل تقرير أرصدة المخزون. يرجى التحقق من اتصال الخادم.';
        setInventoryError(msg);
      }
    } finally {
      setInventoryLoading(false);
    }
  }, [inventoryWarehouse]);

  // تشغيل التحميل عند تغيير التبويب أو الفلاتر
  useEffect(() => {
    if (activeTab === 'summary') {
      void loadSummary();
    } else if (activeTab === 'financial') {
      void loadFinancial();
    } else if (activeTab === 'inventory') {
      void loadInventory();
    }
  }, [activeTab, loadSummary, loadFinancial, loadInventory]);

  // تنسيق العملة المصرية
  const formatEgp = (amount: number | null | undefined): string => {
    const val = Number(amount ?? 0);
    return `${val.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
  };

  // تسمية الفترات بالعربية
  const getPeriodLabel = (p: ReportPeriod): string => {
    switch (p) {
      case 'daily':
        return 'اليومي (آخر ٢٤ ساعة)';
      case 'weekly':
        return 'الأسبوعي (آخر ٧ أيام)';
      case 'monthly':
        return 'الشهري (آخر ٣٠ يومًا)';
      case 'quarterly':
        return 'الربع سنوي (آخر ٩٠ يومًا)';
      case 'yearly':
        return 'السنوي (آخر ٣٦٥ يومًا)';
    }
  };

  // التحقق من صلاحيات التبويبات للواجهة
  const canViewSummary = authMode === 'local_dev' || hasPermission('reports:view');
  const canViewFinancial = authMode === 'local_dev' || hasPermission('finance:reports:view');
  const canViewInventory = authMode === 'local_dev' || hasPermission('inventory:view');

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="fin-reports-title">
      {/* ── ترويسة الصفحة والوصف ────────────────────────────────────────── */}
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">نظام التقارير والتحليل التشغيلي · مصنع القمة</span>
          <h2 id="fin-reports-title">التقارير المالية ومؤشرات الأداء</h2>
          <p>
            لوحة شاملة لمتابعة السيولة النقدية، التدفقات التشغيلية، سجلات المقبوضات والمصروفات، وحركات أرصدة المخازن بدقة واعتماد خادمي.
          </p>
        </div>
      </header>

      {/* ── أشرطة التبويب الثلاثة المعتمدة ──────────────────────────────── */}
      <div
        role="tablist"
        aria-label="أقسام التقارير"
        style={{
          display: 'flex',
          gap: '0.5rem',
          borderBottom: '2px solid #e2e8f0',
          paddingBottom: '0.5rem',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          role="tab"
          id="tab-btn-summary"
          aria-selected={activeTab === 'summary'}
          aria-controls="panel-summary"
          onClick={() => setActiveTab('summary')}
          style={{
            padding: '0.6rem 1.2rem',
            borderRadius: '8px',
            border: activeTab === 'summary' ? '2px solid #0f766e' : '1px solid #cbd5e1',
            background: activeTab === 'summary' ? '#f0fdfa' : '#ffffff',
            color: activeTab === 'summary' ? '#0f766e' : '#475569',
            fontWeight: activeTab === 'summary' ? 700 : 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span>📊</span>
          <span>الملخص التشغيلي والسيولة</span>
          {!canViewSummary && <span title="يتطلب صلاحية reports:view">🔒</span>}
        </button>

        <button
          type="button"
          role="tab"
          id="tab-btn-financial"
          aria-selected={activeTab === 'financial'}
          aria-controls="panel-financial"
          onClick={() => setActiveTab('financial')}
          style={{
            padding: '0.6rem 1.2rem',
            borderRadius: '8px',
            border: activeTab === 'financial' ? '2px solid #0f766e' : '1px solid #cbd5e1',
            background: activeTab === 'financial' ? '#f0fdfa' : '#ffffff',
            color: activeTab === 'financial' ? '#0f766e' : '#475569',
            fontWeight: activeTab === 'financial' ? 700 : 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span>💰</span>
          <span>المقبوضات والمصروفات النقدية</span>
          {!canViewFinancial && <span title="يتطلب صلاحية finance:reports:view">🔒</span>}
        </button>

        <button
          type="button"
          role="tab"
          id="tab-btn-inventory"
          aria-selected={activeTab === 'inventory'}
          aria-controls="panel-inventory"
          onClick={() => setActiveTab('inventory')}
          style={{
            padding: '0.6rem 1.2rem',
            borderRadius: '8px',
            border: activeTab === 'inventory' ? '2px solid #0f766e' : '1px solid #cbd5e1',
            background: activeTab === 'inventory' ? '#f0fdfa' : '#ffffff',
            color: activeTab === 'inventory' ? '#0f766e' : '#475569',
            fontWeight: activeTab === 'inventory' ? 700 : 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span>📦</span>
          <span>تقرير أرصدة المخزون</span>
          {!canViewInventory && <span title="يتطلب صلاحية inventory:view">🔒</span>}
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* 1. تبويب الملخص التشغيلي والسيولة (Summary Report)                 */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'summary' && (
        <div id="panel-summary" role="tabpanel" aria-labelledby="tab-btn-summary">
          {/* شريط الفلاتر والتحكم */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '1rem',
              backgroundColor: '#ffffff',
              padding: '0.85rem 1.25rem',
              borderRadius: '10px',
              border: '1px solid #e2e8f0',
              marginBottom: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 600 }}>نطاق الفترة:</span>
              {(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as ReportPeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSummaryPeriod(p)}
                  style={{
                    padding: '0.35rem 0.8rem',
                    borderRadius: '6px',
                    border: summaryPeriod === p ? '1px solid #0f766e' : '1px solid #cbd5e1',
                    background: summaryPeriod === p ? '#0f766e' : '#f8fafc',
                    color: summaryPeriod === p ? '#ffffff' : '#334155',
                    fontSize: '0.85rem',
                    fontWeight: summaryPeriod === p ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {p === 'daily'
                    ? 'يومي'
                    : p === 'weekly'
                    ? 'أسبوعي'
                    : p === 'monthly'
                    ? 'شهري'
                    : p === 'quarterly'
                    ? 'ربع سنوي'
                    : 'سنوي'}
                </button>
              ))}
              <span
                style={{
                  marginRight: '0.5rem',
                  fontSize: '0.8rem',
                  backgroundColor: '#f1f5f9',
                  padding: '0.25rem 0.6rem',
                  borderRadius: '4px',
                  color: '#475569',
                }}
              >
                الفترة النشطة: <strong>{getPeriodLabel(summaryPeriod)}</strong>
              </span>
            </div>

            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void loadSummary()}
              disabled={summaryLoading}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <span>↻</span>
              <span>{summaryLoading ? 'جاري التحديث...' : 'تحديث المؤشرات'}</span>
            </button>
          </div>

          {/* تنبيه الحصانة النقدية الصارمة (Cash Basis) */}
          <div
            className="warehouse-alert"
            style={{
              backgroundColor: '#eff6ff',
              color: '#1e40af',
              borderColor: '#bfdbfe',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.3rem',
              textAlign: 'right',
              marginBottom: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
              <span>ℹ️</span>
              <span>قواعد احتساب المؤشرات المالية والسيولة (الأساس النقدي - Cash Basis)</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.85rem', color: '#1e3a8a', lineHeight: 1.55 }}>
              الأرقام المالية أدناه تُحتسب على <strong>الأساس النقدي الفعلي</strong>؛ تمثل المقبوضات النقدية والمدفوعات
              حركات الخزينة والعهد المعتمدة فقط، ولا تعبّر عن إيرادات استحقاقية أو صافي أرباح محاسبية. كما تُستبعد التحويلات
              الداخلية بين الخزنة والعهد لضمان عدم تضخيم التدفقات.
            </p>
          </div>

          {/* حالة الخطأ 403 أو خطأ الخادم */}
          {summaryError && (
            <div
              className="warehouse-alert"
              role="alert"
              style={{
                marginBottom: '1rem',
                backgroundColor: summaryIs403 ? '#fff1f2' : '#fff7f7',
                borderColor: summaryIs403 ? '#fecdd3' : '#f0c4c4',
                color: summaryIs403 ? '#9f1239' : '#9b3333',
                textAlign: 'right',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <strong>{summaryIs403 ? '🔒 خطأ صلاحية (403):' : '⚠️ خطأ تحميل:'}</strong> {summaryError}
              </div>
              <button
                type="button"
                onClick={() => void loadSummary()}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid currentColor',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                }}
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {/* حالة التحميل */}
          {summaryLoading ? (
            <div style={{ padding: '2.5rem', textAlign: 'center', color: '#64748b' }}>
              <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>⏳</div>
              <p>جاري استخراج وتجميع المؤشرات التشغيلية والسيولة النقدية من الخادم...</p>
            </div>
          ) : summaryData ? (
            <>
              {/* قسم 1: مؤشرات السيولة النقدية (أساس نقدي) */}
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '1.1rem', color: '#0f172a', marginBottom: '0.75rem', fontWeight: 700 }}>
                  💵 مؤشرات السيولة النقدية والتدفقات (الأساس النقدي)
                </h3>
                <div className="warehouse-summary">
                  <article>
                    <span>رصيد الخزينة الفعلي المتاح</span>
                    <strong style={{ color: '#0f766e' }}>
                      {formatEgp(summaryData.treasury.balance)}
                    </strong>
                    <small style={{ color: '#64748b' }}>نقدية حاضرة بالخزينة الرئيسية</small>
                  </article>

                  <article>
                    <span>إجمالي أرصدة العهد النقدية</span>
                    <strong style={{ color: '#0284c7' }}>
                      {formatEgp(summaryData.treasury.petty_cash_total)}
                    </strong>
                    <small style={{ color: '#64748b' }}>سيولة موزعة على صناديق العهد</small>
                  </article>

                  <article>
                    <span>إجمالي السيولة النقدية المتاحة</span>
                    <strong style={{ color: '#0f172a' }}>
                      {formatEgp(summaryData.treasury.balance + summaryData.treasury.petty_cash_total)}
                    </strong>
                    <small style={{ color: '#64748b' }}>مجموع الخزينة الرئيسية والعهد</small>
                  </article>

                  <article>
                    <span>المقبوضات النقدية للفترة</span>
                    <strong style={{ color: '#16a34a' }}>
                      +{formatEgp(summaryData.treasury.revenues_period)}
                    </strong>
                    <small style={{ color: '#64748b' }}>تدفقات تشغيلية داخلة معتمدة</small>
                  </article>

                  <article>
                    <span>المصروفات النقدية للفترة</span>
                    <strong style={{ color: '#dc2626' }}>
                      -{formatEgp(summaryData.treasury.expenses_period)}
                    </strong>
                    <small style={{ color: '#64748b' }}>سدادات موردين ومصروفات نقدية</small>
                  </article>

                  <article>
                    <span>صافي التدفق النقدي للفترة</span>
                    <strong
                      style={{
                        color: summaryData.treasury.net_period >= 0 ? '#16a34a' : '#dc2626',
                      }}
                    >
                      {summaryData.treasury.net_period >= 0 ? '+' : ''}
                      {formatEgp(summaryData.treasury.net_period)}
                    </strong>
                    <small style={{ color: '#64748b' }}>الفارق الصافي بين المقبوضات والمدفوعات</small>
                  </article>
                </div>
              </div>

              {/* قسم 2: المؤشرات التشغيلية والالتزامات */}
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ fontSize: '1.1rem', color: '#0f172a', marginBottom: '0.75rem', fontWeight: 700 }}>
                  🏭 مؤشرات التشغيل والإنتاج والذمم
                </h3>
                <div className="warehouse-summary">
                  <article>
                    <span>أوامر التشغيل النشطة</span>
                    <strong style={{ color: '#0f766e' }}>
                      {summaryData.production.active_orders.toLocaleString('ar-EG')} أمر
                    </strong>
                    <small style={{ color: '#64748b' }}>قيد التصنيع في خط الإنتاج</small>
                  </article>

                  <article>
                    <span>الأوامر المكتملة بالفترة</span>
                    <strong style={{ color: '#16a34a' }}>
                      {summaryData.production.completed_orders_period.toLocaleString('ar-EG')} أمر
                    </strong>
                    <small style={{ color: '#64748b' }}>أوامر أتمت كافة مراحل التشغيل</small>
                  </article>

                  <article>
                    <span>أصناف الخامات النشطة</span>
                    <strong style={{ color: '#0284c7' }}>
                      {summaryData.inventory.raw_material_distinct_items.toLocaleString('ar-EG')} صنفًا
                    </strong>
                    <small style={{ color: '#64748b' }}>بمخزن الخامات والمستلزمات</small>
                  </article>

                  <article>
                    <span>أصناف المنتج التام</span>
                    <strong style={{ color: '#0f172a' }}>
                      {summaryData.inventory.finished_goods_distinct_items.toLocaleString('ar-EG')} صنفًا
                    </strong>
                    <small style={{ color: '#64748b' }}>بمخزن المنتجات التامة للتسليم</small>
                  </article>

                  <article>
                    <span>مستحقات فواتير الموردين</span>
                    <strong style={{ color: '#ea580c' }}>
                      {formatEgp(summaryData.payables.supplier_payables)}
                    </strong>
                    <small style={{ color: '#64748b' }}>التزامات فواتير خامات غير مسددة</small>
                  </article>

                  <article>
                    <span>توقيت استخراج التقرير</span>
                    <strong style={{ fontSize: '1rem', color: '#475569', fontWeight: 600 }}>
                      {new Date(summaryData.generated_at).toLocaleString('ar-EG')}
                    </strong>
                    <small style={{ color: '#64748b' }}>تحديث تلقائي من قاعدة البيانات</small>
                  </article>
                </div>
              </div>

              {/* ميزان ورسم بياني للتدفق النقدي والسيولة */}
              <CashFlowChart
                revenues={summaryData.treasury.revenues_period}
                expenses={summaryData.treasury.expenses_period}
                net={summaryData.treasury.net_period}
                treasuryBalance={summaryData.treasury.balance}
                pettyCashTotal={summaryData.treasury.petty_cash_total}
                periodLabel={getPeriodLabel(summaryPeriod)}
                loading={false}
              />
            </>
          ) : null}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* 2. تبويب المقبوضات والمصروفات النقدية (Financial Report)            */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'financial' && (
        <div id="panel-financial" role="tabpanel" aria-labelledby="tab-btn-financial">
          {/* شريط الفلاتر والتحكم */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '1rem',
              backgroundColor: '#ffffff',
              padding: '0.85rem 1.25rem',
              borderRadius: '10px',
              border: '1px solid #e2e8f0',
              marginBottom: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 600 }}>الفترة الزمنية:</span>
              {[7, 30, 90, 365].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setFinancialSinceDays(d)}
                  style={{
                    padding: '0.35rem 0.8rem',
                    borderRadius: '6px',
                    border: financialSinceDays === d ? '1px solid #0f766e' : '1px solid #cbd5e1',
                    background: financialSinceDays === d ? '#0f766e' : '#f8fafc',
                    color: financialSinceDays === d ? '#ffffff' : '#334155',
                    fontSize: '0.85rem',
                    fontWeight: financialSinceDays === d ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {d === 7 ? 'آخر ٧ أيام' : d === 30 ? 'آخر شهر' : d === 90 ? 'آخر ٣ أشهر' : 'آخر سنة'}
                </button>
              ))}

              <span style={{ margin: '0 0.5rem', color: '#cbd5e1' }}>|</span>

              <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 600 }}>نوع السند:</span>
              <button
                type="button"
                onClick={() => setFinancialDocType('all')}
                style={{
                  padding: '0.35rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  background: financialDocType === 'all' ? '#e2e8f0' : '#ffffff',
                  fontWeight: financialDocType === 'all' ? 700 : 400,
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                }}
              >
                الكل
              </button>
              <button
                type="button"
                onClick={() => setFinancialDocType('inflow')}
                style={{
                  padding: '0.35rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  background: financialDocType === 'inflow' ? '#dcfce7' : '#ffffff',
                  color: financialDocType === 'inflow' ? '#166534' : '#334155',
                  fontWeight: financialDocType === 'inflow' ? 700 : 400,
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                }}
              >
                مقبوضات فقط
              </button>
              <button
                type="button"
                onClick={() => setFinancialDocType('outflow')}
                style={{
                  padding: '0.35rem 0.6rem',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  background: financialDocType === 'outflow' ? '#fee2e2' : '#ffffff',
                  color: financialDocType === 'outflow' ? '#991b1b' : '#334155',
                  fontWeight: financialDocType === 'outflow' ? 700 : 400,
                  fontSize: '0.82rem',
                  cursor: 'pointer',
                }}
              >
                مصروفات فقط
              </button>
            </div>

            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void loadFinancial()}
              disabled={financialLoading}
            >
              {financialLoading ? 'جاري التحديث...' : 'تحديث السجلات'}
            </button>
          </div>

          {/* حالة الخطأ 403 أو خطأ الخادم */}
          {financialError && (
            <div
              className="warehouse-alert"
              role="alert"
              style={{
                marginBottom: '1rem',
                backgroundColor: financialIs403 ? '#fff1f2' : '#fff7f7',
                borderColor: financialIs403 ? '#fecdd3' : '#f0c4c4',
                color: financialIs403 ? '#9f1239' : '#9b3333',
                textAlign: 'right',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <strong>{financialIs403 ? '🔒 خطأ صلاحية (403):' : '⚠️ خطأ تحميل:'}</strong> {financialError}
              </div>
              <button
                type="button"
                onClick={() => void loadFinancial()}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid currentColor',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                }}
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {/* حالة التحميل */}
          {financialLoading ? (
            <div style={{ padding: '2.5rem', textAlign: 'center', color: '#64748b' }}>
              <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>⏳</div>
              <p>جاري استخراج مستندات وسجلات النقدية للفترة المحددة...</p>
            </div>
          ) : financialData ? (
            <>
              {/* إجماليات الفترة */}
              <div className="warehouse-summary" style={{ marginBottom: '1.5rem' }}>
                <article>
                  <span>إجمالي المقبوضات النقدية</span>
                  <strong style={{ color: '#16a34a' }}>
                    +{formatEgp(financialData.revenues.total)}
                  </strong>
                  <small style={{ color: '#64748b' }}>
                    عدد السندات: {financialData.revenues.count.toLocaleString('ar-EG')}
                  </small>
                </article>

                <article>
                  <span>إجمالي المدفوعات النقدية</span>
                  <strong style={{ color: '#dc2626' }}>
                    -{formatEgp(financialData.expenses.total)}
                  </strong>
                  <small style={{ color: '#64748b' }}>
                    عدد السندات: {financialData.expenses.count.toLocaleString('ar-EG')}
                  </small>
                </article>

                <article>
                  <span>صافي الحركة النقدية للفترة</span>
                  <strong
                    style={{
                      color: financialData.net >= 0 ? '#16a34a' : '#dc2626',
                    }}
                  >
                    {financialData.net >= 0 ? '+' : ''}
                    {formatEgp(financialData.net)}
                  </strong>
                  <small style={{ color: '#64748b' }}>
                    خلال آخر {financialData.since_days} يومًا
                  </small>
                </article>
              </div>

              {/* شريط المقارنة البصرية للمستندات النقدية */}
              <div
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '10px',
                  padding: '1.25rem',
                  marginBottom: '1.5rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.92rem', color: '#0f172a' }}>
                    ميزان المقبوضات والمصروفات النقدية (آخر {financialData.since_days} يومًا)
                  </span>
                  <span style={{ fontSize: '0.82rem', color: '#64748b' }}>
                    صافي الحركة: <strong style={{ color: financialData.net >= 0 ? '#16a34a' : '#dc2626' }}>{financialData.net >= 0 ? '+' : ''}{formatEgp(financialData.net)}</strong>
                  </span>
                </div>
                {financialData.revenues.total === 0 && financialData.expenses.total === 0 ? (
                  <p style={{ margin: 0, color: '#64748b', fontSize: '0.85rem' }}>
                    لا توجد سندات مقبوضات أو مصروفات مسجلة خلال الفترة (صافي الحركة ٠٫٠٠ ج.م).
                  </p>
                ) : (
                  <div>
                    <div
                      style={{
                        height: '12px',
                        display: 'flex',
                        borderRadius: '999px',
                        overflow: 'hidden',
                        backgroundColor: '#f1f5f9',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <div
                        style={{
                          width: `${(financialData.revenues.total / (financialData.revenues.total + financialData.expenses.total || 1)) * 100}%`,
                          backgroundColor: '#16a34a',
                        }}
                        title={`المقبوضات: ${formatEgp(financialData.revenues.total)}`}
                      />
                      <div
                        style={{
                          width: `${(financialData.expenses.total / (financialData.revenues.total + financialData.expenses.total || 1)) * 100}%`,
                          backgroundColor: '#dc2626',
                        }}
                        title={`المصروفات: ${formatEgp(financialData.expenses.total)}`}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
                      <span style={{ color: '#16a34a', fontWeight: 600 }}>
                        ● المقبوضات: +{formatEgp(financialData.revenues.total)} ({financialData.revenues.count.toLocaleString('ar-EG')} سند)
                      </span>
                      <span style={{ color: '#dc2626', fontWeight: 600 }}>
                        ● المصروفات: -{formatEgp(financialData.expenses.total)} ({financialData.expenses.count.toLocaleString('ar-EG')} سند)
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* جدول سندات المقبوضات النقدية */}
              {(financialDocType === 'all' || financialDocType === 'inflow') && (
                <div style={{ marginBottom: '2rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <h3 style={{ fontSize: '1rem', color: '#166534', fontWeight: 700 }}>
                      📥 سندات المقبوضات والتحصيلات النقدية ({financialData.revenues.documents.length})
                    </h3>
                  </div>
                  {financialData.revenues.documents.length === 0 ? (
                    <div className="warehouse-empty">
                      لا توجد سندات مقبوضات نقدية مسجلة في هذه الفترة ({financialSinceDays} يومًا).
                    </div>
                  ) : (
                    <div className="warehouse-table-wrap">
                      <table className="warehouse-table">
                        <thead>
                          <tr>
                            <th>رقم السند</th>
                            <th>التاريخ والوقت</th>
                            <th>البيان والوصف</th>
                            <th style={{ textAlign: 'left' }}>المبلغ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {financialData.revenues.documents.map((doc) => (
                            <tr key={doc.id}>
                              <td>
                                <code>{doc.number}</code>
                              </td>
                              <td style={{ color: '#64748b', fontSize: '0.85rem' }}>
                                {doc.occurred_at ? new Date(doc.occurred_at).toLocaleString('ar-EG') : '—'}
                              </td>
                              <td>{doc.description || '—'}</td>
                              <td style={{ textAlign: 'left', fontWeight: 700, color: '#16a34a' }}>
                                +{formatEgp(doc.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* جدول سندات المصروفات النقدية */}
              {(financialDocType === 'all' || financialDocType === 'outflow') && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <h3 style={{ fontSize: '1rem', color: '#991b1b', fontWeight: 700 }}>
                      📤 سندات المصروفات والمدفوعات النقدية ({financialData.expenses.documents.length})
                    </h3>
                  </div>
                  {financialData.expenses.documents.length === 0 ? (
                    <div className="warehouse-empty">
                      لا توجد سندات مدفوعات أو مصروفات نقدية مسجلة في هذه الفترة ({financialSinceDays} يومًا).
                    </div>
                  ) : (
                    <div className="warehouse-table-wrap">
                      <table className="warehouse-table">
                        <thead>
                          <tr>
                            <th>رقم السند</th>
                            <th>التاريخ والوقت</th>
                            <th>البيان والوصف</th>
                            <th style={{ textAlign: 'left' }}>المبلغ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {financialData.expenses.documents.map((doc) => (
                            <tr key={doc.id}>
                              <td>
                                <code>{doc.number}</code>
                              </td>
                              <td style={{ color: '#64748b', fontSize: '0.85rem' }}>
                                {doc.occurred_at ? new Date(doc.occurred_at).toLocaleString('ar-EG') : '—'}
                              </td>
                              <td>{doc.description || '—'}</td>
                              <td style={{ textAlign: 'left', fontWeight: 700, color: '#dc2626' }}>
                                -{formatEgp(doc.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* 3. تبويب تقرير أرصدة المخزون (Inventory Report)                    */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'inventory' && (
        <div id="panel-inventory" role="tabpanel" aria-labelledby="tab-btn-inventory">
          {/* شريط الفلاتر والتحكم */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '1rem',
              backgroundColor: '#ffffff',
              padding: '0.85rem 1.25rem',
              borderRadius: '10px',
              border: '1px solid #e2e8f0',
              marginBottom: '1rem',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.9rem', color: '#64748b', fontWeight: 600 }}>المخزن المستهدف:</span>
              <select
                value={inventoryWarehouse}
                onChange={(e) => setInventoryWarehouse(e.target.value)}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '0.88rem',
                  background: '#ffffff',
                }}
              >
                <option value="all">كل المخازن</option>
                <option value="main_raw_materials">مخزن الخامات والمستلزمات (main_raw_materials)</option>
                <option value="finished_goods">مخزن المنتجات التامة (finished_goods)</option>
                <option value="machinery">مخزن الماكينات والمعدات (machinery)</option>
              </select>
            </div>

            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void loadInventory()}
              disabled={inventoryLoading}
            >
              {inventoryLoading ? 'جاري الفحص...' : 'فحص الأرصدة'}
            </button>
          </div>

          {/* حالة الخطأ 403 أو خطأ الخادم */}
          {inventoryError && (
            <div
              className="warehouse-alert"
              role="alert"
              style={{
                marginBottom: '1rem',
                backgroundColor: inventoryIs403 ? '#fff1f2' : '#fff7f7',
                borderColor: inventoryIs403 ? '#fecdd3' : '#f0c4c4',
                color: inventoryIs403 ? '#9f1239' : '#9b3333',
                textAlign: 'right',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <strong>{inventoryIs403 ? '🔒 خطأ صلاحية (403):' : '⚠️ خطأ تحميل:'}</strong> {inventoryError}
              </div>
              <button
                type="button"
                onClick={() => void loadInventory()}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid currentColor',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                }}
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {/* حالة التحميل */}
          {inventoryLoading ? (
            <div style={{ padding: '2.5rem', textAlign: 'center', color: '#64748b' }}>
              <div style={{ fontSize: '1.8rem', marginBottom: '0.5rem' }}>⏳</div>
              <p>جاري مطابقة دفاتر أستاذ المخزون واحتساب الأرصدة الفعلية...</p>
            </div>
          ) : inventoryData ? (
            <>
              {/* ملخص إحصائي */}
              <div className="warehouse-summary" style={{ marginBottom: '1.5rem' }}>
                <article>
                  <span>إجمالي الأصناف المسجلة</span>
                  <strong style={{ color: '#0f766e' }}>
                    {inventoryData.total_items.toLocaleString('ar-EG')} صنفًا
                  </strong>
                  <small style={{ color: '#64748b' }}>بناءً على قيود حركة المخزن</small>
                </article>

                <article>
                  <span>الأصناف ذات الرصيد المتاح</span>
                  <strong style={{ color: '#16a34a' }}>
                    {inventoryData.items.filter((it) => !it.low_stock).length.toLocaleString('ar-EG')} صنفًا
                  </strong>
                  <small style={{ color: '#64748b' }}>رصيد فعلي أكبر من الصفر</small>
                </article>

                <article>
                  <span>الأصناف المنخفضة أو النافدة</span>
                  <strong style={{ color: '#ea580c' }}>
                    {inventoryData.items.filter((it) => it.low_stock).length.toLocaleString('ar-EG')} صنفًا
                  </strong>
                  <small style={{ color: '#64748b' }}>رصيد صفر أو سالب يستدعي الشراء</small>
                </article>
              </div>

              {/* شريط المؤشر البصري لسلامة المخزون */}
              <div
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '10px',
                  padding: '1.25rem',
                  marginBottom: '1.5rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.92rem', color: '#0f172a' }}>
                    مؤشر كفاية المخزون ونسبة الأصناف الحرجة
                  </span>
                  <span style={{ fontSize: '0.82rem', color: '#64748b' }}>
                    إجمالي الأصناف: <strong>{inventoryData.total_items.toLocaleString('ar-EG')} صنفًا</strong>
                  </span>
                </div>
                {inventoryData.total_items === 0 ? (
                  <p style={{ margin: 0, color: '#64748b', fontSize: '0.85rem' }}>
                    لا توجد أصناف مسجلة في هذا المخزن حالياً.
                  </p>
                ) : (
                  <div>
                    {(() => {
                      const availableCount = inventoryData.items.filter((it) => !it.low_stock).length;
                      const lowCount = inventoryData.items.filter((it) => it.low_stock).length;
                      const availPct = Math.round((availableCount / (inventoryData.total_items || 1)) * 100);
                      const lowPct = 100 - availPct;
                      return (
                        <>
                          <div
                            style={{
                              height: '12px',
                              display: 'flex',
                              borderRadius: '999px',
                              overflow: 'hidden',
                              backgroundColor: '#f1f5f9',
                              marginBottom: '0.5rem',
                            }}
                          >
                            <div style={{ width: `${availPct}%`, backgroundColor: '#0f766e' }} />
                            <div style={{ width: `${lowPct}%`, backgroundColor: '#ea580c' }} />
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
                            <span style={{ color: '#0f766e', fontWeight: 600 }}>
                              ● أصناف متوفرة للتشغيل: {availableCount.toLocaleString('ar-EG')} ({availPct}%)
                            </span>
                            <span style={{ color: '#ea580c', fontWeight: 600 }}>
                              ● أصناف نافدة أو حرجة: {lowCount.toLocaleString('ar-EG')} ({lowPct}%)
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* جدول الأرصدة */}
              {inventoryData.items.length === 0 ? (
                <div className="warehouse-empty">
                  لا توجد حركات أو أصناف مسجلة في المخزن المحدد حالياً.
                </div>
              ) : (
                <div className="warehouse-table-wrap">
                  <table className="warehouse-table">
                    <thead>
                      <tr>
                        <th>كود الصنف</th>
                        <th>اسم الصنف</th>
                        <th>المخزن</th>
                        <th style={{ textAlign: 'left' }}>الرصيد الفعلي</th>
                        <th style={{ textAlign: 'center' }}>حالة المخزون</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventoryData.items.map((row) => (
                        <tr key={`${row.item_id}-${row.warehouse_id}`}>
                          <td>
                            <code>{row.item_code}</code>
                          </td>
                          <td>
                            <strong>{row.item_name_ar || '—'}</strong>
                          </td>
                          <td>{row.warehouse_name || row.warehouse_id}</td>
                          <td style={{ textAlign: 'left', fontWeight: 700, fontSize: '0.95rem' }}>
                            {/* تمييز دقيق بين رصيد صفر الفعلي وبين غياب البيانات */}
                            {row.balance.toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {row.low_stock ? (
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '0.2rem 0.6rem',
                                  borderRadius: '999px',
                                  fontSize: '0.78rem',
                                  fontWeight: 600,
                                  backgroundColor: '#fef2f2',
                                  color: '#dc2626',
                                  border: '1px solid #fecaca',
                                }}
                              >
                                ⚠️ رصيد نافد أو حرج
                              </span>
                            ) : (
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '0.2rem 0.6rem',
                                  borderRadius: '999px',
                                  fontSize: '0.78rem',
                                  fontWeight: 600,
                                  backgroundColor: '#ecfdf5',
                                  color: '#059669',
                                  border: '1px solid #a7f3d0',
                                }}
                              >
                                ✓ متاح للتشغيل
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
