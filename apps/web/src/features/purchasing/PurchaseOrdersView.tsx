import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { useDialog } from '@/components/feedback/DialogProvider';
import { formatMoney } from '@/lib/formatters';
import { apiClient } from '@/lib/api';
import {
  purchaseOrdersApi,
  PurchaseOrder,
  PO_STATUS_LABELS,
  PO_STATUS_COLORS,
} from './purchaseOrdersApi';

interface Supplier {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

export const PurchaseOrdersView: React.FC = () => {
  const { hasPermission } = useAuth();
  const dialog = useDialog();
  const canApprove = hasPermission('purchase_orders:approve');
  const canManage = hasPermission('purchase_orders:manage');
  const canReceive = hasPermission('suppliers:receive');

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // الفلاتر
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // تفاصيل الأمر المعروض في الـ Drawer / Modal
  const [selectedOrder, setSelectedOrder] = useState<PurchaseOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailActionLoading, setDetailActionLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailSuccess, setDetailSuccess] = useState<string | null>(null);

  // وضع إثبات الاستلام المخزني (GRN Mode) داخل التفاصيل
  const [isReceivingMode, setIsReceivingMode] = useState(false);
  const [receiveInputs, setReceiveInputs] = useState<Record<string, { qty: string; notes: string }>>({});
  const [receiptGeneralNotes, setReceiptGeneralNotes] = useState('');

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const [pos, sups] = await Promise.all([
        purchaseOrdersApi.list(),
        apiClient.request<Supplier[]>('/api/v1/finance/suppliers').catch(() => [] as Supplier[]),
      ]);
      setOrders(pos);
      setSuppliers(sups.filter((s) => s.is_active));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر تحميل أوامر الشراء.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOrders();
  }, []);

  const openOrderDetail = async (poId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    setDetailSuccess(null);
    setIsReceivingMode(false);
    try {
      const po = await purchaseOrdersApi.getById(poId);
      setSelectedOrder(po);

      // تهيئة قيم الاستلام المخزني الافتراضية
      const initReceive: Record<string, { qty: string; notes: string }> = {};
      po.lines.forEach((line) => {
        initReceive[line.id] = {
          qty: String(line.remaining_quantity),
          notes: '',
        };
      });
      setReceiveInputs(initReceive);
      setReceiptGeneralNotes('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر تحميل تفاصيل أمر الشراء.';
      setDetailError(msg);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeOrderDetail = () => {
    setSelectedOrder(null);
    setIsReceivingMode(false);
  };

  const handleApprovePO = async (poId: string) => {
    const approved = await dialog.confirm({
      title: 'اعتماد أمر الشراء',
      message: 'هل أنت متأكد من اعتماد أمر الشراء للتوريد رسمياً؟ بعد الاعتماد يصبح جاهزاً للتوريد والاستلام المخزني.',
      confirmLabel: 'اعتماد الأمر',
      cancelLabel: 'تراجع',
    });
    if (!approved) return;
    setDetailActionLoading(true);
    setDetailError(null);
    try {
      const updated = await purchaseOrdersApi.approve(poId);
      setSelectedOrder(updated);
      setDetailSuccess('تم اعتماد أمر الشراء بنجاح، وأصبح جاهزاً للتوريد والاستلام المخزني.');
      void loadOrders();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر اعتماد أمر الشراء.';
      setDetailError(msg);
    } finally {
      setDetailActionLoading(false);
    }
  };

  const handleCancelPO = async (poId: string) => {
    const reason = await dialog.prompt({
      title: 'إلغاء أمر الشراء',
      message: 'سيُوثَّق الإلغاء في سجل أمر الشراء ولا يمكن الرجوع عنه من هذه الشاشة.',
      label: 'سبب الإلغاء (اختياري)',
      placeholder: 'مثال: تغيّر خطة التوريد أو توفر بديل أرخص',
      confirmLabel: 'إلغاء الأمر',
      cancelLabel: 'تراجع',
      tone: 'danger',
    });
    if (reason === null) return;
    setDetailActionLoading(true);
    setDetailError(null);
    try {
      const updated = await purchaseOrdersApi.cancel(poId, reason || undefined);
      setSelectedOrder(updated);
      setDetailSuccess('تم إلغاء أمر الشراء مع توثيق الأثر.');
      void loadOrders();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر إلغاء أمر الشراء.';
      setDetailError(msg);
    } finally {
      setDetailActionLoading(false);
    }
  };

  const handleConfirmReceipt = async () => {
    if (!selectedOrder) return;

    const linesToReceive = Object.entries(receiveInputs)
      .map(([lineId, data]) => ({
        line_id: lineId,
        received_quantity: Number(data.qty) || 0,
        notes: data.notes.trim(),
      }))
      .filter((l) => l.received_quantity > 0);

    if (linesToReceive.length === 0) {
      setDetailError('يجب إدخال كمية مستلمة أكبر من صفر لبند واحد على الأقل.');
      return;
    }

    setDetailActionLoading(true);
    setDetailError(null);
    setDetailSuccess(null);

    try {
      const updated = await purchaseOrdersApi.receive(selectedOrder.id, {
        lines: linesToReceive,
        notes: receiptGeneralNotes.trim(),
      });
      setSelectedOrder(updated);
      setIsReceivingMode(false);
      setDetailSuccess('تم إثبات استلام الخامات بمخزن الخامات الرئيسي وزيادة الرصيد الحر في دفتر الأستاذ بنجاح.');
      void loadOrders();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر تسجيل الاستلام المخزني.';
      setDetailError(msg);
    } finally {
      setDetailActionLoading(false);
    }
  };

  // تصفية الأوامر
  const filteredOrders = useMemo(() => {
    return orders.filter((po) => {
      if (statusFilter !== 'all' && po.status !== statusFilter) return false;
      if (supplierFilter !== 'all' && po.supplier_id !== supplierFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const num = (po.order_number || '').toLowerCase();
        const sup = (po.supplier_name || '').toLowerCase();
        const prod = (po.production_order_number || '').toLowerCase();
        const notes = (po.notes || '').toLowerCase();
        if (!num.includes(q) && !sup.includes(q) && !prod.includes(q) && !notes.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [orders, statusFilter, supplierFilter, searchQuery]);

  // إحصائيات سريعة
  const metrics = useMemo(() => {
    const draftCount = orders.filter((o) => o.status === 'draft').length;
    const approvedCount = orders.filter((o) => o.status === 'approved' || o.status === 'partially_received').length;
    const receivedCount = orders.filter((o) => o.status === 'received').length;
    return { total: orders.length, draft: draftCount, inProgress: approvedCount, completed: receivedCount };
  }, [orders]);

  return (
    <div className="warehouse-page" dir="rtl">
      {/* بطاقات الإحصائيات العلوية */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>إجمالي أوامر الشراء</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#0f172a' }}>{metrics.total}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>مسودات بانتظار الاعتماد</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: metrics.draft > 0 ? '#d97706' : '#64748b' }}>
            {metrics.draft}
          </div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>أوامر معتمدة جاري توريدها</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#2563eb' }}>{metrics.inProgress}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e2e8f0', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>أوامر مكتملة الاستلام</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#15803d' }}>{metrics.completed}</div>
        </div>
      </div>

      {/* شريط أدوات التصفية والبحث */}
      <div
        style={{
          background: '#fff',
          border: '1px solid #e2e8f0',
          padding: '1rem',
          borderRadius: '8px',
          marginBottom: '1.25rem',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <input
            type="search"
            placeholder="بحث برقم الأمر أو المورد أو أمر التشغيل..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ minWidth: '260px', padding: '0.45rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.88rem' }}
          />

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '0.45rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.88rem' }}
          >
            <option value="all">كل الحالات</option>
            <option value="draft">مسودة جديدة</option>
            <option value="approved">معتمد للتوريد</option>
            <option value="partially_received">مستلم جزئياً</option>
            <option value="received">مكتمل الاستلام</option>
            <option value="cancelled">ملغي</option>
          </select>

          <select
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            style={{ padding: '0.45rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.88rem' }}
          >
            <option value="all">كل الموردين</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void loadOrders()}
          disabled={loading}
          style={{ padding: '0.45rem 1rem', fontSize: '0.85rem' }}
        >
          {loading ? 'جاري التحديث...' : '↻ تحديث'}
        </button>
      </div>

      {error && (
        <div className="warehouse-alert" role="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '1rem' }}>
          ⚠️ {error}
        </div>
      )}

      {/* جدول أوامر الشراء */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
        <table className="order-detail-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ background: '#f8fafc', textAlign: 'right', borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ padding: '0.75rem 1rem' }}>رقم أمر الشراء</th>
              <th style={{ padding: '0.75rem 1rem' }}>المورد</th>
              <th style={{ padding: '0.75rem 1rem' }}>أمر التشغيل</th>
              <th style={{ padding: '0.75rem 1rem' }}>الكميات (مطلوب / مستلم)</th>
              <th style={{ padding: '0.75rem 1rem' }}>القيمة الإجمالية</th>
              <th style={{ padding: '0.75rem 1rem' }}>تاريخ الإنشاء</th>
              <th style={{ padding: '0.75rem 1rem' }}>الحالة</th>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '2.5rem', color: '#64748b' }}>
                  جاري تحميل أوامر الشراء...
                </td>
              </tr>
            ) : filteredOrders.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '2.5rem', color: '#64748b' }}>
                  لا توجد أوامر شراء مطابقة لمعايير البحث.
                </td>
              </tr>
            ) : (
              filteredOrders.map((po) => {
                const badge = PO_STATUS_COLORS[po.status] || { bg: '#f1f5f9', text: '#334155', border: '#cbd5e1' };
                const pct = po.total_ordered_quantity > 0
                  ? Math.min(100, Math.round((po.total_received_quantity / po.total_ordered_quantity) * 100))
                  : 0;

                return (
                  <tr key={po.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{po.order_number}</span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontWeight: 500 }}>{po.supplier_name}</div>
                      <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{po.supplier_code}</div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {po.production_order_number ? (
                        <span style={{ color: '#2563eb', fontWeight: 500 }}>{po.production_order_number}</span>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>شراء عام</span>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <div style={{ fontSize: '0.85rem' }}>
                        {po.total_received_quantity} / {po.total_ordered_quantity}
                        <span style={{ fontSize: '0.75rem', color: '#64748b', marginRight: '0.4rem' }}>({pct}%)</span>
                      </div>
                      <div style={{ width: '100px', height: '5px', background: '#e2e8f0', borderRadius: '3px', marginTop: '0.25rem', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? '#15803d' : '#2563eb' }} />
                      </div>
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      {po.prices_visible && po.total_amount !== null ? (
                        <span style={{ fontWeight: 600, color: '#0f172a' }}>
                          {Number(po.total_amount).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>محجوب (مخزن)</span>
                      )}
                    </td>
                    <td style={{ padding: '0.75rem 1rem', fontSize: '0.82rem', color: '#64748b' }}>
                      {po.created_at ? new Date(po.created_at).toLocaleDateString('ar-EG') : '—'}
                    </td>
                    <td style={{ padding: '0.75rem 1rem' }}>
                      <span
                        style={{
                          background: badge.bg,
                          color: badge.text,
                          border: `1px solid ${badge.border}`,
                          padding: '0.25rem 0.65rem',
                          borderRadius: '4px',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                        }}
                      >
                        {po.status_label_ar || PO_STATUS_LABELS[po.status]}
                      </span>
                    </td>
                    <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => void openOrderDetail(po.id)}
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.82rem' }}
                      >
                        التفاصيل ←
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* نافذة تفاصيل أمر الشراء (Modal / Drawer) */}
      {selectedOrder && (
        <div className="modal-backdrop" style={{ zIndex: 1200 }}>
          <div
            className="modal-container"
            dir="rtl"
            style={{ maxWidth: '920px', width: '95%', maxHeight: '90vh', overflowY: 'auto' }}
          >
            <header className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>تفاصيل أمر الشراء · Purchase Order</span>
                <h2 style={{ margin: '0.25rem 0 0', fontSize: '1.35rem', color: '#0f172a' }}>
                  {selectedOrder.order_number}
                </h2>
              </div>
              <button
                type="button"
                className="btn-icon"
                onClick={closeOrderDetail}
                aria-label="إغلاق"
                style={{ fontSize: '1.25rem', border: 'none', background: 'transparent', cursor: 'pointer' }}
              >
                ✕
              </button>
            </header>

            <div className="modal-body" style={{ padding: '1.25rem 0' }}>
              {detailLoading && (
                <div style={{ textAlign: 'center', padding: '1rem', color: '#64748b' }}>
                  جاري تحميل تفاصيل أمر الشراء...
                </div>
              )}
              {detailError && (
                <div className="warehouse-alert" role="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '1rem' }}>
                  ⚠️ {detailError}
                </div>
              )}
              {detailSuccess && (
                <div className="warehouse-alert" role="status" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '1rem' }}>
                  ✓ {detailSuccess}
                </div>
              )}

              {/* بطاقة بيانات الأمر الأساسية */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', background: '#f8fafc', padding: '1rem', borderRadius: '6px', border: '1px solid #e2e8f0', marginBottom: '1.25rem' }}>
                <div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>المورد</div>
                  <div style={{ fontWeight: 600 }}>{selectedOrder.supplier_name}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>الحالة</div>
                  <div style={{ fontWeight: 600 }}>{selectedOrder.status_label_ar || PO_STATUS_LABELS[selectedOrder.status]}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>أمر التشغيل المرتبط</div>
                  <div style={{ fontWeight: 600 }}>{selectedOrder.production_order_number || '—'}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.78rem', color: '#64748b' }}>تاريخ التسليم المتوقع</div>
                  <div style={{ fontWeight: 600 }}>
                    {selectedOrder.expected_delivery_date
                      ? new Date(selectedOrder.expected_delivery_date).toLocaleDateString('ar-EG')
                      : 'غير محدد'}
                  </div>
                </div>
                {selectedOrder.prices_visible && selectedOrder.total_amount !== null ? (
                  <div>
                    <div style={{ fontSize: '0.78rem', color: '#64748b' }}>الإجمالي المالي</div>
                    <div style={{ fontWeight: 700, color: '#0f172a' }}>
                      {Number(selectedOrder.total_amount).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: '0.78rem', color: '#64748b' }}>الأسعار</div>
                    <span style={{ fontSize: '0.78rem', background: '#f1f5f9', color: '#475569', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                      محجوبة وفق الصلاحيات
                    </span>
                  </div>
                )}
              </div>

              {/* أزرار الإجراءات على مستوى دورة حياة الأمر */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem', alignItems: 'center' }}>
                {selectedOrder.status === 'draft' && canApprove && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void handleApprovePO(selectedOrder.id)}
                    disabled={detailActionLoading}
                    style={{ background: '#2563eb', color: '#fff' }}
                  >
                    {detailActionLoading ? 'جاري الاعتماد...' : '✓ اعتماد أمر الشراء للتوريد'}
                  </button>
                )}

                {selectedOrder.status === 'draft' && canManage && (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => void handleCancelPO(selectedOrder.id)}
                    disabled={detailActionLoading}
                    style={{ color: '#b91c1c' }}
                  >
                    ✕ إلغاء أمر الشراء
                  </button>
                )}

                {(selectedOrder.status === 'approved' || selectedOrder.status === 'partially_received') && canReceive && (
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setIsReceivingMode(!isReceivingMode)}
                    style={{ background: isReceivingMode ? '#64748b' : '#059669', color: '#fff', fontWeight: 600 }}
                  >
                    {isReceivingMode ? 'إلغاء وضع الاستلام' : '📦 إثبات استلام بضاعة (GRN) بمخزن الخامات'}
                  </button>
                )}
              </div>

              {/* وضع إثبات الاستلام المخزني الفعلي */}
              {isReceivingMode && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem' }}>
                  <h4 style={{ margin: '0 0 0.5rem', color: '#166534', fontSize: '1rem' }}>
                    📦 تسجيل إثبات الاستلام الفعلي بمخزن الخامات (Goods Receipt Note - GRN)
                  </h4>
                  <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#15803d' }}>
                    أدخل الكميات المستلمة فعلياً لكل صنف؛ كل استلام يثبت رصيداً حراً في دفتر أستاذ المخزون (StockLedgerEntry).
                  </p>

                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem', marginBottom: '1rem', background: '#fff', borderRadius: '4px', overflow: 'hidden' }}>
                    <thead>
                      <tr style={{ background: '#dcfce7', textAlign: 'right' }}>
                        <th style={{ padding: '0.5rem 0.75rem' }}>الصنف</th>
                        <th style={{ padding: '0.5rem 0.75rem' }}>الوحدة</th>
                        <th style={{ padding: '0.5rem 0.75rem' }}>المتبقي للاستلام</th>
                        <th style={{ padding: '0.5rem 0.75rem', width: '130px' }}>الكمية المستلمة الآن</th>
                        <th style={{ padding: '0.5rem 0.75rem' }}>ملاحظات البند</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedOrder.lines.map((line) => {
                        const input = receiveInputs[line.id] || { qty: '0', notes: '' };
                        return (
                          <tr key={line.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                            <td style={{ padding: '0.5rem 0.75rem' }}>
                              <strong>{line.item_name_ar}</strong>
                              <span style={{ fontSize: '0.75rem', color: '#64748b', marginRight: '0.4rem' }}>{line.item_code}</span>
                            </td>
                            <td style={{ padding: '0.5rem 0.75rem' }}>{line.unit_name_ar}</td>
                            <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>{line.remaining_quantity}</td>
                            <td style={{ padding: '0.5rem 0.75rem' }}>
                              <input
                                type="number"
                                min="0"
                                max={line.remaining_quantity}
                                step="0.01"
                                value={input.qty}
                                onChange={(e) =>
                                  setReceiveInputs((prev) => ({
                                    ...prev,
                                    [line.id]: { ...prev[line.id], qty: e.target.value },
                                  }))
                                }
                                style={{ width: '100%', padding: '0.35rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                              />
                            </td>
                            <td style={{ padding: '0.5rem 0.75rem' }}>
                              <input
                                type="text"
                                placeholder="ملاحظة الاستلام..."
                                value={input.notes}
                                onChange={(e) =>
                                  setReceiveInputs((prev) => ({
                                    ...prev,
                                    [line.id]: { ...prev[line.id], notes: e.target.value },
                                  }))
                                }
                                style={{ width: '100%', padding: '0.35rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <label style={{ display: 'block', marginBottom: '1rem' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>ملاحظات عامة على حركة الاستلام:</span>
                    <input
                      type="text"
                      placeholder="مثال: استلام الدفعة الأولى بمخزن الخامات بحالة جيدة"
                      value={receiptGeneralNotes}
                      onChange={(e) => setReceiptGeneralNotes(e.target.value)}
                      style={{ width: '100%', padding: '0.45rem', marginTop: '0.25rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                    />
                  </label>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={() => setIsReceivingMode(false)}
                      disabled={detailActionLoading}
                    >
                      إلغاء
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void handleConfirmReceipt()}
                      disabled={detailActionLoading}
                      style={{ background: '#059669', color: '#fff', fontWeight: 600 }}
                    >
                      {detailActionLoading ? 'جاري تسجيل الاستلام...' : '✓ تأكيد الاستلام الفعلي بالمخزن'}
                    </button>
                  </div>
                </div>
              )}

              {/* جدول بنود أمر الشراء */}
              <h4 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: '#1e293b' }}>بنود أمر الشراء ({selectedOrder.lines.length})</h4>
              <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
                <table className="order-detail-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9', textAlign: 'right' }}>
                      <th style={{ padding: '0.6rem 0.75rem' }}>الصنف</th>
                      <th style={{ padding: '0.6rem 0.75rem' }}>الوحدة</th>
                      <th style={{ padding: '0.6rem 0.75rem' }}>الكمية المطلوبة</th>
                      <th style={{ padding: '0.6rem 0.75rem' }}>الكمية المستلمة</th>
                      <th style={{ padding: '0.6rem 0.75rem' }}>الكمية المتبقية</th>
                      {selectedOrder.prices_visible && (
                        <>
                          <th style={{ padding: '0.6rem 0.75rem' }}>سعر الوحدة</th>
                          <th style={{ padding: '0.6rem 0.75rem' }}>الإجمالي</th>
                        </>
                      )}
                      <th style={{ padding: '0.6rem 0.75rem' }}>ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedOrder.lines.map((l) => (
                      <tr key={l.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '0.6rem 0.75rem' }}>
                          <div style={{ fontWeight: 600 }}>{l.item_name_ar}</div>
                          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{l.item_code}</div>
                        </td>
                        <td style={{ padding: '0.6rem 0.75rem' }}>{l.unit_name_ar}</td>
                        <td style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>{l.ordered_quantity}</td>
                        <td style={{ padding: '0.6rem 0.75rem', color: l.received_quantity > 0 ? '#15803d' : '#64748b' }}>
                          {l.received_quantity}
                        </td>
                        <td style={{ padding: '0.6rem 0.75rem', fontWeight: 600, color: l.remaining_quantity > 0 ? '#b91c1c' : '#15803d' }}>
                          {l.remaining_quantity}
                        </td>
                        {selectedOrder.prices_visible && (
                          <>
                            <td style={{ padding: '0.6rem 0.75rem' }}>
                              {l.unit_price !== null ? formatMoney(l.unit_price) : '—'}
                            </td>
                            <td style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>
                              {l.total_price !== null ? formatMoney(l.total_price) : '—'}
                            </td>
                          </>
                        )}
                        <td style={{ padding: '0.6rem 0.75rem', fontSize: '0.8rem', color: '#64748b' }}>{l.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* سجل استلامات البضاعة السابقة (GRN) */}
              {selectedOrder.receipts.length > 0 && (
                <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: '#1e293b' }}>
                    📑 مستندات الاستلام المخزني المثبتة (GRN) ({selectedOrder.receipts.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {selectedOrder.receipts.map((r) => (
                      <div
                        key={r.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: '#fff',
                          padding: '0.5rem 0.75rem',
                          borderRadius: '4px',
                          border: '1px solid #cbd5e1',
                          fontSize: '0.85rem',
                        }}
                      >
                        <div>
                          <strong>{r.receipt_number}</strong>
                          <span style={{ marginRight: '0.75rem', color: '#64748b' }}>
                            بتاريخ {new Date(r.received_at).toLocaleString('ar-EG')}
                          </span>
                          {r.notes && <span style={{ marginRight: '0.75rem', color: '#475569' }}>· {r.notes}</span>}
                        </div>
                        <span style={{ background: '#f0fdf4', color: '#15803d', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.78rem', fontWeight: 600 }}>
                          ✓ تم القيد بالمخزن
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
