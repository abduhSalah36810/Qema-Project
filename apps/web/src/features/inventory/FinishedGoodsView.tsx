import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  fetchWarehouses,
  fetchOrders,
  receiveFinishedGoodsApi,
  newIdempotencyKey,
  Warehouse,
  ProductionOrder,
  ProductionOrderItem,
} from '@/features/production/productionApi';
import { fetchFinishedGoodsBalances, FinishedGoodsBalance } from './inventoryApi';

const FINISHED_GOODS_CODE = 'finished_goods';
const RECEIPT_STATUSES = ['in_production', 'manufacturing_completed'];
const EPSILON = 1e-9;

type LineInput = { accepted: string; rejected: string };
type OrderReceiptForm = { lines: Record<string, LineInput>; notes: string; idempotencyKey: string };

function seasonLabel(season: string | null | undefined): string {
  if (season === 'summer') return 'صيفي';
  if (season === 'winter') return 'شتوي';
  if (season === 'autumn') return 'خريفي';
  return season || '—';
}

function sizeLabel(row: FinishedGoodsBalance): string {
  const parts = [row.numeric_size ? String(row.numeric_size) : '', row.letter_size || ''].filter(Boolean);
  return parts.length ? parts.join(' / ') : '—';
}

function remainingOf(item: ProductionOrderItem): number {
  return Math.max(0, Math.round((item.target_quantity - (item.received_quantity ?? 0)) * 1e6) / 1e6);
}

function toNumber(value: string): number {
  return value.trim() === '' ? 0 : Number(value);
}

function buildForm(order: ProductionOrder): OrderReceiptForm {
  const lines: Record<string, LineInput> = {};
  (order.items || []).forEach((item) => {
    lines[item.id] = { accepted: String(remainingOf(item)), rejected: '0' };
  });
  return { lines, notes: '', idempotencyKey: newIdempotencyKey() };
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export function FinishedGoodsView() {
  const { hasPermission } = useAuth();
  const canConfirmReceipt = hasPermission('warehouse:finished_goods:receive');

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [balances, setBalances] = useState<FinishedGoodsBalance[]>([]);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [pendingOrders, setPendingOrders] = useState<ProductionOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'explorer' | 'pending'>('explorer');
  const [selectedProductId, setSelectedProductId] = useState<string>('all');
  const [selectedSizeFilter, setSelectedSizeFilter] = useState<string>('all');
  const [selectedSeasonFilter, setSelectedSeasonFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, OrderReceiptForm>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setBalancesError(null);
    try {
      const warehouses = await fetchWarehouses();
      setWarehouse(warehouses.find((w) => w.code === FINISHED_GOODS_CODE) ?? null);
    } catch {
      setWarehouse(null);
    }
    try {
      setBalances(await fetchFinishedGoodsBalances());
    } catch (err: unknown) {
      setBalances([]);
      setBalancesError(errorText(err, 'تعذر تحميل أرصدة المنتج التام.'));
    }
    try {
      const allOrders = await fetchOrders();
      // أوامر يمكن الاستلام منها خادمياً، ولها بنود متبقية، وانتهت تعبئتها أو بدأ استلامها
      const pending = allOrders.filter((o) => {
        if (!RECEIPT_STATUSES.includes(o.status)) return false;
        const items = o.items || [];
        if (items.length > 0 && !items.some((it) => remainingOf(it) > EPSILON)) return false;
        const packingDone = o.stage_events?.some((e) => e.stage_name === 'packing' && e.status === 'completed');
        const partiallyReceived = items.some((it) => (it.received_quantity ?? 0) > 0);
        return o.status === 'manufacturing_completed' || packingDone || partiallyReceived;
      });
      setPendingOrders(pending);
      setForms(Object.fromEntries(pending.map((o) => [o.id, buildForm(o)])));
    } catch (err: unknown) {
      setError(errorText(err, 'تعذر تحميل أوامر التشغيل.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const updateLine = (orderId: string, itemId: string, field: keyof LineInput, value: string) => {
    setForms((cur) => {
      const form = cur[orderId];
      if (!form) return cur;
      const line = form.lines[itemId] || { accepted: '0', rejected: '0' };
      return { ...cur, [orderId]: { ...form, lines: { ...form.lines, [itemId]: { ...line, [field]: value } } } };
    });
  };

  const lineError = (form: OrderReceiptForm | undefined, item: ProductionOrderItem): string | null => {
    const line = form?.lines[item.id] || { accepted: '0', rejected: '0' };
    const accepted = toNumber(line.accepted);
    const rejected = toNumber(line.rejected);
    if (!Number.isFinite(accepted) || accepted < 0) return 'السليم لا يقل عن صفر';
    if (!Number.isFinite(rejected) || rejected < 0) return 'المرفوض لا يقل عن صفر';
    if (accepted > remainingOf(item) + EPSILON) return `يتجاوز المتبقي (${remainingOf(item)})`;
    return null;
  };

  const payloadLines = (order: ProductionOrder) => {
    const form = forms[order.id];
    return (order.items || [])
      .map((item) => {
        const line = form?.lines[item.id] || { accepted: '0', rejected: '0' };
        return { order_item_id: item.id, accepted_quantity: toNumber(line.accepted), rejected_quantity: toNumber(line.rejected) };
      })
      .filter((l) => l.accepted_quantity > 0 || l.rejected_quantity > 0);
  };

  const handleConfirmOrderReceipt = async (order: ProductionOrder) => {
    const form = forms[order.id];
    const items = order.items || [];
    if (!form || items.length === 0) return;
    if (items.some((item) => lineError(form, item) !== null)) {
      setError('راجع الكميات: لا قيم سالبة، ولا يتجاوز السليم المتبقي لكل بند.');
      return;
    }
    const lines = payloadLines(order);
    if (lines.length === 0) {
      setError('أدخل كمية سليمة أو مرفوضة لبند واحد على الأقل.');
      return;
    }
    setBusyOrderId(order.id);
    setError(null);
    setSuccess(null);
    try {
      const res = await receiveFinishedGoodsApi(order.id, { lines, notes: form.notes }, form.idempotencyKey);
      setSuccess(`✓ تم استلام ${res.accepted_quantity} قطعة سليمة من الأمر ${res.order_number} بمخزن المنتجات التامة.`);
      await loadData();
    } catch (err: unknown) {
      setError(errorText(err, 'تعذر استلام المنتج التام.'));
    } finally {
      setBusyOrderId(null);
    }
  };

  const productOptions = useMemo(() => {
    const map = new Map<string, string>();
    balances.forEach((b) => {
      if (b.product_id) map.set(b.product_id, b.product_name_ar || b.item_code);
    });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ar'));
  }, [balances]);

  const sizeOptions = useMemo(() => [...new Set(balances.map(sizeLabel).filter((s) => s !== '—'))].sort(), [balances]);
  const seasonOptions = useMemo(
    () => [...new Set(balances.map((b) => b.season).filter((s): s is string => Boolean(s)))].sort(),
    [balances],
  );

  const filteredBalances = useMemo(() => {
    const q = search.trim().toLowerCase();
    return balances.filter((b) => {
      if (selectedProductId !== 'all' && b.product_id !== selectedProductId) return false;
      if (selectedSizeFilter !== 'all' && sizeLabel(b) !== selectedSizeFilter) return false;
      if (selectedSeasonFilter !== 'all' && b.season !== selectedSeasonFilter) return false;
      if (!q) return true;
      return (
        b.item_code.toLowerCase().includes(q) ||
        (b.product_name_ar || '').toLowerCase().includes(q) ||
        b.private_label.some((p) => p.customer_name.toLowerCase().includes(q))
      );
    });
  }, [balances, search, selectedProductId, selectedSizeFilter, selectedSeasonFilter]);

  const totals = useMemo(() => {
    return balances.reduce(
      (acc, b) => ({
        available: acc.available + b.available_factory_brand,
        privateLabel: acc.privateLabel + b.private_label.reduce((s, p) => s + p.quantity, 0),
        pending: acc.pending + b.pending_inspection,
        total: acc.total + b.total,
      }),
      { available: 0, privateLabel: 0, pending: 0, total: 0 },
    );
  }, [balances]);

  const fmt = (n: number) => n.toLocaleString('ar-EG');

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="fg-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة المخازن · أمين المخازن</span>
          <h2 id="fg-title">مخزن المنتجات التامة</h2>
          <p>
            أرصدة المنتج التام لكل موديل ومقاس حسب الملكية: المتاح للبيع، والمحجوز لعملاء التصنيع الخاص، والمرتجع تحت الفحص.
          </p>
        </div>
        <button className="btn btn--secondary" onClick={() => void loadData()} disabled={loading}>
          ↻ تحديث البيانات
        </button>
      </header>

      {error && (
        <div className="warehouse-alert" role="alert" style={{ backgroundColor: '#fef2f2', color: '#b91c1c', borderColor: '#f87171', marginBottom: '1rem' }}>
          ⚠️ {error}
        </div>
      )}
      {success && (
        <div className="warehouse-alert" role="status" style={{ backgroundColor: '#f0fdf4', color: '#166534', borderColor: '#86efac', marginBottom: '1rem' }}>
          {success}
        </div>
      )}

      <div className="warehouse-summary">
        <article>
          <span>المستودع</span>
          <strong>{warehouse?.name_ar || 'مخزن المنتجات التامة'}</strong>
          <small>المنتج الجاهز للتسليم والبيع</small>
        </article>
        <article>
          <span>متاح للبيع (براند المصنع)</span>
          <strong style={{ color: '#0f766e' }}>{balancesError ? '—' : `${fmt(totals.available)} قطعة`}</strong>
          <small>قابل للتسليم لأي عميل</small>
        </article>
        <article>
          <span>محجوز لتصنيع خاص</span>
          <strong style={{ color: '#92400e' }}>{balancesError ? '—' : `${fmt(totals.privateLabel)} قطعة`}</strong>
          <small>يسلَّم لعميله فقط</small>
        </article>
        <article>
          <span>مرتجعات تحت الفحص</span>
          <strong style={{ color: '#64748b' }}>{balancesError ? '—' : `${fmt(totals.pending)} قطعة`}</strong>
          <small>غير متاحة للبيع</small>
        </article>
        <article style={{ borderColor: pendingOrders.length > 0 ? '#fbbf24' : '#e2e8f0' }}>
          <span>دفعات بانتظار الاستلام</span>
          <strong style={{ color: pendingOrders.length > 0 ? '#b45309' : '#64748b' }}>{pendingOrders.length} دفعة</strong>
          <small>لها بنود متبقية للاستلام</small>
        </article>
      </div>

      <div className="modal-tabs" style={{ marginBottom: '1.25rem' }}>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'explorer' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('explorer')}
        >
          🏷️ أرصدة الموديلات والمقاسات ({balances.length})
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'pending' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          ⏳ دفعات بانتظار استلام التام ({pendingOrders.length})
        </button>
      </div>

      {activeTab === 'explorer' && (
        <div className="warehouse-draft" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1.25rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
            <label>
              <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>الموديل</span>
              <select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)} style={{ width: '100%' }}>
                <option value="all">كل الموديلات</option>
                {productOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label>
              <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>المقاس</span>
              <select value={selectedSizeFilter} onChange={(e) => setSelectedSizeFilter(e.target.value)} style={{ width: '100%' }}>
                <option value="all">كل المقاسات</option>
                {sizeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>
              <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>الموسم</span>
              <select value={selectedSeasonFilter} onChange={(e) => setSelectedSeasonFilter(e.target.value)} style={{ width: '100%' }}>
                <option value="all">كل المواسم</option>
                {seasonOptions.map((s) => <option key={s} value={s}>{seasonLabel(s)}</option>)}
              </select>
            </label>
            <label>
              <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>بحث</span>
              <input type="search" placeholder="كود الصنف أو الموديل أو العميل" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%' }} />
            </label>
          </div>

          {loading ? (
            <p style={{ color: '#64748b' }}>جاري تحميل أرصدة المنتجات التامة...</p>
          ) : balancesError ? (
            <p role="alert" style={{ color: '#b91c1c' }}>{balancesError}</p>
          ) : filteredBalances.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b', background: '#f8fafc', borderRadius: '6px' }}>
              {balances.length === 0 ? 'لا توجد أرصدة منتج تام بالمخزن حالياً.' : 'لا توجد أرصدة مطابقة للفلاتر المحددة.'}
            </div>
          ) : (
            <div className="warehouse-table-wrap">
              <table className="warehouse-table" aria-label="أرصدة المنتج التام">
                <thead>
                  <tr>
                    <th>الموديل</th>
                    <th>المقاس</th>
                    <th>الموسم</th>
                    <th>متاح للبيع</th>
                    <th>محجوز تصنيع خاص</th>
                    <th>مرتجع تحت الفحص</th>
                    <th>الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBalances.map((b) => (
                    <tr key={b.item_id}>
                      <td><strong>{b.product_name_ar || b.item_name_ar || '—'}</strong></td>
                      <td><span className="badge-tag">{sizeLabel(b)}</span></td>
                      <td>{seasonLabel(b.season)}</td>
                      <td>
                        <strong style={{ color: b.available_factory_brand > 0 ? '#0d9488' : '#64748b' }}>
                          {fmt(b.available_factory_brand)}
                        </strong>
                      </td>
                      <td>
                        {b.private_label.length === 0 ? '—' : (
                          <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>
                            {b.private_label.map((p) => (
                              <li key={p.customer_id}>{p.customer_name || 'عميل غير معروف'}: <strong>{fmt(p.quantity)}</strong></li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>{b.pending_inspection ? fmt(b.pending_inspection) : '—'}</td>
                      <td>
                        <strong>{fmt(b.total)}</strong>
                        {b.unassigned ? <small style={{ display: 'block', color: '#92400e' }}>منها غير مصنف: {fmt(b.unassigned)}</small> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'pending' && (
        <section className="warehouse-draft" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1.25rem' }}>
          <div style={{ marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, color: '#92400e' }}>⏳ دفعات إنتاج بانتظار استلام التام ({pendingOrders.length})</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#78350f' }}>
              سجّل لكل مقاس/بند الكمية السليمة والمرفوضة. القيمة الافتراضية للسليم هي المتبقي من البند.
            </p>
          </div>

          {pendingOrders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b', background: '#f8fafc', borderRadius: '6px' }}>
              ✓ لا توجد دفعات إنتاج بانتظار الاستلام حالياً.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {pendingOrders.map((order) => {
                const form = forms[order.id];
                const items = order.items || [];
                const isBusy = busyOrderId === order.id;
                const hasErrors = items.some((item) => lineError(form, item) !== null);
                const lines = payloadLines(order);
                return (
                  <div key={order.id} style={{ background: '#fffbeb', border: '1px solid #fed7aa', borderRadius: '6px', padding: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <strong style={{ fontSize: '1rem', color: '#1e293b' }}>
                        {order.order_number} — {order.product_name_ar}
                      </strong>
                      <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
                        المستهدف الإجمالي: <strong>{order.target_quantity} قطعة</strong>
                      </span>
                    </div>

                    {items.length === 0 ? (
                      <p style={{ margin: 0, color: '#92400e' }}>هذا الأمر لا يحتوي على بنود منتجات؛ لا يمكن استلامه من هذه الشاشة.</p>
                    ) : (
                      <>
                        <div className="warehouse-table-wrap">
                          <table className="warehouse-table" aria-label={`بنود استلام ${order.order_number}`}>
                            <thead>
                              <tr>
                                <th>البند / المقاس</th>
                                <th>الملكية</th>
                                <th>المستهدف</th>
                                <th>المستلم سابقاً</th>
                                <th>المتبقي</th>
                                <th>سليم الآن</th>
                                <th>مرفوض الآن</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map((item) => {
                                const line = form?.lines[item.id] || { accepted: '0', rejected: '0' };
                                const err = lineError(form, item);
                                const label = `${order.order_number} ${item.variant_info || item.product_name_ar}`;
                                return (
                                  <tr key={item.id}>
                                    <td><strong>{item.product_name_ar}</strong><br /><small>{item.variant_info || item.season}</small></td>
                                    <td>{item.product_type === 'private_label' ? `تصنيع خاص: ${item.customer_name || 'عميل'}` : 'براند المصنع'}</td>
                                    <td>{item.target_quantity}</td>
                                    <td>{item.received_quantity ?? 0}</td>
                                    <td><strong>{remainingOf(item)}</strong></td>
                                    <td>
                                      <input
                                        type="number"
                                        min={0}
                                        max={remainingOf(item)}
                                        step="any"
                                        aria-label={`الكمية السليمة ${label}`}
                                        aria-invalid={err ? true : undefined}
                                        value={line.accepted}
                                        disabled={!canConfirmReceipt || remainingOf(item) <= EPSILON}
                                        onChange={(e) => updateLine(order.id, item.id, 'accepted', e.target.value)}
                                        style={{ width: '6rem' }}
                                      />
                                      {err && <small role="alert" style={{ display: 'block', color: '#b91c1c' }}>{err}</small>}
                                    </td>
                                    <td>
                                      <input
                                        type="number"
                                        min={0}
                                        step="any"
                                        aria-label={`الكمية المرفوضة ${label}`}
                                        value={line.rejected}
                                        disabled={!canConfirmReceipt}
                                        onChange={(e) => updateLine(order.id, item.id, 'rejected', e.target.value)}
                                        style={{ width: '6rem' }}
                                      />
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                          <label style={{ fontSize: '0.85rem', flex: '1 1 260px' }}>
                            ملاحظات الفحص والجودة:
                            <input
                              value={form?.notes || ''}
                              disabled={!canConfirmReceipt}
                              onChange={(e) => setForms((cur) => (cur[order.id] ? { ...cur, [order.id]: { ...cur[order.id], notes: e.target.value } } : cur))}
                              style={{ marginTop: '0.25rem', width: '100%' }}
                            />
                          </label>
                          {canConfirmReceipt ? (
                            <button
                              type="button"
                              className="btn btn--primary"
                              disabled={isBusy || busyOrderId !== null || hasErrors || lines.length === 0}
                              onClick={() => void handleConfirmOrderReceipt(order)}
                              style={{ minWidth: '160px' }}
                            >
                              {isBusy ? 'جاري الترحيل...' : '✓ تأكيد استلام التام'}
                            </button>
                          ) : (
                            <small style={{ color: '#b91c1c' }}>استلام المنتج التام من مسؤولية أمين المخزن أو المدير العام.</small>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
