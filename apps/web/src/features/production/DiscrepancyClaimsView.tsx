/**
 * مساحة «مطالبات فروقات الاستلام» (Phase 4.5 / T2):
 * سجل مطالبات عجز استلام خامات الورشة بين المخزن والإنتاج، مع تصفية بالحالة
 * وتفاصيل كاملة وحسم بواسطة أصحاب warehouse:claims:resolve (أمين المخزن والمدير العام)
 * مع الالتزام بقاعدة Maker-Checker: من أثبت العجز لا يحسم مطالبته.
 * القرارات والتحقق كلها خادمية؛ هذه الشاشة سطح تشغيلي فقط.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  TransferDiscrepancyClaimRead,
  DISCREPANCY_CLAIM_STATUS_BADGE,
  DISCREPANCY_CLAIM_STATUS_AR,
  fetchDiscrepancyClaims,
  fetchOrders,
  ProductionOrder,
} from './productionApi';
import {
  DiscrepancyClaimDetailModal,
  claimStatusBadgeClass,
} from './DiscrepancyClaims';

const fmtQty = (n: number | string): string =>
  Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const fmtDateTime = (value: string): string =>
  new Date(value).toLocaleString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const MFG_TYPE_AR: Record<string, string> = {
  internal: 'داخلي',
  external: 'تشغيل للغير (CMT)',
};

interface DiscrepancyClaimsViewProps {
  /** فتح أمر التشغيل المرتبط بالمطالبة (تنقل إلى أوامر التشغيل) */
  onOpenOrder?: (orderId: string) => void;
}

type StatusFilter = 'all' | 'pending_investigation' | 'accepted_transit_loss' | 'accepted_measurement_error' | 'rejected_under_carrier_liability';

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'الكل' },
  { id: 'pending_investigation', label: 'معلقة' },
  { id: 'accepted_transit_loss', label: 'معتمدة · عجز نقل' },
  { id: 'accepted_measurement_error', label: 'معتمدة · خطأ قياس' },
  { id: 'rejected_under_carrier_liability', label: 'مرفوضة' },
];

export const DiscrepancyClaimsView: React.FC<DiscrepancyClaimsViewProps> = ({ onOpenOrder }) => {
  const { hasPermission } = useAuth();
  // الحسم بصلاحية الخادم الفعلية؛ Maker-Checker يتحقق خادمياً وعلى مستوى المكوّن
  const canResolve = hasPermission('warehouse:claims:resolve');

  const [claims, setClaims] = useState<TransferDiscrepancyClaimRead[]>([]);
  const [ordersMeta, setOrdersMeta] = useState<Record<string, Pick<ProductionOrder, 'id' | 'order_number' | 'customer_name' | 'manufacturing_type' | 'product_name_ar'>>>({});
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedClaim, setSelectedClaim] = useState<TransferDiscrepancyClaimRead | null>(null);

  const loadData = useCallback(async (status: StatusFilter, refreshing = false) => {
    if (refreshing) setIsRefreshing(true); else setIsLoading(true);
    try {
      const [claimsList, ordersList] = await Promise.all([
        fetchDiscrepancyClaims(status === 'all' ? { limit: 200 } : { status, limit: 200 }),
        // إثراء القائمة بالعميل ونمط التصنيع من بيانات أوامر التشغيل الحية
        fetchOrders().catch(() => [] as ProductionOrder[]),
      ]);
      setClaims(claimsList);
      setOrdersMeta(Object.fromEntries(ordersList.map((o) => [o.id, o])));
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof ApiError ? err.message : 'تعذر تحميل مطالبات فروقات الاستلام من الخادم.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadData(statusFilter);
  }, [statusFilter, loadData]);

  const handleResolved = (updated: TransferDiscrepancyClaimRead) => {
    // تحديث الحالة محلياً بعد حسم ناجح دون إعادة تحميل كامل
    setClaims((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    // وإعادة الجلب خلفية لضمان الاتساق مع الخادم (قد تغير فلتر «معلقة» النتيجة)
    void loadData(statusFilter, true);
  };

  const pendingCount = useMemo(() => claims.filter((c) => c.status === 'pending_investigation').length, [claims]);

  return (
    <div className="production-view-container" dir="rtl">
      {/* ── رأس الشاشة ────────────────────────────────────────────── */}
      <div className="prod-toolbar">
        <div className="prod-toolbar__filters" aria-label="تصفية المطالبات بالحالة">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              className={`tool ${statusFilter === f.id ? 'tool--active' : ''}`}
              onClick={() => setStatusFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="tool" onClick={() => void loadData(statusFilter, true)} disabled={isRefreshing}>
          {isRefreshing ? 'جاري التحديث…' : '↻ تحديث'}
        </button>
      </div>

      <section className="claims-summary" aria-label="ملخص المطالبات المعروضة">
        <span>المعروض: <strong>{claims.length}</strong> مطالبة</span>
        <span>معلقة (تمنع إغلاق أوامرها): <strong>{pendingCount}</strong></span>
        {!canResolve && <span>الحسم من صلاحية أمين المخزن أو المدير العام؛ عرضك للمطالبات ومتابعة حالتها فقط.</span>}
      </section>

      {isLoading && <p className="form-hint">جاري تحميل مطالبات فروقات الاستلام…</p>}
      {loadError && (
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">
            <span>{loadError}</span>
            <button type="button" className="modal-alert__resync-btn" onClick={() => void loadData(statusFilter)}>إعادة المحاولة</button>
          </div>
        </div>
      )}

      {!isLoading && !loadError && claims.length === 0 && (
        <p className="form-hint">لا توجد مطالبات مطابقة للفلتر الحالي. تُنشأ المطالبات تلقائياً عند تأكيد استلام الورشة بفرق عن المصروف.</p>
      )}

      {!isLoading && claims.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="order-detail-table" aria-label="سجل مطالبات عجز استلام الخامات">
            <thead>
              <tr>
                <th>رقم المطالبة</th>
                <th>أمر التشغيل</th>
                <th>العميل ونمط التصنيع</th>
                <th>الصنف والوحدة</th>
                <th>المرسل</th>
                <th>المستلم</th>
                <th>الفرق</th>
                <th>مستند التحويل</th>
                <th>مقدّم المطالبة (جهة الاستلام)</th>
                <th>تاريخ الإنشاء</th>
                <th>الحالة</th>
                <th>سبب الفرق / الملاحظات</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => {
                const meta = ordersMeta[c.order_id];
                return (
                  <tr key={c.id}>
                    <td>{c.claim_number}</td>
                    <td>{c.order_number}</td>
                    <td>
                      {meta?.manufacturing_type === 'external' ? (
                        <span>🧵 {MFG_TYPE_AR.external} · العميل: {meta?.customer_name || 'غير محدد'}</span>
                      ) : (
                        <span>🏭 {meta?.manufacturing_type ? MFG_TYPE_AR[meta.manufacturing_type] || meta.manufacturing_type : '—'} · خامات المصنع</span>
                      )}
                    </td>
                    <td>
                      {c.item_name_ar} <span style={{ color: 'var(--text-light)' }}>({c.item_code})</span>
                      {' · '}
                      {c.unit_name_ar}
                    </td>
                    <td>{fmtQty(c.dispatched_quantity)}</td>
                    <td>{fmtQty(c.received_quantity)}</td>
                    <td style={{ color: c.status === 'pending_investigation' ? 'var(--color-danger, #b91c1c)' : undefined, fontWeight: 700 }}>
                      {fmtQty(c.discrepancy_quantity)}
                    </td>
                    <td>{c.transfer_number || '—'}</td>
                    <td>{c.claimed_by}</td>
                    <td>{fmtDateTime(c.created_at)}</td>
                    <td>
                      <span className={claimStatusBadgeClass(c.status)} title={DISCREPANCY_CLAIM_STATUS_AR[c.status] || c.status}>
                        {DISCREPANCY_CLAIM_STATUS_BADGE[c.status] || c.status}
                      </span>
                    </td>
                    <td style={{ maxWidth: '220px' }}>{c.claim_notes || '—'}</td>
                    <td>
                      <button type="button" className="tool" onClick={() => setSelectedClaim(c)}>
                        عرض
                      </button>
                      {onOpenOrder && (
                        <button
                          type="button"
                          className="tool"
                          title="فتح أمر التشغيل المرتبط"
                          onClick={() => onOpenOrder(c.order_id)}
                        >
                          الأمر ↗
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedClaim && (
        <DiscrepancyClaimDetailModal
          claim={selectedClaim}
          isOpen
          onClose={() => setSelectedClaim(null)}
          orderMeta={ordersMeta[selectedClaim.order_id] || null}
          onResolved={handleResolved}
        />
      )}
    </div>
  );
};
