import React, { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { apiClient } from '@/lib/api';
import {
  purchaseOrdersApi,
  ProductionOrderShortageReport,
  PO_STATUS_LABELS,
  PO_STATUS_COLORS,
  PurchaseOrder,
} from '@/features/purchasing/purchaseOrdersApi';

interface Supplier {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
}

interface OrderShortageProcurementModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  onOrdersGenerated?: () => void;
}

interface PurchaseLineInput {
  item_id: string;
  unit_id: string;
  supplier_id: string;
  quantity: number;
  unit_price: number;
  notes: string;
}

export const OrderShortageProcurementModal: React.FC<OrderShortageProcurementModalProps> = ({
  isOpen,
  onClose,
  orderId,
  onOrdersGenerated,
}) => {
  const { hasPermission } = useAuth();
  const canCreatePO = hasPermission('purchase_orders:create');
  const canViewPrices = hasPermission('finance:cash:view') || hasPermission('suppliers:manage');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [report, setReport] = useState<ProductionOrderShortageReport | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  // مدخلات بنود الشراء المقترحة لكل صنف (المورد، الكمية، السعر التقديري)
  const [inputs, setInputs] = useState<Record<string, PurchaseLineInput>>({});
  const [batchNotes, setBatchNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generatedPOs, setGeneratedPOs] = useState<PurchaseOrder[]>([]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    setGeneratedPOs([]);
    try {
      const [shortageData, suppliersData] = await Promise.all([
        purchaseOrdersApi.getOrderShortages(orderId),
        apiClient.request<Supplier[]>('/api/v1/finance/suppliers').catch(() => [] as Supplier[]),
      ]);
      setReport(shortageData);
      setSuppliers(suppliersData.filter((s) => s.is_active));

      // تهيئة قيم المدخلات الافتراضية
      const initInputs: Record<string, PurchaseLineInput> = {};
      const activeSuppliers = suppliersData.filter((s) => s.is_active);
      const defaultSupplierId = activeSuppliers.length > 0 ? activeSuppliers[0].id : '';

      shortageData.materials.forEach((m) => {
        // خامات العملاء في CMT لا ننشئ لها مدخلات شراء
        if (!m.is_cmt_customer_material && m.shortage_quantity > 0) {
          initInputs[m.item_id] = {
            item_id: m.item_id,
            unit_id: m.unit_id,
            supplier_id: m.suggested_supplier_id || defaultSupplierId,
            quantity: m.shortage_quantity,
            unit_price: m.suggested_unit_price || 0,
            notes: '',
          };
        }
      });
      setInputs(initInputs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر تحميل تقرير عجز الخامات.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadData();
    }
  }, [isOpen, orderId]);

  const handleInputChange = (itemId: string, field: keyof PurchaseLineInput, value: unknown) => {
    setInputs((prev) => {
      const current = prev[itemId] || {
        item_id: itemId,
        unit_id: '',
        supplier_id: suppliers[0]?.id || '',
        quantity: 0,
        unit_price: 0,
        notes: '',
      };
      return {
        ...prev,
        [itemId]: { ...current, [field]: value },
      };
    });
  };

  const handleGenerateOrders = async () => {
    const linesToOrder = Object.values(inputs).filter((line) => line.quantity > 0 && Boolean(line.supplier_id));
    if (linesToOrder.length === 0) {
      setError('يرجى تحديد كمية أكبر من صفر ومورد صالح لبند خامة واحد على الأقل.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const payload = {
        notes: batchNotes.trim(),
        lines: linesToOrder.map((l) => ({
          item_id: l.item_id,
          unit_id: l.unit_id,
          supplier_id: l.supplier_id,
          quantity: l.quantity,
          unit_price: l.unit_price || 0,
          notes: l.notes.trim(),
        })),
      };

      const result = await purchaseOrdersApi.generateFromShortage(orderId, payload);
      setGeneratedPOs(result);
      setSuccessMessage(
        `تم توليد ${result.length} أمر شراء مسودة بنجاح! تم توزيع الخامات آلياً على الموردين المحددين.`
      );
      if (onOrdersGenerated) {
        onOrdersGenerated();
      }
      // إعادة تحميل تقرير العجز لتحديث الأرقام اللحظية
      const freshShortage = await purchaseOrdersApi.getOrderShortages(orderId);
      setReport(freshShortage);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'حدث خطأ أثناء توليد أوامر الشراء.';
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" style={{ zIndex: 1100 }}>
      <div
        className="modal-container"
        dir="rtl"
        style={{ maxWidth: '980px', width: '95%', maxHeight: '90vh', overflowY: 'auto' }}
      >
        <header className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>إدارة مشتريات خامات الإنتاج · Phase 5 (T5)</span>
            <h2 style={{ margin: '0.25rem 0 0', fontSize: '1.35rem', color: '#0f172a' }}>
              عجز خامات أمر التشغيل #{report?.order_number || orderId}
            </h2>
          </div>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="إغلاق"
            style={{ fontSize: '1.25rem', border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            ✕
          </button>
        </header>

        <div className="modal-body" style={{ padding: '1.25rem 0' }}>
          {error && (
            <div
              className="warehouse-alert"
              role="alert"
              style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '1rem' }}
            >
              ⚠️ {error}
            </div>
          )}

          {successMessage && (
            <div
              className="warehouse-alert"
              role="status"
              style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', padding: '0.75rem 1rem', borderRadius: '6px', marginBottom: '1rem' }}
            >
              <div>✓ {successMessage}</div>
              {generatedPOs.length > 0 && (
                <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {generatedPOs.map((po) => (
                    <span
                      key={po.id}
                      style={{
                        background: '#dcfce7',
                        border: '1px solid #86efac',
                        padding: '0.2rem 0.6rem',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                      }}
                    >
                      {po.order_number} ({po.supplier_name})
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: '2.5rem 0', color: '#64748b' }}>
              جاري فحص أرصدة المخزون وحساب العجز...
            </div>
          ) : report ? (
            <>
              {/* شريط توضيح نمط التصنيع */}
              {report.manufacturing_type === 'external' ? (
                <div
                  style={{
                    background: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    color: '#1e40af',
                    padding: '0.75rem 1rem',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    fontSize: '0.9rem',
                    lineHeight: '1.5',
                  }}
                >
                  🧵 <strong>أمر تشغيل للغير (CMT):</strong> خامات العميل ({report.customer_name || 'العميل'}) معزولة في أمانات العميل ومستبعدة تلقائياً من الشراء ومشتريات المصنع. أوامر الشراء تُصدر فقط لمستلزمات واستهلاكات المصنع.
                </div>
              ) : (
                <div
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    color: '#334155',
                    padding: '0.75rem 1rem',
                    borderRadius: '6px',
                    marginBottom: '1rem',
                    fontSize: '0.9rem',
                  }}
                >
                  🏭 <strong>تصنيع داخلي:</strong> جميع الخامات والمستلزمات ملك المصنع، ويُحسب العجز مقارنة بالرصيد الحر بمخزن الخامات الرئيسي.
                </div>
              )}

              {/* بطاقات المؤشرات السريعة */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>إجمالي بنود الخامات</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: '#0f172a' }}>{report.materials.length}</div>
                </div>
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>بنود العجز الفعلي</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold', color: report.total_shortage_items_count > 0 ? '#b91c1c' : '#15803d' }}>
                    {report.total_shortage_items_count}
                  </div>
                </div>
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', padding: '0.75rem 1rem', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>جاهزية بدء الإنتاج</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: report.can_start_production ? '#15803d' : '#d97706' }}>
                    {report.can_start_production ? '✓ الخامات مكتملة' : '⚠️ يلزم توريد عجز'}
                  </div>
                </div>
              </div>

              {/* جدول بنود الخامات والعجز */}
              <div style={{ overflowX: 'auto', marginBottom: '1.5rem' }}>
                <table className="order-detail-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9', textAlign: 'right' }}>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>الصنف</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>الوحدة</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>الملكية</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>المطلوب</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>المتاح الحر</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>بالطريق (PO)</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1' }}>العجز الصافي</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1', minWidth: '150px' }}>المورد المقترح</th>
                      <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1', width: '110px' }}>كمية الشراء</th>
                      {canViewPrices && <th style={{ padding: '0.6rem 0.75rem', borderBottom: '1px solid #cbd5e1', width: '90px' }}>السعر التقديري</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.materials.map((mat) => {
                      const input = inputs[mat.item_id];
                      const isShortage = mat.shortage_quantity > 0;
                      return (
                        <tr
                          key={mat.item_id}
                          style={{
                            background: mat.is_cmt_customer_material ? '#f8fafc' : isShortage ? '#fffbeb' : '#fff',
                            borderBottom: '1px solid #e2e8f0',
                          }}
                        >
                          <td style={{ padding: '0.6rem 0.75rem' }}>
                            <div style={{ fontWeight: 600 }}>{mat.item_name_ar}</div>
                            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{mat.item_code}</div>
                          </td>
                          <td style={{ padding: '0.6rem 0.75rem' }}>{mat.unit_name_ar}</td>
                          <td style={{ padding: '0.6rem 0.75rem' }}>
                            {mat.is_cmt_customer_material ? (
                              <span style={{ fontSize: '0.75rem', background: '#e0e7ff', color: '#3730a3', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                                عميل أمانة
                              </span>
                            ) : (
                              <span style={{ fontSize: '0.75rem', background: '#f1f5f9', color: '#334155', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                                مصنع
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '0.6rem 0.75rem' }}>{mat.required_quantity}</td>
                          <td style={{ padding: '0.6rem 0.75rem', color: mat.available_stock > 0 ? '#15803d' : '#94a3b8' }}>
                            {mat.available_stock}
                          </td>
                          <td style={{ padding: '0.6rem 0.75rem', color: mat.pending_inbound_quantity > 0 ? '#2563eb' : '#94a3b8' }}>
                            {mat.pending_inbound_quantity > 0 ? `+${mat.pending_inbound_quantity}` : '—'}
                          </td>
                          <td style={{ padding: '0.6rem 0.75rem', fontWeight: 'bold', color: isShortage ? '#b91c1c' : '#15803d' }}>
                            {mat.is_cmt_customer_material ? '0 (عميل)' : mat.shortage_quantity > 0 ? mat.shortage_quantity : '0 (مكتمل)'}
                          </td>
                          <td style={{ padding: '0.6rem 0.75rem' }}>
                            {!mat.is_cmt_customer_material && isShortage ? (
                              <select
                                style={{ width: '100%', padding: '0.35rem', fontSize: '0.82rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                value={input?.supplier_id || ''}
                                onChange={(e) => handleInputChange(mat.item_id, 'supplier_id', e.target.value)}
                              >
                                {suppliers.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: '0.6rem 0.75rem' }}>
                            {!mat.is_cmt_customer_material && isShortage ? (
                              <input
                                type="number"
                                min="0.01"
                                step="0.01"
                                style={{ width: '100%', padding: '0.35rem', fontSize: '0.82rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                value={input?.quantity ?? mat.shortage_quantity}
                                onChange={(e) => handleInputChange(mat.item_id, 'quantity', Number(e.target.value))}
                              />
                            ) : (
                              <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>—</span>
                            )}
                          </td>
                          {canViewPrices && (
                            <td style={{ padding: '0.6rem 0.75rem' }}>
                              {!mat.is_cmt_customer_material && isShortage ? (
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="0.00"
                                  style={{ width: '100%', padding: '0.35rem', fontSize: '0.82rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                  value={input?.unit_price ?? 0}
                                  onChange={(e) => handleInputChange(mat.item_id, 'unit_price', Number(e.target.value))}
                                />
                              ) : (
                                <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* أوامر الشراء المرتبطة سابقاً بهذا الأمر */}
              {report.existing_purchase_orders.length > 0 && (
                <div style={{ marginBottom: '1.5rem', background: '#f8fafc', padding: '1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: '#1e293b' }}>
                    📦 أوامر الشراء الصادرة مسبقاً لهذا الأمر ({report.existing_purchase_orders.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {report.existing_purchase_orders.map((po) => {
                      const badge = PO_STATUS_COLORS[po.status] || { bg: '#f1f5f9', text: '#334155', border: '#cbd5e1' };
                      return (
                        <div
                          key={po.id}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: '#fff',
                            padding: '0.6rem 0.8rem',
                            borderRadius: '4px',
                            border: '1px solid #cbd5e1',
                            fontSize: '0.85rem',
                          }}
                        >
                          <div>
                            <strong>{po.order_number}</strong> · المورد: {po.supplier_name}
                            <span style={{ marginRight: '0.75rem', color: '#64748b' }}>
                              مطلوب: {po.total_ordered_quantity} | مستلم: {po.total_received_quantity}
                            </span>
                          </div>
                          <span
                            style={{
                              background: badge.bg,
                              color: badge.text,
                              border: `1px solid ${badge.border}`,
                              padding: '0.2rem 0.6rem',
                              borderRadius: '4px',
                              fontSize: '0.78rem',
                              fontWeight: 600,
                            }}
                          >
                            {po.status_label_ar || PO_STATUS_LABELS[po.status]}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ملاحظات التوليد وزر الإجراء */}
              {canCreatePO && report.total_shortage_items_count > 0 && (
                <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#334155' }}>ملاحظات أوامر الشراء (اختياري):</span>
                    <input
                      type="text"
                      value={batchNotes}
                      onChange={(e) => setBatchNotes(e.target.value)}
                      placeholder="مثال: توريد عاجل لتشغيل الدفعة الأولى"
                      style={{ width: '100%', padding: '0.45rem', marginTop: '0.25rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                    />
                  </label>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={onClose}
                      disabled={isSubmitting}
                      style={{ padding: '0.5rem 1rem' }}
                    >
                      إلغاء
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void handleGenerateOrders()}
                      disabled={isSubmitting || suppliers.length === 0}
                      style={{ padding: '0.5rem 1.25rem', background: '#2563eb', color: '#fff', fontWeight: 600 }}
                    >
                      {isSubmitting ? 'جاري توليد الأوامر...' : '🛒 توليد أوامر الشراء المسودة (مجمعة حسب المورد)'}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
