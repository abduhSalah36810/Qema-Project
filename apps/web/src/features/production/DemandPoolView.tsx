/**
 * واجهة سلة طلبات العملاء غير المخططة (Demand Pool - Phase 4.5 / T3):
 * - استعراض بنود الطلبات المفتوحة مع المتبقي غير المخطط لكل بند.
 * - اختيار بنود متوافقة فقط (نفس الموديل + نفس المقاس) وتخصيص كميات لكل بند.
 * - معاينة حصص العملاء واحتياج الخامات والعجز قبل التجميع.
 * - إنشاء أمر تشغيل مجمع (بصلاحية production:orders:create) مع تخصيصات العملاء.
 * كل قواعد التحقق (التوافق، سقف المتبقي 409، BOM النشط) في الخادم؛ الواجهة تعكسها فقط.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  DemandPoolItemRead,
  DemandAllocationItem,
  DemandMaterialsPreviewResponse,
  ProductionOrderDemandRead,
  ProductionOrder,
  fetchDemandPool,
  previewDemandAggregation,
  createAggregatedOrderApi,
  fetchOrderDemands,
} from './productionApi';

const fmtQty = (n: number | string): string =>
  Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const fmtDate = (value?: string | null): string =>
  value ? new Date(value).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

const SEASON_AR: Record<string, string> = { summer: 'صيفي', autumn: 'خريفي', winter: 'شتوي' };

const fmtPct = (n: number): string => `${Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 2 })}٪`;

interface DemandPoolViewProps {
  onOpenOrder?: (orderId: string) => void;
}

export const DemandPoolView: React.FC<DemandPoolViewProps> = ({ onOpenOrder }) => {
  const { hasPermission } = useAuth();
  // القراءة لأصحاب production:orders:view أو customers:orders:view (كما في نقطة النهاية)
  const canRead = hasPermission('production:orders:view') || hasPermission('customers:orders:view');
  // التجميع بصلاحية production:orders:create (مدير الإنتاج والمدير العام)
  const canCreate = hasPermission('production:orders:create');

  const [pool, setPool] = useState<DemandPoolItemRead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [productFilter, setProductFilter] = useState<string>('all');

  // بند الطلب المختار للسحب: التخصيص لكل بند
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [preview, setPreview] = useState<DemandMaterialsPreviewResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    order: ProductionOrder;
    demands: ProductionOrderDemandRead[];
  } | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => `aggregate-${Date.now()}`);

  const loadPool = useCallback(async (refreshing = false) => {
    if (refreshing) setIsRefreshing(true); else setIsLoading(true);
    try {
      const list = await fetchDemandPool();
      setPool(list);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof ApiError ? err.message : 'تعذر تحميل سلة طلبات العملاء من الخادم.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  // تصفية الموديل (نفس فلاتر الخادم متاحة؛ التصفية هنا على البيانات المحمّلة)
  const filteredPool = useMemo(
    () => (productFilter === 'all' ? pool : pool.filter((p) => p.product_id === productFilter)),
    [pool, productFilter],
  );
  const products = useMemo(() => {
    const map = new Map<string, string>();
    pool.forEach((p) => map.set(p.product_id, p.product_name));
    return Array.from(map.entries());
  }, [pool]);

  /** مجموعة التوافق: أول بند مختار يحدد الموديل والمقاس المسموح اختيارهما معه */
  const selection = useMemo(
    () => Object.entries(allocations).filter(([, qty]) => qty > 0),
    [allocations],
  );
  const selectedKeys = new Set(selection.map(([id]) => id));
  const selectionOrigin: DemandPoolItemRead | null = useMemo(() => {
    if (!selection.length) return null;
    const firstId = selection[0][0];
    return pool.find((p) => p.customer_order_line_id === firstId) || null;
  }, [selection, pool]);

  const totalAllocated = useMemo(() => selection.reduce((sum, [, qty]) => sum + qty, 0), [selection]);

  const setAllocation = (item: DemandPoolItemRead, raw: string) => {
    const value = Number(raw);
    setAllocations((prev) => {
      const next = { ...prev };
      if (!raw || Number.isNaN(value) || value <= 0) {
        delete next[item.customer_order_line_id];
      } else {
        // سقف محلي = المتبقي غير المخطط؛ الخادم يرفض الزيادة بـ409 كذلك
        next[item.customer_order_line_id] = Math.min(value, item.unplanned_quantity);
      }
      return next;
    });
  };

  /** التوافق: نفس الموديل + نفس المقاس (قاعدة الخادم) — غير المتوافق معطل أثناء وجود اختيار */
  const isIncompatible = (item: DemandPoolItemRead): boolean => {
    if (!selectionOrigin) return false;
    if (selectedKeys.has(item.customer_order_line_id)) return false;
    return item.product_id !== selectionOrigin.product_id || item.variant_id !== selectionOrigin.variant_id;
  };

  const handlePreview = async () => {
    if (!selection.length) return;
    setIsPreviewing(true);
    setActionError(null);
    try {
      const items: DemandAllocationItem[] = selection.map(([lineId, qty]) => ({
        customer_order_line_id: lineId,
        allocated_quantity: qty,
      }));
      setPreview(await previewDemandAggregation(items));
    } catch (err: unknown) {
      setPreview(null);
      setActionError(err instanceof ApiError ? err.message : 'تعذر معاينة التجميع من الخادم.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleCreate = async () => {
    if (!selection.length || !canCreate || isCreating) return;
    setIsCreating(true);
    setActionError(null);
    try {
      const items: DemandAllocationItem[] = selection.map(([lineId, qty]) => ({
        customer_order_line_id: lineId,
        allocated_quantity: qty,
      }));
      const order = await createAggregatedOrderApi(
        { items, season: selectionOrigin?.season, notes: 'أمر تشغيل مجمع من سلة طلبات العملاء' },
        idempotencyKey,
      );
      setIdempotencyKey(`aggregate-${Date.now()}`);
      // عرض تخصيصات العملاء للأمر المنشأ (ProductionOrderDemandRead من الخادم)
      const demands = await fetchOrderDemands(order.id);
      setSuccessInfo({ order, demands });
      setPreview(null);
      setAllocations({});
      void loadPool(true);
    } catch (err: unknown) {
      // رسائل الخادم كما هي: 409 تجاوز المتبقي، 422 عدم توافق/غياب BOM، 403 صلاحية
      setActionError(err instanceof ApiError ? err.message : 'تعذر إنشاء أمر التشغيل المجمع.');
    } finally {
      setIsCreating(false);
    }
  };

  if (!canRead) {
    return (
      <div className="production-view-container" dir="rtl">
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">لا تملك صلاحية عرض سلة طلبات العملاء (production:orders:view أو customers:orders:view).</div>
        </div>
      </div>
    );
  }

  return (
    <div className="production-view-container" dir="rtl">
      {/* ── شريط التحكم ────────────────────────────────────────────── */}
      <div className="prod-toolbar">
        <div className="prod-toolbar__filters" aria-label="تصفية السلة بالموديل">
          <button className={`tool ${productFilter === 'all' ? 'tool--active' : ''}`} onClick={() => setProductFilter('all')}>
            كل الموديلات ({pool.length})
          </button>
          {products.map(([id, name]) => (
            <button
              key={id}
              className={`tool ${productFilter === id ? 'tool--active' : ''}`}
              onClick={() => setProductFilter(id)}
            >
              {name} ({pool.filter((p) => p.product_id === id).length})
            </button>
          ))}
        </div>
        <button type="button" className="tool" onClick={() => void loadPool(true)} disabled={isRefreshing}>
          {isRefreshing ? 'جاري التحديث…' : '↻ تحديث'}
        </button>
      </div>

      {isLoading && <p className="form-hint">جاري تحميل سلة طلبات العملاء…</p>}
      {loadError && (
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">
            <span>{loadError}</span>
            <button type="button" className="modal-alert__resync-btn" onClick={() => void loadPool(true)}>إعادة المحاولة</button>
          </div>
        </div>
      )}

      {!isLoading && !loadError && filteredPool.length === 0 && (
        <p className="form-hint">لا توجد بنود غير مخططة في السلة حالياً؛ كل بنود الطلبات المفتوحة مغطاة بأوامر تشغيل.</p>
      )}

      {!isLoading && filteredPool.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="order-detail-table" aria-label="سلة طلبات العملاء غير المخططة">
            <thead>
              <tr>
                <th>طلب العميل</th>
                <th>العميل</th>
                <th>الموديل</th>
                <th>المقاس</th>
                <th>الموسم</th>
                <th>الكمية المطلوبة</th>
                <th>المخطط لها</th>
                <th>المتبقي غير المخطط</th>
                <th>تاريخ الطلب</th>
                <th>التسليم المتوقع</th>
                <th>تخصيص للأمر المجمع</th>
              </tr>
            </thead>
            <tbody>
              {filteredPool.map((item) => {
                const incompatible = isIncompatible(item);
                const isSelected = selectedKeys.has(item.customer_order_line_id);
                return (
                  <tr key={item.customer_order_line_id} style={incompatible ? { opacity: 0.45 } : undefined}>
                    <td>{item.customer_order_number}</td>
                    <td>{item.customer_name}</td>
                    <td>{item.product_name}</td>
                    <td>{item.variant_label || item.numeric_size || item.letter_size || '—'}</td>
                    <td>{SEASON_AR[item.season] || item.season}</td>
                    <td>{fmtQty(item.ordered_quantity)}</td>
                    <td>{fmtQty(item.planned_quantity)}</td>
                    <td style={{ fontWeight: 700, color: 'var(--teal-primary, #0f766e)' }}>{fmtQty(item.unplanned_quantity)}</td>
                    <td>{fmtDate(item.order_date)}</td>
                    <td>{fmtDate(item.expected_delivery_at)}</td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        max={item.unplanned_quantity}
                        aria-label={`تخصيص من ${item.customer_order_number}`}
                        disabled={incompatible || item.unplanned_quantity <= 0}
                        value={allocations[item.customer_order_line_id] ?? ''}
                        onChange={(e) => setAllocation(item, e.target.value)}
                        placeholder={`≤ ${fmtQty(item.unplanned_quantity)}`}
                        style={{ width: '110px' }}
                      />
                      {isSelected && <span style={{ color: 'var(--teal-primary, #0f766e)', fontSize: '10px' }}> مختار</span>}
                      {incompatible && (
                        <span style={{ color: 'var(--text-light)', fontSize: '10px' }}> غير متوافق مع الاختيار</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── منطقة الإجراءات: المعاينة والإنشاء ──────────────────────── */}
      <div className="claims-summary" aria-label="ملخص الاختيار">
        <span>بنود مختارة: <strong>{selection.length}</strong></span>
        <span>إجمالي الكمية المجمععة: <strong>{fmtQty(totalAllocated)}</strong></span>
        {selectionOrigin && (
          <span>
            مجموعة متوافقة: <strong>{selectionOrigin.product_name} · {selectionOrigin.variant_label}</strong>
          </span>
        )}
      </div>

      {actionError && (
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">{actionError}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="tool"
          disabled={selection.length === 0 || isPreviewing || Boolean(successInfo)}
          onClick={() => void handlePreview()}
        >
          {isPreviewing ? 'جاري المعاينة…' : '🔍 معاينة الخامات والحصص'}
        </button>
        {canCreate && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={selection.length === 0 || isCreating || Boolean(successInfo)}
            title="إنشاء أمر تشغيل موحد للبنود المتوافقة (نفس الموديل والمقاس)"
            onClick={() => void handleCreate()}
          >
            {isCreating ? 'جاري الإنشاء…' : '➕ إنشاء أمر تشغيل مجمع'}
          </button>
        )}
      </div>

      {/* ── المعاينة: حصص العملاء والخامات والعجز ──────────────────── */}
      {preview && (
        <section aria-labelledby="pool-preview-title" style={{ marginTop: '8px' }}>
          <h3 id="pool-preview-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>
            معاينة التجميع: {preview.product_name} · {preview.variant_label} · إجمالي {fmtQty(preview.total_target_quantity)} قطعة
          </h3>
          {!preview.all_materials_available && (
            <div className="modal-alert modal-alert--warning" role="alert">
              <div className="modal-alert__content">يوجد عجز في خامات الأمر المجمع — راجع جدول الاحتياجات قبل الإنشاء.</div>
            </div>
          )}
          {preview.all_materials_available && (
            <p className="form-hint" style={{ color: '#166534' }}>جميع الخامات المطلوبة متاحة بمخزن الخامات الرئيسي.</p>
          )}

          <table className="order-detail-table" aria-label="حصص العملاء في الأمر المجمع">
            <thead>
              <tr>
                <th>العميل</th>
                <th>طلب العميل</th>
                <th>الكمية المخصصة</th>
                <th>النسبة</th>
              </tr>
            </thead>
            <tbody>
              {preview.customer_shares.map((s) => (
                <tr key={s.customer_order_line_id}>
                  <td>{s.customer_name}</td>
                  <td>{s.customer_order_number}</td>
                  <td>{fmtQty(s.allocated_quantity)}</td>
                  <td>{fmtPct(s.percentage)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="order-detail-table" aria-label="احتياج الخامات للأمر المجمع">
            <thead>
              <tr>
                <th>الخامة</th>
                <th>الوحدة</th>
                <th>لكل قطعة</th>
                <th>الاحتياج الكلي</th>
                <th>المتاح بالمخزن</th>
                <th>العجز</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {preview.materials.map((m) => (
                <tr key={m.item_id}>
                  <td>{m.item_name_ar} <span style={{ color: 'var(--text-light)' }}>({m.item_code})</span></td>
                  <td>{m.unit_name_ar}</td>
                  <td>{fmtQty(m.quantity_per_piece)}</td>
                  <td>{fmtQty(m.required_quantity)}</td>
                  <td>{fmtQty(m.available_quantity)}</td>
                  <td style={{ color: m.shortage_quantity > 0 ? 'var(--color-danger, #b91c1c)' : undefined, fontWeight: m.shortage_quantity > 0 ? 700 : undefined }}>
                    {fmtQty(m.shortage_quantity)}
                  </td>
                  <td>{m.is_sufficient ? 'متاح' : 'عجز'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── نجاح الإنشاء: الأمر المنشأ وتخصيصات عملائه ─────────────── */}
      {successInfo && (
        <section aria-labelledby="pool-success-title" className="claims-summary" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: '8px' }}>
          <h3 id="pool-success-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>
            ✅ تم إنشاء أمر التشغيل المجمع {successInfo.order.order_number} ({fmtQty(successInfo.order.target_quantity)} قطعة)
          </h3>
          <table className="order-detail-table" aria-label="تخصيصات العملاء للأمر المنشأ">
            <thead>
              <tr>
                <th>العميل</th>
                <th>طلب العميل</th>
                <th>المخصص</th>
                <th>المستوفى</th>
                <th>المتبقي</th>
                <th>نسبة الاستيفاء</th>
              </tr>
            </thead>
            <tbody>
              {successInfo.demands.map((d) => (
                <tr key={d.id}>
                  <td>{d.customer_name}</td>
                  <td>{d.customer_order_number}</td>
                  <td>{fmtQty(d.allocated_quantity)}</td>
                  <td>{fmtQty(d.fulfilled_quantity)}</td>
                  <td>{fmtQty(d.remaining_quantity)}</td>
                  <td>{fmtPct(d.fulfillment_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {onOpenOrder && (
            <button type="button" className="tool" onClick={() => onOpenOrder(successInfo.order.id)}>
              فتح أمر التشغيل ↗
            </button>
          )}
          <button type="button" className="tool" onClick={() => setSuccessInfo(null)}>بدء تجميع جديد</button>
        </section>
      )}
    </div>
  );
};
