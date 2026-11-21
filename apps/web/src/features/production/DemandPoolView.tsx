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
import { formatDate } from '@/lib/formatters';

const fmtQty = (n: number | string): string =>
  Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const fmtDate = (value?: string | null): string => formatDate(value);

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
    <div className="warehouse-page production-view-container" dir="rtl" style={{ padding: '16px 20px' }}>
      {/* ── شريط التحكم ────────────────────────────────────────────── */}
      <div className="prod-toolbar" style={{ marginBottom: '16px', background: '#ffffff', padding: '14px 18px', borderRadius: '10px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div className="prod-toolbar__filters" aria-label="تصفية السلة بالموديل" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
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

      {isLoading && <p className="form-hint" style={{ fontSize: '14px', padding: '12px' }}>جاري تحميل سلة طلبات العملاء…</p>}
      {loadError && (
        <div className="modal-alert modal-alert--danger" role="alert" style={{ marginBottom: '16px' }}>
          <div className="modal-alert__content">
            <span>{loadError}</span>
            <button type="button" className="modal-alert__resync-btn" onClick={() => void loadPool(true)}>إعادة المحاولة</button>
          </div>
        </div>
      )}

      {!isLoading && !loadError && filteredPool.length === 0 && (
        <div className="warehouse-empty" style={{ padding: '32px 20px', textAlign: 'center', background: '#fff', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
          <p className="form-hint" style={{ fontSize: '14px', margin: 0 }}>لا توجد بنود غير مخططة في السلة حالياً؛ كل بنود الطلبات المفتوحة مغطاة بأوامر تشغيل.</p>
        </div>
      )}

      {!isLoading && filteredPool.length > 0 && (
        <div className="warehouse-table-wrap" style={{ marginBottom: '16px', border: '1px solid #e2e8f0', borderRadius: '10px', background: '#ffffff', overflowX: 'auto' }}>
          <table className="warehouse-table order-detail-table" aria-label="سلة طلبات العملاء غير المخططة" style={{ width: '100%', minWidth: '850px', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>طلب العميل</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>العميل</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>الموديل</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>المقاس</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>الموسم</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>الكمية المطلوبة</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>المخطط لها</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>المتبقي غير المخطط</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>تاريخ الطلب</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>التسليم المتوقع</th>
                <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>تخصيص للأمر المجمع</th>
              </tr>
            </thead>
            <tbody>
              {filteredPool.map((item) => {
                const incompatible = isIncompatible(item);
                const isSelected = selectedKeys.has(item.customer_order_line_id);
                return (
                  <tr key={item.customer_order_line_id} style={{ borderBottom: '1px solid #f1f5f9', ...(incompatible ? { opacity: 0.45, background: '#fafafa' } : isSelected ? { background: '#f0fdf4' } : {}) }}>
                    <td style={{ padding: '12px 14px', fontWeight: 600 }}>{item.customer_order_number}</td>
                    <td style={{ padding: '12px 14px' }}>{item.customer_name}</td>
                    <td style={{ padding: '12px 14px' }}>{item.product_name}</td>
                    <td style={{ padding: '12px 14px' }}>{item.variant_label || item.numeric_size || item.letter_size || '—'}</td>
                    <td style={{ padding: '12px 14px' }}>{SEASON_AR[item.season] || item.season}</td>
                    <td style={{ padding: '12px 14px' }}>{fmtQty(item.ordered_quantity)}</td>
                    <td style={{ padding: '12px 14px' }}>{fmtQty(item.planned_quantity)}</td>
                    <td style={{ padding: '12px 14px', fontWeight: 700, color: '#0f766e', fontSize: '15px' }}>{fmtQty(item.unplanned_quantity)}</td>
                    <td style={{ padding: '12px 14px' }}>{fmtDate(item.order_date)}</td>
                    <td style={{ padding: '12px 14px' }}>{fmtDate(item.expected_delivery_at)}</td>
                    <td style={{ padding: '12px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <input
                          type="number"
                          className="form-input"
                          min="0"
                          step="1"
                          max={item.unplanned_quantity}
                          aria-label={`تخصيص من ${item.customer_order_number}`}
                          disabled={incompatible || item.unplanned_quantity <= 0}
                          value={allocations[item.customer_order_line_id] ?? ''}
                          onChange={(e) => setAllocation(item, e.target.value)}
                          placeholder={`≤ ${fmtQty(item.unplanned_quantity)}`}
                          style={{ width: '105px', height: '36px', fontSize: '13.5px', textAlign: 'center', padding: '4px 8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                        />
                        {isSelected && <span style={{ color: '#0f766e', fontWeight: 700, fontSize: '12px', background: '#ccfbf1', padding: '2px 8px', borderRadius: '999px' }}>مختار</span>}
                        {incompatible && (
                          <span style={{ color: '#94a3b8', fontSize: '11.5px' }}>غير متوافق مع الاختيار</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── منطقة الإجراءات: المعاينة والإنشاء ──────────────────────── */}
      <div className="claims-summary" aria-label="ملخص الاختيار" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '14px 20px', margin: '16px 0', fontSize: '14px' }}>
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>بنود مختارة: <strong style={{ fontSize: '15px', color: '#0f172a' }}>{selection.length}</strong></span>
          <span>إجمالي الكمية المجمعة: <strong style={{ fontSize: '16px', color: '#0f766e' }}>{fmtQty(totalAllocated)} قطعة</strong></span>
          {selectionOrigin && (
            <span>
              المجموعة المتوافقة: <strong style={{ color: '#0369a1' }}>{selectionOrigin.product_name} · {selectionOrigin.variant_label}</strong>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="tool"
            style={{ height: '38px', padding: '0 18px', fontSize: '13.5px' }}
            disabled={selection.length === 0 || isPreviewing || Boolean(successInfo)}
            onClick={() => void handlePreview()}
          >
            {isPreviewing ? 'جاري المعاينة…' : '🔍 معاينة الخامات والحصص'}
          </button>
          {canCreate && (
            <button
              type="button"
              className="btn btn--primary"
              style={{ height: '38px', padding: '0 20px', fontSize: '13.5px', background: '#0f766e', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: selection.length === 0 || isCreating || Boolean(successInfo) ? 'not-allowed' : 'pointer', opacity: selection.length === 0 || isCreating || Boolean(successInfo) ? 0.5 : 1 }}
              disabled={selection.length === 0 || isCreating || Boolean(successInfo)}
              title="إنشاء أمر تشغيل موحد للبنود المتوافقة (نفس الموديل والمقاس)"
              onClick={() => void handleCreate()}
            >
              {isCreating ? 'جاري الإنشاء…' : '➕ إنشاء أمر تشغيل مجمع'}
            </button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="modal-alert modal-alert--danger" role="alert" style={{ marginBottom: '16px' }}>
          <div className="modal-alert__content">{actionError}</div>
        </div>
      )}

      {/* ── المعاينة: حصص العملاء والخامات والعجز ──────────────────── */}
      {preview && (
        <section aria-labelledby="pool-preview-title" style={{ marginTop: '20px', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <h3 id="pool-preview-title" style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0 0 16px', color: '#0f172a' }}>
            معاينة التجميع: {preview.product_name} · {preview.variant_label} · إجمالي {fmtQty(preview.total_target_quantity)} قطعة
          </h3>
          {!preview.all_materials_available && (
            <div className="modal-alert modal-alert--warning" role="alert" style={{ marginBottom: '16px' }}>
              <div className="modal-alert__content">⚠️ يوجد عجز في خامات الأمر المجمع — راجع جدول الاحتياجات أدناه قبل الإنشاء.</div>
            </div>
          )}
          {preview.all_materials_available && (
            <p className="form-hint" style={{ color: '#166534', fontWeight: 600, fontSize: '14px', marginBottom: '16px' }}>✅ جميع الخامات المطلوبة متاحة بمخزن الخامات الرئيسي.</p>
          )}

          <h4 style={{ fontSize: '14px', fontWeight: 700, margin: '14px 0 8px', color: '#334155' }}>حصص العملاء في الأمر المجمع:</h4>
          <div className="warehouse-table-wrap" style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflowX: 'auto', marginBottom: '18px' }}>
            <table className="warehouse-table order-detail-table" aria-label="حصص العملاء في الأمر المجمع" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>العميل</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>طلب العميل</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>الكمية المخصصة</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>النسبة</th>
                </tr>
              </thead>
              <tbody>
                {preview.customer_shares.map((s) => (
                  <tr key={s.customer_order_line_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '10px 14px' }}>{s.customer_name}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.customer_order_number}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 700, color: '#0f766e' }}>{fmtQty(s.allocated_quantity)}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtPct(s.percentage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 style={{ fontSize: '14px', fontWeight: 700, margin: '14px 0 8px', color: '#334155' }}>احتياج الخامات المقدر للأمر المجمع:</h4>
          <div className="warehouse-table-wrap" style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflowX: 'auto' }}>
            <table className="warehouse-table order-detail-table" aria-label="احتياج الخامات للأمر المجمع" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>الخامة</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>الوحدة</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>لكل قطعة</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>الاحتياج الكلي</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>المتاح بالمخزن</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>العجز</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {preview.materials.map((m) => (
                  <tr key={m.item_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{m.item_name_ar} <span style={{ color: '#94a3b8', fontWeight: 400 }}>({m.item_code})</span></td>
                    <td style={{ padding: '10px 14px' }}>{m.unit_name_ar}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtQty(m.quantity_per_piece)}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtQty(m.required_quantity)}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtQty(m.available_quantity)}</td>
                    <td style={{ padding: '10px 14px', color: m.shortage_quantity > 0 ? '#dc2626' : undefined, fontWeight: m.shortage_quantity > 0 ? 700 : undefined }}>
                      {fmtQty(m.shortage_quantity)}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ padding: '3px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, background: m.is_sufficient ? '#dcfce7' : '#fee2e2', color: m.is_sufficient ? '#15803d' : '#b91c1c' }}>
                        {m.is_sufficient ? 'متاح' : 'عجز'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── نجاح الإنشاء: الأمر المنشأ وتخصيصات عملائه ─────────────── */}
      {successInfo && (
        <section aria-labelledby="pool-success-title" style={{ marginTop: '20px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '20px' }}>
          <h3 id="pool-success-title" style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0 0 14px', color: '#166534' }}>
            ✅ تم إنشاء أمر التشغيل المجمع {successInfo.order.order_number} ({fmtQty(successInfo.order.target_quantity)} قطعة)
          </h3>
          <div className="warehouse-table-wrap" style={{ border: '1px solid #bbf7d0', borderRadius: '8px', overflowX: 'auto', marginBottom: '16px', background: '#fff' }}>
            <table className="warehouse-table order-detail-table" aria-label="تخصيصات العملاء للأمر المنشأ" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>العميل</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>طلب العميل</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>المخصص</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>المستوفى</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>المتبقي</th>
                  <th style={{ padding: '10px 14px', color: '#475569' }}>نسبة الاستيفاء</th>
                </tr>
              </thead>
              <tbody>
                {successInfo.demands.map((d) => (
                  <tr key={d.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '10px 14px' }}>{d.customer_name}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{d.customer_order_number}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 700, color: '#0f766e' }}>{fmtQty(d.allocated_quantity)}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtQty(d.fulfilled_quantity)}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtQty(d.remaining_quantity)}</td>
                    <td style={{ padding: '10px 14px' }}>{fmtPct(d.fulfillment_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {onOpenOrder && (
              <button type="button" className="btn btn--primary" style={{ height: '38px', padding: '0 18px', background: '#0f766e', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: 'pointer' }} onClick={() => onOpenOrder(successInfo.order.id)}>
                فتح أمر التشغيل ↗
              </button>
            )}
            <button type="button" className="tool" style={{ height: '38px', padding: '0 18px' }} onClick={() => setSuccessInfo(null)}>بدء تجميع جديد</button>
          </div>
        </section>
      )}
    </div>
  );
};
