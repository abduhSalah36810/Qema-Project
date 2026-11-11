import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { userLabel } from '@/lib/userLabel';
import { useAuth } from '@/features/auth/AuthContext';
import { useDialog } from '@/components/feedback/DialogProvider';
import {
  fetchCustomerReturns,
  fetchReturnableDeliveries,
  inspectCustomerReturn,
  recordCustomerReturn,
  RETURN_CONDITION_LABELS,
  RETURN_DISPOSITION_LABELS,
  type CustomerReturn,
  type ReturnableDelivery,
  type ReturnCondition,
} from './customersApi';

/**
 * مرتجعات العملاء:
 * 1. تسجيل مرتجع على سند تسليم (كمية لا تتجاوز المسلم ناقص المرتجع سابقاً) مع السبب والحالة الظاهرة.
 *    البضاعة تدخل «تحت الفحص» ولا تصبح متاحة للبيع، وتُخصم قيمتها من حساب العميل (بلا استرداد نقدي تلقائي).
 * 2. الفحص: لكل سطر الكمية الصالحة للبيع (تعود للرصيد) والتالفة (تُعدم كهالك ولا تختلط بالرصيد).
 * الخادم يفرض الصلاحيات والكميات؛ الواجهة تتحقق قبل الإرسال وتطلب تأكيداً قبل كل ترحيل.
 */

const EPS = 1e-9;

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

const fmt = (n: number) => n.toLocaleString('ar-EG', { maximumFractionDigits: 3 });
const fmtDate = (value?: string | null) =>
  value ? new Date(value).toLocaleString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `ret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const DISPOSITION_BADGE: Record<string, string> = {
  pending_inspection: 'waiting',
  restocked: 'done',
  partially_restocked: 'action',
  scrapped: 'rejected',
};

type DraftLine = { qty: string; condition: ReturnCondition; notes: string };
type InspectLine = { restocked: string; scrapped: string };

export function CustomerReturnsView() {
  const { hasPermission, user } = useAuth();
  const canManage = hasPermission('customers:deliveries:manage');
  const dialog = useDialog();

  const [tab, setTab] = useState<'pending' | 'inspected'>('pending');
  const [returns, setReturns] = useState<CustomerReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  // تسجيل مرتجع
  const [recordOpen, setRecordOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deliveries, setDeliveries] = useState<ReturnableDelivery[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ReturnableDelivery | null>(null);
  const [reason, setReason] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [formError, setFormError] = useState('');
  const recordKey = useRef<string>(newKey());

  // الفحص
  const [inspecting, setInspecting] = useState<CustomerReturn | null>(null);
  const [inspect, setInspect] = useState<Record<string, InspectLine>>({});
  const [inspectNotes, setInspectNotes] = useState('');
  const [inspectError, setInspectError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReturns(await fetchCustomerReturns({ status: tab }));
    } catch (err) {
      setError(errorText(err, 'تعذر تحميل المرتجعات.'));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const searchDeliveries = useCallback(async (term: string) => {
    setSearching(true);
    try {
      setDeliveries(await fetchReturnableDeliveries(term));
    } catch (err) {
      setFormError(errorText(err, 'تعذر تحميل سندات التسليم.'));
    } finally {
      setSearching(false);
    }
  }, []);

  const openRecord = () => {
    setRecordOpen(true);
    setSelected(null);
    setReason('');
    setReceivedBy('');
    setDraft({});
    setFormError('');
    setSearch('');
    recordKey.current = newKey();
    void searchDeliveries('');
  };

  const chooseDelivery = (d: ReturnableDelivery) => {
    setSelected(d);
    setDraft(Object.fromEntries(d.lines.map((l) => [l.delivery_line_id, { qty: '', condition: 'unknown' as ReturnCondition, notes: '' }])));
    setFormError('');
  };

  const lineError = (lineId: string): string | null => {
    const line = selected?.lines.find((l) => l.delivery_line_id === lineId);
    const value = draft[lineId]?.qty ?? '';
    if (!line || value === '') return null;
    const q = Number(value);
    if (!Number.isFinite(q) || q < 0) return 'كمية غير صالحة';
    if (q > line.returnable_quantity + EPS) return `أكبر من المتاح للإرجاع (${fmt(line.returnable_quantity)})`;
    return null;
  };

  const chosenLines = useMemo(
    () => (selected ? selected.lines.filter((l) => Number(draft[l.delivery_line_id]?.qty || 0) > 0) : []),
    [selected, draft],
  );

  const submitRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (reason.trim().length < 3) {
      setFormError('اكتب سبب المرتجع (مثلاً: عيب خياطة، مقاس خطأ).');
      return;
    }
    if (selected.lines.some((l) => lineError(l.delivery_line_id))) {
      setFormError('راجع الكميات المعلَّمة قبل التسجيل.');
      return;
    }
    if (chosenLines.length === 0) {
      setFormError('اكتب كمية مرتجعة لبند واحد على الأقل.');
      return;
    }
    const summary = chosenLines.map((l) => `${l.product_name} (${l.variant_info}): ${fmt(Number(draft[l.delivery_line_id].qty))}`).join('، ');
    const confirmed = await dialog.confirm({
      title: `تسجيل مرتجع على ${selected.delivery_number}؟`,
      message: `${summary}. تدخل البضاعة «تحت الفحص» ولا تُتاح للبيع قبل الفحص، وتُخصم قيمتها من حساب العميل. أي استرداد نقدي يتم بسند صرف منفصل من المدير المالي.`,
      confirmLabel: 'تسجيل المرتجع',
    });
    if (!confirmed) return;
    setBusy(true);
    setFormError('');
    try {
      const created = await recordCustomerReturn(selected.customer_id, selected.order_id, selected.delivery_id, {
        reason: reason.trim(),
        received_by: receivedBy.trim(),
        idempotency_key: recordKey.current,
        lines: chosenLines.map((l) => ({
          delivery_line_id: l.delivery_line_id,
          quantity: Number(draft[l.delivery_line_id].qty),
          condition: draft[l.delivery_line_id].condition,
          notes: draft[l.delivery_line_id].notes.trim(),
        })),
      });
      setRecordOpen(false);
      setSuccess(`تم تسجيل المرتجع ${created.return_number}. البضاعة الآن تحت الفحص.`);
      setTab('pending');
      await load();
    } catch (err) {
      setFormError(errorText(err, 'تعذر تسجيل المرتجع.'));
    } finally {
      setBusy(false);
    }
  };

  const openInspect = (ret: CustomerReturn) => {
    setInspecting(ret);
    setInspectNotes('');
    setInspectError('');
    setInspect(
      Object.fromEntries(
        ret.lines.map((l) => [
          l.id,
          l.condition === 'damaged' ? { restocked: '0', scrapped: String(l.quantity) } : { restocked: String(l.quantity), scrapped: '0' },
        ]),
      ),
    );
  };

  const inspectLineError = (lineId: string, qty: number): string | null => {
    const v = inspect[lineId];
    if (!v) return null;
    const r = Number(v.restocked);
    const d = Number(v.scrapped);
    if (!Number.isFinite(r) || !Number.isFinite(d) || r < 0 || d < 0) return 'كميات غير صالحة';
    if (Math.abs(r + d - qty) > EPS) return `الصالح + التالف يجب أن يساوي ${fmt(qty)}`;
    return null;
  };

  const submitInspect = async () => {
    if (!inspecting) return;
    if (inspecting.lines.some((l) => inspectLineError(l.id, l.quantity))) {
      setInspectError('راجع كميات الفحص المعلَّمة.');
      return;
    }
    const restocked = inspecting.lines.reduce((s, l) => s + Number(inspect[l.id].restocked), 0);
    const scrapped = inspecting.lines.reduce((s, l) => s + Number(inspect[l.id].scrapped), 0);
    const confirmed = await dialog.confirm({
      title: `اعتماد فحص ${inspecting.return_number}؟`,
      message: `يعود ${fmt(restocked)} قطعة للرصيد القابل للبيع، ويُعدم ${fmt(scrapped)} قطعة كهالك تالف. لا يمكن التراجع عن الفحص.`,
      confirmLabel: 'اعتماد الفحص',
      tone: scrapped > 0 ? 'danger' : undefined,
    });
    if (!confirmed) return;
    setBusy(true);
    setInspectError('');
    try {
      await inspectCustomerReturn(inspecting.customer_id, inspecting.id, {
        notes: inspectNotes.trim(),
        lines: inspecting.lines.map((l) => ({
          return_line_id: l.id,
          restocked_quantity: Number(inspect[l.id].restocked),
          scrapped_quantity: Number(inspect[l.id].scrapped),
        })),
      });
      setSuccess(`تم اعتماد فحص المرتجع ${inspecting.return_number}.`);
      setInspecting(null);
      await load();
    } catch (err) {
      setInspectError(errorText(err, 'تعذر اعتماد الفحص.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="returns-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">المبيعات والتسليم والمخازن</span>
          <h2 id="returns-title">مرتجعات العملاء</h2>
          <p>
            تسجيل البضاعة التي أعادها العميل على سند التسليم، ثم فحصها: الصالح يعود للبيع، والتالف يُعدم ولا يختلط بالرصيد.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {canManage && (
            <button type="button" className="btn btn--teal" onClick={openRecord} disabled={busy}>
              ＋ تسجيل مرتجع
            </button>
          )}
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
            ↻ تحديث
          </button>
        </div>
      </header>

      {error && <div className="modal-alert modal-alert--danger" role="alert"><div className="modal-alert__content">{error}</div></div>}
      {success && <div className="modal-alert modal-alert--success" role="status"><div className="modal-alert__content">✓ {success}</div></div>}

      <div className="tab-bar" role="tablist" style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0' }}>
        <button type="button" role="tab" aria-selected={tab === 'pending'} className={`tab-btn ${tab === 'pending' ? 'tab-btn--active' : ''}`} onClick={() => setTab('pending')}>
          بانتظار الفحص
        </button>
        <button type="button" role="tab" aria-selected={tab === 'inspected'} className={`tab-btn ${tab === 'inspected' ? 'tab-btn--active' : ''}`} onClick={() => setTab('inspected')}>
          السجل (تم الفحص)
        </button>
      </div>

      {loading ? (
        <p className="form-hint">جاري تحميل المرتجعات…</p>
      ) : returns.length === 0 ? (
        <p className="form-hint">{tab === 'pending' ? 'لا توجد مرتجعات بانتظار الفحص.' : 'لا يوجد سجل مرتجعات مفحوصة بعد.'}</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {returns.map((ret) => (
            <article key={ret.id} className="customer-return-card" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.85rem' }}>
              <header style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                  <strong>{ret.return_number}</strong>{' '}
                  <span className={`status-badge status-badge--${DISPOSITION_BADGE[ret.disposition] ?? 'muted'}`}>
                    {RETURN_DISPOSITION_LABELS[ret.disposition] ?? ret.disposition}
                  </span>
                  <div className="form-hint">
                    {ret.customer_name} ({ret.customer_code}) · طلب {ret.order_number} · تسليم {ret.delivery_number}
                  </div>
                  <div className="form-hint">
                    سجّله {userLabel(ret.created_by, user?.id)} · {fmtDate(ret.returned_at)}
                    {ret.received_by && <> · سلّمه {ret.received_by}</>}
                    {ret.inspected_by && <> · فحصه {userLabel(ret.inspected_by, user?.id)} · {fmtDate(ret.inspected_at)}</>}
                  </div>
                  <div className="form-hint">السبب: {ret.reason}</div>
                  {ret.inspection_notes && <div className="form-hint">ملاحظات الفحص: {ret.inspection_notes}</div>}
                </div>
                {canManage && ret.disposition === 'pending_inspection' && (
                  <button type="button" className="btn btn--teal btn--sm" onClick={() => openInspect(ret)} disabled={busy}>
                    فحص المرتجع
                  </button>
                )}
              </header>
              <div className="table-wrapper">
                <table className="data-table" aria-label={`بنود ${ret.return_number}`}>
                  <thead>
                    <tr>
                      <th>الموديل والمقاس</th>
                      <th>الكمية</th>
                      <th>الحالة عند الاستلام</th>
                      <th>صالح للبيع</th>
                      <th>تالف</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ret.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.product_name} <small className="form-hint">{l.variant_info}</small>
                          {l.notes && <div className="form-hint">{l.notes}</div>}
                        </td>
                        <td className="qty-col">{fmt(l.quantity)}</td>
                        <td>{RETURN_CONDITION_LABELS[l.condition] ?? l.condition}</td>
                        <td className="qty-col">{ret.disposition === 'pending_inspection' ? '—' : fmt(l.restocked_quantity)}</td>
                        <td className="qty-col">{ret.disposition === 'pending_inspection' ? '—' : fmt(l.scrapped_quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      )}

      {recordOpen && (
        <div className="drawer-backdrop" onClick={() => !busy && setRecordOpen(false)}>
          <div className="modal-box modal-box--large" role="dialog" aria-modal="true" aria-label="تسجيل مرتجع عميل" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <header className="modal-box__header">
              <div>
                <span className="modal-box__eyebrow">مرتجعات العملاء</span>
                <h3 className="modal-box__title">{selected ? `مرتجع على ${selected.delivery_number}` : 'اختر سند التسليم'}</h3>
              </div>
              <button type="button" className="drawer-close-btn" onClick={() => setRecordOpen(false)} disabled={busy} aria-label="إغلاق">✕</button>
            </header>
            <div className="modal-box__body">
              {formError && <div className="modal-alert modal-alert--danger" role="alert"><div className="modal-alert__content">{formError}</div></div>}
              {!selected ? (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void searchDeliveries(search);
                    }}
                    style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}
                  >
                    <input
                      type="search"
                      aria-label="بحث عن سند تسليم"
                      placeholder="رقم التسليم، رقم الطلب، اسم العميل أو كوده"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="btn btn--secondary" disabled={searching}>بحث</button>
                  </form>
                  {searching ? (
                    <p className="form-hint">جاري البحث…</p>
                  ) : deliveries.length === 0 ? (
                    <p className="form-hint">لا توجد سندات تسليم بها كميات قابلة للإرجاع.</p>
                  ) : (
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {deliveries.map((d) => (
                        <button
                          type="button"
                          key={d.delivery_id}
                          className="btn btn--secondary"
                          style={{ textAlign: 'start', display: 'block', width: '100%' }}
                          onClick={() => chooseDelivery(d)}
                        >
                          <strong>{d.delivery_number}</strong> · {d.customer_name} ({d.customer_code}) · طلب {d.order_number} · {fmtDate(d.delivered_at)}
                          <div className="form-hint">
                            {d.lines.map((l) => `${l.product_name} ${l.variant_info}: يمكن إرجاع ${fmt(l.returnable_quantity)}`).join('، ')}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <form onSubmit={(e) => void submitRecord(e)} noValidate>
                  <p className="form-hint">
                    {selected.customer_name} ({selected.customer_code}) · طلب {selected.order_number} · سُلّم {fmtDate(selected.delivered_at)}{' '}
                    <button type="button" className="btn-link btn-sm" onClick={() => setSelected(null)}>تغيير السند</button>
                  </p>
                  <div className="drawer-row">
                    <label className="drawer-field">
                      <span className="drawer-field__label">سبب المرتجع *</span>
                      <input className="drawer-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: عيب خياطة في الياقة" maxLength={1000} />
                    </label>
                    <label className="drawer-field">
                      <span className="drawer-field__label">من سلّم المرتجع (اختياري)</span>
                      <input className="drawer-input" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="مثال: مندوب العميل" maxLength={128} />
                    </label>
                  </div>
                  <div className="table-wrapper">
                    <table className="data-table" aria-label="بنود المرتجع">
                      <thead>
                        <tr>
                          <th>الموديل والمقاس</th>
                          <th>المسلم</th>
                          <th>أُرجع سابقاً</th>
                          <th>الكمية المرتجعة</th>
                          <th>الحالة الظاهرة</th>
                          <th>ملاحظة</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.lines.map((l) => {
                          const d = draft[l.delivery_line_id];
                          const err = lineError(l.delivery_line_id);
                          const disabled = l.returnable_quantity <= EPS;
                          return (
                            <tr key={l.delivery_line_id}>
                              <td>{l.product_name} <small className="form-hint">{l.variant_info}</small></td>
                              <td className="qty-col">{fmt(l.delivered_quantity)}</td>
                              <td className="qty-col">{fmt(l.returned_quantity)}</td>
                              <td>
                                <input
                                  type="number"
                                  min={0}
                                  max={l.returnable_quantity}
                                  step="any"
                                  aria-label={`الكمية المرتجعة من ${l.product_name} ${l.variant_info}`}
                                  value={d?.qty ?? ''}
                                  disabled={disabled}
                                  placeholder={disabled ? 'أُرجع بالكامل' : `حتى ${fmt(l.returnable_quantity)}`}
                                  onChange={(e) => setDraft((p) => ({ ...p, [l.delivery_line_id]: { ...p[l.delivery_line_id], qty: e.target.value } }))}
                                  style={{ width: '7rem' }}
                                />
                                {err && <div style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{err}</div>}
                              </td>
                              <td>
                                <select
                                  aria-label={`حالة ${l.product_name} ${l.variant_info}`}
                                  value={d?.condition ?? 'unknown'}
                                  disabled={disabled}
                                  onChange={(e) => setDraft((p) => ({ ...p, [l.delivery_line_id]: { ...p[l.delivery_line_id], condition: e.target.value as ReturnCondition } }))}
                                >
                                  {(Object.keys(RETURN_CONDITION_LABELS) as ReturnCondition[]).map((c) => (
                                    <option key={c} value={c}>{RETURN_CONDITION_LABELS[c]}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  aria-label={`ملاحظة ${l.product_name} ${l.variant_info}`}
                                  value={d?.notes ?? ''}
                                  disabled={disabled}
                                  onChange={(e) => setDraft((p) => ({ ...p, [l.delivery_line_id]: { ...p[l.delivery_line_id], notes: e.target.value } }))}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="form-hint">الحالة الظاهرة للتوثيق فقط؛ قرار «صالح للبيع» أو «تالف» يتم عند الفحص.</p>
                  <footer className="modal-box__footer">
                    <button type="submit" className="btn-teal" disabled={busy}>{busy ? 'جاري التسجيل…' : 'تسجيل المرتجع'}</button>
                    <button type="button" className="btn-secondary" onClick={() => setRecordOpen(false)} disabled={busy}>إلغاء</button>
                  </footer>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {inspecting && (
        <div className="drawer-backdrop" onClick={() => !busy && setInspecting(null)}>
          <div className="modal-box modal-box--large" role="dialog" aria-modal="true" aria-label={`فحص ${inspecting.return_number}`} dir="rtl" onClick={(e) => e.stopPropagation()}>
            <header className="modal-box__header">
              <div>
                <span className="modal-box__eyebrow">فحص مرتجع عميل</span>
                <h3 className="modal-box__title">{inspecting.return_number} · {inspecting.customer_name}</h3>
              </div>
              <button type="button" className="drawer-close-btn" onClick={() => setInspecting(null)} disabled={busy} aria-label="إغلاق">✕</button>
            </header>
            <div className="modal-box__body">
              {inspectError && <div className="modal-alert modal-alert--danger" role="alert"><div className="modal-alert__content">{inspectError}</div></div>}
              <p className="form-hint">لكل بند: كم قطعة صالحة تعود للبيع، وكم قطعة تالفة تُعدم. المجموع يساوي الكمية المرتجعة.</p>
              <div className="table-wrapper">
                <table className="data-table" aria-label="نتيجة الفحص">
                  <thead>
                    <tr>
                      <th>الموديل والمقاس</th>
                      <th>المرتجع</th>
                      <th>الحالة عند الاستلام</th>
                      <th>صالح للبيع</th>
                      <th>تالف (هالك)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspecting.lines.map((l) => {
                      const v = inspect[l.id];
                      const err = inspectLineError(l.id, l.quantity);
                      return (
                        <tr key={l.id}>
                          <td>{l.product_name} <small className="form-hint">{l.variant_info}</small>{l.notes && <div className="form-hint">{l.notes}</div>}</td>
                          <td className="qty-col">{fmt(l.quantity)}</td>
                          <td>{RETURN_CONDITION_LABELS[l.condition]}</td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              aria-label={`الصالح من ${l.product_name} ${l.variant_info}`}
                              value={v?.restocked ?? ''}
                              onChange={(e) => {
                                const r = e.target.value;
                                const rest = Number(r);
                                setInspect((p) => ({
                                  ...p,
                                  [l.id]: { restocked: r, scrapped: Number.isFinite(rest) && rest <= l.quantity ? String(Math.max(0, +(l.quantity - rest).toFixed(3))) : p[l.id].scrapped },
                                }));
                              }}
                              style={{ width: '6.5rem' }}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              aria-label={`التالف من ${l.product_name} ${l.variant_info}`}
                              value={v?.scrapped ?? ''}
                              onChange={(e) => setInspect((p) => ({ ...p, [l.id]: { ...p[l.id], scrapped: e.target.value } }))}
                              style={{ width: '6.5rem' }}
                            />
                            {err && <div style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{err}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <label className="drawer-field" style={{ marginTop: '0.5rem' }}>
                <span className="drawer-field__label">ملاحظات الفحص</span>
                <input className="drawer-input" value={inspectNotes} onChange={(e) => setInspectNotes(e.target.value)} placeholder="مثال: قطعتان سليمتان بعد الكي" maxLength={1000} />
              </label>
              <footer className="modal-box__footer">
                <button type="button" className="btn-teal" onClick={() => void submitInspect()} disabled={busy}>{busy ? 'جاري الاعتماد…' : 'اعتماد الفحص'}</button>
                <button type="button" className="btn-secondary" onClick={() => setInspecting(null)} disabled={busy}>إلغاء</button>
              </footer>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
