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
  fetchCatalogItems,
} from '@/features/production/productionApi';
import { formatDate } from '@/lib/formatters';

export const CustomerMaterialsView: React.FC = () => {
  const { hasPermission } = useAuth();
  const canReceive = hasPermission('suppliers:receive') || hasPermission('warehouse:dispatch') || hasPermission('inventory:stocktake:manage');

  const [activeTab, setActiveTab] = useState<'balances' | 'receipts' | 'new_receipt' | 'new_return'>('balances');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [balances, setBalances] = useState<CustomerMaterialBalanceItem[]>([]);
  const [receipts, setReceipts] = useState<CustomerMaterialReceipt[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
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

  // تحميل العملاء ودليل الأصناف
  useEffect(() => {
    void fetchCustomers().then((data) => {
      setCustomers(data.filter((c) => c.status === 'active'));
    }).catch(() => { });

    void fetchCatalogItems().then((items) => {
      setCatalogItems(items);
    }).catch(() => { });
  }, []);

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
    void loadData();
  }, [loadData]);

  // إضافة سطر استلام جديد
  const addReceiptLine = () => {
    setReceiptLines((prev) => [
      ...prev,
      { item_id: '', unit_id: '', quantity: '', unit_cost_estimate: '', notes: '' },
    ]);
  };

  // حذف سطر استلام
  const removeReceiptLine = (idx: number) => {
    setReceiptLines((prev) => prev.filter((_, i) => i !== idx));
  };

  // تحديث سطر استلام
  const updateReceiptLine = (idx: number, field: string, val: string) => {
    setReceiptLines((prev) =>
      prev.map((line, i) => {
        if (i !== idx) return line;
        if (field === 'item_id') {
          const selected = catalogItems.find((it) => it.id === val);
          return {
            ...line,
            item_id: val,
            unit_id: selected?.unit_id || '',
          };
        }
        return { ...line, [field]: val };
      }),
    );
  };

  // إرسال سند استلام خامة جديد
  const handleSubmitReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReceiptCustomer) {
      setActionError('يرجى اختيار العميل');
      return;
    }
    const validLines = receiptLines.filter((l) => l.item_id && Number(l.quantity) > 0);
    if (validLines.length === 0) {
      setActionError('يرجى إدخال صنف واحد على الأقل بكمية صالحة');
      return;
    }

    setIsLoading(true);
    setActionError(null);
    setSuccessMessage(null);

    try {
      await createCustomerMaterialReceipt({
        customer_id: newReceiptCustomer,
        received_date: newReceiptDate,
        notes: newReceiptNotes || undefined,
        lines: validLines.map((l) => ({
          item_id: l.item_id,
          unit_id: l.unit_id || catalogItems.find((it) => it.id === l.item_id)?.unit_id || '',
          quantity_received: Number(l.quantity),
          unit_cost_estimate: l.unit_cost_estimate ? Number(l.unit_cost_estimate) : undefined,
          notes: l.notes || undefined,
        })),
      });

      setSuccessMessage('تم تسجيل سند استلام خامات الأمانة بنجاح وتحديث أرصدة العميل');
      setNewReceiptNotes('');
      setReceiptLines([{ item_id: '', unit_id: '', quantity: '', unit_cost_estimate: '', notes: '' }]);
      setActiveTab('balances');
      void loadData();
    } catch (err: unknown) {
      setActionError(err instanceof ApiError || err instanceof Error ? err.message : 'تعذر تسجيل سند الاستلام');
    } finally {
      setIsLoading(false);
    }
  };

  // إرسال سند إرجاع خامات متبقية
  const handleSubmitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnReceiptLineId || Number(returnQuantity) <= 0) {
      setActionError('يرجى اختيار سطر الاستلام وتحديد كمية الإرجاع');
      return;
    }

    setIsLoading(true);
    setActionError(null);
    setSuccessMessage(null);

    try {
      await createCustomerMaterialReturn({
        customer_id: returnCustomer,
        receipt_line_id: returnReceiptLineId,
        quantity: Number(returnQuantity),
        notes: returnNotes || undefined,
      });

      setSuccessMessage('تم تسجيل سند إرجاع خامات الأمانة للعميل بنجاح');
      setReturnQuantity('');
      setReturnNotes('');
      setReturnReceiptLineId('');
      setSelectedLineRemaining(0);
      setActiveTab('balances');
      void loadData();
    } catch (err: unknown) {
      setActionError(err instanceof ApiError || err instanceof Error ? err.message : 'تعذر تسجيل سند الإرجاع');
    } finally {
      setIsLoading(false);
    }
  };

  // تصفية أسطر الاستلام المتاحة للإرجاع
  const activeReceiptLinesForReturn = receipts
    .filter((r) => !returnCustomer || r.customer_id === returnCustomer)
    .flatMap((r) =>
      r.lines
        .filter((l) => l.quantity_remaining > 0)
        .map((l) => ({
          ...l,
          receipt_number: r.receipt_number,
          customer_name: r.customer_name,
        })),
    );

  return (
    <div className="warehouse-page" dir="rtl" style={{ padding: '24px 32px' }}>
      {/* ── ترويسة الصفحة وبطاقات المؤشرات ──────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '24px' }}>
        <div>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>المخازن والأمانات · التشغيل للغير (Toll Manufacturing / CMT)</span>
          <h1 style={{ margin: '4px 0 0', fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-main)' }}>
            📦 أمانات خامات العملاء
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>
            إدارة أقمشة ومستلزمات العملاء الموردة أمانة وفصلها التام محاسبياً ومخزنياً عن أصول مخزون المصنع (MFG-DEC-02).
          </p>
        </div>

        {/* كروت المؤشرات السريعة */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ padding: '12px 20px', background: 'var(--surface-white)', border: '1px solid var(--border-subtle)', borderRadius: '8px', minWidth: '140px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>أصناف الأمانة الحالية</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--text-main)', marginTop: '2px' }}>{balances.length}</div>
          </div>
          <div style={{ padding: '12px 20px', background: 'var(--surface-white)', border: '1px solid var(--border-subtle)', borderRadius: '8px', minWidth: '140px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>سندات الاستلام المسجلة</div>
            <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--teal-primary, #0d9488)', marginTop: '2px' }}>{receipts.length}</div>
          </div>
        </div>
      </div>

      {/* تنبيهات النجاح والخطأ */}
      {actionError && (
        <div className="modal-alert modal-alert--danger" style={{ margin: '0 0 16px' }}>
          <span>⚠️ {actionError}</span>
        </div>
      )}
      {successMessage && (
        <div className="modal-alert modal-alert--success" style={{ margin: '0 0 16px' }}>
          <span>✓ {successMessage}</span>
        </div>
      )}

      {/* ── شريط الأدوات والتبويبات ───────────────────────────── */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: '20px', border: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'balances' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveTab('balances')}
            >
              📊 أرصدة الخامات المتاحة
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'receipts' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveTab('receipts')}
            >
              📜 سجل سندات الاستلام
            </button>
            {canReceive && (
              <>
                <button
                  type="button"
                  className={`tab-btn ${activeTab === 'new_receipt' ? 'tab-btn--active' : ''}`}
                  onClick={() => {
                    setActiveTab('new_receipt');
                    setActionError(null);
                    setSuccessMessage(null);
                  }}
                >
                  ＋ سند استلام خامات أمانة جديد
                </button>
                <button
                  type="button"
                  className={`tab-btn ${activeTab === 'new_return' ? 'tab-btn--active' : ''}`}
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0, whiteSpace: 'nowrap' }}>تصفية حسب العميل:</label>
            <select
              className="form-input"
              style={{ minWidth: '200px', height: '38px', fontSize: '14px' }}
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
            >
              <option value="">جميع العملاء</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="tool"
              onClick={() => void loadData()}
              disabled={isLoading}
              title="تحديث البيانات"
              style={{ height: '38px', padding: '0 12px' }}
            >
              🔄 تحديث
            </button>
          </div>
        </div>
      </div>

      {/* ── محتوى التبويبات ──────────────────────────────────── */}
      <div className="card" style={{ padding: '24px', border: '1px solid var(--border-subtle)', background: 'var(--surface-white)' }}>
        {isLoading && <div style={{ textAlign: 'center', padding: '40px', fontSize: '14px', color: 'var(--text-muted)' }}>جاري تحميل البيانات...</div>}

        {/* تبويب 1: أرصدة الخامات */}
        {!isLoading && activeTab === 'balances' && (
          <div>
            <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>أرصدة خامات العملاء الحالية (أمانة في المخزن)</h3>
              <span className="badge badge--info">{balances.length} صنف مسجل</span>
            </div>

            {balances.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)', fontSize: '14px' }}>
                لا توجد خامات عملاء مسجلة حالياً كأمانة. استخدم «سند استلام خامات أمانة جديد» لتسجيل خامات واردة للتشغيل.
              </div>
            ) : (
              <div className="order-table-wrap">
                <table className="order-detail-table" style={{ width: '100%', minWidth: '880px', fontSize: '14px' }}>
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
                        <td style={{ textAlign: 'right', color: 'var(--status-red-tx, #b91c1c)' }}>{Number(b.total_wasted).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--status-amber-tx, #d97706)' }}>{Number(b.total_returned).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
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
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>سجل سندات استلام خامات العملاء</h3>
              <span className="badge badge--info">{receipts.length} سند</span>
            </div>

            {receipts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)', fontSize: '14px' }}>
                لا توجد سندات استلام خامات أمانة مسجلة.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {receipts.map((r) => (
                  <div key={r.id} className="card" style={{ padding: '16px', border: '1px solid var(--border-subtle)', background: 'var(--surface-alt)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <strong style={{ fontSize: '1.05rem' }}>{r.receipt_number}</strong>
                          <span className="badge badge--primary">عميل: {r.customer_name}</span>
                          <span className="badge badge--secondary">{r.status}</span>
                        </div>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          تاريخ الاستلام: {formatDate(r.received_date)} · المستلم: {r.received_by}
                        </span>
                      </div>
                      {r.notes && (
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '350px' }}>
                          ملاحظات: {r.notes}
                        </div>
                      )}
                    </div>

                    <div className="order-table-wrap" style={{ margin: 0 }}>
                      <table className="order-detail-table" style={{ width: '100%', minWidth: '780px', fontSize: '14px', margin: 0 }}>
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
                              <td style={{ textAlign: 'right', color: 'var(--status-red-tx, #b91c1c)' }}>{Number(l.quantity_wasted).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
                              <td style={{ textAlign: 'right', color: 'var(--status-amber-tx, #d97706)' }}>{Number(l.quantity_returned).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}</td>
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
                <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>العميل المورد للخامة *</label>
                <select
                  className="form-input"
                  style={{ height: '40px', fontSize: '14px' }}
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
                <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>تاريخ الاستلام الفعلي بالمخزن</label>
                <input
                  type="date"
                  className="form-input"
                  style={{ height: '40px', fontSize: '14px' }}
                  value={newReceiptDate}
                  onChange={(e) => setNewReceiptDate(e.target.value)}
                />
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <label className="form-label" style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>بنود الخامات المستلمة أمانة *</label>
                <button type="button" className="btn btn--secondary" style={{ padding: '6px 14px', fontSize: '13px' }} onClick={addReceiptLine}>
                  ＋ إضافة خامة أخرى
                </button>
              </div>

              <div className="order-table-wrap">
                <table className="order-detail-table" style={{ width: '100%', minWidth: '780px', fontSize: '14px' }}>
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
                            className="form-input"
                            style={{ height: '38px', fontSize: '14px' }}
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
                            className="form-input"
                            style={{ height: '38px', fontSize: '14px' }}
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
                            className="form-input"
                            style={{ height: '38px', fontSize: '14px' }}
                            placeholder="سعر تقديري (للتأمين/الهالك)"
                            value={line.unit_cost_estimate}
                            onChange={(e) => updateReceiptLine(idx, 'unit_cost_estimate', e.target.value)}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            className="tool"
                            style={{ color: 'var(--status-red-tx, #b91c1c)', padding: '4px 8px' }}
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
              <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>ملاحظات الاستلام والفحص الأولي</label>
              <textarea
                className="form-input"
                rows={2}
                style={{ fontSize: '14px', width: '100%' }}
                placeholder="رقم إذن توريد العميل أو حالة الطرود والأثواب..."
                value={newReceiptNotes}
                onChange={(e) => setNewReceiptNotes(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button type="button" className="btn btn--secondary" onClick={() => setActiveTab('balances')}>
                إلغاء
              </button>
              <button type="submit" className="btn btn--primary" disabled={isLoading} style={{ minHeight: '40px', padding: '0 20px', fontSize: '14px' }}>
                حفظ واعتماد سند الاستلام أمانة
              </button>
            </div>
          </form>
        )}

        {/* تبويب 4: سند إرجاع خامات متبقية */}
        {!isLoading && activeTab === 'new_return' && (
          <form onSubmit={handleSubmitReturn} style={{ maxWidth: '650px', margin: '0 auto' }}>
            <div style={{ marginBottom: '16px' }}>
              <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>العميل المستلم للمرتجع *</label>
              <select
                className="form-input"
                style={{ height: '40px', fontSize: '14px' }}
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
                <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>سطر استلام الخامة المتبقية *</label>
                <select
                  className="form-input"
                  style={{ height: '40px', fontSize: '14px' }}
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
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginTop: '4px' }}>
                    لا توجد أسطر استلام بخامات متبقية لهذا العميل.
                  </span>
                )}
              </div>
            )}

            {returnReceiptLineId && (
              <div style={{ marginBottom: '16px' }}>
                <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>
                  الكمية المراد إرجاعها * (الحد الأقصى المتاح للإرجاع: {selectedLineRemaining})
                </label>
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  max={selectedLineRemaining}
                  required
                  className="form-input"
                  style={{ height: '40px', fontSize: '14px' }}
                  placeholder="الكمية"
                  value={returnQuantity}
                  onChange={(e) => setReturnQuantity(e.target.value)}
                />
              </div>
            )}

            <div style={{ marginBottom: '20px' }}>
              <label className="form-label" style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>ملاحظات ومسوغ الإرجاع</label>
              <textarea
                className="form-input"
                rows={2}
                style={{ fontSize: '14px', width: '100%' }}
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
                style={{ minHeight: '40px', padding: '0 20px', fontSize: '14px' }}
                disabled={isLoading || !returnReceiptLineId || Number(returnQuantity) <= 0}
              >
                حفظ وتأكيد إرجاع الخامات
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
