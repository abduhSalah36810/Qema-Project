import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import { userLabel } from '@/lib/userLabel';
import { WorkshopReturnsPanel } from './WorkshopReturnsPanel';
import { OrderProgress } from './OrderProgress';
import { nextStep, ORDER_STATUS_LABEL } from './orderWorkflow';
import type { OrderDetailTab } from '@/lib/navigation';
import {
  ProductionOrder,
  ProductionOrderItem,
  dispatchMaterialsApi,
  receiveMaterialsApi,
  updateStageApi,
  addOrderMaterialApi,
  removeOrderMaterialApi,
  rollbackStageApi,
  fetchProductionOrderById,
  CatalogItem,
  ProductionDefect,
  fetchOrderDefects,
  reportOrderDefect,
  updateOrderDefect,
  receiveFinishedGoodsApi,
  fetchOrderWipSummary,
  reconcileOrderMaterialsApi,
  type ReturnCondition,
  closeProductionOrderApi,
  newIdempotencyKey,
  OrderWipSummary,
  OrderClosePayload,
} from './productionApi';

interface OrderDetailModalProps {
  order: ProductionOrder;
  isOpen: boolean;
  onClose: () => void;
  onOrderUpdated: (updatedOrder: ProductionOrder) => void;
  catalogItems?: CatalogItem[];
  isCatalogLoading?: boolean;
  catalogError?: string | null;
  /** فتح الأمر مباشرة على قسم محدد (من صندوق المهام) */
  initialTab?: OrderDetailTab;
}

type DetailTab = OrderDetailTab;

const STAGE_TITLES_AR: Record<string, string> = {
  cutting: 'القص على الباترون',
  finishing: 'التشطيب',
  snap_installation: 'تركيب الكبسولة',
  ironing: 'الكي',
  packing: 'التعبئة والتغليف',
};

const STAGE_SEQUENCE = [
  'cutting',
  'finishing',
  'snap_installation',
  'ironing',
  'packing',
];

const STAGE_STATUS_AR: Record<string, string> = {
  not_started: 'لم تبدأ',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتملة',
};

const ORDER_STATUS_AR: Record<string, string> = {
  draft: 'مسودة جديدة',
  materials_dispatched: 'خامات بالطريق',
  in_production: 'قيد الإنتاج',
  manufacturing_completed: 'اكتمل التصنيع الميداني',
  receipt_completed: 'تم استلام المنتج التام',
  completed: 'مكتملة التجهيز',
  closed: 'مغلق ومسوى نهائياً',
};

const FG_RECEIPT_STATUSES = ['in_production', 'manufacturing_completed'];
const RECONCILIATION_STATUSES = ['in_production', 'manufacturing_completed', 'receipt_completed'];
const ROLLBACK_STATUSES = ['in_production', 'manufacturing_completed'];
const EPSILON = 1e-9;

const REFRESH_FAILED_TEXT =
  'تم تنفيذ العملية على الخادم بنجاح، لكن تعذر تحديث بيانات الأمر في الشاشة. أعد تحميل البيانات للتحقق من الحالة الحالية.';

function parseApiError(err: unknown, defaultMessage: string): { text: string; isNetworkIssue: boolean } {
  if (err instanceof ApiError) {
    if (err.isNetworkError || err.isTimeout) {
      return {
        text: `${err.message || defaultMessage} (تنبيه: تعذر التأكد من وصول الطلب للخادم بسبب انقطاع الاتصال أو انتهاء المهلة. يرجى التحقق من الشبكة أو إعادة مزامنة البيانات قبل إعادة المحاولة).`,
        isNetworkIssue: true,
      };
    }
    return { text: err.message || defaultMessage, isNetworkIssue: false };
  }
  if (err instanceof Error && err.message) {
    return { text: err.message, isNetworkIssue: false };
  }
  return { text: defaultMessage, isNetworkIssue: false };
}

/** سبب تعطيل أزرار المراحل حسب حالة الأمر (الخادم يرفض أي تحديث خارج in_production). */
function stageLockReason(status: string): string | null {
  if (status === 'in_production') return null;
  if (status === 'draft') return 'اصرف الخامات وأكد استلامها أولاً؛ تحديث المراحل متاح بعد استلام الخامات في الورشة.';
  if (status === 'materials_dispatched') return 'أكد استلام الخامات في الورشة أولاً؛ تحديث المراحل متاح بعد تأكيد الاستلام.';
  return `لا يمكن تحديث المراحل وحالة الأمر "${ORDER_STATUS_AR[status] || status}".`;
}

function itemRemaining(item: ProductionOrderItem): number {
  return Math.max(0, round6(item.target_quantity - (item.received_quantity ?? 0)));
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function toNumber(value: string): number {
  if (value.trim() === '') return 0;
  return Number(value);
}

type FgLineInput = { accepted: string; rejected: string };
type ReconInput = { consumed: string; returned: string; scrapped: string; notes: string; condition: ReturnCondition };

const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = { good: 'سليمة', needs_inspection: 'تحتاج فحص', damaged: 'تالفة' };

function initialFgLines(items: ProductionOrderItem[] | undefined): Record<string, FgLineInput> {
  const result: Record<string, FgLineInput> = {};
  (items || []).forEach((item) => {
    result[item.id] = { accepted: String(itemRemaining(item)), rejected: '0' };
  });
  return result;
}

function fmtQty(value: number): string {
  return Number(value || 0).toLocaleString('ar-EG', { maximumFractionDigits: 4 });
}

function cleanVariant(info: string | undefined, season: string | undefined): string {
  return (info || season || '').replace(/summer/g, 'صيفي').replace(/autumn/g, 'خريفي').replace(/winter/g, 'شتوي');
}

/**
 * مستلزمات التصنيع كما حُفظت في الأمر وقت إنشائه (لا تتأثر بتعديل مستلزمات الموديل لاحقاً)،
 * مع إجمالي الأمر مقارنةً بالمخطط والمنصرف والمستلم من سجل خامات الأمر نفسه.
 */
function OrderBomSnapshot({ order, orderItems }: { order: ProductionOrder; orderItems: ProductionOrderItem[] }) {
  const withBom = orderItems.filter((it) => (it.bom_lines ?? []).length > 0);
  const withoutBom = orderItems.filter((it) => (it.bom_lines ?? []).length === 0);

  const totals = new Map<string, { item_id: string; item_name: string; unit_name: string; required: number }>();
  for (const it of withBom) {
    for (const b of it.bom_lines ?? []) {
      const key = `${b.item_id}|${b.unit_name}`;
      const row = totals.get(key) ?? { item_id: b.item_id, item_name: b.item_name, unit_name: b.unit_name, required: 0 };
      row.required += Number(b.total_quantity || 0);
      totals.set(key, row);
    }
  }
  const materialByItem = new Map(order.materials.map((m) => [m.item_id, m]));
  const bomIds = new Set([...totals.values()].map((t) => t.item_id));
  const dispatchStarted = order.status !== 'draft';

  return (
    <section className="order-bom" aria-labelledby="order-bom-title" style={{ marginTop: '24px' }}>
      <h3 id="order-bom-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>مستلزمات التصنيع المحفوظة في الأمر</h3>
      <p className="form-hint">نسخة ثابتة من مستلزمات كل مقاس وقت إنشاء الأمر؛ تعديل مستلزمات الموديل لاحقاً لا يغيّرها.</p>

      {withBom.length === 0 ? (
        <p className="notice notice--warning">
          هذا الأمر أُنشئ بخامات مُدخلة يدوياً أو قبل تفعيل مستلزمات المقاسات، فلا توجد نسخة مستلزمات محفوظة له. الخامات المخططة والمصروفة في تبويب «الخامات».
        </p>
      ) : (
        <>
          {withBom.map((it) => (
            <article key={it.id} className="order-bom__line">
              <header>
                <strong>{it.product_name_ar} — {cleanVariant(it.variant_info, it.season)}</strong>
                <span>
                  <span className="status-badge status-badge--done">{fmtQty(it.target_quantity)} قطعة</span>{' '}
                  {it.bom_version_number ? <span className="status-badge status-badge--action">إصدار المستلزمات {it.bom_version_number}</span> : <span className="status-badge status-badge--muted">رقم الإصدار غير متاح</span>}
                </span>
              </header>
              <div className="payroll-table-wrap">
                <table className="md-table order-bom__table">
                  <thead><tr><th>الصنف</th><th>الوحدة</th><th>الكمية للقطعة</th><th>إجمالي السطر</th></tr></thead>
                  <tbody>
                    {(it.bom_lines ?? []).map((b) => (
                      <tr key={b.item_id}>
                        <td><strong>{b.item_name}</strong></td>
                        <td data-label="الوحدة">{b.unit_name || '—'}</td>
                        <td data-label="الكمية للقطعة">{fmtQty(b.quantity_per_piece)}</td>
                        <td data-label="إجمالي السطر"><strong>{fmtQty(b.total_quantity)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}

          {withoutBom.length > 0 && (
            <p className="form-hint">
              {withoutBom.length} سطر بدون مستلزمات محفوظة (أُنشئ بخامات يدوية): {withoutBom.map((it) => `${it.product_name_ar} ${cleanVariant(it.variant_info, it.season)}`).join('، ')}.
            </p>
          )}

          <h4 style={{ margin: '16px 0 6px', fontWeight: 600 }}>إجمالي احتياجات الأمر (مجمعة حسب الصنف)</h4>
          <div className="payroll-table-wrap">
            <table className="md-table order-bom__table">
              <thead>
                <tr><th>الصنف</th><th>الوحدة</th><th>المطلوب حسب المستلزمات</th><th>المخطط في الأمر</th><th>المنصرف</th><th>المستلم بالورشة</th></tr>
              </thead>
              <tbody>
                {[...totals.values()].sort((a, b) => a.item_name.localeCompare(b.item_name, 'ar')).map((row) => {
                  const m = materialByItem.get(row.item_id);
                  return (
                    <tr key={`${row.item_id}|${row.unit_name}`}>
                      <td><strong>{row.item_name}</strong></td>
                      <td data-label="الوحدة">{row.unit_name || '—'}</td>
                      <td data-label="المطلوب حسب المستلزمات"><strong>{fmtQty(row.required)}</strong></td>
                      <td data-label="المخطط في الأمر">{m ? fmtQty(m.planned_quantity) : <small className="form-hint">غير مسجل في خامات الأمر</small>}</td>
                      <td data-label="المنصرف">{!m ? '—' : dispatchStarted ? fmtQty(m.dispatched_quantity) : <small className="form-hint">لم يُصرف بعد</small>}</td>
                      <td data-label="المستلم بالورشة">{!m ? '—' : ['draft', 'materials_dispatched'].includes(order.status) ? <small className="form-hint">لم يُستلم بعد</small> : fmtQty(m.received_quantity)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {order.materials.some((m) => !bomIds.has(m.item_id)) && (
            <p className="form-hint">توجد خامات أُضيفت يدوياً على الأمر خارج المستلزمات؛ تظهر بعلامة «يدوي» في تبويب «الخامات».</p>
          )}
        </>
      )}
    </section>
  );
}

export const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  order,
  isOpen,
  onClose,
  onOrderUpdated,
  catalogItems = [],
  isCatalogLoading = false,
  catalogError = null,
  initialTab,
}) => {
  const { hasPermission, user } = useAuth();
  const canDispatch = hasPermission('warehouse:dispatch');
  // فصل الصارف عن المستلم: من صرف الخامات لا يرى زر تأكيد استلامها (الخادم يرفضه أيضاً)
  const dispatchedByMe = Boolean(user?.id && order.pending_transfer_dispatched_by === user.id);
  const canReceiveWip = hasPermission('production:wip:receive') && !dispatchedByMe;
  const canReceiveFinishedGoods = hasPermission('warehouse:finished_goods:receive');
  const canReconcile = hasPermission('production:orders:manage');
  const canManageMaterials = hasPermission('production:orders:manage');
  const canManageStages = hasPermission('production:stages:manage');
  const canReportDefects = hasPermission('production:orders:manage');
  const canCloseOrder = hasPermission('production:orders:close');
  const canReceiveReturns = hasPermission('warehouse:returns:receive');
  const canResolveReturns = hasPermission('production:returns:resolve');

  // التبويبات حسب دور المستخدم: أمين المخزن لا يُشغل بالمراحل والعيوب، والإنتاج لا يرى ما لا يخصه
  const showStagesTab = canManageStages || hasPermission('production:orders:close');
  const showDefectsTab = canReportDefects;
  const roleDefaultTab = (): DetailTab => {
    const next = nextStep(order, hasPermission, user?.id);
    if (next?.isMine) return next.tab;
    return 'materials';
  };
  const [activeTab, setActiveTab] = useState<DetailTab>(() => initialTab ?? roleDefaultTab());
  const [defects, setDefects] = useState<ProductionDefect[]>([]);
  const [defectForm, setDefectForm] = useState({ stage_name: 'cutting', description: '', affected_quantity: '', responsible: '', repair_action: '', repair_cost_description: '' });
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isResyncing, setIsResyncing] = useState<boolean>(false);
  const [hasPendingRefresh, setHasPendingRefresh] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error' | 'warning';
    text: string;
    canResync?: boolean;
  } | null>(null);
  const [newItemId, setNewItemId] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('');
  const [newItemNotes, setNewItemNotes] = useState('');
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [stageNotes, setStageNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.notes || '']))
  );
  const [rollbackReasons, setRollbackReasons] = useState<Record<string, string>>({});

  // نموذج استلام المنتج التام لكل بند
  const [fgLines, setFgLines] = useState<Record<string, FgLineInput>>(() => initialFgLines(order.items));
  const [fgNotes, setFgNotes] = useState('');
  const [fgIdempotencyKey, setFgIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  // نموذج تأكيد استلام الخامات في الورشة (القيمة الافتراضية = المنصرف)
  const [receiptInputs, setReceiptInputs] = useState<Record<string, { qty: string; notes: string }>>(() => {
    const init: Record<string, { qty: string; notes: string }> = {};
    order.materials.forEach((m) => {
      init[m.item_id] = { qty: String(m.dispatched_quantity), notes: '' };
    });
    return init;
  });
  const [receiptIdempotencyKey, setReceiptIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  // ملخص الورشة والتسوية والإغلاق
  const [wipSummary, setWipSummary] = useState<OrderWipSummary | null>(null);
  const [wipLoading, setWipLoading] = useState(false);
  const [wipError, setWipError] = useState<string | null>(null);
  const [reconInputs, setReconInputs] = useState<Record<string, ReconInput>>({});
  const [reconNotes, setReconNotes] = useState('');
  const [returnsVersion, setReturnsVersion] = useState(0);
  const [reconIdempotencyKey, setReconIdempotencyKey] = useState<string>(() => newIdempotencyKey());
  const [closeForm, setCloseForm] = useState({ discrepancy_signoff: false, discrepancy_notes: '', under_production_reason: '', notes: '' });
  const [closeIdempotencyKey, setCloseIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  // مزامنة الملاحظات ومدخلات الاستلام عند تحديث أمر التشغيل
  useEffect(() => {
    setStageNotes(Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.notes || ''])));
    setReceiptInputs((prev) => {
      const updated: Record<string, { qty: string; notes: string }> = {};
      order.materials.forEach((m) => {
        const previous = prev[m.item_id];
        // بعد الصرف مباشرة تكون القيمة المحفوظة صفراً من حالة المسودة؛ نعيدها إلى الكمية المنصرفة
        const stale = !previous || (Number(previous.qty || 0) === 0 && m.dispatched_quantity > 0);
        updated[m.item_id] = stale ? { qty: String(m.dispatched_quantity), notes: previous?.notes || '' } : previous;
      });
      return updated;
    });
  }, [order.id, order.stage_events, order.materials]);

  useEffect(() => {
    setFgLines(initialFgLines(order.items));
  }, [order.id, order.items]);

  const loadWipSummary = useCallback(async () => {
    setWipLoading(true);
    setWipError(null);
    try {
      const summary = await fetchOrderWipSummary(order.id);
      setWipSummary(summary);
      setReconInputs(() => {
        const next: Record<string, ReconInput> = {};
        summary.materials.forEach((m) => {
          next[m.item_id] = { consumed: '', returned: '', scrapped: '', notes: '', condition: 'good' };
        });
        return next;
      });
    } catch (err: unknown) {
      setWipError(parseApiError(err, 'تعذر تحميل ملخص خامات الورشة لهذا الأمر.').text);
    } finally {
      setWipLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    if (isOpen && activeTab === 'wip') {
      void loadWipSummary();
    }
  }, [isOpen, activeTab, order.status, loadWipSummary]);

  if (!isOpen) return null;

  /** بعد نجاح العملية خادمياً: تحديث الأمر من الخادم، وإبلاغ المستخدم بنجاح حقيقي أو بتعذر التحديث. */
  const refreshAfterSuccess = async (successText: string) => {
    try {
      const freshOrder = await fetchProductionOrderById(order.id);
      onOrderUpdated(freshOrder);
      setHasPendingRefresh(false);
      setStatusMessage({ type: 'success', text: successText });
    } catch (refreshErr: unknown) {
      console.error('Failed to refresh order after mutation:', refreshErr);
      setHasPendingRefresh(true);
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
      setHasPendingRefresh(false);
      setStatusMessage({ type: 'success', text: 'تمت مزامنة بيانات أمر التشغيل من الخادم وتحديث الشاشة.' });
      if (activeTab === 'wip') void loadWipSummary();
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

  const loadDefects = async () => {
    try { setDefects(await fetchOrderDefects(order.id)); }
    catch (err: unknown) { setStatusMessage({ type: 'error', text: parseApiError(err, 'تعذر تحميل سجل العيوب.').text }); }
  };

  const handleReportDefect = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsProcessing(true);
    try {
      const created = await reportOrderDefect(order.id, { ...defectForm, affected_quantity: Number(defectForm.affected_quantity) });
      setDefects((items) => [created, ...items]);
      setDefectForm({ stage_name: 'cutting', description: '', affected_quantity: '', responsible: '', repair_action: '', repair_cost_description: '' });
      setStatusMessage({ type: 'success', text: 'تم تسجيل العيب.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذر تسجيل العيب؛ تحقق من الحقول والصلاحية.');
    } finally { setIsProcessing(false); }
  };

  const handleAddMaterial = async (event: React.FormEvent) => {
    event.preventDefault();
    const item = catalogItems.find((candidate) => candidate.id === newItemId);
    const quantity = Number(newItemQuantity);
    if (!item || !Number.isFinite(quantity) || quantity <= 0) {
      setStatusMessage({ type: 'error', text: 'اختر صنفاً وأدخل كمية أكبر من صفر.' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const line = await addOrderMaterialApi(order.id, {
        item_id: item.id,
        unit_id: item.unit_id,
        planned_quantity: quantity,
        notes: newItemNotes,
      });
      onOrderUpdated({ ...order, materials: [...order.materials, line] });
      setNewItemId('');
      setNewItemQuantity('');
      setNewItemNotes('');
      setStatusMessage({ type: 'success', text: 'تمت إضافة الصنف إلى مسودة أمر التشغيل.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذرت إضافة الصنف. تحقق من الاتصال وحالة الأمر ثم أعد المحاولة.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRemoveMaterial = async (materialId: string) => {
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await removeOrderMaterialApi(order.id, materialId);
      onOrderUpdated({ ...order, materials: order.materials.filter((line) => line.id !== materialId) });
      setPendingRemoveId(null);
      setStatusMessage({ type: 'success', text: 'تم حذف الصنف من المسودة.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذر حذف الصنف. تحقق من اتصال الخادم وحالة الأمر.');
    } finally {
      setIsProcessing(false);
    }
  };

  // 1. صرف الخامات من المخزن الرئيسي
  const handleDispatch = async () => {
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await dispatchMaterialsApi(order.id, 'صرف خامات تشغيل الدفعة');
    } catch (err: unknown) {
      reportFailure(err, 'تعذر صرف الخامات من المخزن الرئيسي. تحقق من رصيد الخامات وصلاحياتك والاتصال بالخادم.');
      setIsProcessing(false);
      return;
    }
    await refreshAfterSuccess('تم تسجيل صرف الخامات كـ "بالطريق" وتحديث حالة أمر التشغيل.');
    setIsProcessing(false);
  };

  // التحقق من كميات استلام الخامات: بين صفر والمنصرف (مطابق لقواعد الخادم)
  const receiptLineError = (itemId: string, dispatched: number): string | null => {
    const raw = receiptInputs[itemId]?.qty ?? String(dispatched);
    if (raw.trim() === '') return 'أدخل الكمية المستلمة';
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) return 'الكمية لا تقل عن صفر';
    if (qty > dispatched + EPSILON) return `لا تتجاوز المنصرف (${dispatched})`;
    return null;
  };
  const receiptHasErrors = order.materials.some((m) => receiptLineError(m.item_id, m.dispatched_quantity) !== null);

  // 2. تأكيد استلام الخامات في مخزن تحت التشغيل
  const handleConfirmReceipt = async () => {
    if (receiptHasErrors) {
      setStatusMessage({ type: 'error', text: 'راجع كميات الاستلام: يجب أن تكون كل كمية بين صفر والكمية المنصرفة.' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    const payload = {
      received_lines: order.materials.map((m) => ({
        item_id: m.item_id,
        received_quantity: Number(receiptInputs[m.item_id]?.qty ?? m.dispatched_quantity),
        notes: receiptInputs[m.item_id]?.notes || '',
      })),
      notes: 'تأكيد استلام أمين المخزن',
    };
    try {
      await receiveMaterialsApi(order.id, payload, receiptIdempotencyKey);
    } catch (err: unknown) {
      reportFailure(err, 'تعذر تأكيد استلام الخامات بمخزن تحت التشغيل. تحقق من اتصال الخادم وصلاحياتك وحالة أمر التشغيل.');
      setIsProcessing(false);
      return;
    }
    setReceiptIdempotencyKey(newIdempotencyKey());
    await refreshAfterSuccess('تم تأكيد الاستلام بمخزن تحت التشغيل وتوثيق الفروقات.');
    setIsProcessing(false);
  };

  // 3. تحديث مرحلة إنتاج تتابعياً
  const handleUpdateStage = async (stageName: string, nextStatus: 'in_progress' | 'completed') => {
    const lockReason = stageLockReason(order.status);
    if (lockReason) {
      setStatusMessage({ type: 'error', text: lockReason });
      return;
    }
    const stageIndex = STAGE_SEQUENCE.indexOf(stageName);
    if (stageIndex > 0) {
      const prevStage = STAGE_SEQUENCE[stageIndex - 1];
      const prevEvent = order.stage_events.find((s) => s.stage_name === prevStage);
      if (!prevEvent || prevEvent.status !== 'completed') {
        setStatusMessage({
          type: 'error',
          text: `لا يمكن نقل مرحلة (${STAGE_TITLES_AR[stageName]}) إلا بعد اكتمال مرحلة (${STAGE_TITLES_AR[prevStage]}).`,
        });
        return;
      }
    }
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await updateStageApi(order.id, stageName, nextStatus, stageNotes[stageName] || '');
    } catch (err: unknown) {
      reportFailure(err, `تعذر تحديث مرحلة (${STAGE_TITLES_AR[stageName]}). تحقق من التتابع وصلاحياتك والاتصال بالخادم.`);
      setIsProcessing(false);
      return;
    }
    await refreshAfterSuccess(`تم تحديث مرحلة (${STAGE_TITLES_AR[stageName]}) إلى: ${nextStatus === 'completed' ? 'مكتملة' : 'قيد التنفيذ'}.`);
    setIsProcessing(false);
  };

  const handleRollbackStage = async (stageName: string) => {
    const reason = (rollbackReasons[stageName] || '').trim();
    if (reason.length < 3) {
      setStatusMessage({ type: 'error', text: 'اكتب سبب التراجع (٣ أحرف على الأقل).' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const rollbackResult = await rollbackStageApi(order.id, stageName, reason);
      onOrderUpdated(rollbackResult);
      setHasPendingRefresh(false);
      setRollbackReasons((previous) => ({ ...previous, [stageName]: '' }));
      setStatusMessage({ type: 'success', text: 'أُعيد فتح المرحلة، وسُجل التراجع في سجل المراحل.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذر التراجع عن المرحلة. قد تكون مرحلة لاحقة قد بدأت؛ حدّث الأمر وحاول مجدداً.');
    } finally {
      setIsProcessing(false);
    }
  };

  // 4. استلام المنتج التام لكل بند
  const orderItems = order.items || [];
  // الخامات المصدرها مستلزمات التصنيع المحفوظة في الأمر (الباقي أُضيف يدوياً)
  const bomItemIds = new Set(orderItems.flatMap((it) => (it.bom_lines ?? []).map((b) => b.item_id)));
  const hasBomSnapshot = bomItemIds.size > 0;
  const fgLineError = (item: ProductionOrderItem): string | null => {
    const input = fgLines[item.id] || { accepted: '0', rejected: '0' };
    const accepted = toNumber(input.accepted);
    const rejected = toNumber(input.rejected);
    if (!Number.isFinite(accepted) || accepted < 0) return 'السليم لا يقل عن صفر';
    if (!Number.isFinite(rejected) || rejected < 0) return 'المرفوض لا يقل عن صفر';
    const remaining = itemRemaining(item);
    if (accepted > remaining + EPSILON) return `السليم يتجاوز المتبقي (${remaining})`;
    return null;
  };
  const fgPayloadLines = orderItems
    .map((item) => {
      const input = fgLines[item.id] || { accepted: '0', rejected: '0' };
      return { order_item_id: item.id, accepted_quantity: toNumber(input.accepted), rejected_quantity: toNumber(input.rejected) };
    })
    .filter((line) => line.accepted_quantity > 0 || line.rejected_quantity > 0);
  const fgHasErrors = orderItems.some((item) => fgLineError(item) !== null);
  const canSubmitFg = FG_RECEIPT_STATUSES.includes(order.status) && orderItems.length > 0;

  const handleReceiveFinishedGoods = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fgHasErrors) {
      setStatusMessage({ type: 'error', text: 'راجع كميات الاستلام: لا تقبل قيم سالبة، ولا يتجاوز السليم المتبقي لكل بند.' });
      return;
    }
    if (fgPayloadLines.length === 0) {
      setStatusMessage({ type: 'error', text: 'أدخل كمية سليمة أو مرفوضة لبند واحد على الأقل.' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    let acceptedTotal = 0;
    let receiptStatus = '';
    try {
      const res = await receiveFinishedGoodsApi(order.id, { lines: fgPayloadLines, notes: fgNotes }, fgIdempotencyKey);
      acceptedTotal = res.accepted_quantity;
      receiptStatus = res.receipt_status;
    } catch (err: unknown) {
      reportFailure(err, 'تعذر استلام المنتج التام. تحقق من الكميات وحالة الأمر وصلاحياتك.');
      setIsProcessing(false);
      return;
    }
    setFgIdempotencyKey(newIdempotencyKey());
    setFgNotes('');
    await refreshAfterSuccess(
      `تم استلام ${acceptedTotal} قطعة سليمة بمخزن المنتج التام (حالة الاستلام: ${receiptStatus === 'complete' ? 'مكتمل' : 'جزئي'}).`
    );
    setIsProcessing(false);
  };

  // 5. تسوية خامات الورشة
  const reconLine = (itemId: string): ReconInput =>
    reconInputs[itemId] || { consumed: '', returned: '', scrapped: '', notes: '', condition: 'good' };
  const reconSums = (itemId: string) => {
    const input = reconLine(itemId);
    return {
      consumed: toNumber(input.consumed),
      returned: toNumber(input.returned),
      scrapped: toNumber(input.scrapped),
    };
  };
  const reconLineError = (itemId: string, balance: number): string | null => {
    const { consumed, returned, scrapped } = reconSums(itemId);
    if ([consumed, returned, scrapped].some((v) => !Number.isFinite(v) || v < 0)) return 'لا تقبل قيم سالبة';
    if (consumed + returned + scrapped > balance + EPSILON) return `المجموع يتجاوز رصيد الورشة (${balance})`;
    const line = reconLine(itemId);
    if (returned > EPSILON && line.condition !== 'good' && !line.notes.trim()) return 'اكتب ملاحظة عن حالة المرتجع';
    return null;
  };
  const reconMaterials = wipSummary?.materials || [];
  const reconHasErrors = reconMaterials.some((m) => reconLineError(m.item_id, m.current_wip_balance) !== null);
  const reconPayloadLines = reconMaterials
    .map((m) => {
      const sums = reconSums(m.item_id);
      return {
        item_id: m.item_id,
        consumed_quantity: sums.consumed,
        returned_quantity: sums.returned,
        scrapped_quantity: sums.scrapped,
        return_condition: reconLine(m.item_id).condition,
        notes: reconLine(m.item_id).notes,
      };
    })
    .filter((line) => line.consumed_quantity + line.returned_quantity + line.scrapped_quantity > 0);
  const canSubmitRecon = RECONCILIATION_STATUSES.includes(order.status);

  const handleReconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reconHasErrors) {
      setStatusMessage({ type: 'error', text: 'مجموع المستهلك والمرتجع والتالف لكل خامة يجب ألا يتجاوز رصيدها الحالي بالورشة.' });
      return;
    }
    if (reconPayloadLines.length === 0) {
      setStatusMessage({ type: 'error', text: 'أدخل كمية مستهلكة أو مرتجعة أو تالفة لخامة واحدة على الأقل.' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    let reconNumber = '';
    let returnNumber = '';
    try {
      const res = await reconcileOrderMaterialsApi(order.id, { lines: reconPayloadLines, notes: reconNotes }, reconIdempotencyKey);
      reconNumber = res.reconciliation_number;
      returnNumber = res.return_transfer_number || '';
    } catch (err: unknown) {
      reportFailure(err, 'تعذر تسجيل تسوية خامات الورشة.');
      setIsProcessing(false);
      return;
    }
    setReconIdempotencyKey(newIdempotencyKey());
    setReconNotes('');
    await loadWipSummary();
    setReturnsVersion((v) => v + 1);
    await refreshAfterSuccess(
      returnNumber
        ? `تم تسجيل تسوية خامات الورشة (${reconNumber}). المرتجع بالطريق برقم ${returnNumber} وينتظر فحص واستلام أمين المخزن قبل أن يدخل رصيد الخامات.`
        : `تم تسجيل تسوية خامات الورشة (${reconNumber}).`
    );
    setIsProcessing(false);
  };

  // 6. إغلاق أمر التشغيل
  const hasDiscrepancies = (wipSummary?.unresolved_discrepancies_count ?? 0) > 0;
  const isUnderProduced = wipSummary ? wipSummary.total_received_goods + EPSILON < wipSummary.target_quantity : false;
  const hardCloseBlockers: string[] = [];
  if (wipSummary) {
    if (!wipSummary.stages_completed) hardCloseBlockers.push('أكمل مراحل التشغيل الخمس أولاً.');
    if (wipSummary.pending_transfers_count > 0) hardCloseBlockers.push('يوجد تحويل خامات بالطريق (صرف أو مرتجع ورشة) لم يؤكد استلامه بعد.');
    if ((wipSummary.returns_pending_resolution_count ?? 0) > 0) {
      hardCloseBlockers.push('في مرتجعات الورشة عجز أو كميات مرفوضة تنتظر قرار التسوية (قسم المرتجعات أعلاه).');
    }
    if (Math.abs(wipSummary.net_wip_balance) > EPSILON) hardCloseBlockers.push('سوِّ رصيد خامات الورشة حتى يصبح صفراً (من نموذج التسوية أعلاه).');
  }

  const handleCloseOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasDiscrepancies && !closeForm.discrepancy_signoff) {
      setStatusMessage({ type: 'error', text: 'يوجد فروقات استلام بالورشة؛ فعّل إقرار اعتماد الفروقات قبل الإغلاق.' });
      return;
    }
    if (isUnderProduced && closeForm.under_production_reason.trim().length === 0) {
      setStatusMessage({ type: 'error', text: 'الكمية المستلمة أقل من المستهدفة؛ اكتب سبب العجز الإنتاجي قبل الإغلاق.' });
      return;
    }
    const payload: OrderClosePayload = { notes: closeForm.notes };
    if (hasDiscrepancies) {
      payload.discrepancy_signoff = closeForm.discrepancy_signoff;
      payload.discrepancy_notes = closeForm.discrepancy_notes;
    }
    if (isUnderProduced) {
      payload.under_production_reason = closeForm.under_production_reason.trim();
    }
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await closeProductionOrderApi(order.id, payload, closeIdempotencyKey);
    } catch (err: unknown) {
      reportFailure(err, 'تعذر إغلاق أمر التشغيل.');
      setIsProcessing(false);
      return;
    }
    setCloseIdempotencyKey(newIdempotencyKey());
    await refreshAfterSuccess('تم إغلاق أمر التشغيل نهائياً.');
    setIsProcessing(false);
  };

  const stageLock = stageLockReason(order.status);
  const rollbackAllowedByStatus = ROLLBACK_STATUSES.includes(order.status);
  const busy = isProcessing || hasPendingRefresh;

  // الإغلاق بزر Esc كبقية الحوارات (لا يغلق أثناء تنفيذ عملية)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isProcessing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isProcessing, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-card modal-card--xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="modal-header">
          <div>
            <div className="modal-badge-row">
              <span className="order-code-badge">{order.order_number}</span>
              <span className={`status-pill status-pill--${order.status}`}>
                {ORDER_STATUS_LABEL[order.status] || ORDER_STATUS_AR[order.status] || order.status}
              </span>
            </div>
            <h2 className="modal-title">
              {order.product_name_ar} — كمية: {order.target_quantity} قطعة
            </h2>
            <p className="modal-subtitle">
              {(order.items && order.items.length > 0
                ? order.items.map((it) => `مقاس ${(it.variant_info || '').match(/\d{2,3}/)?.[0] ?? '—'}: ${Number(it.target_quantity)}`).join('، ')
                : order.variant_info)}
              {order.assigned_to ? ` · المسؤول: ${order.assigned_to}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
            <button className="modal-close" onClick={onClose} aria-label="إغلاق">
              ✕
            </button>
          </div>
        </div>

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
          >
            <div className="modal-alert__content">
              <span>{statusMessage.text}</span>
              {(hasPendingRefresh || statusMessage.canResync) && (
                <button
                  type="button"
                  className="modal-alert__resync-btn"
                  onClick={() => void handleResyncOrder()}
                  disabled={isResyncing}
                >
                  {isResyncing ? 'جاري المزامنة...' : '🔄 إعادة مزامنة بيانات الأمر'}
                </button>
              )}
            </div>
          </div>
        )}

        <OrderProgress
          order={order}
          hasPermission={hasPermission}
          userId={user?.id}
          onGoToStep={(tab) => {
            setActiveTab(tab);
            if (tab === 'defects') void loadDefects();
          }}
        />

        {/* ألسنة التبويب */}
        <div className="modal-tabs" role="tablist" aria-label="أقسام أمر التشغيل">
          {orderItems.length > 0 && (
            <button
              className={`tab-btn ${activeTab === 'items' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveTab('items')}
            >
              الموديلات والمقاسات ({orderItems.length})
            </button>
          )}
          <button
            className={`tab-btn ${activeTab === 'materials' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('materials')}
          >
            الخامات: الصرف والاستلام ({order.materials.length})
          </button>
          {showStagesTab && (
            <button
              className={`tab-btn ${activeTab === 'stages' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveTab('stages')}
            >
              مراحل التصنيع
            </button>
          )}
          {showDefectsTab && (
            <button className={`tab-btn ${activeTab === 'defects' ? 'tab-btn--active' : ''}`} onClick={() => { setActiveTab('defects'); void loadDefects(); }}>
              العيوب والهالك
            </button>
          )}
          <button
            className={`tab-btn ${activeTab === 'fg_receipt' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('fg_receipt')}
          >
            استلام المنتج التام {order.status === 'receipt_completed' || order.status === 'closed' ? '✓' : ''}
          </button>
          <button
            className={`tab-btn ${activeTab === 'wip' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('wip')}
          >
            التسوية والمرتجعات والإغلاق
          </button>
        </div>

        <div className="modal-body">
          {/* تبويب بنود وموديلات أمر التشغيل */}
          {activeTab === 'items' && orderItems.length > 0 && (
            <div className="tab-pane">
              <div style={{ marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>أصناف وموديلات أمر التشغيل ({orderItems.length})</h3>
                <p style={{ color: '#64748b', fontSize: '0.875rem' }}>الموديلات والمقاسات ومواصفات الأقمشة المعتمدة لهذه الدفعة.</p>
              </div>
              <table className="preview-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>الموديل</th>
                    <th>المقاس</th>
                    <th>الكمية المستهدفة</th>
                    <th>المستلم سليم</th>
                    <th>نوع التصنيع</th>
                    <th>مواصفات القماش</th>
                    <th>ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {orderItems.map((it, idx) => (
                    <tr key={it.id || idx}>
                      <td>{idx + 1}</td>
                      <td><strong>{it.product_name_ar}</strong></td>
                      <td><small>{(it.variant_info || it.season || '').replace(/summer/g, 'صيفي').replace(/autumn/g, 'خريفي').replace(/winter/g, 'شتوي')}</small></td>
                      <td><strong style={{ color: 'var(--teal-accent, #0d9488)' }}>{it.target_quantity} قطعة</strong></td>
                      <td>{it.received_quantity ?? 0}</td>
                      <td>
                        {it.product_type === 'factory_brand' ? (
                          <span className="badge-tag">براند المصنع</span>
                        ) : (
                          <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e' }}>
                            تصنيع: {it.customer_name || 'عميل خارجي'}
                          </span>
                        )}
                      </td>
                      <td>
                        <small>{it.fabric_name} · {it.fabric_color} · {it.fabric_weight} · {it.fabric_area}</small>
                      </td>
                      <td><small>{it.notes || '—'}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <OrderBomSnapshot order={order} orderItems={orderItems} />
            </div>
          )}

          {/* تبويب الخامات والمخازن */}
          {activeTab === 'materials' && (
            <div className="tab-pane">
              <div className="warehouse-action-bar">
                {order.status === 'draft' && (
                  <div className="action-box">
                    <div>
                      <strong>الخطوة ١: صرف الخامات من مخزن الخامات الرئيسي</strong>
                      <p>تسجيل الخامات كـ "بالطريق" تمهيداً لتسليمها لخط الإنتاج.</p>
                    </div>
                    {canDispatch ? (
                      <button
                        className="btn btn--primary"
                        onClick={() => void handleDispatch()}
                        disabled={busy}
                      >
                        {isProcessing ? 'جاري الصرف...' : 'صرف الخامات (بالطريق) ←'}
                      </button>
                    ) : (
                      <span className="badge-tag" style={{ background: '#f1f5f9', color: '#475569', padding: '0.4rem 0.8rem' }}>
                        صرف الخامات من مهام أمين المخزن؛ الأمر بانتظاره.
                      </span>
                    )}
                  </div>
                )}

                {order.status === 'materials_dispatched' && (
                  <div className="action-box action-box--highlight">
                    <div>
                      <strong>الخطوة ٢: تأكيد استلام الخامات في الورشة</strong>
                      <p>
                        سجّل الكمية المستلمة فعلياً لكل خامة (من صفر حتى الكمية المنصرفة)، وتوثَّق الفروقات دون مسح السجل.
                      </p>
                    </div>
                    {canReceiveWip ? (
                      <button
                        className="btn btn--teal"
                        onClick={() => void handleConfirmReceipt()}
                        disabled={busy || receiptHasErrors}
                      >
                        {isProcessing ? 'جاري التوثيق...' : '✓ تأكيد استلام الخامات وتسجيل الفروقات'}
                      </button>
                    ) : (
                      <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e', padding: '0.4rem 0.8rem' }}>
                        {dispatchedByMe
                          ? 'أنت من صرف هذه الخامات؛ بانتظار تأكيد استلامها في الورشة من مسؤول الإنتاج أو مستخدم آخر مخوّل.'
                          : 'تأكيد استلام الخامات بالورشة من مسؤولية مسؤول الإنتاج، ولا يؤكده من صرف الخامات بنفسه.'}
                      </span>
                    )}
                  </div>
                )}

                {['in_production', 'manufacturing_completed', 'receipt_completed', 'completed', 'closed'].includes(order.status) && (
                  <div className="action-box action-box--success">
                    <div>
                      <strong>✓ الخامات مستلمة في مخزن تحت التشغيل</strong>
                      <p>تم إغلاق دورة الصرف والاستلام. سجّل مصير الخامات من تبويب "تسوية خامات الورشة والإغلاق".</p>
                    </div>
                  </div>
                )}
              </div>

              {order.status === 'draft' && canManageMaterials && (
                <form className="order-material-add" onSubmit={(event) => void handleAddMaterial(event)}>
                  <div className="order-material-add__intro">
                    <strong>إضافة خامة إلى المسودة</strong>
                    <span>يمكن تعديل قائمة الخامات قبل تسجيل الصرف.</span>
                  </div>
                  <label>
                    <span>الصنف</span>
                    <select value={newItemId} onChange={(event) => setNewItemId(event.target.value)} required>
                      <option value="">{isCatalogLoading ? 'جاري تحميل الأصناف…' : 'اختر صنفاً من دليل الأصناف المسجل'}</option>
                      {catalogItems.filter((item) => item.is_active && item.item_type !== 'finished_garment' && (!item.approval_status || item.approval_status === 'approved') && !order.materials.some((line) => line.item_id === item.id)).map((item) => (
                        <option key={item.id} value={item.id}>{item.name_ar} · {item.code}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>الكمية المطلوبة</span>
                    <input type="number" min="0.01" step="0.01" value={newItemQuantity} onChange={(event) => setNewItemQuantity(event.target.value)} required />
                  </label>
                  <label>
                    <span>ملاحظة (اختياري)</span>
                    <input value={newItemNotes} onChange={(event) => setNewItemNotes(event.target.value)} placeholder="تفاصيل الصنف أو الاستخدام" />
                  </label>
                  <button className="btn btn--primary" type="submit" disabled={busy || isCatalogLoading || catalogItems.length === 0}>
                    {isProcessing ? 'جاري الإضافة…' : '＋ إضافة الصنف'}
                  </button>
                  {catalogError && <p className="form-hint" role="alert">{catalogError}</p>}
                  {!catalogError && !isCatalogLoading && catalogItems.length === 0 && <p className="form-hint">لا توجد أصناف مسجلة في قاعدة البيانات؛ أضف الصنف أولاً من شاشة الأصناف والمخازن.</p>}
                </form>
              )}
              {order.status !== 'draft' && <p className="provisional-hint">تم إيقاف تعديل الخامات بعد بدء الصرف للحفاظ على سجل الحركة. لإضافة خامة، يلزم إجراء معتمد لتعديل الأمر بعد الصرف.</p>}
              <table className="order-detail-table">
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>الكود</th>
                    <th>الوحدة</th>
                    <th>الكمية المخططة (لقطة)</th>
                    <th>المنصرف</th>
                    <th>المستلم فعلياً</th>
                    <th>الفارق</th>
                    <th>الحالة</th>
                    {hasBomSnapshot && <th>المصدر</th>}
                    <th>ملاحظات الفروقات</th>
                    {order.status === 'draft' && canManageMaterials && <th>إجراء</th>}
                  </tr>
                </thead>
                <tbody>
                  {order.materials.length === 0 ? (
                    <tr><td colSpan={(order.status === 'draft' && canManageMaterials ? 10 : 9) + (hasBomSnapshot ? 1 : 0)} className="empty-materials">لا توجد خامات مسجلة لهذا الأمر بعد. أضف الخامات قبل الصرف.</td></tr>
                  ) : order.materials.map((m) => {
                    const isReceiving = order.status === 'materials_dispatched';
                    const rawQty = receiptInputs[m.item_id]?.qty ?? String(m.dispatched_quantity);
                    const lineError = isReceiving ? receiptLineError(m.item_id, m.dispatched_quantity) : null;
                    const currentRec = Number(rawQty);
                    const diff = isReceiving
                      ? (Number.isFinite(currentRec) ? round6(currentRec - m.dispatched_quantity) : 0)
                      : m.discrepancy_quantity;

                    return (
                      <tr key={m.id}>
                        <td><strong>{m.item_name_ar}</strong></td>
                        <td><code>{m.item_code}</code></td>
                        <td>{m.unit_name_ar}</td>
                        <td className="qty-col">{m.planned_quantity}</td>
                        <td className="qty-col">{m.dispatched_quantity}</td>
                        <td className="qty-col">
                          {isReceiving ? (
                            <>
                              <input
                                type="number"
                                step="any"
                                min={0}
                                max={m.dispatched_quantity}
                                className="table-input"
                                aria-label={`الكمية المستلمة ${m.item_name_ar}`}
                                aria-invalid={lineError ? true : undefined}
                                value={rawQty}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setReceiptInputs((prev) => ({
                                    ...prev,
                                    [m.item_id]: { qty: val, notes: prev[m.item_id]?.notes || '' },
                                  }));
                                }}
                              />
                              {lineError && <small role="alert" style={{ display: 'block', color: '#b91c1c' }}>{lineError}</small>}
                            </>
                          ) : (
                            m.received_quantity
                          )}
                        </td>
                        <td className={`diff-col ${diff < 0 ? 'diff--neg' : diff > 0 ? 'diff--pos' : ''}`}>
                          {diff !== 0 ? `${diff > 0 ? '+' : ''}${diff}` : 'مطابق (٠)'}
                        </td>
                        <td>
                          <span className={`mat-status-tag mat-status--${m.status}`}>
                            {m.status === 'pending' && 'معلق'}
                            {m.status === 'dispatched' && 'بالطريق'}
                            {m.status === 'received_complete' && 'مستلم كامل'}
                            {m.status === 'received_with_discrepancy' && 'استلام بفارق'}
                          </span>
                        </td>
                        {hasBomSnapshot && (
                          <td>
                            {bomItemIds.has(m.item_id)
                              ? <span className="status-badge status-badge--done order-bom__source" title="من مستلزمات التصنيع المحفوظة في الأمر">مستلزمات</span>
                              : <span className="status-badge status-badge--waiting order-bom__source" title="أضيفت يدوياً على الأمر">يدوي</span>}
                          </td>
                        )}
                        <td>
                          {isReceiving ? (
                            <input
                              type="text"
                              className="table-input table-input--text"
                              placeholder="سبب الفارق إن وجد"
                              value={receiptInputs[m.item_id]?.notes || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setReceiptInputs((prev) => ({
                                  ...prev,
                                  [m.item_id]: { qty: prev[m.item_id]?.qty ?? String(m.dispatched_quantity), notes: val },
                                }));
                              }}
                            />
                          ) : (
                            m.notes || '—'
                          )}
                        </td>
                        {order.status === 'draft' && canManageMaterials && (
                          <td>
                            {bomItemIds.has(m.item_id) ? (
                              <small className="form-hint" title="بنود المستلزمات المحفوظة لا تُحذف حتى لا يختلف المطلوب عن المصروف دون توثيق">ثابت</small>
                            ) : pendingRemoveId === m.id ? (
                              <span style={{ display: 'inline-flex', gap: '4px' }}>
                                <button type="button" className="material-remove-button" onClick={() => void handleRemoveMaterial(m.id)} disabled={busy}>تأكيد الحذف</button>
                                <button type="button" className="btn btn--sm btn--secondary" onClick={() => setPendingRemoveId(null)} disabled={isProcessing}>تراجع</button>
                              </span>
                            ) : (
                              <button type="button" className="material-remove-button" onClick={() => setPendingRemoveId(m.id)} disabled={busy}>حذف</button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* تبويب مراحل التشغيل التتابعية */}
          {activeTab === 'stages' && (
            <div className="tab-pane">
              <div className="provisional-hint">
                📌 <strong>قاعدة التتابع الإلزامي:</strong> لا يُسمح بتخطي المراحل أو بدء مرحلة قبل اكتمال سابقتها. تحديث المراحل متاح فقط والأمر "قيد الإنتاج".
              </div>
              {stageLock && canManageStages && (
                <p className="form-hint" role="note" style={{ color: '#92400e' }}>{stageLock}</p>
              )}

              <div className="stages-flow-list">
                {STAGE_SEQUENCE.map((stageKey, idx) => {
                  const event = order.stage_events.find((s) => s.stage_name === stageKey);
                  const stageStatus = event?.status || 'not_started';
                  const prevStageKey = idx > 0 ? STAGE_SEQUENCE[idx - 1] : null;
                  const prevEvent = prevStageKey
                    ? order.stage_events.find((s) => s.stage_name === prevStageKey)
                    : null;
                  const isPrevCompleted = idx === 0 || prevEvent?.status === 'completed';
                  const canRollback = rollbackAllowedByStatus && stageStatus === 'completed' && STAGE_SEQUENCE.slice(idx + 1).every((laterKey) =>
                    (order.stage_events.find((stage) => stage.stage_name === laterKey)?.status ?? 'not_started') === 'not_started'
                  );

                  return (
                    <div
                      key={stageKey}
                      className={`stage-card stage-card--${stageStatus} ${
                        !isPrevCompleted ? 'stage-card--locked' : ''
                      }`}
                    >
                      <div className="stage-card__number">{idx + 1}</div>
                      <div className="stage-card__info">
                        <div className="stage-card__head">
                          <h3 className="stage-card__title">
                            {STAGE_TITLES_AR[stageKey]}
                          </h3>
                          <span className={`stage-badge stage-badge--${stageStatus}`}>
                            {stageStatus === 'not_started' && 'لم تبدأ بعد'}
                            {stageStatus === 'in_progress' && 'قيد التنفيذ الآن'}
                            {stageStatus === 'completed' && '✓ مكتملة'}
                          </span>
                        </div>
                        <div className="stage-card__meta">
                          <span>المسؤول: {event ? userLabel(event.actor_id || event.actor_name, user?.id) : 'النظام'}</span>
                          {event?.timestamp && (
                            <span>التحديث: {new Date(event.timestamp).toLocaleTimeString('ar-EG')}</span>
                          )}
                          {event?.notes && <span className="stage-note">({event.notes})</span>}
                        </div>
                        {(order.stage_history || []).filter((history) => history.stage_name === stageKey).map((history) => (
                          <div className="stage-history-entry" key={history.id}>
                            <strong>تغيير موثق:</strong> {STAGE_STATUS_AR[history.from_status] || history.from_status} ← {STAGE_STATUS_AR[history.to_status] || history.to_status} · {userLabel(history.actor_id || history.actor_name, user?.id)} · {new Date(history.timestamp).toLocaleString('ar-EG')}
                            {history.previous_notes && <span>الملاحظة السابقة: {history.previous_notes}</span>}
                            <span>السبب: {history.reason}</span>
                          </div>
                        ))}
                        {stageStatus !== 'completed' && canManageStages && !stageLock && (
                          <label className="stage-detail-input">
                            <span>تفاصيل المرحلة / ملاحظات</span>
                            <textarea
                              value={stageNotes[stageKey] || ''}
                              onChange={(e) => setStageNotes((previous) => ({ ...previous, [stageKey]: e.target.value }))}
                              placeholder="مثال: تفاصيل العمل أو ملاحظة تحتاج المتابعة"
                              rows={2}
                            />
                          </label>
                        )}
                      </div>

                      <div className="stage-card__actions">
                        {canManageStages ? (
                          <>
                            {stageStatus === 'not_started' && (
                              <button
                                className="btn btn--sm btn--secondary"
                                onClick={() => void handleUpdateStage(stageKey, 'in_progress')}
                                disabled={Boolean(stageLock) || !isPrevCompleted || busy}
                                title={
                                  stageLock
                                    ? stageLock
                                    : !isPrevCompleted
                                    ? 'يجب إكمال المرحلة السابقة أولاً'
                                    : 'بدء تشغيل المرحلة'
                                }
                              >
                                بدء المرحلة ▶
                              </button>
                            )}

                            {stageStatus === 'in_progress' && (
                              <button
                                className="btn btn--sm btn--primary"
                                onClick={() => void handleUpdateStage(stageKey, 'completed')}
                                disabled={Boolean(stageLock) || busy}
                                title={stageLock || 'إكمال المرحلة'}
                              >
                                ✓ إكمال المرحلة
                              </button>
                            )}

                            {stageStatus === 'completed' && (
                              <>
                                <span className="stage-done-tag">تم الإنجاز</span>
                                {canRollback && (
                                  <div className="stage-rollback-control">
                                    <label>
                                      <span>سبب إعادة فتح المرحلة *</span>
                                      <input
                                        value={rollbackReasons[stageKey] || ''}
                                        onChange={(e) => setRollbackReasons((previous) => ({ ...previous, [stageKey]: e.target.value }))}
                                        placeholder="اكتب سبب التراجع"
                                      />
                                    </label>
                                    <button className="material-remove-button" onClick={() => void handleRollbackStage(stageKey)} disabled={busy}>
                                      إعادة فتح المرحلة
                                    </button>
                                  </div>
                                )}
                              </>
                            )}
                          </>
                        ) : (
                          <span className="stage-badge stage-badge--read-only">
                            {stageStatus === 'completed' ? 'تم الإنجاز' : stageStatus === 'in_progress' ? 'قيد العمل' : 'معلق'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'defects' && (
            <div className="tab-pane">
              <h3>تسجيل عيب أو إصلاح</h3>
              {canReportDefects ? (
                <form className="form-grid" onSubmit={(event) => void handleReportDefect(event)}>
                  <label>المرحلة<select value={defectForm.stage_name} onChange={(e) => setDefectForm({ ...defectForm, stage_name: e.target.value })}>{STAGE_SEQUENCE.map((key) => <option key={key} value={key}>{STAGE_TITLES_AR[key]}</option>)}</select></label>
                  <label>الكمية المتأثرة<input required type="number" min="0.001" step="0.001" value={defectForm.affected_quantity} onChange={(e) => setDefectForm({ ...defectForm, affected_quantity: e.target.value })} /></label>
                  <label>المسؤول أو القسم<input required value={defectForm.responsible} onChange={(e) => setDefectForm({ ...defectForm, responsible: e.target.value })} /></label>
                  <label>وصف العيب<input required value={defectForm.description} onChange={(e) => setDefectForm({ ...defectForm, description: e.target.value })} /></label>
                  <label>الإجراء المطلوب<input required value={defectForm.repair_action} onChange={(e) => setDefectForm({ ...defectForm, repair_action: e.target.value })} /></label>
                  <label>تكلفة الإصلاح (وصف فقط)<input value={defectForm.repair_cost_description} onChange={(e) => setDefectForm({ ...defectForm, repair_cost_description: e.target.value })} /></label>
                  <button className="btn btn--primary" disabled={isProcessing}>تسجيل العيب</button>
                </form>
              ) : (
                <p className="provisional-hint">تسجيل العيوب من مهام مسؤول الإنتاج.</p>
              )}
              <div className="defect-list">
                {defects.map((defect) => <article className="action-box" key={defect.id}>
                  <strong>{defect.defect_number} · {STAGE_TITLES_AR[defect.stage_name]}</strong>
                  <p>{defect.description} · الكمية: {defect.affected_quantity} · المسؤول: {defect.responsible}</p>
                  <p>الإصلاح: {defect.repair_action}{defect.repair_cost_description ? ` · التكلفة الوصفية: ${defect.repair_cost_description}` : ''}</p>
                  <select
                    aria-label="حالة الإصلاح"
                    value={defect.status}
                    disabled={!canReportDefects}
                    onChange={async (e) => {
                      try {
                        const updated = await updateOrderDefect(order.id, defect.id, { status: e.target.value as ProductionDefect['status'] });
                        setDefects((items) => items.map((item) => item.id === updated.id ? updated : item));
                      } catch (err: unknown) {
                        reportFailure(err, 'تعذر تحديث حالة الإصلاح.');
                      }
                    }}
                  >
                    <option value="reported">مسجل</option><option value="repair_in_progress">قيد الإصلاح</option><option value="repaired">تم الإصلاح</option><option value="closed">مغلق</option>
                  </select>
                </article>)}
                {defects.length === 0 && <p>لا توجد عيوب مسجلة لهذا الأمر.</p>}
              </div>
            </div>
          )}

          {/* تبويب استلام المنتج التام لكل بند */}
          {activeTab === 'fg_receipt' && (
            <div className="tab-pane">
              <div style={{ marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>استلام المنتج التام لكل مقاس/بند</h3>
                <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
                  سجّل لكل بند الكمية السليمة (تدخل مخزن المنتج التام في رصيد مالكها) والكمية المرفوضة بالفحص (لا تدخل المخزون). يمكن الاستلام على دفعات حتى استكمال المستهدف لكل بند.
                </p>
              </div>

              {(order.status === 'receipt_completed' || order.status === 'closed') && (
                <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '6px', color: '#166534', marginBottom: '1rem' }}>
                  <strong>✓ تم استلام كامل كميات بنود الأمر بمخزن المنتج التام.</strong>
                </div>
              )}
              {(order.status === 'draft' || order.status === 'materials_dispatched') && (
                <p className="form-hint" role="note" style={{ color: '#92400e' }}>
                  اصرف الخامات وأكد استلامها في الورشة أولاً؛ استلام المنتج التام متاح والأمر "قيد الإنتاج" أو "اكتمل التصنيع".
                </p>
              )}
              {orderItems.length === 0 ? (
                <p className="form-hint">هذا الأمر لا يحتوي على بنود منتجات؛ لا يمكن استلام منتج تام له.</p>
              ) : (
                <form className="warehouse-draft" onSubmit={(e) => void handleReceiveFinishedGoods(e)} style={{ background: '#f8fafc', padding: '1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <table className="order-detail-table" aria-label="بنود استلام المنتج التام">
                    <thead>
                      <tr>
                        <th>البند / المقاس</th>
                        <th>الملكية</th>
                        <th>المستهدف</th>
                        <th>المستلم سليم سابقاً</th>
                        <th>المرفوض سابقاً</th>
                        <th>المتبقي</th>
                        <th>سليم الآن</th>
                        <th>مرفوض الآن</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderItems.map((item) => {
                        const remaining = itemRemaining(item);
                        const input = fgLines[item.id] || { accepted: '0', rejected: '0' };
                        const lineError = fgLineError(item);
                        const label = `${item.product_name_ar} ${item.variant_info || ''}`.trim();
                        return (
                          <tr key={item.id}>
                            <td><strong>{item.product_name_ar}</strong><br /><small>{(item.variant_info || item.season || '').replace(/summer/g, 'صيفي').replace(/autumn/g, 'خريفي').replace(/winter/g, 'شتوي')}</small></td>
                            <td>{item.product_type === 'private_label' ? `تصنيع خاص: ${item.customer_name || 'عميل'}` : 'براند المصنع'}</td>
                            <td className="qty-col">{item.target_quantity}</td>
                            <td className="qty-col">{item.received_quantity ?? 0}</td>
                            <td className="qty-col">{item.rejected_quantity ?? 0}</td>
                            <td className="qty-col"><strong>{remaining}</strong></td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                max={remaining}
                                step="any"
                                className="table-input"
                                aria-label={`الكمية السليمة ${label}`}
                                aria-invalid={lineError ? true : undefined}
                                value={input.accepted}
                                disabled={!canSubmitFg || !canReceiveFinishedGoods}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setFgLines((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] || { accepted: '0', rejected: '0' }), accepted: val } }));
                                }}
                              />
                              {lineError && <small role="alert" style={{ display: 'block', color: '#b91c1c' }}>{lineError}</small>}
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                className="table-input"
                                aria-label={`الكمية المرفوضة ${label}`}
                                value={input.rejected}
                                disabled={!canSubmitFg || !canReceiveFinishedGoods}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setFgLines((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] || { accepted: '0', rejected: '0' }), rejected: val } }));
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <label style={{ display: 'block', margin: '1rem 0' }}>
                    ملاحظات الاستلام وفحص الجودة:
                    <input
                      value={fgNotes}
                      onChange={(e) => setFgNotes(e.target.value)}
                      placeholder="فحص المقاسات والكبسولات والخياطة..."
                      style={{ width: '100%', marginTop: '0.25rem' }}
                      disabled={!canSubmitFg || !canReceiveFinishedGoods}
                    />
                  </label>

                  {canReceiveFinishedGoods ? (
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={busy || !canSubmitFg || fgHasErrors || fgPayloadLines.length === 0}
                      style={{ minWidth: '180px', height: '40px' }}
                    >
                      {isProcessing ? 'جاري التحقق والترحيل...' : '✓ تأكيد استلام المنتج التام'}
                    </button>
                  ) : (
                    <p style={{ color: '#b91c1c', fontSize: '0.875rem', margin: 0 }}>
                      ⛔ استلام المنتج التام في المخزن من مسؤولية أمين المخزن أو المدير العام.
                    </p>
                  )}
                </form>
              )}
            </div>
          )}

          {/* تبويب تسوية خامات الورشة وإغلاق الأمر */}
          {activeTab === 'wip' && (
            <div className="tab-pane">
              <div style={{ marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>تسوية خامات الورشة</h3>
                <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
                  سجّل مصير رصيد كل خامة بالورشة: المستهلك فعلياً، والمرتجع لمخزن الخامات، والتالف. لا يتجاوز مجموعها الرصيد الحالي للخامة.
                </p>
              </div>

              {wipLoading && <p className="form-hint">جاري تحميل ملخص خامات الورشة…</p>}
              {wipError && (
                <div className="modal-alert modal-alert--danger" role="alert">
                  <div className="modal-alert__content">
                    <span>{wipError}</span>
                    <button type="button" className="modal-alert__resync-btn" onClick={() => void loadWipSummary()}>إعادة المحاولة</button>
                  </div>
                </div>
              )}

              {wipSummary && (
                <>
                  {!canSubmitRecon && (
                    <p className="form-hint" role="note" style={{ color: '#92400e' }}>
                      {order.status === 'closed'
                        ? 'الأمر مغلق؛ لا يمكن تسجيل تسويات جديدة.'
                        : 'تسوية خامات الورشة متاحة بعد تأكيد استلام الخامات بالورشة وقبل إغلاق الأمر.'}
                    </p>
                  )}
                  <form onSubmit={(e) => void handleReconcile(e)}>
                    <table className="order-detail-table" aria-label="تسوية خامات الورشة">
                      <thead>
                        <tr>
                          <th>الخامة</th>
                          <th>الوحدة</th>
                          <th>المنصرف</th>
                          <th>المستلم بالورشة</th>
                          <th>رصيد الورشة الحالي</th>
                          <th>مستهلك</th>
                          <th>مرتجع للمخزن</th>
                          <th>تالف</th>
                          <th>حالة المرتجع</th>
                          <th>المتبقي بعد التسوية</th>
                          <th>ملاحظات</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wipSummary.materials.length === 0 ? (
                          <tr><td colSpan={11} className="empty-materials">لا توجد خامات مسجلة لهذا الأمر.</td></tr>
                        ) : wipSummary.materials.map((m) => {
                          const input = reconLine(m.item_id);
                          const sums = reconSums(m.item_id);
                          const remainingAfter = round6(m.current_wip_balance - sums.consumed - sums.returned - sums.scrapped);
                          const lineError = reconLineError(m.item_id, m.current_wip_balance);
                          const editable = canSubmitRecon && canReconcile && m.current_wip_balance > EPSILON;
                          const setField = (field: keyof ReconInput, value: string) =>
                            setReconInputs((prev) => ({ ...prev, [m.item_id]: { ...reconLine(m.item_id), ...prev[m.item_id], [field]: value } }));
                          return (
                            <tr key={m.item_id}>
                              <td><strong>{m.item_name_ar}</strong><br /><small><code>{m.item_code}</code></small></td>
                              <td>{m.unit_name_ar}</td>
                              <td className="qty-col">{m.dispatched_quantity}</td>
                              <td className="qty-col">{m.received_quantity}</td>
                              <td className="qty-col"><strong>{m.current_wip_balance}</strong></td>
                              {(['consumed', 'returned', 'scrapped'] as const).map((field) => (
                                <td key={field}>
                                  <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    className="table-input"
                                    aria-label={`${field === 'consumed' ? 'مستهلك' : field === 'returned' ? 'مرتجع' : 'تالف'} ${m.item_name_ar}`}
                                    value={input[field]}
                                    disabled={!editable}
                                    onChange={(e) => setField(field, e.target.value)}
                                  />
                                </td>
                              ))}
                              <td>
                                <select
                                  aria-label={`حالة المرتجع ${m.item_name_ar}`}
                                  value={input.condition}
                                  disabled={!editable || sums.returned <= EPSILON}
                                  onChange={(e) => setField('condition', e.target.value)}
                                >
                                  {(Object.keys(RETURN_CONDITION_LABELS) as ReturnCondition[]).map((c) => (
                                    <option key={c} value={c}>{RETURN_CONDITION_LABELS[c]}</option>
                                  ))}
                                </select>
                              </td>
                              <td className={`qty-col ${remainingAfter < 0 ? 'diff--neg' : ''}`}>
                                <strong>{remainingAfter}</strong>
                                {lineError && <small role="alert" style={{ display: 'block', color: '#b91c1c' }}>{lineError}</small>}
                              </td>
                              <td>
                                <input
                                  type="text"
                                  className="table-input table-input--text"
                                  value={input.notes}
                                  disabled={!editable}
                                  onChange={(e) => setField('notes', e.target.value)}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="form-hint">إجمالي رصيد خامات الورشة لهذا الأمر: <strong>{wipSummary.net_wip_balance}</strong></p>
                    {canReconcile ? (
                      canSubmitRecon && (
                        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <label style={{ flex: '1 1 240px' }}>
                            ملاحظات التسوية
                            <input value={reconNotes} onChange={(e) => setReconNotes(e.target.value)} style={{ width: '100%' }} />
                          </label>
                          <button
                            type="submit"
                            className="btn btn--teal"
                            disabled={busy || reconHasErrors || reconPayloadLines.length === 0}
                          >
                            {isProcessing ? 'جاري التسجيل…' : 'تسجيل تسوية الخامات'}
                          </button>
                        </div>
                      )
                    ) : (
                      <p className="form-hint">تسوية خامات الورشة (المستهلك والمرتجع والهالك) من مسؤولية مسؤول الإنتاج.</p>
                    )}
                  </form>

                  <WorkshopReturnsPanel
                    key={`${order.id}:${returnsVersion}`}
                    orderId={order.id}
                    currentUserId={user?.id}
                    canReceive={canReceiveReturns}
                    canResolve={canResolveReturns}
                    onChanged={async (message) => {
                      await loadWipSummary();
                      await refreshAfterSuccess(message);
                    }}
                  />

                  <hr style={{ margin: '1.5rem 0', border: 'none', borderTop: '1px solid #e2e8f0' }} />

                  <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>إغلاق أمر التشغيل</h3>
                  {order.status === 'closed' ? (
                    <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '6px', color: '#166534' }}>
                      <strong>✓ أمر التشغيل مغلق نهائياً.</strong>
                    </div>
                  ) : (
                    <>
                      <p className="form-hint">
                        المستلم سليم: <strong>{wipSummary.total_received_goods}</strong> من المستهدف <strong>{wipSummary.target_quantity}</strong>
                        {' · '}فروقات استلام الورشة: <strong>{wipSummary.unresolved_discrepancies_count}</strong>
                      </p>
                      {wipSummary.blocking_reasons.length > 0 ? (
                        <div className="modal-alert modal-alert--warning">
                          <div className="modal-alert__content" style={{ display: 'block' }}>
                            <strong>ما يمنع الإغلاق حالياً:</strong>
                            <ul style={{ margin: '0.25rem 0 0', paddingInlineStart: '1.25rem' }}>
                              {wipSummary.blocking_reasons.map((reason) => <li key={reason}>{reason}</li>)}
                            </ul>
                          </div>
                        </div>
                      ) : (
                        <p className="form-hint" style={{ color: '#166534' }}>الأمر جاهز للإغلاق.</p>
                      )}

                      {canCloseOrder ? (
                        <form onSubmit={(e) => void handleCloseOrder(e)} style={{ display: 'grid', gap: '0.75rem', marginTop: '0.75rem' }}>
                          {hasDiscrepancies && (
                            <>
                              <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={closeForm.discrepancy_signoff}
                                  onChange={(e) => setCloseForm({ ...closeForm, discrepancy_signoff: e.target.checked })}
                                />
                                أقر باعتماد فروقات استلام الخامات بالورشة
                              </label>
                              <label>
                                ملاحظات اعتماد الفروقات
                                <input
                                  value={closeForm.discrepancy_notes}
                                  onChange={(e) => setCloseForm({ ...closeForm, discrepancy_notes: e.target.value })}
                                  style={{ width: '100%' }}
                                />
                              </label>
                            </>
                          )}
                          {isUnderProduced && (
                            <label>
                              سبب العجز الإنتاجي (المستلم أقل من المستهدف) *
                              <textarea
                                value={closeForm.under_production_reason}
                                onChange={(e) => setCloseForm({ ...closeForm, under_production_reason: e.target.value })}
                                rows={2}
                                style={{ width: '100%' }}
                              />
                            </label>
                          )}
                          <label>
                            ملاحظات الإغلاق
                            <input
                              value={closeForm.notes}
                              onChange={(e) => setCloseForm({ ...closeForm, notes: e.target.value })}
                              style={{ width: '100%' }}
                            />
                          </label>
                          {hardCloseBlockers.length > 0 && (
                            <div className="close-blockers" role="note" id="close-blockers">
                              <strong>لا يمكن إغلاق الأمر الآن:</strong>
                              <ul>{hardCloseBlockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                            </div>
                          )}
                          {hardCloseBlockers.length === 0 && hasDiscrepancies && !closeForm.discrepancy_signoff && (
                            <p className="form-hint" role="note" id="close-blockers">فعّل إقرار فروقات الاستلام أعلاه ليصبح الإغلاق متاحاً.</p>
                          )}
                          {hardCloseBlockers.length === 0 && isUnderProduced && closeForm.under_production_reason.trim().length === 0 && (
                            <p className="form-hint" role="note" id="close-blockers">اكتب سبب نقص الإنتاج أعلاه ليصبح الإغلاق متاحاً.</p>
                          )}
                          <div>
                            <button
                              type="submit"
                              className="btn btn--primary"
                              aria-describedby="close-blockers"
                              disabled={
                                busy ||
                                hardCloseBlockers.length > 0 ||
                                (hasDiscrepancies && !closeForm.discrepancy_signoff) ||
                                (isUnderProduced && closeForm.under_production_reason.trim().length === 0)
                              }
                            >
                              {isProcessing ? 'جاري الإغلاق…' : 'إغلاق أمر التشغيل نهائياً'}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <p className="form-hint">إغلاق أمر التشغيل من مسؤولية مسؤول الإنتاج أو المدير العام.</p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void handleResyncOrder()}
              disabled={isProcessing || isResyncing}
              title="تحديث بيانات أمر التشغيل من الخادم"
            >
              {isResyncing ? 'جاري المزامنة...' : '🔄 إعادة مزامنة بيانات الأمر'}
            </button>
          </div>
          <button className="btn btn--secondary" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
