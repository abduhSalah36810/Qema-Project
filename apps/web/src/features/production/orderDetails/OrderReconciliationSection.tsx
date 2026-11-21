/**
 * تبويب «التسوية والمرتجعات» في صفحة تفاصيل أمر التشغيل (T4.2):
 * - مطالبات عجز استلام الخامات (T2) مع نافذة التفاصيل والحسم.
 * - نموذج تسوية خامات الورشة (مستهلك/مرتجع/تالف) بقيود الرصيد.
 * - لوحة مرتجعات الورشة + بطاقة تسوية المصنعية لأوامر التشغيل للغير (CMT) — عرضية من حقول موجودة.
 * - قسم إغلاق أمر التشغيل أسفل التبويب (عقد اختبار T13: زر الإغلاق داخل تبويب التسوية).
 * المنطق منقول حرفيًا من تبويب wip بالـModal القديم.
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  DiscrepancyClaimsSection,
} from '../DiscrepancyClaims';
import { WorkshopReturnsPanel } from '../WorkshopReturnsPanel';
import {
  OrderWipSummary,
  TransferDiscrepancyClaimRead,
  reconcileOrderMaterialsApi,
  newIdempotencyKey,
} from '../productionApi';
import {
  EPSILON,
  RECONCILIATION_STATUSES,
  RETURN_CONDITION_LABELS,
  round6,
  toNumber,
  fmtQty,
  type ReconInput,
  type SectionContext,
} from './constants';
import { OrderClosureSection, type CloseFormState } from './OrderClosureSection';

interface OrderReconciliationSectionProps {
  ctx: SectionContext;
  wipSummary: OrderWipSummary | null;
  wipLoading: boolean;
  wipError: string | null;
  onRetryWip: () => void;
  claims: TransferDiscrepancyClaimRead[];
  claimsLoading: boolean;
  claimsError: string | null;
  onRetryClaims: () => void;
  onOpenClaim: (claim: TransferDiscrepancyClaimRead | null) => void;
  returnsVersion: number;
  /** bumped بعد كل تسوية ناجحة لإعادة تركيب لوحة المرتجعات */
  onReturnsChanged: () => void;
  reloadWip: () => Promise<void>;
  closeForm: CloseFormState;
  onCloseFormChange: (patch: Partial<CloseFormState>) => void;
  onCloseSubmit: (e: React.FormEvent) => void;
  busy: boolean;
}

export const OrderReconciliationSection: React.FC<OrderReconciliationSectionProps> = ({
  ctx, wipSummary, wipLoading, wipError, onRetryWip,
  claims, claimsLoading, claimsError, onRetryClaims,
  onOpenClaim,
  returnsVersion, onReturnsChanged, reloadWip,
  closeForm, onCloseFormChange, onCloseSubmit, busy,
}) => {
  const { order, refreshOrder, reportFailure, setStatus, setBusy } = ctx;
  const { hasPermission, user } = useAuth();
  const canReconcile = hasPermission('production:orders:manage');
  const canReceiveReturns = hasPermission('warehouse:returns:receive');
  const canResolveReturns = hasPermission('production:returns:resolve');
  const isCmt = order.manufacturing_type === 'external';

  const [isProcessing, setIsProcessing] = useState(false);
  const [reconInputs, setReconInputs] = useState<Record<string, ReconInput>>({});
  const [reconNotes, setReconNotes] = useState('');
  const [reconIdempotencyKey, setReconIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  // مزامنة سلوك الـModal القديم: كل تحديث لملخص الورشة يصفّر مدخلات التسوية
  useEffect(() => {
    setReconInputs(() => {
      const next: Record<string, ReconInput> = {};
      (wipSummary?.materials || []).forEach((m) => {
        next[m.item_id] = { consumed: '', returned: '', scrapped: '', notes: '', condition: 'good' };
      });
      return next;
    });
  }, [wipSummary]);

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
      setStatus({ type: 'error', text: 'مجموع المستهلك والمرتجع والتالف لكل خامة يجب ألا يتجاوز رصيدها الحالي بالورشة.' });
      return;
    }
    if (reconPayloadLines.length === 0) {
      setStatus({ type: 'error', text: 'أدخل كمية مستهلكة أو مرتجعة أو تالفة لخامة واحدة على الأقل.' });
      return;
    }
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    let reconNumber = '';
    let returnNumber = '';
    try {
      const res = await reconcileOrderMaterialsApi(order.id, { lines: reconPayloadLines, notes: reconNotes }, reconIdempotencyKey);
      reconNumber = res.reconciliation_number;
      returnNumber = res.return_transfer_number || '';
    } catch (err: unknown) {
      reportFailure(err, 'تعذر تسجيل تسوية خامات الورشة.');
      setIsProcessing(false);
      setBusy(false);
      return;
    }
    setReconIdempotencyKey(newIdempotencyKey());
    setReconNotes('');
    await reloadWip();
    onReturnsChanged();
    await refreshOrder(
      returnNumber
        ? `تم تسجيل تسوية خامات الورشة (${reconNumber}). المرتجع بالطريق برقم ${returnNumber} وينتظر فحص واستلام أمين المخزن قبل أن يدخل رصيد الخامات.`
        : `تم تسجيل تسوية خامات الورشة (${reconNumber}).`
    );
    setIsProcessing(false);
    setBusy(false);
  };

  return (
    <div className="tab-pane">
      <div style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>تسوية خامات الورشة</h3>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          سجّل مصير رصيد كل خامة بالورشة: المستهلك فعلياً، والمرتجع لمخزن الخامات، والتالف. لا يتجاوز مجموعها الرصيد الحالي للخامة.
        </p>
      </div>

      {/* مطالبات عجز استلام الخامات (Phase 4.5 T2): المعلقة منها تمنع إغلاق الأمر */}
      <DiscrepancyClaimsSection
        claims={claims}
        isLoading={claimsLoading}
        errorText={claimsError}
        onRetry={onRetryClaims}
        onOpenClaim={(c) => onOpenClaim(c)}
      />

      {wipLoading && <p className="form-hint">جاري تحميل ملخص خامات الورشة…</p>}
      {wipError && (
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">
            <span>{wipError}</span>
            <button type="button" className="modal-alert__resync-btn" onClick={onRetryWip}>إعادة المحاولة</button>
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

          {/* بطاقة تسوية المصنعية لأوامر التشغيل للغير (CMT) — عرضية من حقول الأمر، لا منطق جديد (G-4.1-6) */}
          {isCmt && order.materials.length > 0 && (
            <section aria-labelledby="cmt-settlement-title" style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
              <h4 id="cmt-settlement-title" style={{ fontSize: '0.95rem', fontWeight: 600, color: '#92400e' }}>
                🧵 تسوية خامات العميل (CMT) — أمانة تُحسم عند الإغلاق
              </h4>
              <div style={{ overflowX: 'auto' }}>
                <table className="preview-table table--compact" aria-label="تسوية خامات العميل">
                  <thead>
                    <tr>
                      <th>الخامة</th>
                      <th>الملكية</th>
                      <th>المعاملة التجارية</th>
                      <th>المخطط</th>
                      <th>المستهلك الفعلي</th>
                      <th>الهالك الفعلي</th>
                      <th>المرتجع الفعلي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.materials.map((m) => (
                      <tr key={m.id}>
                        <td><strong>{m.item_name_ar}</strong></td>
                        <td>{m.supplied_by === 'customer' ? 'أمانة العميل' : 'المصنع'}</td>
                        <td>{m.commercial_treatment === 'billed_separately' ? 'فاتورة منفصلة' : 'ضمن مصنعية التشغيل'}</td>
                        <td className="qty-col">{fmtQty(Number(m.planned_quantity))}</td>
                        <td className="qty-col">{fmtQty(Number(m.actual_consumed_quantity ?? 0))}</td>
                        <td className={`qty-col ${(m.actual_waste_quantity ?? 0) > 0 ? 'diff--neg' : ''}`}>{fmtQty(Number(m.actual_waste_quantity ?? 0))}</td>
                        <td className="qty-col">{fmtQty(Number(m.actual_returned_quantity ?? 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(order.excess_waste_qty || 0) > 0 && (
                <p style={{ color: '#b91c1c', fontSize: '0.875rem', marginTop: '8px' }}>
                  ⚠️ تجاوز سقف الهالك المعتمد ({order.allowed_waste_pct ?? '1.5'}%) بمقدار {Number(order.excess_waste_qty).toFixed(2)} — يُعرض للعميل عند الإغلاق.
                </p>
              )}
            </section>
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
                {reconMaterials.length === 0 ? (
                  <tr><td colSpan={11} className="empty-materials">لا توجد خامات مسجلة لهذا الأمر.</td></tr>
                ) : reconMaterials.map((m) => {
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
                          {(Object.keys(RETURN_CONDITION_LABELS) as Array<keyof typeof RETURN_CONDITION_LABELS>).map((c) => (
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
                  <label style={{ flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>ملاحظات التسوية</span>
                    <input
                      className="form-input"
                      value={reconNotes}
                      onChange={(e) => setReconNotes(e.target.value)}
                      placeholder="تفاصيل وقرارات تسوية خامات الورشة"
                      style={{ width: '100%' }}
                    />
                  </label>
                  <button
                    type="submit"
                    className="btn btn--teal"
                    disabled={busy || isProcessing || reconHasErrors || reconPayloadLines.length === 0}
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
              await reloadWip();
              await refreshOrder(message);
            }}
          />

          <hr style={{ margin: '1.5rem 0', border: 'none', borderTop: '1px solid #e2e8f0' }} />

          <OrderClosureSection
            ctx={ctx}
            wipSummary={wipSummary}
            closeForm={closeForm}
            onCloseFormChange={onCloseFormChange}
            onCloseSubmit={onCloseSubmit}
            busy={busy}
          />
        </>
      )}

      {/* تفاصيل مطالبة عجز الاستلام والحسم تُدار على مستوى الصفحة الرئيسية للأمر */}
    </div>
  );
};
