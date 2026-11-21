/**
 * قسم «إغلاق أمر التشغيل» (T4.2) — منقول حرفيًا من منطقة الإغلاق في تبويب wip بالـModal القديم.
 * يُعرض أسفل تبويب «التسوية والمرتجعات» وأيضاً داخل تبويب «الإغلاق والتكاليف»
 * (يُركَّب مرة واحدة فقط في كل لحظة، وحالة النموذج مرفوعة إلى الصفحة حتى لا تُفقد عند التنقل).
 */
import React from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import type { OrderWipSummary, OrderClosePayload } from '../productionApi';
import { EPSILON, type SectionContext } from './constants';

export interface CloseFormState {
  discrepancy_signoff: boolean;
  discrepancy_notes: string;
  under_production_reason: string;
  notes: string;
}

interface OrderClosureSectionProps {
  ctx: SectionContext;
  wipSummary: OrderWipSummary | null;
  closeForm: CloseFormState;
  onCloseFormChange: (patch: Partial<CloseFormState>) => void;
  onCloseSubmit: (e: React.FormEvent) => void;
  /** قفل الحالة العامة (معالجة جارية في أي قسم) */
  busy: boolean;
}

export const OrderClosureSection: React.FC<OrderClosureSectionProps> = ({
  ctx, wipSummary, closeForm, onCloseFormChange, onCloseSubmit, busy,
}) => {
  const { order } = ctx;
  const { hasPermission } = useAuth();
  const canCloseOrder = hasPermission('production:orders:close');

  const hasDiscrepancies = (wipSummary?.unresolved_discrepancies_count ?? 0) > 0;
  const isUnderProduced = wipSummary ? wipSummary.total_received_goods + EPSILON < wipSummary.target_quantity : false;
  const blockingReasons: string[] = [];
  if (wipSummary) {
    (wipSummary.blocking_reasons || []).forEach((reason) => {
      if (reason.includes('بالطريق') && wipSummary.pending_transfers_count > 0) {
        const inTransitMats = (wipSummary.materials || []).filter((m) => m.in_transit_quantity > 0);
        if (inTransitMats.length > 0) {
          inTransitMats.forEach((m) => {
            blockingReasons.push(
              `تحويل خامات بالطريق: صنف «${m.item_name_ar}» (كمية: ${m.in_transit_quantity} ${m.unit_name_ar}) · المستلم: مسؤول الإنتاج بالورشة لم يؤكد استلامه بعد.`
            );
          });
        } else if ((order.returns_awaiting_receipt ?? 0) > 0) {
          blockingReasons.push('مرتجع خامات من الورشة بالطريق إلى مخزن الخامات الرئيسي · المستلم: أمين المخزن لم يؤكد استلامه بعد.');
        } else {
          blockingReasons.push(reason);
        }
      } else {
        blockingReasons.push(reason);
      }
    });
    if (blockingReasons.length === 0 && !wipSummary.can_close) {
      if (!wipSummary.stages_completed) blockingReasons.push('أكمل مراحل التشغيل الخمس أولاً.');
      if (Math.abs(wipSummary.net_wip_balance) > EPSILON) blockingReasons.push('سوِّ رصيد خامات الورشة حتى يصبح صفراً.');
    }
  }
  const isProcessing = busy;

  return (
    <>
      <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>إغلاق أمر التشغيل</h3>
      {order.status === 'closed' ? (
        <div style={{ padding: '1rem', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '6px', color: '#166534' }}>
          <strong>✓ أمر التشغيل مغلق نهائياً.</strong>
        </div>
      ) : (
        <>
          <p className="form-hint" style={{ fontSize: '0.875rem' }}>
            المستلم سليم: <strong>{wipSummary?.total_received_goods ?? '—'}</strong> من المستهدف <strong>{wipSummary?.target_quantity ?? '—'}</strong>
            {' · '}فروقات استلام الورشة: <strong>{wipSummary?.unresolved_discrepancies_count ?? '—'}</strong>
          </p>

          {canCloseOrder ? (
            <form onSubmit={onCloseSubmit} style={{ display: 'grid', gap: '0.85rem', marginTop: '0.75rem' }}>
              {hasDiscrepancies && (
                <>
                  <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={closeForm.discrepancy_signoff}
                      onChange={(e) => onCloseFormChange({ discrepancy_signoff: e.target.checked })}
                    />
                    <span>أقر باعتماد فروقات استلام الخامات بالورشة</span>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>ملاحظات اعتماد الفروقات</span>
                    <input
                      className="form-input"
                      value={closeForm.discrepancy_notes}
                      onChange={(e) => onCloseFormChange({ discrepancy_notes: e.target.value })}
                      placeholder="تفاصيل وفروقات الاستلام بالورشة"
                      style={{ width: '100%' }}
                    />
                  </label>
                </>
              )}
              {isUnderProduced && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>سبب العجز الإنتاجي (المستلم أقل من المستهدف) *</span>
                  <textarea
                    className="form-input"
                    value={closeForm.under_production_reason}
                    onChange={(e) => onCloseFormChange({ under_production_reason: e.target.value })}
                    rows={2}
                    placeholder="بيان سبب عدم استكمال كامل الكمية المستهدفة للدفعة"
                    style={{ width: '100%' }}
                  />
                </label>
              )}
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>ملاحظات الإغلاق</span>
                <input
                  className="form-input"
                  value={closeForm.notes}
                  onChange={(e) => onCloseFormChange({ notes: e.target.value })}
                  placeholder="ملاحظات ختامية لأمر التشغيل"
                  style={{ width: '100%' }}
                />
              </label>
              {blockingReasons.length > 0 && (
                <div className="modal-alert modal-alert--warning close-blockers" role="note" id="close-blockers" style={{ margin: '0.5rem 0' }}>
                  <div className="modal-alert__content" style={{ display: 'block' }}>
                    <strong>لا يمكن إغلاق الأمر الآن (موانع الإغلاق):</strong>
                    <ul style={{ margin: '0.35rem 0 0', paddingInlineStart: '1.25rem' }}>
                      {blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  </div>
                </div>
              )}
              {blockingReasons.length === 0 && (
                wipSummary && <p className="form-hint" style={{ color: '#166534' }}>✓ استوفت متطلبات الإغلاق والأمر جاهز للإغلاق النهائي.</p>
              )}
              {blockingReasons.length === 0 && hasDiscrepancies && !closeForm.discrepancy_signoff && (
                <p className="form-hint" role="note" id="close-blockers" style={{ color: '#b91c1c' }}>فعّل إقرار فروقات الاستلام أعلاه ليصبح الإغلاق متاحاً.</p>
              )}
              {blockingReasons.length === 0 && isUnderProduced && closeForm.under_production_reason.trim().length === 0 && (
                <p className="form-hint" role="note" id="close-blockers" style={{ color: '#b91c1c' }}>اكتب سبب نقص الإنتاج أعلاه ليصبح الإغلاق متاحاً.</p>
              )}
              <div>
                <button
                  type="submit"
                  className="btn btn--primary"
                  aria-describedby="close-blockers"
                  disabled={
                    busy ||
                    blockingReasons.length > 0 ||
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
  );
};

export type { OrderClosePayload };
