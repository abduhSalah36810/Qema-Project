/**
 * تبويب «المنتج التام» في صفحة تفاصيل أمر التشغيل (T4.2):
 * نموذج استلام المنتج التام لكل مقاس/بند (سليم/مرفوض) + جدول استيفاء حصص طلبات العملاء
 * (المخصص/المستوفى/المتبقي) من بيانات T3. المنطق منقول حرفيًا من تبويب fg_receipt بالـModal القديم.
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  ProductionOrderItem,
  ProductionOrderDemandRead,
  receiveFinishedGoodsApi,
  newIdempotencyKey,
} from '../productionApi';
import { FG_RECEIPT_STATUSES, EPSILON, itemRemaining, toNumber, initialFgLines, type FgLineInput, type SectionContext } from './constants';

interface OrderFinishedGoodsSectionProps {
  ctx: SectionContext;
  orderItems: ProductionOrderItem[];
  /** تخصيصات طلبات العملاء (fetchOrderDemands) — تُعرض كاستيفاء حصص */
  demands: ProductionOrderDemandRead[];
}

const fmtPct = (n: number): string => `${Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 2 })}٪`;

export const OrderFinishedGoodsSection: React.FC<OrderFinishedGoodsSectionProps> = ({ ctx, orderItems, demands }) => {
  const { order, refreshOrder, reportFailure, setStatus, setBusy } = ctx;
  const { hasPermission } = useAuth();
  const canReceiveFinishedGoods = hasPermission('warehouse:finished_goods:receive');
  const isCmt = order.manufacturing_type === 'external';

  const [isProcessing, setIsProcessing] = useState(false);
  const [fgLines, setFgLines] = useState<Record<string, FgLineInput>>(() => initialFgLines(order.items));
  const [fgNotes, setFgNotes] = useState('');
  const [fgIdempotencyKey, setFgIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  useEffect(() => {
    setFgLines(initialFgLines(order.items));
  }, [order.id, order.items]);

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

  const totalTarget = orderItems.reduce((s, it) => s + (it.target_quantity ?? 0), 0);
  const totalAccepted = orderItems.reduce((s, it) => s + (it.received_quantity ?? 0), 0);
  const totalRejected = orderItems.reduce((s, it) => s + (it.rejected_quantity ?? 0), 0);
  const totalRemaining = Math.max(0, totalTarget - totalAccepted);

  // 4. استلام المنتج التام لكل بند
  const handleReceiveFinishedGoods = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fgHasErrors) {
      setStatus({ type: 'error', text: 'راجع كميات الاستلام: لا تقبل قيم سالبة، ولا يتجاوز السليم المتبقي لكل بند.' });
      return;
    }
    if (fgPayloadLines.length === 0) {
      setStatus({ type: 'error', text: 'أدخل كمية سليمة أو مرفوضة لبند واحد على الأقل.' });
      return;
    }
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    let acceptedTotal = 0;
    let receiptStatus = '';
    try {
      const res = await receiveFinishedGoodsApi(order.id, { lines: fgPayloadLines, notes: fgNotes }, fgIdempotencyKey);
      acceptedTotal = res.accepted_quantity;
      receiptStatus = res.receipt_status;
    } catch (err: unknown) {
      reportFailure(err, 'تعذر استلام المنتج التام. تحقق من الكميات وحالة الأمر وصلاحياتك.');
      setIsProcessing(false);
      setBusy(false);
      return;
    }
    setFgIdempotencyKey(newIdempotencyKey());
    setFgNotes('');
    await refreshOrder(
      `تم استلام ${acceptedTotal} قطعة سليمة بمخزن المنتج التام (حالة الاستلام: ${receiptStatus === 'complete' ? 'مكتمل' : 'جزئي'}).`
    );
    setIsProcessing(false);
    setBusy(false);
  };

  return (
    <div className="tab-pane">
      {/* بطاقات المؤشرات التشغيلية للمنتج التام */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>إجمالي المستهدف للأمر</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0f172a', margin: '2px 0' }}>{totalTarget} قطعة</div>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>عبر {orderItems.length} بند / مقاس</div>
        </div>

        <div style={{ padding: '12px 14px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #86efac' }}>
          <div style={{ fontSize: '0.8rem', color: '#166534' }}>المستلم سليم بمخزن التام</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#166534', margin: '2px 0' }}>{totalAccepted} قطعة</div>
          <div style={{ fontSize: '0.75rem', color: '#15803d' }}>
            نسبة الإنجاز: {totalTarget > 0 ? Math.round((totalAccepted / totalTarget) * 100) : 0}%
          </div>
        </div>

        <div style={{ padding: '12px 14px', background: totalRejected > 0 ? '#fef2f2' : '#f8fafc', borderRadius: '8px', border: totalRejected > 0 ? '1px solid #fca5a5' : '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '0.8rem', color: totalRejected > 0 ? '#b91c1c' : '#64748b' }}>المرفوض بفحص الجودة</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: totalRejected > 0 ? '#b91c1c' : '#64748b', margin: '2px 0' }}>{totalRejected} قطعة</div>
          <div style={{ fontSize: '0.75rem', color: totalRejected > 0 ? '#dc2626' : '#94a3b8' }}>
            {totalRejected > 0 ? 'تالف غير مطابق للمواصفات' : 'لا يوجد مرفوض مسجل'}
          </div>
        </div>

        <div style={{ padding: '12px 14px', background: totalRemaining === 0 ? '#f0fdf4' : '#eff6ff', borderRadius: '8px', border: totalRemaining === 0 ? '1px solid #86efac' : '1px solid #bfdbfe' }}>
          <div style={{ fontSize: '0.8rem', color: totalRemaining === 0 ? '#166534' : '#1e40af' }}>المتبقي قيد التشغيل (WIP)</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: totalRemaining === 0 ? '#166534' : '#1e40af', margin: '2px 0' }}>{totalRemaining} قطعة</div>
          <div style={{ fontSize: '0.75rem', color: totalRemaining === 0 ? '#15803d' : '#2563eb' }}>
            {totalRemaining === 0 ? 'اكتمل استلام كافة البنود' : 'بانتظار اكتمال الإنتاج والفحص'}
          </div>
        </div>
      </div>

      {isCmt && (
        <div className="provisional-hint" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', marginBottom: '16px' }}>
          🧵 <strong>أمانة العميل ({order.customer_name || 'العميل'}):</strong> المنتج التام مملوك للعميل؛ الاستلام يرحّل الكميات السليمة مباشرة إلى رصيد العميل الخاص في مخزن المنتج التام ليصبح جاهزاً للتسليم أو التعبئة للعميل، دون اختلاط بمنتجات المصنع التامة.
        </div>
      )}

      <div style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>استلام المنتج التام لكل مقاس/بند</h3>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          {isCmt
            ? 'المنتج التام ملك العميل؛ سجّل لكل بند الكمية السليمة (تدخل مخزن المنتج التام في رصيد العميل) والكمية المرفوضة بالفحص. يمكن الاستلام على دفعات حتى استكمال المستهدف.'
            : 'سجّل لكل بند الكمية السليمة (تدخل مخزن المنتج التام في رصيد مالكها) والكمية المرفوضة بالفحص (لا تدخل المخزون). يمكن الاستلام على دفعات حتى استكمال المستهدف لكل بند.'}
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
              disabled={isProcessing || !canSubmitFg || fgHasErrors || fgPayloadLines.length === 0}
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

      {/* استيفاء حصص طلبات العملاء (للأوامر المجمعة — براند المصنع) */}
      {!isCmt && demands.length > 0 && (
        <section aria-labelledby="fg-fulfillment-title" style={{ marginTop: '24px' }}>
          <h3 id="fg-fulfillment-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>استيفاء حصص طلبات العملاء</h3>
          <p style={{ color: '#64748b', fontSize: '0.875rem' }}>المستوفى من كل حصة يتحدث تلقائياً مع استلام المنتج التام من الخادم.</p>
          <div style={{ overflowX: 'auto' }}>
            <table className="order-detail-table" aria-label="استيفاء حصص طلبات العملاء">
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
                {demands.map((d) => (
                  <tr key={d.id}>
                    <td>{d.customer_name}</td>
                    <td>{d.customer_order_number}</td>
                    <td className="qty-col">{d.allocated_quantity}</td>
                    <td className="qty-col">{d.fulfilled_quantity}</td>
                    <td className="qty-col">{d.remaining_quantity}</td>
                    <td>{fmtPct(d.fulfillment_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};
