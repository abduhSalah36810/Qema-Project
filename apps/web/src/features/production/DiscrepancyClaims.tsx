/**
 * مطالبات عجز استلام خامات الورشة (Phase 4.5 / T2) — مكوّن مشترك:
 * - DiscrepancyClaimDetailModal: تفاصيل المطالبة وسياق التحويل ونموذج الحسم بخطوتين.
 * - DiscrepancyClaimsSection: قسم مطالبات أمر التشغيل داخل تبويب التسوية (قابل لنقل إلى مساحة T4).
 * الواجهة تعكس حماية الخادم كما هي: الحسم بصلاحية warehouse:claims:resolve فقط، ومن أثبت
 * العجز (claimed_by) لا يحسمه (Maker-Checker)، والقرارات المتاحة هي الثلاثة المدعومة خادمياً فقط.
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  TransferDiscrepancyClaimRead,
  DISCREPANCY_CLAIM_STATUS_AR,
  DISCREPANCY_CLAIM_STATUS_BADGE,
  DISCREPANCY_CLAIM_DECISIONS,
  DiscrepancyClaimDecision,
  resolveDiscrepancyClaimApi,
  ProductionOrder,
} from './productionApi';

const fmtQty = (n: number | string): string =>
  Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const fmtMoney = (n: number | string): string =>
  Number(n || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDateTime = (value: string): string =>
  new Date(value).toLocaleString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** صنف شارة الحالة على طريقة status-pill القائمة */
export const claimStatusBadgeClass = (status: string): string => {
  if (status === 'pending_investigation') return 'claim-status claim-status--pending';
  if (status.startsWith('accepted')) return 'claim-status claim-status--accepted';
  if (status.startsWith('rejected')) return 'claim-status claim-status--rejected';
  return 'claim-status';
};

// ─── تفاصيل المطالبة والحسم ──────────────────────────────────────────────────

interface DiscrepancyClaimDetailModalProps {
  claim: TransferDiscrepancyClaimRead;
  isOpen: boolean;
  onClose: () => void;
  /** بيانات الأمر المرتبط (لعرض العميل ونمط التصنيع عند انطباقهما) */
  orderMeta?: Pick<ProductionOrder, 'customer_name' | 'manufacturing_type'> | null;
  /** يُستدعى بالمطالبة المحدّثة بعد حسم ناجح خادمياً */
  onResolved: (updated: TransferDiscrepancyClaimRead) => void;
}

export const DiscrepancyClaimDetailModal: React.FC<DiscrepancyClaimDetailModalProps> = ({
  claim, isOpen, onClose, orderMeta, onResolved,
}) => {
  const { hasPermission, user } = useAuth();
  const canResolvePermission = hasPermission('warehouse:claims:resolve');
  const isCreator = Boolean(user?.id && claim.claimed_by === user.id);
  const isPending = claim.status === 'pending_investigation';
  /** الحسم: صلاحية فعلية + مطالبة معلقة + ليست مطالبتَه هو (Maker-Checker) — والخادم يحمي كذلك */
  const canResolve = canResolvePermission && isPending && !isCreator;

  const [decision, setDecision] = useState<DiscrepancyClaimDecision | ''>('');
  const [notes, setNotes] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // مفتاح ثابت لكل محاولة حتى لا يتكرر التنفيذ خادمياً، ويُجدد بعد النجاح فقط
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => `claim-resolve-${claim.id}-${Date.now()}`);

  useEffect(() => {
    if (isOpen) {
      setDecision('');
      setNotes('');
      setConfirmStep(false);
      setIsProcessing(false);
      setErrorText(null);
      setIdempotencyKey(`claim-resolve-${claim.id}-${Date.now()}`);
    }
  }, [isOpen, claim.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isProcessing) onClose();
    };
    if (isOpen) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, isProcessing, onClose]);

  if (!isOpen) return null;

  const chosenDecision = DISCREPANCY_CLAIM_DECISIONS.find((d) => d.value === decision);

  const submitResolve = async () => {
    if (!decision || !canResolve || isProcessing) return;
    setIsProcessing(true);
    setErrorText(null);
    try {
      const updated = await resolveDiscrepancyClaimApi(
        claim.id,
        { decision: decision as DiscrepancyClaimDecision, resolution_notes: notes.trim() },
        idempotencyKey,
      );
      setIdempotencyKey(`claim-resolve-${claim.id}-${Date.now()}`);
      onResolved(updated);
      onClose();
    } catch (err: unknown) {
      // رسائل الخادم الواضحة تُعرض كما هي: 409 حسم مسبق أو فصل مسؤوليات، 403 صلاحية، 422 بيانات ناقصة
      setErrorText(err instanceof ApiError || err instanceof Error ? err.message : 'تعذر إرسال قرار الحسم إلى الخادم.');
      setConfirmStep(false);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={`تفاصيل المطالبة ${claim.claim_number}`}>
      <div className="modal-card modal-card--lg" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <div>
            <div className="modal-badge-row">
              <span className="order-code-badge">{claim.claim_number}</span>
              <span className={claimStatusBadgeClass(claim.status)}>
                {DISCREPANCY_CLAIM_STATUS_BADGE[claim.status] || claim.status}
              </span>
            </div>
            <h2 className="modal-title">مطالبة عجز استلام خامات الورشة</h2>
            <p className="modal-subtitle">
              أمر التشغيل {claim.order_number} · تحويل {claim.transfer_number || '—'}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="إغلاق">✕</button>
        </div>

        <div className="modal-body">
          {/* بيانات المطالبة والفرق */}
          <table className="order-detail-table" aria-label="بيانات الفرق">
            <thead>
              <tr>
                <th>الصنف</th>
                <th>الوحدة</th>
                <th>المرسل من المخزن</th>
                <th>المستلم بالورشة</th>
                <th>الفرق (العجز)</th>
                <th>تكلفة الفرق</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{claim.item_name_ar} <span style={{ color: 'var(--text-light)' }}>({claim.item_code})</span></td>
                <td>{claim.unit_name_ar}</td>
                <td>{fmtQty(claim.dispatched_quantity)}</td>
                <td>{fmtQty(claim.received_quantity)}</td>
                <td style={{ color: 'var(--color-danger, #b91c1c)', fontWeight: 700 }}>{fmtQty(claim.discrepancy_quantity)}</td>
                <td>{fmtMoney(claim.total_cost)} ج.م</td>
              </tr>
            </tbody>
          </table>

          <div className="claim-meta-grid">
            <span>مقدّم المطالبة (مثبِت العجز بالورشة): <strong>{claim.claimed_by}</strong></span>
            <span>تاريخ إنشاء المطالبة: <strong>{fmtDateTime(claim.created_at)}</strong></span>
            <span>بند التحويل: <strong>{claim.transfer_line_id}</strong></span>
            {orderMeta?.manufacturing_type === 'external' && (
              <span>
                🧵 تشغيل للغير (CMT) — العميل: <strong>{orderMeta.customer_name || 'غير محدد'}</strong>
              </span>
            )}
          </div>

          {claim.claim_notes && (
            <p className="form-hint" role="note">ملاحظات مقدّم المطالبة عند الإثبات: {claim.claim_notes}</p>
          )}

          {/* الحالة بعد الحسم */}
          {!isPending && (
            <div className="modal-alert modal-alert--success" role="status">
              <div className="modal-alert__content" style={{ display: 'block' }}>
                <strong>تم حسم هذه المطالبة مسبقاً:</strong> {DISCREPANCY_CLAIM_STATUS_AR[claim.status] || claim.status}
                <ul style={{ margin: '0.25rem 0 0', paddingInlineStart: '1.25rem' }}>
                  <li>الحاسم: {claim.resolved_by || '—'} · بتاريخ: {claim.resolved_at ? fmtDateTime(claim.resolved_at) : '—'}</li>
                  <li>بيان القرار: {claim.resolution_notes || '—'}</li>
                </ul>
              </div>
            </div>
          )}

          {/* سبب عدم توفر الحسم: الصلاحية أو Maker-Checker */}
          {isPending && !canResolve && (
            <div className="modal-alert modal-alert--warning" role="note">
              <div className="modal-alert__content">
                {isCreator
                  ? 'لا يجوز لمن أثبت العجز بالورشة أن يحسم مطالبته بنفسه (فصل المسؤوليات). يتولى الحسم أمين المخزن أو المدير العام.'
                  : 'الحسم من صلاحية أمين المخزن أو المدير العام فقط؛ يمكنك متابعة حالة التحقيق فقط.'}
              </div>
            </div>
          )}

          {/* نموذج الحسم — القرارات المدعومة خادمياً فقط */}
          {canResolve && !confirmStep && (
            <form
              onSubmit={(e) => { e.preventDefault(); if (decision && notes.trim().length >= 3) setConfirmStep(true); }}
              style={{ display: 'grid', gap: '0.75rem' }}
              aria-label="نموذج حسم المطالبة"
            >
              <label>
                قرار الحسم *
                <select
                  required
                  value={decision}
                  onChange={(e) => setDecision(e.target.value as DiscrepancyClaimDecision)}
                  aria-label="قرار الحسم"
                >
                  <option value="">— اختر قراراً —</option>
                  {DISCREPANCY_CLAIM_DECISIONS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </label>
              {chosenDecision && (
                <p className="form-hint" role="note">أثر القرار المخزني: {chosenDecision.impact}</p>
              )}
              <label>
                بيان وأسباب القرار (إلزامي · 3 أحرف على الأقل) *
                <textarea
                  required
                  rows={3}
                  minLength={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  aria-label="بيان قرار الحسم"
                />
              </label>
              {errorText && <p className="field-error" role="alert">{errorText}</p>}
              <div>
                <button type="submit" className="btn btn--primary" disabled={!decision || notes.trim().length < 3}>
                  متابعة إلى التأكيد النهائي
                </button>
              </div>
            </form>
          )}

          {/* ملخص التأكيد النهائي قبل الإرسال */}
          {canResolve && confirmStep && chosenDecision && (
            <div className="claim-confirm-box" role="alertdialog" aria-label="تأكيد قرار الحسم النهائي">
              <strong>تأكيد نهائي قبل إرسال القرار:</strong>
              <ul style={{ margin: '0.35rem 0 0', paddingInlineStart: '1.25rem' }}>
                <li>المطالبة: {claim.claim_number} · الصنف: {claim.item_name_ar}</li>
                <li>
                  الكمية محل التسوية: <strong>{fmtQty(claim.discrepancy_quantity)} {claim.unit_name_ar}</strong>
                  {' '}(من أصل مُرسل {fmtQty(claim.dispatched_quantity)} ومستلم {fmtQty(claim.received_quantity)})
                  · تكلفة الفرق: {fmtMoney(claim.total_cost)} ج.م
                </li>
                <li>القرار: {chosenDecision.label}</li>
                <li>أثر القرار: {chosenDecision.impact}</li>
                <li>بيان القرار: «{notes.trim()}»</li>
                <li>القرار نهائي ولا يمكن تعديله أو تكراره بعد الحسم (الخادم يرفض أي حسم ثانٍ).</li>
              </ul>
              {errorText && <p className="field-error" role="alert">{errorText}</p>}
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={isProcessing}
                  onClick={() => void submitResolve()}
                >
                  {isProcessing ? 'جاري إرسال القرار…' : 'تأكيد الحسم نهائياً'}
                </button>
                <button type="button" className="btn" disabled={isProcessing} onClick={() => setConfirmStep(false)}>
                  رجوع وتعديل
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── قسم مطالبات أمر التشغيل (داخل تبويب التسوية) ────────────────────────────

interface DiscrepancyClaimsSectionProps {
  claims: TransferDiscrepancyClaimRead[];
  isLoading: boolean;
  errorText: string | null;
  onRetry: () => void;
  onOpenClaim: (claim: TransferDiscrepancyClaimRead) => void;
}

export const DiscrepancyClaimsSection: React.FC<DiscrepancyClaimsSectionProps> = ({
  claims, isLoading, errorText, onRetry, onOpenClaim,
}) => {
  const pendingClaims = claims.filter((c) => c.status === 'pending_investigation');
  const resolvedClaims = claims.filter((c) => c.status !== 'pending_investigation');
  return (
    <section aria-labelledby="order-claims-title" style={{ marginBottom: '16px' }}>
      <h3 id="order-claims-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>
        مطالبات عجز استلام الخامات ({claims.length})
      </h3>
      <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
        تُنشأ تلقائياً عند فرق استلام الورشة، ويحسمها أمين المخزن أو المدير العام؛ الأمر لا يُغلق قبل حسم المطالبات المعلقة.
      </p>

      {isLoading && <p className="form-hint">جاري تحميل مطالبات الأمر…</p>}
      {errorText && (
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">
            <span>{errorText}</span>
            <button type="button" className="modal-alert__resync-btn" onClick={onRetry}>إعادة المحاولة</button>
          </div>
        </div>
      )}

      {pendingClaims.length > 0 && (
        <div className="modal-alert modal-alert--warning claim-close-blocker" role="alert">
          <div className="modal-alert__content" style={{ display: 'block' }}>
            <strong>يمنع الإغلاق:</strong> يوجد {pendingClaims.length} مطالبة معلقة بانتظار حسم أمين المخزن.
            لا يمكن إغلاق أمر التشغيل قبل حسمها — الخادم يرفض الإغلاق أيضاً عند وجود مطالبات معلقة.
          </div>
        </div>
      )}

      {!isLoading && claims.length === 0 && !errorText && (
        <p className="form-hint">لا توجد مطالبات عجز استلام على هذا الأمر.</p>
      )}

      {claims.length > 0 && (
        <table className="order-detail-table" aria-label="مطالبات عجز استلام الخامات">
          <thead>
            <tr>
              <th>رقم المطالبة</th>
              <th>الصنف</th>
              <th>المرسل</th>
              <th>المستلم</th>
              <th>الفرق</th>
              <th>الحالة</th>
              <th>تاريخ الإنشاء</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...pendingClaims, ...resolvedClaims].map((c) => (
              <tr key={c.id}>
                <td>{c.claim_number}</td>
                <td>{c.item_name_ar} <span style={{ color: 'var(--text-light)' }}>({c.item_code})</span></td>
                <td>{fmtQty(c.dispatched_quantity)}</td>
                <td>{fmtQty(c.received_quantity)}</td>
                <td style={{ color: c.status === 'pending_investigation' ? 'var(--color-danger, #b91c1c)' : undefined, fontWeight: 600 }}>
                  {fmtQty(c.discrepancy_quantity)} {c.unit_name_ar}
                </td>
                <td><span className={claimStatusBadgeClass(c.status)}>{DISCREPANCY_CLAIM_STATUS_BADGE[c.status] || c.status}</span></td>
                <td>{fmtDateTime(c.created_at)}</td>
                <td>
                  <button type="button" className="tool" onClick={() => onOpenClaim(c)}>
                    عرض التفاصيل
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};
