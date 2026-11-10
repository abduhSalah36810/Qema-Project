import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { userLabel } from '@/lib/userLabel';
import {
  fetchOrderReturns,
  newIdempotencyKey,
  receiveOrderReturnApi,
  resolveOrderReturnApi,
  type ReturnLine,
  type ReturnTransfer,
} from './productionApi';

/**
 * مرتجعات الورشة إلى مخزن الخامات:
 * - بالطريق: أمين المخزن يفحص ويؤكد المقبول والمرفوض (والعجز يُحسب تلقائياً) مع تفسير مكتوب.
 * - بانتظار التسوية: مسؤول الإنتاج أو المدير العام يقرر مصير العجز والمرفوض بسبب مكتوب.
 * الخادم يفرض الصلاحيات وفصل المسجل عن المستلم والمستلم عن المسوّي؛ الواجهة تعكس ذلك فقط.
 */
interface Props {
  orderId: string;
  currentUserId?: string | null;
  canReceive: boolean;
  canResolve: boolean;
  onChanged: (message: string) => void | Promise<void>;
}

type ReceiptInput = { accepted: string; rejected: string; notes: string };
type ResolutionInput = { shortage: string; shortageReason: string; rejected: string; disposition: 'restock' | 'scrap'; rejectedReason: string };

const EPS = 1e-9;

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export function WorkshopReturnsPanel({ orderId, currentUserId, canReceive, canResolve, onChanged }: Props) {
  const [returns, setReturns] = useState<ReturnTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipts, setReceipts] = useState<Record<string, ReceiptInput>>({});
  const [resolutions, setResolutions] = useState<Record<string, ResolutionInput>>({});
  const keysRef = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setReturns(await fetchOrderReturns(orderId));
    } catch (err) {
      setError(errorText(err, 'تعذر تحميل مرتجعات الورشة.'));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const keyFor = (id: string) => {
    if (!keysRef.current[id]) keysRef.current[id] = newIdempotencyKey();
    return keysRef.current[id];
  };
  const receiptOf = (line: ReturnLine): ReceiptInput =>
    receipts[line.line_id] || { accepted: String(line.declared_quantity), rejected: '0', notes: '' };
  const resolutionOf = (line: ReturnLine): ResolutionInput =>
    resolutions[line.line_id] || {
      shortage: line.shortage_open_quantity > EPS ? String(line.shortage_open_quantity) : '',
      shortageReason: '',
      rejected: line.rejected_open_quantity > EPS ? String(line.rejected_open_quantity) : '',
      disposition: 'scrap',
      rejectedReason: '',
    };

  const submitReceipt = async (rt: ReturnTransfer) => {
    const lines = rt.lines.map((line) => {
      const input = receiptOf(line);
      return { item_id: line.item_id, accepted_quantity: num(input.accepted), rejected_quantity: num(input.rejected), notes: input.notes.trim() };
    });
    for (const [i, line] of lines.entries()) {
      const declared = rt.lines[i].declared_quantity;
      if (line.accepted_quantity < 0 || line.rejected_quantity < 0) return setError('لا تقبل كميات سالبة.');
      if (line.accepted_quantity + line.rejected_quantity > declared + EPS) {
        return setError(`مجموع المقبول والمرفوض للخامة ${rt.lines[i].item_name_ar} يتجاوز المرتجع المسجل (${declared}).`);
      }
      const hasIssue = line.rejected_quantity > EPS || line.accepted_quantity + line.rejected_quantity < declared - EPS;
      if (hasIssue && !line.notes) return setError(`اكتب تفسيراً للعجز أو المرفوض في خامة ${rt.lines[i].item_name_ar}.`);
    }
    setBusy(true);
    setError('');
    try {
      const updated = await receiveOrderReturnApi(orderId, rt.id, { lines }, keyFor(rt.id));
      keysRef.current[rt.id] = newIdempotencyKey();
      await load();
      await onChanged(
        updated.awaiting_resolution
          ? `تم استلام المرتجع ${rt.transfer_number}. المقبول دخل مخزن الخامات، والمرفوض معزول والعجز مسجّل، وينتظران قرار مسؤول الإنتاج أو المدير العام.`
          : `تم استلام المرتجع ${rt.transfer_number} كاملاً ودخل مخزن الخامات.`,
      );
    } catch (err) {
      setError(errorText(err, 'تعذر تأكيد استلام المرتجع.'));
    } finally {
      setBusy(false);
    }
  };

  const submitResolution = async (rt: ReturnTransfer) => {
    const lines: Array<{ item_id: string; kind: 'shortage' | 'rejected'; disposition: 'write_off' | 'restock' | 'scrap'; quantity: number; reason: string }> = [];
    for (const line of rt.lines) {
      const input = resolutionOf(line);
      if (line.shortage_open_quantity > EPS && num(input.shortage) > EPS) {
        if (!input.shortageReason.trim()) return setError(`اكتب سبب تسوية عجز ${line.item_name_ar}.`);
        lines.push({ item_id: line.item_id, kind: 'shortage', disposition: 'write_off', quantity: num(input.shortage), reason: input.shortageReason.trim() });
      }
      if (line.rejected_open_quantity > EPS && num(input.rejected) > EPS) {
        if (!input.rejectedReason.trim()) return setError(`اكتب سبب قرار المرفوض في ${line.item_name_ar}.`);
        lines.push({ item_id: line.item_id, kind: 'rejected', disposition: input.disposition, quantity: num(input.rejected), reason: input.rejectedReason.trim() });
      }
    }
    if (lines.length === 0) return setError('أدخل كمية للتسوية مع سببها.');
    setBusy(true);
    setError('');
    try {
      const updated = await resolveOrderReturnApi(orderId, rt.id, { lines }, keyFor(`${rt.id}:resolve`));
      keysRef.current[`${rt.id}:resolve`] = newIdempotencyKey();
      setResolutions({});
      await load();
      await onChanged(
        updated.awaiting_resolution
          ? `سُجّلت التسوية للمرتجع ${rt.transfer_number}، وما زالت كميات أخرى بانتظار القرار.`
          : `اكتملت تسوية المرتجع ${rt.transfer_number}؛ لم يعد يمنع إغلاق الأمر.`,
      );
    } catch (err) {
      setError(errorText(err, 'تعذر تسجيل التسوية.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="form-hint">جاري تحميل مرتجعات الورشة…</p>;
  if (returns.length === 0 && !error) return null;

  return (
    <section aria-label="مرتجعات الورشة إلى مخزن الخامات" style={{ marginTop: '1.25rem' }}>
      <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>مرتجعات الورشة إلى مخزن الخامات</h3>
      <p className="form-hint">
        المرتجع لا يدخل رصيد الخامات حتى يفحصه أمين المخزن. المرفوض يبقى معزولاً والعجز مسجلاً حتى يقرر مسؤول الإنتاج أو المدير العام مصيرهما.
      </p>
      {error && <div className="modal-alert modal-alert--error" role="alert"><div className="modal-alert__content">{error}</div></div>}

      {returns.map((rt) => {
        const isDeclarer = Boolean(currentUserId && rt.declared_by === currentUserId);
        const isReceiver = Boolean(currentUserId && rt.received_by === currentUserId);
        const showReceipt = rt.awaiting_receipt && canReceive && !isDeclarer;
        const showResolution = rt.awaiting_resolution && canResolve && !isReceiver;
        return (
          <article key={rt.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem', marginTop: '0.75rem' }}>
            <header style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
              <strong><code>{rt.transfer_number}</code> · {rt.status_ar}</strong>
              <small>
                سجّله {userLabel(rt.declared_by, currentUserId)}
                {rt.received_by ? ` · استلمه ${userLabel(rt.received_by, currentUserId)}` : ''}
              </small>
            </header>
            <div style={{ overflowX: 'auto' }}>
              <table className="order-detail-table" aria-label={`خامات المرتجع ${rt.transfer_number}`}>
                <thead>
                  <tr>
                    <th>الخامة</th>
                    <th>المرتجع المسجل</th>
                    {showReceipt ? <><th>المقبول</th><th>المرفوض/تالف</th><th>تفسير العجز أو المرفوض</th></> : <><th>المقبول</th><th>المرفوض</th><th>العجز</th></>}
                    {showResolution && <th>القرار</th>}
                  </tr>
                </thead>
                <tbody>
                  {rt.lines.map((line) => {
                    const r = receiptOf(line);
                    const res = resolutionOf(line);
                    const setR = (patch: Partial<ReceiptInput>) => setReceipts((cur) => ({ ...cur, [line.line_id]: { ...r, ...patch } }));
                    const setS = (patch: Partial<ResolutionInput>) => setResolutions((cur) => ({ ...cur, [line.line_id]: { ...res, ...patch } }));
                    const shortagePreview = Math.max(0, line.declared_quantity - num(r.accepted) - num(r.rejected));
                    return (
                      <tr key={line.line_id}>
                        <td><strong>{line.item_name_ar}</strong> <small>{line.unit_name_ar}</small><br /><small>{line.notes}</small></td>
                        <td className="qty-col">{line.declared_quantity}</td>
                        {showReceipt ? (
                          <>
                            <td><input type="number" min={0} step="any" className="table-input" aria-label={`المقبول ${line.item_name_ar}`} value={r.accepted} onChange={(e) => setR({ accepted: e.target.value })} /></td>
                            <td><input type="number" min={0} step="any" className="table-input" aria-label={`المرفوض ${line.item_name_ar}`} value={r.rejected} onChange={(e) => setR({ rejected: e.target.value })} /></td>
                            <td>
                              <input type="text" className="table-input table-input--text" aria-label={`تفسير ${line.item_name_ar}`} value={r.notes} onChange={(e) => setR({ notes: e.target.value })} />
                              {shortagePreview > EPS && <small style={{ display: 'block', color: '#b45309' }}>عجز {shortagePreview}</small>}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="qty-col">{rt.awaiting_receipt ? '—' : line.accepted_quantity}</td>
                            <td className="qty-col">{rt.awaiting_receipt ? '—' : `${line.rejected_quantity}${line.rejected_open_quantity > EPS ? ` (معلق ${line.rejected_open_quantity})` : ''}`}</td>
                            <td className="qty-col">{rt.awaiting_receipt ? '—' : `${line.shortage_quantity}${line.shortage_open_quantity > EPS ? ` (معلق ${line.shortage_open_quantity})` : ''}`}</td>
                          </>
                        )}
                        {showResolution && (
                          <td style={{ minWidth: 260 }}>
                            {line.shortage_open_quantity > EPS && (
                              <div style={{ marginBottom: '0.5rem' }}>
                                <small>إثبات فقد العجز (بلا تحميل مسؤولية مالية على أحد)</small>
                                <input type="number" min={0} step="any" className="table-input" aria-label={`كمية العجز ${line.item_name_ar}`} value={res.shortage} onChange={(e) => setS({ shortage: e.target.value })} />
                                <input type="text" className="table-input table-input--text" placeholder="سبب التسوية" aria-label={`سبب تسوية العجز ${line.item_name_ar}`} value={res.shortageReason} onChange={(e) => setS({ shortageReason: e.target.value })} />
                              </div>
                            )}
                            {line.rejected_open_quantity > EPS && (
                              <div>
                                <small>قرار في المرفوض</small>
                                <input type="number" min={0} step="any" className="table-input" aria-label={`كمية المرفوض ${line.item_name_ar}`} value={res.rejected} onChange={(e) => setS({ rejected: e.target.value })} />
                                <select aria-label={`قرار المرفوض ${line.item_name_ar}`} value={res.disposition} onChange={(e) => setS({ disposition: e.target.value as ResolutionInput['disposition'] })}>
                                  <option value="scrap">هالك على الأمر</option>
                                  <option value="restock">صالح · يعاد لمخزن الخامات</option>
                                </select>
                                <input type="text" className="table-input table-input--text" placeholder="سبب القرار" aria-label={`سبب قرار المرفوض ${line.item_name_ar}`} value={res.rejectedReason} onChange={(e) => setS({ rejectedReason: e.target.value })} />
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {showReceipt && (
              <button type="button" className="btn btn--teal" disabled={busy} onClick={() => void submitReceipt(rt)}>تأكيد فحص واستلام المرتجع</button>
            )}
            {showResolution && (
              <button type="button" className="btn btn--teal" disabled={busy} onClick={() => void submitResolution(rt)}>تسجيل قرار التسوية</button>
            )}
            {rt.awaiting_receipt && !showReceipt && (
              <p className="form-hint">
                {isDeclarer ? 'أنت من سجّل هذا المرتجع؛ يفحصه ويستلمه أمين المخزن.' : 'بانتظار فحص واستلام أمين المخزن.'}
              </p>
            )}
            {rt.awaiting_resolution && !showResolution && (
              <p className="form-hint">
                {isReceiver ? 'أنت من أثبت العجز أو الرفض؛ يقرر تسويته مسؤول الإنتاج أو المدير العام.' : 'بانتظار قرار مسؤول الإنتاج أو المدير العام في العجز والمرفوض.'}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
