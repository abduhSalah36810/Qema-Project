import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { userLabel } from '@/lib/userLabel';
import { useDialog } from '@/components/feedback/DialogProvider';
import { fetchStockBalances, type StockBalance } from '@/features/inventory/inventoryApi';
import {
  createExtraIssueApi,
  fetchOrderExtraIssues,
  fetchWarehouses,
  newIdempotencyKey,
  receiveExtraIssueApi,
  type WarehouseTransfer,
} from './productionApi';

/**
 * صرف خامات إضافي لأمر قائم (مثلاً لإصلاح عيوب):
 * - أمين المخزن يختار الخامات والكميات والسبب ويرحّل الصرف مباشرة بعد تأكيد.
 * - مسؤول الإنتاج (غير الصارف) يؤكد ما استلمته الورشة فعلاً، والفرق يُسجل.
 * الخادم يفرض الصلاحيات والأرصدة وحالة الأمر؛ الواجهة تعرض ذلك وتتحقق قبل الإرسال فقط.
 */
interface Props {
  orderId: string;
  orderStatus: string;
  currentUserId?: string | null;
  canDispatch: boolean;
  canReceive: boolean;
  /** بدأ استلام المنتج التام (سليم أو مرفوض): لا صرف إضافي لأن تكلفة القطعة حُمّلت */
  finishedGoodsStarted?: boolean;
  onChanged: (message: string) => void | Promise<void>;
}

type DraftLine = { key: string; itemId: string; qty: string; notes: string };

const OPEN_STATUSES = ['in_production', 'manufacturing_completed'];
const EPS = 1e-9;

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

function fmt(n: number): string {
  return n.toLocaleString('ar-EG', { maximumFractionDigits: 3 });
}

function fmtDate(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

let lineSeq = 0;
const newLine = (): DraftLine => ({ key: `l${(lineSeq += 1)}`, itemId: '', qty: '', notes: '' });

export function ExtraIssuePanel({ orderId, orderStatus, currentUserId, canDispatch, canReceive, finishedGoodsStarted = false, onChanged }: Props) {
  const dialog = useDialog();
  const [issues, setIssues] = useState<WarehouseTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [stock, setStock] = useState<StockBalance[]>([]);
  const [stockError, setStockError] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [formError, setFormError] = useState('');
  const [receipts, setReceipts] = useState<Record<string, { qty: string; notes: string }>>({});
  const keysRef = useRef<Record<string, string>>({});
  const keyFor = (id: string) => {
    if (!keysRef.current[id]) keysRef.current[id] = newIdempotencyKey();
    return keysRef.current[id];
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setIssues(await fetchOrderExtraIssues(orderId));
    } catch (err) {
      setError(errorText(err, 'تعذر تحميل سجل الصرف الإضافي.'));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const inTransit = issues.find((t) => t.status === 'in_transit');
  const orderOpen = OPEN_STATUSES.includes(orderStatus) && !finishedGoodsStarted;
  const canStartIssue = canDispatch && orderOpen && !inTransit;

  const openForm = async () => {
    setFormOpen(true);
    setFormError('');
    setStockError('');
    try {
      const warehouses = await fetchWarehouses();
      const raw = warehouses.find((w) => w.code === 'main_raw_materials');
      if (!raw) throw new Error('مخزن الخامات غير موجود.');
      const balances = await fetchStockBalances(raw.id);
      setStock(balances.filter((b) => (b.balance ?? 0) > EPS).sort((x, y) => x.item_name_ar.localeCompare(y.item_name_ar, 'ar')));
    } catch (err) {
      setStockError(errorText(err, 'تعذر تحميل أرصدة مخزن الخامات.'));
    }
  };

  const stockById = useMemo(() => new Map(stock.map((s) => [s.item_id, s])), [stock]);

  const lineProblem = (line: DraftLine): string | null => {
    if (!line.itemId) return 'اختر الخامة';
    const qty = Number(line.qty);
    if (!line.qty || !Number.isFinite(qty) || qty <= 0) return 'اكتب كمية أكبر من صفر';
    const available = stockById.get(line.itemId)?.balance ?? 0;
    if (qty > available + EPS) return `أكبر من المتاح (${fmt(available)})`;
    if (lines.filter((l) => l.itemId === line.itemId).length > 1) return 'الخامة مكررة؛ اجمع الكمية في سطر واحد';
    return null;
  };

  const submitIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanReason = reason.trim().replace(/\s+/g, ' ');
    if (cleanReason.length < 3) {
      setFormError('اكتب سبب الصرف الإضافي (مثلاً: إصلاح عيوب القص).');
      return;
    }
    const problems = lines.map(lineProblem).filter(Boolean);
    if (problems.length) {
      setFormError('راجع سطور الخامات المعلَّمة قبل الصرف.');
      return;
    }
    const summary = lines
      .map((l) => {
        const s = stockById.get(l.itemId);
        return `${s?.item_name_ar ?? ''}: ${fmt(Number(l.qty))} ${s?.unit_name_ar ?? ''}`;
      })
      .join('، ');
    const confirmed = await dialog.confirm({
      title: 'ترحيل الصرف الإضافي؟',
      message: `سيُخصم من مخزن الخامات فوراً: ${summary}. تبقى الكميات «بالطريق» حتى يؤكد مسؤول الإنتاج استلامها بالورشة. لا يمكن تعديل الصرف بعد ترحيله.`,
      confirmLabel: 'ترحيل الصرف',
    });
    if (!confirmed) return;
    setBusy(true);
    setFormError('');
    try {
      const created = await createExtraIssueApi(
        orderId,
        { reason: cleanReason, lines: lines.map((l) => ({ item_id: l.itemId, quantity: Number(l.qty), notes: l.notes.trim() })) },
        keyFor('new-issue'),
      );
      delete keysRef.current['new-issue'];
      setFormOpen(false);
      setReason('');
      setLines([newLine()]);
      await load();
      await onChanged(`تم ترحيل الصرف الإضافي ${created.transfer_number}. بانتظار تأكيد مسؤول الإنتاج للاستلام بالورشة.`);
    } catch (err) {
      setFormError(errorText(err, 'تعذر ترحيل الصرف الإضافي.'));
    } finally {
      setBusy(false);
    }
  };

  const receiptOf = (lineId: string, dispatched: number) => receipts[lineId] ?? { qty: String(dispatched), notes: '' };

  const submitReceipt = async (issue: WarehouseTransfer) => {
    const bad = issue.lines.find((l) => {
      const q = Number(receiptOf(l.id, l.dispatched_quantity).qty);
      return !Number.isFinite(q) || q < 0 || q > l.dispatched_quantity + EPS;
    });
    if (bad) {
      setError(`كمية «${bad.item_name_ar}» يجب أن تكون بين صفر والمنصرف (${fmt(bad.dispatched_quantity)}).`);
      return;
    }
    const confirmed = await dialog.confirm({
      title: `تأكيد استلام ${issue.transfer_number}؟`,
      message: 'تُضاف الكميات المستلمة لرصيد الأمر بالورشة وتكلفتها لتكلفة الأمر، وأي فرق يُسجل عجزاً. لا يمكن التراجع.',
      confirmLabel: 'تأكيد الاستلام',
    });
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await receiveExtraIssueApi(
        orderId,
        issue.id,
        {
          received_lines: issue.lines.map((l) => {
            const r = receiptOf(l.id, l.dispatched_quantity);
            return { item_id: l.item_id, received_quantity: Number(r.qty), notes: r.notes.trim() };
          }),
        },
        keyFor(issue.id),
      );
      await load();
      await onChanged(`تم تأكيد استلام الصرف الإضافي ${issue.transfer_number} بالورشة.`);
    } catch (err) {
      setError(errorText(err, 'تعذر تأكيد الاستلام.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="extra-issue-panel" aria-label="صرف خامات إضافي" style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0 }}>صرف خامات إضافي</h3>
          <p className="form-hint" style={{ margin: '0.25rem 0 0' }}>
            لخامات تحتاجها الورشة بعد الصرف الأول (مثلاً لإصلاح عيوب). متاح قبل بدء استلام المنتج التام.
          </p>
        </div>
        {canStartIssue && !formOpen && (
          <button type="button" className="btn btn--teal btn--sm" onClick={() => void openForm()} disabled={busy}>
            ＋ صرف إضافي
          </button>
        )}
      </div>

      {canDispatch && finishedGoodsStarted && OPEN_STATUSES.includes(orderStatus) && (
        <p className="form-hint">بدأ استلام المنتج التام لهذا الأمر، فلا صرف إضافي عليه. أنشئ أمر تشغيل جديداً إذا لزم.</p>
      )}

      {canDispatch && orderOpen && inTransit && (
        <p className="form-hint">يوجد صرف إضافي بالطريق؛ يمكن صرف غيره بعد أن يؤكد مسؤول الإنتاج استلامه.</p>
      )}

      {error && (
        <div className="modal-alert modal-alert--danger" role="alert">
          <div className="modal-alert__content">{error}</div>
        </div>
      )}

      {formOpen && (
        <form onSubmit={(e) => void submitIssue(e)} noValidate style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem', marginTop: '0.75rem' }}>
          {stockError && (
            <div className="modal-alert modal-alert--danger" role="alert">
              <div className="modal-alert__content">{stockError}</div>
            </div>
          )}
          {formError && (
            <div className="modal-alert modal-alert--danger" role="alert">
              <div className="modal-alert__content">{formError}</div>
            </div>
          )}
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>
            سبب الصرف الإضافي *
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثال: إصلاح عيوب القص في 5 قطع"
              style={{ width: '100%' }}
              maxLength={500}
            />
          </label>
          <div className="table-wrapper">
            <table className="data-table" aria-label="خامات الصرف الإضافي">
              <thead>
                <tr>
                  <th>الخامة (من مخزن الخامات)</th>
                  <th>المتاح</th>
                  <th>الكمية</th>
                  <th>ملاحظة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const s = stockById.get(line.itemId);
                  const problem = line.itemId || line.qty ? lineProblem(line) : null;
                  return (
                    <tr key={line.key}>
                      <td>
                        <select
                          aria-label="الخامة"
                          value={line.itemId}
                          onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, itemId: e.target.value } : l)))}
                        >
                          <option value="">— اختر الخامة —</option>
                          {stock.map((b) => (
                            <option key={b.item_id} value={b.item_id}>
                              {b.item_name_ar} ({b.item_code})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="qty-col">{s ? `${fmt(s.balance ?? 0)} ${s.unit_name_ar}` : '—'}</td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          aria-label="الكمية"
                          value={line.qty}
                          onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, qty: e.target.value } : l)))}
                          style={{ width: '7rem' }}
                        />
                        {s && <small className="form-hint"> {s.unit_name_ar}</small>}
                        {problem && <div className="form-error" style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{problem}</div>}
                      </td>
                      <td>
                        <input
                          aria-label="ملاحظة السطر"
                          value={line.notes}
                          onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, notes: e.target.value } : l)))}
                        />
                      </td>
                      <td>
                        {lines.length > 1 && (
                          <button type="button" className="btn btn--sm btn--secondary" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}>
                            حذف السطر
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn--sm btn--secondary" onClick={() => setLines((prev) => [...prev, newLine()])} disabled={busy}>
              ＋ خامة أخرى
            </button>
            <button type="submit" className="btn btn--teal" disabled={busy}>
              {busy ? 'جاري الترحيل…' : 'ترحيل الصرف'}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setFormOpen(false)} disabled={busy}>
              إلغاء
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="form-hint">جاري تحميل سجل الصرف الإضافي…</p>
      ) : issues.length === 0 ? (
        <p className="form-hint">لا يوجد صرف إضافي لهذا الأمر.</p>
      ) : (
        issues.map((issue) => {
          const pending = issue.status === 'in_transit';
          const mine = Boolean(currentUserId && issue.dispatched_by === currentUserId);
          const receiving = pending && canReceive && !mine;
          const reasonText = issue.notes.replace(/^صرف إضافي:\s*/, '');
          return (
            <article key={issue.id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.75rem', marginTop: '0.75rem' }}>
              <header style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div>
                  <strong>{issue.transfer_number}</strong>{' '}
                  <span className={`status-badge status-badge--${pending ? 'waiting' : 'done'}`}>
                    {pending ? 'بالطريق · بانتظار استلام الورشة' : 'مستلم بالورشة'}
                  </span>
                  <div className="form-hint">
                    صرفه {userLabel(issue.dispatched_by, currentUserId)} · {fmtDate(issue.dispatched_at)}
                    {issue.received_by && <> · استلمه {userLabel(issue.received_by, currentUserId)} · {fmtDate(issue.received_at)}</>}
                  </div>
                  <div className="form-hint">السبب: {reasonText}</div>
                </div>
              </header>
              <div className="table-wrapper">
                <table className="data-table" aria-label={`سطور ${issue.transfer_number}`}>
                  <thead>
                    <tr>
                      <th>الخامة</th>
                      <th>المنصرف</th>
                      <th>{receiving ? 'المستلم فعلاً' : 'المستلم'}</th>
                      <th>الفرق</th>
                    </tr>
                  </thead>
                  <tbody>
                    {issue.lines.map((l) => {
                      const r = receiptOf(l.id, l.dispatched_quantity);
                      const rec = receiving ? Number(r.qty) : l.received_quantity;
                      const diff = pending && !receiving ? null : (Number.isFinite(rec) ? rec - l.dispatched_quantity : 0);
                      return (
                        <tr key={l.id}>
                          <td>
                            {l.item_name_ar}
                            {l.notes && <div className="form-hint">{l.notes}</div>}
                          </td>
                          <td className="qty-col">{fmt(l.dispatched_quantity)} {l.unit_name_ar}</td>
                          <td>
                            {receiving ? (
                              <>
                                <input
                                  type="number"
                                  min={0}
                                  max={l.dispatched_quantity}
                                  step="any"
                                  aria-label={`المستلم من ${l.item_name_ar}`}
                                  value={r.qty}
                                  onChange={(e) => setReceipts((prev) => ({ ...prev, [l.id]: { ...r, qty: e.target.value } }))}
                                  style={{ width: '6.5rem' }}
                                />
                                <input
                                  aria-label={`ملاحظة استلام ${l.item_name_ar}`}
                                  placeholder="سبب الفرق إن وجد"
                                  value={r.notes}
                                  onChange={(e) => setReceipts((prev) => ({ ...prev, [l.id]: { ...r, notes: e.target.value } }))}
                                  style={{ marginInlineStart: 6 }}
                                />
                              </>
                            ) : pending ? (
                              <small className="form-hint">لم يُستلم بعد</small>
                            ) : (
                              fmt(l.received_quantity)
                            )}
                          </td>
                          <td className="qty-col" style={{ color: diff && Math.abs(diff) > EPS ? '#b91c1c' : undefined }}>
                            {diff === null ? '—' : Math.abs(diff) > EPS ? fmt(diff) : '٠'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {receiving && (
                <button type="button" className="btn btn--teal btn--sm" style={{ marginTop: '0.5rem' }} onClick={() => void submitReceipt(issue)} disabled={busy}>
                  {busy ? 'جاري التأكيد…' : 'تأكيد استلام الورشة'}
                </button>
              )}
              {pending && canReceive && mine && (
                <p className="form-hint">صرفت هذه الخامات بنفسك؛ يؤكد استلامها مسؤول الإنتاج.</p>
              )}
            </article>
          );
        })
      )}
    </section>
  );
}
