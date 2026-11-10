import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { apiClient, ApiError } from '@/lib/api';
import { CatalogItem, fetchCatalogItems } from '@/features/production/productionApi';

/**
 * المشتريات: فاتورة مورد ← استلام فعلي بالمخزن (كامل أو على دفعات) ← طلب سداد يُعتمد في الخزينة.
 * كل المبالغ المعروضة (الإجمالي، قيمة المستلم، المستحق) تأتي من الخادم كما هي، ولا تُعاد حسابها هنا،
 * حتى لا تختلف هذه الشاشة عن الخزينة وكشف حساب المورد.
 */

type Supplier = { id: string; code: string; name: string; is_active: boolean };
type InvoiceLine = {
  id: string;
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  invoiced_quantity: number;
  received_quantity: number;
  remaining_quantity?: number;
  unit_price: string | number;
  discount_amount?: string | number;
  line_total?: string | number;
};
export type InvoicePayment = {
  id: string;
  cash_document_id: string;
  amount: string | number;
  status: string;
  created_at: string;
};
type Invoice = {
  id: string;
  internal_number: string;
  supplier_id: string;
  supplier_name: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total: string | number;
  paid_total: string | number;
  status: 'awaiting_receipt' | 'partially_received' | 'received' | string;
  notes: string;
  lines: InvoiceLine[];
  payments?: InvoicePayment[];
  received_value?: string | number;
  pending_payments_total?: string | number;
  payable_balance?: string | number;
  /** مؤشرات بلا مبالغ: متاحة لأمين المخزن */
  has_pending_payment_request?: boolean;
  can_request_full_balance?: boolean;
};
type DraftLine = {
  item_id: string;
  item_code: string;
  item_name_ar: string;
  unit_id: string;
  unit_name_ar: string;
  quantity: number;
  unit_price: number;
  discount: number;
};

const money = (v: string | number | undefined) =>
  `${Number(v || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
const qty = (v: number | undefined) => Number(v || 0).toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const STATUS: Record<string, { label: string; tone: 'wait' | 'part' | 'done' }> = {
  awaiting_receipt: { label: 'بانتظار الاستلام بالمخزن', tone: 'wait' },
  partially_received: { label: 'مستلمة جزئياً', tone: 'part' },
  received: { label: 'مستلمة بالكامل', tone: 'done' },
};

function errText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export function SupplierPurchasingView() {
  const { hasPermission, roles } = useAuth();
  const isWarehouseOnly = roles.includes('warehouse_manager') && !roles.includes('finance_manager') && !roles.includes('general_manager');
  const canCreateInvoices = hasPermission('suppliers:invoices:create');
  const canReceive = hasPermission('suppliers:receive');
  const canRequestPayment = !isWarehouseOnly && hasPermission('suppliers:payments:request');
  // طلب سداد كامل المستحق: الخادم يحسب المبلغ ولا يعرضه لأمين المخزن
  const canRequestFullBalance = hasPermission('suppliers:payments:request_full_balance');
  const showMoney = !isWarehouseOnly;

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [showNewInvoice, setShowNewInvoice] = useState(false);

  const [header, setHeader] = useState({ supplier_id: '', invoice_number: '', notes: '' });
  const [draft, setDraft] = useState({ item_id: '', quantity: '', unit_price: '', discount: '' });
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [receiving, setReceiving] = useState<Record<string, Record<string, string>>>({});
  const [paymentAmounts, setPaymentAmounts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [supplierRows, invoiceRows, catalog] = await Promise.all([
        apiClient.request<Supplier[]>('/api/v1/finance/suppliers'),
        apiClient.request<Invoice[]>('/api/v1/finance/supplier-invoices'),
        fetchCatalogItems(),
      ]);
      setSuppliers(supplierRows);
      setInvoices(invoiceRows);
      setItems(catalog);
    } catch (err) {
      setError(errText(err, 'تعذر تحميل الموردين وفواتير الشراء.'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const purchasable = useMemo(
    () => items.filter((i) => i.is_active && i.item_type !== 'finished_garment' && (i.approval_status === 'approved' || !i.approval_status)),
    [items]
  );
  const selectedItem = purchasable.find((i) => i.id === draft.item_id);
  const lineTotal = (l: DraftLine) => l.quantity * l.unit_price - l.discount;
  const draftTotal = lines.reduce((s, l) => s + lineTotal(l), 0);

  const flash = (ok: string) => { setError(''); setSuccess(ok); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const fail = (msg: string) => { setSuccess(''); setError(msg); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const addLine = () => {
    const quantity = Number(draft.quantity);
    const price = Number(draft.unit_price);
    const discount = Number(draft.discount || 0);
    if (!selectedItem) return fail('اختر الخامة من القائمة.');
    if (!Number.isFinite(quantity) || quantity <= 0) return fail('أدخل كمية أكبر من صفر.');
    if (!Number.isFinite(price) || price < 0) return fail('أدخل سعر وحدة صحيحاً.');
    if (!Number.isFinite(discount) || discount < 0 || discount > quantity * price) return fail('الخصم لا يمكن أن يكون سالباً أو أكبر من قيمة البند.');
    if (lines.some((l) => l.item_id === selectedItem.id)) return fail('هذه الخامة موجودة في الفاتورة بالفعل. احذف البند ثم أضفه بالكمية الصحيحة.');
    setLines((cur) => [...cur, {
      item_id: selectedItem.id, item_code: selectedItem.code, item_name_ar: selectedItem.name_ar,
      unit_id: selectedItem.unit_id, unit_name_ar: selectedItem.unit_name_ar, quantity, unit_price: price, discount,
    }]);
    setDraft({ item_id: '', quantity: '', unit_price: '', discount: '' });
    setError('');
  };

  const createInvoice = async (e: FormEvent) => {
    e.preventDefault();
    if (!header.supplier_id) return fail('اختر المورد.');
    if (!header.invoice_number.trim()) return fail('أدخل رقم فاتورة المورد كما هو مكتوب على الفاتورة الورقية.');
    if (lines.length === 0) return fail('أضف بنداً واحداً على الأقل.');
    setBusy(true);
    try {
      const inv = await apiClient.request<Invoice>('/api/v1/finance/supplier-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: header.supplier_id,
          invoice_number: header.invoice_number.trim(),
          invoice_date: new Date().toISOString(),
          notes: header.notes.trim(),
          // الإجمالي يحسبه الخادم من البنود (الكمية × السعر − الخصم)
          lines: lines.map((l) => ({
            item_id: l.item_id, unit_id: l.unit_id, invoiced_quantity: l.quantity,
            unit_price: l.unit_price, discount_amount: l.discount.toFixed(2),
          })),
        }),
      });
      setHeader({ supplier_id: '', invoice_number: '', notes: '' });
      setLines([]);
      setShowNewInvoice(false);
      flash(`تم حفظ الفاتورة ${inv.invoice_number} (${inv.internal_number})${showMoney ? ` بإجمالي ${money(inv.invoice_total)}` : ''}. لم يتغير المخزون بعد — الخطوة التالية: استلام الكميات الفعلية بالمخزن من القائمة أدناه. الفاتورة لا تعني أن المبلغ دُفع.`);
      await load();
    } catch (err) {
      fail(errText(err, 'تعذر حفظ الفاتورة.'));
    } finally {
      setBusy(false);
    }
  };

  const remainingOf = (l: InvoiceLine) => l.remaining_quantity ?? Math.max(0, l.invoiced_quantity - l.received_quantity);

  const fillRemaining = (inv: Invoice) => {
    const full: Record<string, string> = {};
    inv.lines.forEach((l) => { full[l.id] = String(remainingOf(l)); });
    setReceiving((cur) => ({ ...cur, [inv.id]: full }));
  };

  const confirmReceipt = async (inv: Invoice) => {
    const values = receiving[inv.id] ?? {};
    const payloadLines = inv.lines
      .map((l) => ({ line_id: l.id, received_quantity: Number(values[l.id] || 0), name: l.item_name_ar, remaining: remainingOf(l) }))
      .filter((l) => l.received_quantity > 0);
    if (payloadLines.length === 0) return fail('اكتب الكمية التي وصلت فعلاً لبند واحد على الأقل.');
    const over = payloadLines.find((l) => l.received_quantity > l.remaining + 1e-9);
    if (over) return fail(`الكمية المستلمة من «${over.name}» أكبر من المتبقي على الفاتورة (${qty(over.remaining)}).`);
    setBusy(true);
    try {
      const updated = await apiClient.request<Invoice>(`/api/v1/finance/supplier-invoices/${inv.id}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: payloadLines.map(({ line_id, received_quantity }) => ({ line_id, received_quantity })),
          notes: 'استلام وفحص بمخزن الخامات',
        }),
      });
      setReceiving((cur) => ({ ...cur, [inv.id]: {} }));
      const summary = payloadLines.map((l) => `${l.name}: ${qty(l.received_quantity)}`).join('، ');
      flash(`تم الاستلام وإضافة الكميات لرصيد مخزن الخامات (${summary}). حالة الفاتورة الآن: ${STATUS[updated.status]?.label ?? updated.status}.`);
      await load();
    } catch (err) {
      fail(errText(err, 'تعذر تسجيل الاستلام.'));
    } finally {
      setBusy(false);
    }
  };

  const maxPayable = (inv: Invoice) => Math.max(0, Number(inv.payable_balance || 0) - Number(inv.pending_payments_total || 0));

  const requestPayment = async (inv: Invoice) => {
    const amount = Number(paymentAmounts[inv.id]);
    if (!Number.isFinite(amount) || amount <= 0) return fail('أدخل مبلغ السداد.');
    if (amount > maxPayable(inv) + 0.001) return fail(`المبلغ أكبر من المستحق المتاح للسداد (${money(maxPayable(inv))}).`);
    setBusy(true);
    try {
      const doc = await apiClient.request<{ status: string }>(`/api/v1/finance/supplier-invoices/${inv.id}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amount.toFixed(2), description: `سداد للمورد ${inv.supplier_name} عن فاتورة ${inv.invoice_number}` }),
      });
      setPaymentAmounts((cur) => ({ ...cur, [inv.id]: '' }));
      flash(doc.status === 'approved'
        ? `تم سداد ${money(amount)} للمورد ${inv.supplier_name} وخُصم من الخزنة.`
        : `تم تسجيل طلب سداد ${money(amount)} للمورد ${inv.supplier_name}. الخزنة لم تتغير بعد: يعتمده المدير المالي من شاشة «الخزينة والاعتمادات».`);
      await load();
    } catch (err) {
      fail(errText(err, 'تعذر تسجيل طلب السداد.'));
    } finally {
      setBusy(false);
    }
  };

  const requestFullBalance = async (inv: Invoice) => {
    setBusy(true);
    try {
      const ack = await apiClient.request<{ message: string; cash_document_number: string }>(
        `/api/v1/finance/supplier-invoices/${inv.id}/payment-requests/full-balance`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      );
      flash(`طلب سداد فاتورة ${inv.internal_number} (${inv.supplier_name}): ${ack.message} رقم المستند ${ack.cash_document_number}.`);
      await load();
    } catch (err) {
      fail(errText(err, 'تعذر إرسال طلب سداد كامل المستحق.'));
    } finally {
      setBusy(false);
    }
  };

  // «تحتاج إجراء»: لم تُستلم بالكامل، أو عليها مستحق (للمالية)، أو يمكن طلب سداد كامل مستحقها (للمخزن)
  const visibleInvoices = invoices.filter((inv) =>
    filter === 'all' ||
    inv.status !== 'received' ||
    (showMoney && Number(inv.payable_balance || 0) > 0.001) ||
    (canRequestFullBalance && Boolean(inv.can_request_full_balance))
  );

  return (
    <section className="warehouse-draft purchasing" aria-labelledby="supplier-title">
      <h3 id="supplier-title" className="sr-only">فواتير الشراء واستلام الخامات</h3>
      <ol className="purchasing__steps" aria-label="خطوات الشراء">
        <li><strong>١</strong> سجّل فاتورة المورد</li>
        <li><strong>٢</strong> استلم الكميات الفعلية بالمخزن</li>
        <li><strong>٣</strong> اطلب السداد ← يُعتمد في الخزينة</li>
      </ol>

      {error && <div className="purchasing__alert purchasing__alert--error" role="alert">⚠️ {error}</div>}
      {success && <div className="purchasing__alert purchasing__alert--ok" role="status">✓ {success}</div>}

      {canCreateInvoices && !showNewInvoice && (
        <div className="purchasing__new-toggle">
          <button type="button" className="btn btn--primary" onClick={() => setShowNewInvoice(true)}>＋ تسجيل فاتورة شراء جديدة</button>
        </div>
      )}

      {canCreateInvoices && showNewInvoice && (
        <form className="purchasing__card" onSubmit={(e) => void createInvoice(e)} aria-labelledby="new-invoice-title">
          <div className="purchasing__card-head">
            <h4 id="new-invoice-title">١. فاتورة شراء جديدة</h4>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowNewInvoice(false)}>إغلاق النموذج</button>
          </div>
          <div className="purchasing__grid">
            <label>المورد
              <select required value={header.supplier_id} onChange={(e) => setHeader({ ...header, supplier_id: e.target.value })}>
                <option value="">— اختر المورد —</option>
                {suppliers.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <small>المورد غير موجود؟ أضفه من «البيانات الأساسية».</small>
            </label>
            <label>رقم فاتورة المورد
              <input required value={header.invoice_number} onChange={(e) => setHeader({ ...header, invoice_number: e.target.value })} placeholder="كما هو على الفاتورة الورقية" />
            </label>
            <label>ملاحظات
              <input value={header.notes} onChange={(e) => setHeader({ ...header, notes: e.target.value })} placeholder="اختياري" />
            </label>
          </div>

          <fieldset className="purchasing__line-form">
            <legend>أضف بنداً</legend>
            <label className="purchasing__wide">الخامة
              <select value={draft.item_id} onChange={(e) => setDraft({ ...draft, item_id: e.target.value })}>
                <option value="">— اختر الخامة —</option>
                {purchasable.map((i) => <option key={i.id} value={i.id}>{i.name_ar} ({i.unit_name_ar})</option>)}
              </select>
            </label>
            <label>الكمية {selectedItem ? `(${selectedItem.unit_name_ar})` : ''}
              <input type="number" min="0.001" step="0.001" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
            </label>
            <label>سعر الوحدة
              <input type="number" min="0" step="0.01" value={draft.unit_price} onChange={(e) => setDraft({ ...draft, unit_price: e.target.value })} />
            </label>
            <label>خصم على البند (ج.م)
              <input type="number" min="0" step="0.01" value={draft.discount} onChange={(e) => setDraft({ ...draft, discount: e.target.value })} placeholder="0" />
            </label>
            <button type="button" className="btn btn--secondary" onClick={addLine}>＋ إضافة البند</button>
          </fieldset>

          {lines.length > 0 ? (
            <div className="md-table-wrap">
              <table className="md-table">
                <thead><tr><th>الخامة</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>الإجمالي</th><th /></tr></thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={l.item_id}>
                      <td><strong>{l.item_name_ar}</strong><small>{l.item_code}</small></td>
                      <td>{qty(l.quantity)} {l.unit_name_ar}</td>
                      <td>{money(l.unit_price)}</td>
                      <td>{l.discount ? money(l.discount) : '—'}</td>
                      <td><strong>{money(lineTotal(l))}</strong></td>
                      <td><button type="button" className="md-link md-link--muted" onClick={() => setLines((cur) => cur.filter((_, i) => i !== idx))}>حذف</button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={4}>إجمالي الفاتورة</td><td colSpan={2}><strong>{money(draftTotal)}</strong></td></tr></tfoot>
              </table>
            </div>
          ) : <p className="md-hint">لم تُضف بنود بعد.</p>}

          <button className="btn btn--primary purchasing__submit" disabled={busy || lines.length === 0}>
            {busy ? 'جاري الحفظ…' : 'حفظ الفاتورة'}
          </button>
        </form>
      )}

      <div className="purchasing__list-head">
        <h4>٢ و ٣. الفواتير: الاستلام والسداد</h4>
        <div className="md-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={filter === 'open'} className={`md-tab${filter === 'open' ? ' md-tab--active' : ''}`} onClick={() => setFilter('open')}>تحتاج إجراء</button>
          <button type="button" role="tab" aria-selected={filter === 'all'} className={`md-tab${filter === 'all' ? ' md-tab--active' : ''}`} onClick={() => setFilter('all')}>كل الفواتير</button>
        </div>
      </div>

      {loading ? <div className="md-empty" role="status">جاري التحميل…</div> : visibleInvoices.length === 0 ? (
        <div className="md-empty">{filter === 'open' ? 'لا توجد فواتير تحتاج استلاماً أو سداداً.' : 'لا توجد فواتير شراء بعد.'}</div>
      ) : visibleInvoices.map((inv) => {
        const st = STATUS[inv.status] ?? { label: inv.status, tone: 'wait' as const };
        const canReceiveThis = canReceive && inv.status !== 'received';
        const payable = maxPayable(inv);
        const pending = Number(inv.pending_payments_total || 0);
        return (
          <article key={inv.id} className="purchasing__card purchasing__invoice">
            <header className="purchasing__invoice-head">
              <div>
                <strong>{inv.supplier_name}</strong>
                <small>فاتورة المورد {inv.invoice_number} · مرجع النظام {inv.internal_number} · {new Date(inv.invoice_date).toLocaleDateString('ar-EG')}</small>
              </div>
              <span className={`purchasing__status purchasing__status--${st.tone}`}>{st.label}</span>
            </header>

            {showMoney && (
              <dl className="purchasing__figures">
                <div><dt>إجمالي الفاتورة</dt><dd>{money(inv.invoice_total)}</dd></div>
                <div><dt>قيمة ما استُلم</dt><dd>{money(inv.received_value)}</dd></div>
                <div><dt>المدفوع (معتمد)</dt><dd>{money(inv.paid_total)}</dd></div>
                {pending > 0 && <div><dt>سداد بانتظار الخزينة</dt><dd className="purchasing__warn">{money(pending)}</dd></div>}
                <div><dt>المستحق للمورد</dt><dd className={Number(inv.payable_balance) > 0 ? 'purchasing__due' : 'purchasing__ok'}>{money(inv.payable_balance)}</dd></div>
              </dl>
            )}

            <div className="md-table-wrap">
              <table className="md-table">
                <thead>
                  <tr>
                    <th>الخامة</th><th>في الفاتورة</th><th>استُلم</th><th>المتبقي</th>
                    {canReceiveThis && <th>وصل الآن</th>}
                    {showMoney && <th>إجمالي البند</th>}
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l) => {
                    const remaining = remainingOf(l);
                    return (
                      <tr key={l.id}>
                        <td><strong>{l.item_name_ar}</strong><small>{l.item_code}</small></td>
                        <td>{qty(l.invoiced_quantity)} {l.unit_name_ar}</td>
                        <td>{qty(l.received_quantity)}</td>
                        <td>{remaining > 0 ? <span className="purchasing__warn">{qty(remaining)}</span> : <span className="purchasing__ok">✓</span>}</td>
                        {canReceiveThis && (
                          <td>
                            {remaining > 0 ? (
                              <input
                                className="purchasing__qty"
                                aria-label={`الكمية التي وصلت من ${l.item_name_ar}`}
                                type="number" min="0" step="0.001" max={remaining}
                                value={receiving[inv.id]?.[l.id] ?? ''}
                                placeholder="0"
                                onChange={(e) => setReceiving((cur) => ({ ...cur, [inv.id]: { ...cur[inv.id], [l.id]: e.target.value } }))}
                              />
                            ) : '—'}
                          </td>
                        )}
                        {showMoney && <td>{money(l.line_total)}{Number(l.discount_amount || 0) > 0 && <small>خصم {money(l.discount_amount)}</small>}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <footer className="purchasing__actions">
              {canReceiveThis && (
                <>
                  <button type="button" className="btn btn--secondary" onClick={() => fillRemaining(inv)}>وصل كل المتبقي</button>
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void confirmReceipt(inv)}>تأكيد الاستلام بالمخزن</button>
                </>
              )}
              {canRequestPayment && payable > 0.001 && (
                <div className="purchasing__pay">
                  <label>مبلغ السداد
                    <input type="number" min="0.01" step="0.01" max={payable.toFixed(2)} placeholder={`حتى ${payable.toFixed(2)}`}
                      value={paymentAmounts[inv.id] ?? ''} onChange={(e) => setPaymentAmounts({ ...paymentAmounts, [inv.id]: e.target.value })} />
                  </label>
                  <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void requestPayment(inv)}>طلب سداد (يُعتمد في الخزينة)</button>
                </div>
              )}
              {canRequestFullBalance && inv.can_request_full_balance && (
                <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void requestFullBalance(inv)}>
                  طلب سداد كامل المستحق
                </button>
              )}
              {!showMoney && inv.has_pending_payment_request && (
                <span className="purchasing__status purchasing__status--part">طلب سداد مرسل · بانتظار اعتماد الخزينة</span>
              )}
              {showMoney && inv.status === 'received' && Number(inv.payable_balance || 0) <= 0.001 && pending <= 0 && (
                <span className="purchasing__ok">✓ الفاتورة مستلمة ومسددة بالكامل</span>
              )}
            </footer>

            {inv.payments && inv.payments.length > 0 && showMoney && (
              <ul className="purchasing__payments" aria-label="دفعات الفاتورة">
                {inv.payments.map((p) => (
                  <li key={p.id}>
                    <span>{money(p.amount)} · {new Date(p.created_at).toLocaleDateString('ar-EG')}</span>
                    <span className={`purchasing__status purchasing__status--${p.status === 'approved' ? 'done' : p.status === 'rejected' ? 'wait' : 'part'}`}>
                      {p.status === 'approved' ? 'معتمد وخُصم من الخزنة' : p.status === 'rejected' ? 'مرفوض' : 'بانتظار اعتماد الخزينة'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </section>
  );
}
