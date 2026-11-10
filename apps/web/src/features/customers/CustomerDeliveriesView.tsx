import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  fetchPendingDeliveries,
  PendingDeliveryItem,
  recordCustomerDelivery,
} from './customersApi';

function formatQuantity(qty: number): string {
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(qty);
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export function CustomerDeliveriesView() {
  const [items, setItems] = useState<PendingDeliveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'ready' | 'shortage'>('all');

  // Dispatch modal state
  const [selectedItem, setSelectedItem] = useState<PendingDeliveryItem | null>(null);
  const [dispatchQty, setDispatchQty] = useState('');
  const [receivedBy, setReceivedBy] = useState('');
  const [dispatchNotes, setDispatchNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPendingDeliveries();
      setItems(data);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل طلبات التسليم المعلقة.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Statistics
  const stats = useMemo(() => {
    const totalPending = items.length;
    const readyCount = items.filter((item) => item.available_stock >= item.remaining_quantity && item.available_stock > 0).length;
    const shortageCount = items.filter((item) => item.available_stock < item.remaining_quantity).length;
    const totalRemainingQty = items.reduce((sum, item) => sum + item.remaining_quantity, 0);

    return { totalPending, readyCount, shortageCount, totalRemainingQty };
  }, [items]);

  // Filtered Items
  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return items.filter((item) => {
      const matchesSearch =
        !term ||
        item.customer_name.toLowerCase().includes(term) ||
        item.customer_code.toLowerCase().includes(term) ||
        item.order_number.toLowerCase().includes(term) ||
        item.product_name.toLowerCase().includes(term) ||
        item.variant_info.toLowerCase().includes(term);

      if (!matchesSearch) return false;

      if (stockFilter === 'ready') {
        return item.available_stock >= item.remaining_quantity && item.available_stock > 0;
      }
      if (stockFilter === 'shortage') {
        return item.available_stock < item.remaining_quantity;
      }

      return true;
    });
  }, [items, searchTerm, stockFilter]);

  const openDispatchModal = (item: PendingDeliveryItem) => {
    setSelectedItem(item);
    const maxPossible = Math.min(item.remaining_quantity, item.available_stock);
    setDispatchQty(maxPossible > 0 ? String(maxPossible) : '0');
    setReceivedBy('');
    setDispatchNotes('');
    setModalError(null);
  };

  const handleDispatchSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedItem) return;

    const qty = Number(dispatchQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setModalError('يرجى إدخال كمية تسليم صحيحة أكبر من الصفر.');
      return;
    }

    if (qty > selectedItem.remaining_quantity) {
      setModalError(`الكمية المدخلة (${qty}) تتجاوز المتبقي للعميل (${selectedItem.remaining_quantity}).`);
      return;
    }

    if (qty > selectedItem.available_stock) {
      setModalError(`الكمية المدخلة (${qty}) تتجاوز الرصيد المتاح بمخزن التام (${selectedItem.available_stock}).`);
      return;
    }

    if (!receivedBy.trim()) {
      setModalError('يرجى كتابة اسم المستلم أو مندوب العميل.');
      return;
    }

    setSubmitting(true);
    setModalError(null);

    try {
      await recordCustomerDelivery(selectedItem.customer_id, selectedItem.order_id, {
        received_by: receivedBy.trim(),
        notes: dispatchNotes.trim(),
        lines: [
          {
            order_line_id: selectedItem.order_line_id,
            quantity: qty,
          },
        ],
      });

      setSuccess(`تم صرف وتسليم ${qty} قطعة من (${selectedItem.product_name} - ${selectedItem.variant_info}) للعميل (${selectedItem.customer_name}) وخصمها من مخزن التام بنجاح.`);
      setSelectedItem(null);
      await loadData();
    } catch (err: unknown) {
      setModalError(err instanceof ApiError ? err.message : 'تعذر تسجيل صرف التسليم. راجع الرصيد المتاح.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="deliveries-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">المبيعات والتسليم والمخازن</span>
          <h2 id="deliveries-title">طلبات التسليم وصرف المنتج التام للعملاء</h2>
          <p>
            متابعة بنود طلبيات العملاء الجاهزة للتسليم، والتحقق المباشر من رصيد مخزن المنتجات التامة، وتنفيذ الصرف الفعلي مع الخصم المخزني الموثق.
          </p>
        </div>
        <div>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void loadData()}
            disabled={loading}
          >
            ↻ تحديث الطلبات
          </button>
        </div>
      </header>

      {/* تنبيهات النجاح والخطأ العام */}
      {error && (
        <div className="warehouse-alert" role="alert" style={{ background: '#fef2f2', border: '1px solid #f87171', color: '#b91c1c', padding: '0.75rem', borderRadius: '4px', marginBottom: '1rem' }}>
          ⚠️ {error}
        </div>
      )}

      {success && (
        <div className="warehouse-alert" role="alert" style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#166534', padding: '0.75rem', borderRadius: '4px', marginBottom: '1rem' }}>
          ✓ {success}
        </div>
      )}

      {/* بطاقات الإحصائيات التشغيلية */}
      <div className="customers-stats" aria-label="ملخص طلبات التسليم" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
        <article style={{ background: '#fff', padding: '1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>إجمالي البنود المعلقة</span>
          <strong style={{ display: 'block', fontSize: '1.5rem', color: '#0f172a', marginTop: '0.25rem' }}>{stats.totalPending}</strong>
        </article>
        <article style={{ background: '#fff', padding: '1rem', borderRadius: '6px', border: '1px solid #bbf7d0', borderRight: '4px solid #16a34a' }}>
          <span style={{ fontSize: '0.85rem', color: '#166534' }}>جاهز للصرف فوراً (متوفر بالمخزن)</span>
          <strong style={{ display: 'block', fontSize: '1.5rem', color: '#16a34a', marginTop: '0.25rem' }}>{stats.readyCount}</strong>
        </article>
        <article style={{ background: '#fff', padding: '1rem', borderRadius: '6px', border: '1px solid #fecaca', borderRight: '4px solid #dc2626' }}>
          <span style={{ fontSize: '0.85rem', color: '#991b1b' }}>بانتظار اكتمال الإنتاج (عجز رصيد)</span>
          <strong style={{ display: 'block', fontSize: '1.5rem', color: '#dc2626', marginTop: '0.25rem' }}>{stats.shortageCount}</strong>
        </article>
        <article style={{ background: '#fff', padding: '1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>إجمالي القطع المتبقية للتسليم</span>
          <strong style={{ display: 'block', fontSize: '1.5rem', color: '#0f766e', marginTop: '0.25rem' }}>{formatQuantity(stats.totalRemainingQty)} قطعة</strong>
        </article>
      </div>

      {/* شريط الفلترة والبحث */}
      <div className="catalog-toolbar" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem', background: '#fff', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
        <input
          type="text"
          placeholder="ابحث باسم العميل، كود العميل، رقم الطلب، أو اسم الموديل..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ flex: '1', minWidth: '240px', padding: '0.5rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
        />

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className={`btn-secondary btn-sm ${stockFilter === 'all' ? 'btn--primary' : ''}`}
            onClick={() => setStockFilter('all')}
            style={stockFilter === 'all' ? { background: '#0f766e', color: '#fff' } : {}}
          >
            الكل ({items.length})
          </button>
          <button
            type="button"
            className={`btn-secondary btn-sm ${stockFilter === 'ready' ? 'btn--primary' : ''}`}
            onClick={() => setStockFilter('ready')}
            style={stockFilter === 'ready' ? { background: '#16a34a', color: '#fff' } : {}}
          >
            جاهز للصرف فقط ({stats.readyCount})
          </button>
          <button
            type="button"
            className={`btn-secondary btn-sm ${stockFilter === 'shortage' ? 'btn--primary' : ''}`}
            onClick={() => setStockFilter('shortage')}
            style={stockFilter === 'shortage' ? { background: '#dc2626', color: '#fff' } : {}}
          >
            بانتظار تصنيع ({stats.shortageCount})
          </button>
        </div>
      </div>

      {/* جدول بنود التسليم */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
          <div className="catalog-spinner" style={{ margin: '0 auto 1rem' }} />
          <p>جاري تحميل طلبات التسليم ومطابقة أرصدة مخزن التام...</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', background: '#fff', borderRadius: '6px', border: '1px solid #e2e8f0', color: '#64748b' }}>
          <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: '0.5rem' }}>📦</span>
          <h4>لا توجد طلبات تسليم مطابقة للبحث أو الفلتر المختار</h4>
          <p>جميع الطلبات مسلّمة بالكامل أو لا توجد طلبيات بيع معلقة حالياً.</p>
        </div>
      ) : (
        <div style={{ background: '#fff', borderRadius: '6px', border: '1px solid #cbd5e1', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'right', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1', color: '#334155' }}>
                <th style={{ padding: '8px 10px' }}>العميل</th>
                <th style={{ padding: '8px 10px' }}>رقم الطلب / التاريخ</th>
                <th style={{ padding: '8px 10px' }}>الموديل والمواصفات</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>المطلوب</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>المسلّم سابقاً</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>المتبقي</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>رصيد مخزن التام</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>حالة التوفر</th>
                <th style={{ padding: '8px 10px', textAlign: 'center' }}>إجراء الصرف</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => {
                const isFullyAvailable = item.available_stock >= item.remaining_quantity && item.available_stock > 0;
                const isPartiallyAvailable = item.available_stock > 0 && item.available_stock < item.remaining_quantity;
                const isOutOfStock = item.available_stock <= 0;

                return (
                  <tr
                    key={item.order_line_id}
                    style={{
                      borderBottom: '1px solid #e2e8f0',
                      background: isFullyAvailable ? '#fafffc' : isOutOfStock ? '#fffafa' : '#fff',
                    }}
                  >
                    <td style={{ padding: '10px' }}>
                      <strong style={{ display: 'block', color: '#0f172a' }}>{item.customer_name}</strong>
                      <span style={{ fontSize: '0.8rem', color: '#64748b' }}>كود: {item.customer_code}</span>
                    </td>
                    <td style={{ padding: '10px' }}>
                      <span style={{ fontWeight: 600, color: '#0f766e' }}>{item.order_number}</span>
                      <span style={{ display: 'block', fontSize: '0.75rem', color: '#64748b' }}>{formatDate(item.order_date)}</span>
                    </td>
                    <td style={{ padding: '10px' }}>
                      <strong style={{ color: '#1e293b' }}>{item.product_name}</strong>
                      <span style={{ display: 'block', fontSize: '0.8rem', color: '#475569' }}>
                        المقاس: {(item.variant_info || '').replace(/summer/g, 'صيفي').replace(/autumn/g, 'خريفي').replace(/winter/g, 'شتوي')}
                      </span>
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center', fontWeight: 600 }}>
                      {formatQuantity(item.requested_quantity)}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center', color: '#64748b' }}>
                      {formatQuantity(item.delivered_quantity)}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center', fontWeight: 700, color: '#0f172a' }}>
                      {formatQuantity(item.remaining_quantity)}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '1rem',
                          color: isFullyAvailable ? '#16a34a' : isPartiallyAvailable ? '#d97706' : '#dc2626',
                        }}
                      >
                        {formatQuantity(item.available_stock)}
                      </span>
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      {isFullyAvailable ? (
                        <span style={{ background: '#dcfce7', color: '#166534', padding: '3px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                          ✓ متوفر بالكامل
                        </span>
                      ) : isPartiallyAvailable ? (
                        <span style={{ background: '#fef3c7', color: '#92400e', padding: '3px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                          ⚠️ متوفر جزئي ({formatQuantity(item.available_stock)})
                        </span>
                      ) : (
                        <span style={{ background: '#fee2e2', color: '#991b1b', padding: '3px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>
                          ✖ رصيد صفر (قيد الإنتاج)
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={() => openDispatchModal(item)}
                        disabled={item.available_stock <= 0}
                        style={{
                          padding: '6px 12px',
                          borderRadius: '4px',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          cursor: item.available_stock > 0 ? 'pointer' : 'not-allowed',
                          border: 'none',
                          background: item.available_stock > 0 ? '#0f766e' : '#cbd5e1',
                          color: item.available_stock > 0 ? '#fff' : '#64748b',
                        }}
                        title={item.available_stock > 0 ? 'صرف وتسليم البضاعة للعميل' : 'لا يوجد رصيد بمخزن التام للصرف'}
                      >
                        🚚 صرف وتسليم
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* نافذة تأكيد الصرف والتسليم الفعلي */}
      {selectedItem && (
        <div
          className="customer-modal-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#fff',
              borderRadius: '8px',
              maxWidth: '520px',
              width: '100%',
              padding: '1.5rem',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.75rem', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.2rem', color: '#0f172a' }}>🚚 تسجيل صرف وتسليم بضاعة للعميل</h3>
              <button
                type="button"
                onClick={() => setSelectedItem(null)}
                style={{ background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: '#64748b' }}
              >
                ✕
              </button>
            </div>

            {modalError && (
              <div style={{ background: '#fef2f2', border: '1px solid #f87171', color: '#b91c1c', padding: '0.5rem 0.75rem', borderRadius: '4px', marginBottom: '1rem', fontSize: '0.85rem' }}>
                ⚠️ {modalError}
              </div>
            )}

            <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0', marginBottom: '1rem', fontSize: '0.85rem' }}>
              <div style={{ marginBottom: '0.25rem' }}>العميل: <strong>{selectedItem.customer_name}</strong> ({selectedItem.customer_code})</div>
              <div style={{ marginBottom: '0.25rem' }}>الطلب: <strong>{selectedItem.order_number}</strong> بتاريخ {formatDate(selectedItem.order_date)}</div>
              <div style={{ marginBottom: '0.25rem' }}>الصنف: <strong>{selectedItem.product_name}</strong> — {selectedItem.variant_info}</div>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px dashed #cbd5e1' }}>
                <span>المتبقي للعميل: <strong>{formatQuantity(selectedItem.remaining_quantity)}</strong></span>
                <span>المتاح بمخزن التام: <strong style={{ color: '#0f766e' }}>{formatQuantity(selectedItem.available_stock)}</strong></span>
              </div>
            </div>

            <form onSubmit={(e) => void handleDispatchSubmit(e)}>
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                  كمية الصرف والتسليم الحالية (قطعة):
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="number"
                    min="1"
                    max={Math.min(selectedItem.remaining_quantity, selectedItem.available_stock)}
                    step="1"
                    required
                    value={dispatchQty}
                    onChange={(e) => setDispatchQty(e.target.value)}
                    style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '1rem', fontWeight: 600 }}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setDispatchQty(String(Math.min(selectedItem.remaining_quantity, selectedItem.available_stock)))}
                    style={{ fontSize: '0.8rem' }}
                  >
                    أقصى كمية متاحة
                  </button>
                </div>
                <small style={{ color: '#64748b' }}>
                  الحد الأقصى المسموح به: {Math.min(selectedItem.remaining_quantity, selectedItem.available_stock)} قطعة (محكوم بالرصيد المتاح والمتبقي).
                </small>
              </div>

              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                  اسم المستلم / مندوب العميل: <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="مثال: أحمد عبد الله (مندوب الشحن / العميل نفسه)"
                  value={receivedBy}
                  onChange={(e) => setReceivedBy(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                />
              </div>

              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                  ملاحظات التسليم أو رقم إذن الصرف:
                </label>
                <input
                  type="text"
                  placeholder="أي تفاصيل تخص كراتين التعبئة أو سيارة التحميل..."
                  value={dispatchNotes}
                  onChange={(e) => setDispatchNotes(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setSelectedItem(null)}
                  disabled={submitting}
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={submitting || Number(dispatchQty) <= 0 || Number(dispatchQty) > selectedItem.available_stock}
                  style={{ background: '#0f766e' }}
                >
                  {submitting ? 'جاري قيد الصرف...' : '✓ تأكيد الصرف وخصم رصيد التام'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

