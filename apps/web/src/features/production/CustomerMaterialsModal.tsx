import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import { fetchCustomers, Customer } from '@/features/customers/customersApi';
import {
  CustomerMaterialReceipt,
  CustomerMaterialBalanceItem,
  fetchCustomerMaterialReceipts,
  createCustomerMaterialReceipt,
  fetchCustomerMaterialBalances,
  createCustomerMaterialReturn,
  CatalogItem,
} from './productionApi';

interface CustomerMaterialsModalProps {
  isOpen: boolean;
  onClose: () => void;
  catalogItems?: CatalogItem[];
}

export const CustomerMaterialsModal: React.FC<CustomerMaterialsModalProps> = ({
  isOpen,
  onClose,
  catalogItems = [],
}) => {
  const { hasPermission } = useAuth();
  const canReceive = hasPermission('suppliers:receive') || hasPermission('warehouse:dispatch');

  const [activeTab, setActiveTab] = useState<'balances' | 'receipts' | 'new_receipt' | 'new_return'>('balances');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [balances, setBalances] = useState<CustomerMaterialBalanceItem[]>([]);
  const [receipts, setReceipts] = useState<CustomerMaterialReceipt[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // فورم سند استلام جديد
  const [newReceiptCustomer, setNewReceiptCustomer] = useState<string>('');
  const [newReceiptDate, setNewReceiptDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [newReceiptNotes, setNewReceiptNotes] = useState<string>('');
  const [receiptLines, setReceiptLines] = useState<Array<{
    item_id: string;
    unit_id: string;
    quantity: string;
    unit_cost_estimate: string;
    notes: string;
  }>>([
    { item_id: '', unit_id: '', quantity: '', unit_cost_estimate: '', notes: '' },
  ]);

  // فورم سند إرجاع
  const [returnCustomer, setReturnCustomer] = useState<string>('');
  const [returnReceiptLineId, setReturnReceiptLineId] = useState<string>('');
  const [returnQuantity, setReturnQuantity] = useState<string>('');
  const [returnNotes, setReturnNotes] = useState<string>('');
  const [selectedLineRemaining, setSelectedLineRemaining] = useState<number>(0);

  // تحميل العملاء
  useEffect(() => {
    if (!isOpen) return;
    void fetchCustomers().then((data) => {
      setCustomers(data.filter((c) => c.status === 'active'));
    }).catch(() => {
      // تجاهل الخطأ الهادئ
    });
  }, [isOpen]);

  // تحميل الأرصدة والسندات
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setActionError(null);
    try {
      const [balData, recData] = await Promise.all([
        fetchCustomerMaterialBalances(selectedCustomerId || undefined),
        fetchCustomerMaterialReceipts(selectedCustomerId || undefined),
      ]);
      setBalances(balData);
      setReceipts(recData);
    } catch (err: unknown) {
      setActionError(err instanceof ApiError || err instanceof Error ? err.message : 'تعذر تحميل بيانات خامات العملاء');
    } finally {
      setIsLoading(false);
    }
  }, [selectedCustomerId]);

  useEffect(() => {
    if (isOpen) {
      void loadData();
    }
  }, [isOpen, loadData]);

  if (!isOpen) return null;

  // إضافة سطر استلام جديد
  const addReceiptLine = () => {
    setReceiptLines((prev) => [
      ...prev,
      { item_id: '', unit_id: '', quantity: '', unit_cost_estimate: '', notes: '' },
    ]);
  };

  const removeReceiptLine = (idx: number) => {
    if (receiptLines.length <= 1) return;
    setReceiptLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateReceiptLine = (idx: number, field: string, val: string) => {
    setReceiptLines((prev) => {
      const updated = [...prev];
      const target = { ...updated[idx], [field]: val };
      if (field === 'item_id') {
        const item = catalogItems.find((it) => it.id === val);
        if (item) {
          target.unit_id = item.unit_id;
        }
      }
      updated[idx] = target;
      return updated;
    });
  };

  // إرسال سند استلام جديد
  const handleSubmitReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setSuccessMessage(null);

    if (!newReceiptCustomer) {
      setActionError('يرجى اختيار العميل أولاً.');
      return;
    }

    const validLines = receiptLines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (validLines.length === 0) {
      setActionError('يرجى إضافة سطر خامة واحد على الأقل بكمية صحيحة.');
      return;
    }

    try {
      setIsLoading(true);
      const created = await createCustomerMaterialReceipt({
        customer_id: newReceiptCustomer,
        received_date: newReceiptDate ? new Date(newReceiptDate).toISOString() : undefined,
        notes: newReceiptNotes,
        lines: validLines.map((l) => ({
          item_id: l.item_id,
          unit_id: l.unit_id,
          quantity_received: Number(l.quantity),
          unit_cost_estimate: Number(l.unit_cost_estimate) || 0,
          notes: l.notes,
        })),
      });

      setSuccessMessage(`تم تسجيل سند استلام خامات أمانة بنجاح برقم (${created.receipt_number})`);
      setReceiptLines([{ item_id: '', unit_id: '', quantity: '', unit_cost_estimate: '', notes: '' }]);
      setNewReceiptNotes('');
      setActiveTab('receipts');
      void loadData();
    } catch (err: unknown) {
      setActionError(err instanceof ApiError || err instanceof Error ? err.message : 'فشل تسجيل سند استلام الخامات');
    } finally {
      setIsLoading(false);
    }
  };

  // إرسال سند إرجاع خامات
  const handleSubmitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setSuccessMessage(null);

    if (!returnCustomer || !returnReceiptLineId || !returnQuantity) {
      setActionError('يرجى استيفاء بيانات العميل وسطر الاستلام والكمية المرتجعة.');
      return;
    }

    const qtyNum = Number(returnQuantity);
    if (qtyNum <= 0) {
      setActionError('يجب أن تكون الكمية المرتجعة أكبر من صفر.');
      return;
    }

    if (qtyNum > selectedLineRemaining) {
      setActionError(`الكمية المراد إرجاعها (${qtyNum}) تتجاوز الرصيد المتبقي بسطر الاستلام (${selectedLineRemaining}).`);
      return;
    }

    try {
      setIsLoading(true);
      const ret = await createCustomerMaterialReturn({
        customer_id: returnCustomer,
        receipt_line_id: returnReceiptLineId,
        quantity: qtyNum,
        notes: returnNotes,
      });

      setSuccessMessage(`تم تسجيل سند إرجاع خامات متبقية بنجاح برقم (${ret.return_number})`);
      setReturnQuantity('');
      setReturnNotes('');
      setReturnReceiptLineId('');
      setActiveTab('balances');
      void loadData();
    } catch (err: unknown) {
      setActionError(err instanceof ApiError || err instanceof Error ? err.message : 'فشل تسجيل سند إرجاع الخامات');
    } finally {
      setIsLoading(false);
    }
  };

  // تصفية أسطر الاستلام النشطة للعميل المختار للإرجاع
  const activeReceiptLinesForReturn = receipts
    .filter((r) => r.customer_id === returnCustomer)
    .flatMap((r) =>
      r.lines
        .filter((l) => l.quantity_remaining > 0)
        .map((l) => ({
          ...l,
          receipt_number: r.receipt_number,
        })),
    );

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        className="modal modal--wide modal--scrollable"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '1050px', width: '95%' }}
      >
        <div className="modal__header">
          <div>
            <h2 className="modal__title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>📦</span> خامات العملاء الموردة أمانة (التشغيل للغير / Toll Manufacturing)
            </h2>
            <p className="modal__subtitle">
              تتبع خامات الأقمشة والمستلزمات المملوكة للعملاء وفصلها الصارم عن أصول مخزون المصنع (MFG-DEC-02).
            </p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>

        {/* تنبيهات النجاح والخطأ */}
        {actionError && (
          <div className="notice notice--error" style={{ margin: '12px 24px' }}>
            <span>⚠️ {actionError}</span>
          </div>
        )}
        {successMessage && (
          <div className="notice notice--success" style={{ margin: '12px 24px' }}>
            <span>✓ {successMessage}</span>
          </div>
        )}

        {/* شريط الأدوات والتبويبات */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap', gap: '12px' }}>
          <div className="tab-group" style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className={`btn btn--sm ${activeTab === 'balances' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setActiveTab('balances')}
            >
              📊 أرصدة الخامات المتاحة
            </button>
            <button
              type="button"
              className={`btn btn--sm ${activeTab === 'receipts' ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => setActiveTab('receipts')}
            >
              📜 سجل سندات الاستلام
            </button>
            {canReceive && (
              <>
                <button
                  type="button"
                  className={`btn btn--sm ${activeTab === 'new_receipt' ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => {
                    setActiveTab('new_receipt');
                    setActionError(null);
                    setSuccessMessage(null);
                  }}
                >
                  ＋ سند استلام خامة جديد
                </button>
                <button
                  type="button"
                  className={`btn btn--sm ${activeTab === 'new_return' ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => {
                    setActiveTab('new_return');
                    setActionError(null);
                    setSuccessMessage(null);
                  }}
                >
                  ↩️ إرجاع فائض خامات للعميل
                </button>
              </>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>تصفية حسب العميل:</label>
            <select
              className="form-control"
              style={{ minWidth: '180px', padding: '4px 8px', fontSize: '0.85rem' }}
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
            >
              <option value="">جميع العملاء</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void loadData()}
              disabled={isLoading}
              title="تحديث البيانات"
            >
              🔄
            </button>
          </div>
        </div>

        <div className="modal__body" style={{ padding: '24px' }}>
          {isLoading && <div style={{ textAlign: 'center', padding: '32px' }}>جاري تحميل البيانات...</div>}

          {/* تبويب 1: أرصدة الخامات */}
          {!isLoading && activeTab === 'balances' && (
            <div>
              <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>أرصدة خامات العملاء الحالية (أمانة في المخزن)</h3>
                <span className="badge badge--info">{balances.length} صنف مسجل</span>
              </div>

              {balances.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px', color: 'var(--color-text-muted)' }}>
                  لا توجد خامات عملاء مسجلة حالياً. استخدم «سند استلام خامة جديد» لتسجيل خامات واردة للتشغيل.
                </div>
              ) : (
                <div className="table-responsive">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>العميل</th>
                        <th>كود الصنف</th>
                        <th>اسم الخامة</th>
                        <th>الوحدة</th>
                        <th style={{ textAlign: 'right' }}>إجمالي الوارد</th>
                        <th style={{ textAlign: 'right' }}>المستهلك بالإنتاج</th>
                        <th style={{ textAlign: 'right' }}>الهالك الموثق</th>
                        <th style={{ textAlign: 'right' }}>المرتجع للعميل</th>
                        <th style={{ textAlign: 'right', fontWeight: 700 }}>الرصيد المتبقي</th>
                      </tr>
                    </thead>
                    <tbody>
                      {balances.map((b) => (
                        <tr key={`${b.customer_id}-${b.item_id}`}>
                          <td><strong>{b.customer_name}</strong></td>
                          <td><code>{b.item_code}</code></td>
                          <td>{b.item_name_ar}</td>
                          <td>{b.unit_name}</td>
                          <td style={{ textAlign: 'right' }}>{Number(b.total_received).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                          <td style={{ textAlign: 'right' }}>{Number(b.total_consumed).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-danger)' }}>{Number(b.total_wasted).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-warning)' }}>{Number(b.total_returned).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span className={`badge ${Number(b.current_balance) > 0 ? 'badge--success' : 'badge--secondary'}`}>
                              {Number(b.current_balance).toLocaleString('ar-EG', { maximumFractionDigits: 3 })} {b.unit_name}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* تبويب 2: سجل السندات */}
          {!isLoading && activeTab === 'receipts' && (
            <div>
              <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>سجل سندات استلام خامات العملاء</h3>
                <span className="badge badge--info">{receipts.length} سند</span>
              </div>

              {receipts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px', color: 'var(--color-text-muted)' }}>
                  لا توجد سندات استلام خامات مسجلة.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {receipts.map((r) => (
                    <div key={r.id} className="card" style={{ padding: '16px', border: '1px solid var(--color-border)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <strong style={{ fontSize: '1.05rem' }}>{r.receipt_number}</strong>
                            <span className="badge badge--primary">عميل: {r.customer_name}</span>
                            <span className="badge badge--secondary">{r.status}</span>
                          </div>
                          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                            تاريخ الاستلام: {new Date(r.received_date).toLocaleDateString('ar-EG')} · المستلم: {r.received_by}
                          </span>
                        </div>
                        {r.notes && (
                          <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', maxWidth: '350px' }}>
                            ملاحظات: {r.notes}
                          </div>
                        )}
                      </div>

                      <div className="table-responsive">
                        <table className="table table--compact" style={{ margin: 0 }}>
                          <thead>
                            <tr>
                              <th>كود الخامة</th>
                              <th>اسم الخامة</th>
                              <th style={{ textAlign: 'right' }}>الكمية المستلمة</th>
                              <th style={{ textAlign: 'right' }}>المستهلك</th>
                              <th style={{ textAlign: 'right' }}>الهالك</th>
                              <th style={{ textAlign: 'right' }}>المرتجع</th>
                              <th style={{ textAlign: 'right' }}>المتبقي أمانة</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.lines.map((l) => (
                              <tr key={l.id}>
                                <td><code>{l.item_code}</code></td>
                                <td>{l.item_name_ar}</td>
                                <td style={{ textAlign: 'right' }}>{Number(l.quantity_received).toLocaleString('ar-EG', { maximumFractionDigits: 3 })} {l.unit_name}</td>
                                <td style={{ textAlign: 'right' }}>{Number(l.quantity_consumed).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                                <td style={{ textAlign: 'right', color: 'var(--color-danger)' }}>{Number(l.quantity_wasted).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                                <td style={{ textAlign: 'right', color: 'var(--color-warning)' }}>{Number(l.quantity_returned).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                                <td style={{ textAlign: 'right' }}>
                                  <strong>{Number(l.quantity_remaining).toLocaleString('ar-EG', { maximumFractionDigits: 3 })} {l.unit_name}</strong>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* تبويب 3: سند استلام خامة جديد */}
          {!isLoading && activeTab === 'new_receipt' && (
            <form onSubmit={handleSubmitReceipt}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                <div>
                  <label className="form-label">العميل المورد للخامة *</label>
                  <select
                    className="form-control"
                    required
                    value={newReceiptCustomer}
                    onChange={(e) => setNewReceiptCustomer(e.target.value)}
                  >
                    <option value="">-- اختر العميل --</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="form-label">تاريخ الاستلام الفعلي بالمخزن</label>
                  <input
                    type="date"
                    className="form-control"
                    value={newReceiptDate}
                    onChange={(e) => setNewReceiptDate(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <label className="form-label" style={{ margin: 0 }}>بنود الخامات المستلمة أمانة *</label>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={addReceiptLine}>
                    ＋ إضافة خامة أخرى
                  </button>
                </div>

                <div className="table-responsive">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: '40%' }}>صنف الخامة / القماش</th>
                        <th style={{ width: '25%' }}>الكمية المستلمة</th>
                        <th style={{ width: '25%' }}>تكلفة تقديرية للوحدة (اختياري)</th>
                        <th style={{ width: '10%' }}>إجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receiptLines.map((line, idx) => (
                        <tr key={idx}>
                          <td>
                            <select
                              className="form-control"
                              required
                              value={line.item_id}
                              onChange={(e) => updateReceiptLine(idx, 'item_id', e.target.value)}
                            >
                              <option value="">-- اختر الخامة من الدليل --</option>
                              {catalogItems
                                .filter((it) => it.is_active && it.item_type !== 'finished_garment')
                                .map((it) => (
                                  <option key={it.id} value={it.id}>
                                    {it.code} — {it.name_ar} ({it.unit_name_ar})
                                  </option>
                                ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.001"
                              min="0.001"
                              required
                              className="form-control"
                              placeholder="الكمية"
                              value={line.quantity}
                              onChange={(e) => updateReceiptLine(idx, 'quantity', e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              className="form-control"
                              placeholder="سعر تقديري (للتأمين/الهالك)"
                              value={line.unit_cost_estimate}
                              onChange={(e) => updateReceiptLine(idx, 'unit_cost_estimate', e.target.value)}
                            />
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              style={{ color: 'var(--color-danger)' }}
                              onClick={() => removeReceiptLine(idx)}
                              disabled={receiptLines.length <= 1}
                              title="حذف السطر"
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label className="form-label">ملاحظات الاستلام والفحص الأولي</label>
                <textarea
                  className="form-control"
                  rows={2}
                  placeholder="رقم إذن توريد العميل أو حالة الطرود والأثواب..."
                  value={newReceiptNotes}
                  onChange={(e) => setNewReceiptNotes(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setActiveTab('balances')}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--primary" disabled={isLoading}>
                  حفظ واعتماد سند الاستلام أمانة
                </button>
              </div>
            </form>
          )}

          {/* تبويب 4: سند إرجاع خامات متبقية */}
          {!isLoading && activeTab === 'new_return' && (
            <form onSubmit={handleSubmitReturn} style={{ maxWidth: '650px', margin: '0 auto' }}>
              <div style={{ marginBottom: '16px' }}>
                <label className="form-label">العميل المستلم للمرتجع *</label>
                <select
                  className="form-control"
                  required
                  value={returnCustomer}
                  onChange={(e) => {
                    setReturnCustomer(e.target.value);
                    setReturnReceiptLineId('');
                    setSelectedLineRemaining(0);
                  }}
                >
                  <option value="">-- اختر العميل --</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
              </div>

              {returnCustomer && (
                <div style={{ marginBottom: '16px' }}>
                  <label className="form-label">سطر استلام الخامة المتبقية *</label>
                  <select
                    className="form-control"
                    required
                    value={returnReceiptLineId}
                    onChange={(e) => {
                      const lineId = e.target.value;
                      setReturnReceiptLineId(lineId);
                      const target = activeReceiptLinesForReturn.find((l) => l.id === lineId);
                      setSelectedLineRemaining(target ? target.quantity_remaining : 0);
                    }}
                  >
                    <option value="">-- اختر الخامة وسند الاستلام --</option>
                    {activeReceiptLinesForReturn.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.receipt_number} — {l.item_name_ar} (المتبقي: {l.quantity_remaining} {l.unit_name})
                      </option>
                    ))}
                  </select>
                  {activeReceiptLinesForReturn.length === 0 && (
                    <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', display: 'block', marginTop: '4px' }}>
                      لا توجد أسطر استلام بخامات متبقية لهذا العميل.
                    </span>
                  )}
                </div>
              )}

              {returnReceiptLineId && (
                <div style={{ marginBottom: '16px' }}>
                  <label className="form-label">
                    الكمية المراد إرجاعها * (الحد الأقصى المتاح للإرجاع: {selectedLineRemaining})
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    max={selectedLineRemaining}
                    required
                    className="form-control"
                    placeholder="الكمية"
                    value={returnQuantity}
                    onChange={(e) => setReturnQuantity(e.target.value)}
                  />
                </div>
              )}

              <div style={{ marginBottom: '20px' }}>
                <label className="form-label">ملاحظات ومسوغ الإرجاع</label>
                <textarea
                  className="form-control"
                  rows={2}
                  placeholder="سبب إرجاع الفائض للعميل أو رقم إذن الخروج..."
                  value={returnNotes}
                  onChange={(e) => setReturnNotes(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setActiveTab('balances')}>
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={isLoading || !returnReceiptLineId || Number(returnQuantity) <= 0}
                >
                  حفظ وتأكيد إرجاع الخامات
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
