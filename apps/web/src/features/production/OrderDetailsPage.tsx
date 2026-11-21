/**
 * صفحة تفاصيل أمر التشغيل — مساحة عمل الإنتاج (Phase 4.5 / T4)
 * ─────────────────────────────────────────────────────────────────────────────
 * تحويل تفاصيل أمر التشغيل من Modal متضخم إلى مساحة عمل منظمة بـ6 تبويبات:
 * 1. نظرة عامة (Overview): الملخص، شريط الخطوات، الموديلات، BOM Snapshot، تخصيصات العملاء (T3).
 * 2. الخامات (Materials): الصرف والاستلام، خامات المسودة، مطالبات الفروقات (T2)، الصرف الإضافي.
 * 3. التنفيذ (Execution): مراحل التصنيع الخمس، تسجيل التأخيرات، التخطي، التراجع، العيوب.
 * 4. المنتج التام (Finished Goods): استلام التام، استيفاء حصص طلبات العملاء (T3).
 * 5. التسوية (Reconcile): تسوية WIP، المرتجعات، تسوية خامات العميل (CMT).
 * 6. الإغلاق (Closure): شروط وحواجز الإغلاق، اعتماد الفروقات، إغلاق الأمر، التكاليف والهالك الفعلي.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import type { OrderDetailTab } from '@/lib/navigation';
import {
  ProductionOrder,
  ProductionOrderItem,
  CatalogItem,
  OrderWipSummary,
  TransferDiscrepancyClaimRead,
  ProductionOrderDemandRead,
  fetchProductionOrderById,
  fetchOrderWipSummary,
  fetchOrderDiscrepancyClaims,
  fetchOrderDemands,
  closeProductionOrderApi,
  newIdempotencyKey,
  OrderClosePayload,
} from './productionApi';
import { nextStep, ORDER_STATUS_LABEL } from './orderWorkflow';
import {
  ORDER_STATUS_AR,
  REFRESH_FAILED_TEXT,
  parseApiError,
  seasonAr,
  type SectionContext,
} from './orderDetails/constants';
import { OrderOverviewSection } from './orderDetails/OrderOverviewSection';
import { OrderMaterialsSection } from './orderDetails/OrderMaterialsSection';
import { OrderExecutionSection } from './orderDetails/OrderExecutionSection';
import { OrderFinishedGoodsSection } from './orderDetails/OrderFinishedGoodsSection';
import { OrderReconciliationSection } from './orderDetails/OrderReconciliationSection';
import { type CloseFormState } from './orderDetails/OrderClosureSection';
import { OrderCostsSection } from './orderDetails/OrderCostsSection';
import { OrderShortageProcurementModal } from './orderDetails/OrderShortageProcurementModal';
import { DiscrepancyClaimDetailModal } from './DiscrepancyClaims';

export type PageTab = 'overview' | 'materials' | 'execution' | 'finished' | 'costing' | 'reconcile';

export interface OrderDetailsPageProps {
  order: ProductionOrder;
  onBack: () => void;
  onOrderUpdated: (updatedOrder: ProductionOrder) => void;
  catalogItems?: CatalogItem[];
  isCatalogLoading?: boolean;
  catalogError?: string | null;
  /** فتح الأمر مباشرة على تبويب محدد (من صندوق المهام أو Deep Link) */
  initialTab?: OrderDetailTab;
  /** تفعيل غلاف Modal للتوافق العكسي مع الاختبارات */
  isModalWrapper?: boolean;
}

function mapInitialTab(tab?: OrderDetailTab | PageTab): PageTab {
  if (!tab) return 'overview';
  if (tab === 'items' || tab === 'overview') return 'overview';
  if (tab === 'materials') return 'materials';
  if (tab === 'stages' || tab === 'defects' || tab === 'execution') return 'execution';
  if (tab === 'fg_receipt' || tab === 'finished') return 'finished';
  if (tab === 'costing') return 'costing';
  if (tab === 'wip' || tab === 'reconcile' || tab === 'closure') return 'reconcile';
  return 'overview';
}

export const OrderDetailsPage: React.FC<OrderDetailsPageProps> = ({
  order,
  onBack,
  onOrderUpdated,
  catalogItems = [],
  isCatalogLoading = false,
  catalogError = null,
  initialTab,
  isModalWrapper = false,
}) => {
  const { hasPermission, user } = useAuth();
  const canManageStages = hasPermission('production:stages:manage');
  const canCloseOrder = hasPermission('production:orders:close');
  const showStagesTab = canManageStages || canCloseOrder;
  const isCmt = order.manufacturing_type === 'external';

  const determineDefaultTab = (): PageTab => {
    if (initialTab) return mapInitialTab(initialTab);
    const step = nextStep(order, hasPermission, user?.id);
    if (step?.isMine) {
      return mapInitialTab(step.tab);
    }
    return 'overview';
  };

  const [activeTab, setActiveTab] = useState<PageTab>(() => determineDefaultTab());
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isResyncing, setIsResyncing] = useState<boolean>(false);
  const [isProcurementModalOpen, setIsProcurementModalOpen] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'warning';
    text: string;
    canResync?: boolean;
  } | null>(null);

  // تخصيصات طلبات العملاء للأمر المجمع (T3)
  const [demands, setDemands] = useState<ProductionOrderDemandRead[]>([]);
  useEffect(() => {
    let isMounted = true;
    if (order.id) {
      fetchOrderDemands(order.id)
        .then((data) => {
          if (isMounted) setDemands(data || []);
        })
        .catch(() => {
          if (isMounted) setDemands([]);
        });
    }
    return () => {
      isMounted = false;
    };
  }, [order.id]);

  // مطالبات عجز استلام الخامات (T2)
  const [claims, setClaims] = useState<TransferDiscrepancyClaimRead[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [openClaim, setOpenClaim] = useState<TransferDiscrepancyClaimRead | null>(null);

  const loadClaims = useCallback(async () => {
    setClaimsLoading(true);
    setClaimsError(null);
    try {
      const data = await fetchOrderDiscrepancyClaims(order.id);
      setClaims(data);
    } catch (err: unknown) {
      setClaimsError(parseApiError(err, 'تعذر تحميل مطالبات الفروقات لهذا الأمر.').text);
    } finally {
      setClaimsLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    void loadClaims();
  }, [loadClaims]);

  // ملخص الورشة (WIP Summary) للتسوية والإغلاق
  const [wipSummary, setWipSummary] = useState<OrderWipSummary | null>(null);
  const [wipLoading, setWipLoading] = useState(false);
  const [wipError, setWipError] = useState<string | null>(null);
  const [returnsVersion, setReturnsVersion] = useState(0);

  const loadWipSummary = useCallback(async () => {
    setWipLoading(true);
    setWipError(null);
    try {
      const summary = await fetchOrderWipSummary(order.id);
      setWipSummary(summary);
    } catch (err: unknown) {
      setWipError(parseApiError(err, 'تعذر تحميل ملخص خامات الورشة لهذا الأمر.').text);
    } finally {
      setWipLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    if (activeTab === 'reconcile') {
      void loadWipSummary();
    }
  }, [activeTab, loadWipSummary]);

  // نموذج إغلاق الأمر
  const [closeForm, setCloseForm] = useState<CloseFormState>({
    discrepancy_signoff: false,
    discrepancy_notes: '',
    under_production_reason: '',
    notes: '',
  });
  const [closeIdempotencyKey, setCloseIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  const handleCloseFormChange = (patch: Partial<CloseFormState>) => {
    setCloseForm((prev) => ({ ...prev, ...patch }));
  };

  const handleCloseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const payload: OrderClosePayload = {
        discrepancy_signoff: closeForm.discrepancy_signoff,
        discrepancy_notes: closeForm.discrepancy_notes,
        under_production_reason: closeForm.under_production_reason,
        notes: closeForm.notes,
      };
      await closeProductionOrderApi(order.id, payload, closeIdempotencyKey);
      setCloseIdempotencyKey(newIdempotencyKey());
      await refreshAfterSuccess('تم إغلاق أمر التشغيل نهائياً وتسوية فروقاته بنجاح.');
    } catch (err: unknown) {
      reportFailure(err, 'تعذر إغلاق أمر التشغيل. تحقق من استيفاء شروط الإغلاق وصلاحياتك ثم أعد المحاولة.');
    } finally {
      setIsProcessing(false);
    }
  };

  const refreshAfterSuccess = async (successText: string) => {
    try {
      const freshOrder = await fetchProductionOrderById(order.id);
      onOrderUpdated(freshOrder);
      setStatusMessage({ type: 'success', text: successText });
      if (activeTab === 'reconcile') {
        void loadWipSummary();
      }
      void loadClaims();
    } catch (refreshErr: unknown) {
      console.error('Failed to refresh order after mutation:', refreshErr);
      setStatusMessage({ type: 'warning', text: `${successText} ${REFRESH_FAILED_TEXT}`, canResync: true });
    }
  };

  const reportFailure = (err: unknown, fallback: string) => {
    const parsed = parseApiError(err, fallback);
    setStatusMessage({ type: 'error', text: parsed.text, canResync: parsed.isNetworkIssue });
  };

  const handleResyncOrder = async () => {
    setIsResyncing(true);
    try {
      const freshOrder = await fetchProductionOrderById(order.id);
      onOrderUpdated(freshOrder);
      setStatusMessage({ type: 'success', text: 'تمت مزامنة بيانات أمر التشغيل من الخادم وتحديث الشاشة.' });
      if (activeTab === 'reconcile') {
        void loadWipSummary();
      }
      void loadClaims();
    } catch (err: unknown) {
      const parsed = parseApiError(err, 'تعذر إعادة مزامنة بيانات الأمر من الخادم حالياً.');
      setStatusMessage({
        type: 'warning',
        text: `${parsed.text} يرجى التحقق من اتصال الشبكة ثم النقر على "إعادة مزامنة بيانات الأمر".`,
        canResync: true,
      });
    } finally {
      setIsResyncing(false);
    }
  };

  // سياق مشترك للأقسام الفرعية
  const ctx: SectionContext = {
    order,
    onOrderUpdated,
    refreshOrder: refreshAfterSuccess,
    reportFailure,
    setStatus: setStatusMessage,
    setBusy: setIsProcessing,
  };

  const orderItems: ProductionOrderItem[] = order.items && order.items.length > 0 ? order.items : [];

  return (
    <div className={`production-order-workspace ${isModalWrapper ? 'production-order-workspace--modal' : ''}`} dir="rtl">
      {/* ─── 1. ترويسة مساحة العمل ────────────────────────────────────── */}
      <header className="order-details-header">
        <div className="order-details-header__main">
          <div className="order-details-header__identity">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={onBack}
                title="العودة إلى أوامر التشغيل"
                style={{ fontWeight: 600, padding: '4px 10px' }}
              >
                ← العودة للقائمة
              </button>
              <span className="order-code-badge">{order.order_number}</span>
              <span className={`status-pill status-pill--${order.status}`}>
                {ORDER_STATUS_LABEL[order.status] || ORDER_STATUS_AR[order.status] || order.status}
              </span>
            </div>
            <h1 className="modal-title" style={{ fontSize: '1.35rem', margin: '6px 0 2px' }}>
              {order.product_name_ar} — كمية: {order.target_quantity} قطعة
            </h1>
            <p className="modal-subtitle" style={{ margin: 0, color: 'var(--text-light, #64748b)', fontSize: '13px' }}>
              الموسم: {seasonAr(order.season)} · تاريخ الإنشاء: {order.created_at ? new Date(order.created_at).toLocaleDateString('ar-EG') : '—'}
              {(order.items && order.items.length > 0
                ? ` · ${order.items.map((it) => `مقاس ${(it.variant_info || '').match(/\d{2,3}/)?.[0] ?? '—'}: ${Number(it.target_quantity)}`).join('، ')}`
                : order.variant_info ? ` · ${order.variant_info}` : '')}
              {order.assigned_to ? ` · خط التشغيل: ${order.assigned_to}` : ''}
            </p>
          </div>

          <div className="order-details-header__actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              onClick={() => void handleResyncOrder()}
              disabled={isProcessing || isResyncing}
              title="تحديث بيانات أمر التشغيل من الخادم"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              {isResyncing ? 'جاري التحديث...' : '🔄 تحديث'}
            </button>
            <button
              className="modal-close"
              onClick={onBack}
              aria-label="إغلاق"
              title="إغلاق والعودة"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '1.25rem', padding: '4px 8px' }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* لافتة تمييز نمط التصنيع في رأس الأمر (Phase 4.5 T1) */}
        <div
          className={`order-mfg-banner ${isCmt ? 'order-mfg-banner--cmt' : 'order-mfg-banner--internal'}`}
          role="note"
          aria-label="نمط التصنيع"
          style={{ marginTop: '10px' }}
        >
          {isCmt ? (
            <span>
              🧵 تشغيل للغير (CMT) — العميل: <strong>{order.customer_name || 'غير محدد'}</strong>
              {' '}· الخامات ملك العميل وتُصرف من أمانته (سقف الهالك {order.allowed_waste_pct ?? '1.5'}%)
            </span>
          ) : (
            <span>🏭 تصنيع داخلي · الخامات والمنتج التام ملك المصنع</span>
          )}
        </div>

        {/* شريط رسائل الحالة وإعادة المزامنة */}
        {statusMessage && (
          <div
            role={statusMessage.type === 'error' ? 'alert' : 'status'}
            className={`modal-alert modal-alert--${
              statusMessage.type === 'success'
                ? 'success'
                : statusMessage.type === 'warning'
                ? 'warning'
                : 'danger'
            }`}
            style={{ marginTop: '10px' }}
          >
            <div className="modal-alert__content" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{statusMessage.text}</span>
              {statusMessage.canResync && (
                <button
                  type="button"
                  className="modal-alert__resync-btn"
                  onClick={() => void handleResyncOrder()}
                  disabled={isResyncing}
                >
                  {isResyncing ? 'جاري المزامنة…' : 'إعادة مزامنة بيانات الأمر'}
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {/* ─── 2. ألسنة التبويب الستة المنظمة حسب دورة المصنع ──────────────── */}
      <nav className="modal-tabs" aria-label="أقسام أمر التشغيل" style={{ marginTop: '12px' }}>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'overview' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          نظرة عامة
        </button>

        <button
          type="button"
          className={`tab-btn ${activeTab === 'materials' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('materials')}
        >
          الخامات ({order.materials.length})
        </button>

        {showStagesTab && (
          <button
            type="button"
            className={`tab-btn ${activeTab === 'execution' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('execution')}
          >
            مراحل التصنيع
          </button>
        )}

        <button
          type="button"
          className={`tab-btn ${activeTab === 'finished' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('finished')}
        >
          استلام المنتج التام {order.status === 'receipt_completed' || order.status === 'closed' ? '✓' : ''}
        </button>

        <button
          type="button"
          className={`tab-btn ${activeTab === 'costing' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('costing')}
        >
          بطاقة التكلفة والربحية {order.cost_calculated_at ? '✓' : ''}
        </button>

        <button
          type="button"
          className={`tab-btn ${activeTab === 'reconcile' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('reconcile')}
        >
          التسوية والإغلاق
        </button>
      </nav>

      {/* ─── 3. محتوى التبويب النشط ───────────────────────────────────── */}
      <main className="order-details-body" style={{ padding: '16px 20px', minHeight: '480px' }}>
        {activeTab === 'overview' && (
          <OrderOverviewSection
            ctx={ctx}
            orderItems={orderItems}
            demands={demands}
            claims={claims}
            wipSummary={wipSummary}
            onGoToPageTab={(targetTab) => {
              if (targetTab === 'materials') setActiveTab('materials');
              else if (targetTab === 'execution') setActiveTab('execution');
              else if (targetTab === 'finished') setActiveTab('finished');
              else if (targetTab === 'costing') setActiveTab('costing');
              else if (targetTab === 'reconcile' || (targetTab as string) === 'closure') setActiveTab('reconcile');
              else setActiveTab('overview');
            }}
            onOpenProcurementModal={() => setIsProcurementModalOpen(true)}
          />
        )}

        {activeTab === 'materials' && (
          <OrderMaterialsSection
            ctx={ctx}
            catalogItems={catalogItems}
            isCatalogLoading={isCatalogLoading}
            catalogError={catalogError}
            claims={claims}
            claimsLoading={claimsLoading}
            claimsError={claimsError}
            onRetryClaims={loadClaims}
            onOpenClaim={(claim) => setOpenClaim(claim)}
          />
        )}

        {activeTab === 'execution' && (
          <OrderExecutionSection ctx={ctx} />
        )}

        {activeTab === 'finished' && (
          <OrderFinishedGoodsSection
            ctx={ctx}
            orderItems={orderItems}
            demands={demands}
          />
        )}

        {activeTab === 'costing' && (
          <OrderCostsSection ctx={ctx} />
        )}

        {activeTab === 'reconcile' && (
          <OrderReconciliationSection
            ctx={ctx}
            wipSummary={wipSummary}
            wipLoading={wipLoading}
            wipError={wipError}
            onRetryWip={loadWipSummary}
            claims={claims}
            claimsLoading={claimsLoading}
            claimsError={claimsError}
            onRetryClaims={loadClaims}
            onOpenClaim={(c) => setOpenClaim(c)}
            returnsVersion={returnsVersion}
            onReturnsChanged={() => setReturnsVersion((v) => v + 1)}
            reloadWip={loadWipSummary}
            closeForm={closeForm}
            onCloseFormChange={handleCloseFormChange}
            onCloseSubmit={handleCloseSubmit}
            busy={isProcessing}
          />
        )}
      </main>

      {/* نافذة تفاصيل مطالبة العجز والحسم (T2) عند فتحها من أي تبويب */}
      {openClaim && (
        <DiscrepancyClaimDetailModal
          claim={openClaim}
          isOpen
          onClose={() => setOpenClaim(null)}
          orderMeta={{ customer_name: order.customer_name, manufacturing_type: order.manufacturing_type }}
          onResolved={(updated) => {
            setClaims((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
            void loadWipSummary();
          }}
        />
      )}

      {/* نافذة تدقيق عجز الخامات وتوليد أوامر الشراء (T5) */}
      <OrderShortageProcurementModal
        isOpen={isProcurementModalOpen}
        onClose={() => setIsProcurementModalOpen(false)}
        orderId={order.id}
        onOrdersGenerated={() => {
          void refreshAfterSuccess('تم توليد أوامر الشراء بنجاح وتحديث بيانات أمر التشغيل.');
        }}
      />
    </div>
  );
};
