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
  const hardCloseBlockers: string[] = [];
  if (wipSummary) {
    if (!wipSummary.stages_completed) hardCloseBlockers.push('أكمل مراحل التشغيل الخمس أولاً.');
    if (wipSummary.pending_transfers_count > 0) hardCloseBlockers.push('يوجد تحويل خامات بالطريق (صرف أو مرتجع ورشة) لم يؤكد استلامه بعد.');
    if ((wipSummary.returns_pending_resolution_count ?? 0) > 0) {
      hardCloseBlockers.push('في مرتجعات الورشة عجز أو كميات مرفوضة تنتظر قرار التسوية (قسم المرتجعات أعلاه).');
    }
    if (Math.abs(wipSummary.net_wip_balance) > EPSILON) hardCloseBlockers.push('سوِّ رصيد خامات الورشة حتى يصبح صفراً (من نموذج التسوية أعلاه).');
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
          <p className="form-hint">
            المستلم سليم: <strong>{wipSummary?.total_received_goods ?? '—'}</strong> من المستهدف <strong>{wipSummary?.target_quantity ?? '—'}</strong>
            {' · '}فروقات استلام الورشة: <strong>{wipSummary?.unresolved_discrepancies_count ?? '—'}</strong>
          </p>
          {(wipSummary?.blocking_reasons.length ?? 0) > 0 ? (
            <div className="modal-alert modal-alert--warning">
              <div className="modal-alert__content" style={{ display: 'block' }}>
                <strong>ما يمنع الإغلاق حالياً:</strong>
                <ul style={{ margin: '0.25rem 0 0', paddingInlineStart: '1.25rem' }}>
                  {wipSummary?.blocking_reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              </div>
            </div>
          ) : (
            wipSummary && <p className="form-hint" style={{ color: '#166534' }}>الأمر جاهز للإغلاق.</p>
          )}

          {canCloseOrder ? (
            <form onSubmit={onCloseSubmit} style={{ display: 'grid', gap: '0.75rem', marginTop: '0.75rem' }}>
              {hasDiscrepancies && (
                <>
                  <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={closeForm.discrepancy_signoff}
                      onChange={(e) => onCloseFormChange({ discrepancy_signoff: e.target.checked })}
                    />
                    أقر باعتماد فروقات استلام الخامات بالورشة
                  </label>
                  <label>
                    ملاحظات اعتماد الفروقات
                    <input
                      value={closeForm.discrepancy_notes}
                      onChange={(e) => onCloseFormChange({ discrepancy_notes: e.target.value })}
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
                    onChange={(e) => onCloseFormChange({ under_production_reason: e.target.value })}
                    rows={2}
                    style={{ width: '100%' }}
                  />
                </label>
              )}
              <label>
                ملاحظات الإغلاق
                <input
                  value={closeForm.notes}
                  onChange={(e) => onCloseFormChange({ notes: e.target.value })}
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
  );
};

export type { OrderClosePayload };
