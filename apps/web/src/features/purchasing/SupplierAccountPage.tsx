import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/AuthContext';
import {
  financeApi,
  Supplier,
  SupplierInvoice,
  SupplierStatementReport,
  UnallocatedPayment,
  SUPPLIER_INVOICE_STATUS_LABELS,
} from '@/features/finance/financeApi';
import { formatMoney } from '@/lib/formatters';

interface SupplierAccountPageProps {
  supplier: Supplier;
  onBack: () => void;
  onSupplierUpdated?: (supplier: Supplier) => void;
}

function formatDate(date: string): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('ar-EG');
}

function apiError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'حدث خطأ غير متوقع. حاول مرة أخرى.';
}

export function SupplierAccountPage({ supplier, onBack, onSupplierUpdated: _onSupplierUpdated }: SupplierAccountPageProps) {
  const { hasPermission, roles } = useAuth();
  const isWarehouseOnly = roles.includes('warehouse_manager') && !roles.includes('finance_manager') && !roles.includes('general_manager');
  const canCreateInvoices = hasPermission('suppliers:invoices:create');
  const canRequestPayment = !isWarehouseOnly && hasPermission('suppliers:payments:request');
  const canAllocatePayment = hasPermission('finance:payments:manage') || hasPermission('finance:treasury:disburse') || hasPermission('suppliers:payments:request');
  const canApproveOpening = hasPermission('finance:approval:general_manager') || hasPermission('finance:approval:finance_manager') || roles.includes('general_manager') || roles.includes('finance_manager');

  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [statement, setStatement] = useState<SupplierStatementReport | null>(null);
  const [unallocatedPayments, setUnallocatedPayments] = useState<UnallocatedPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'invoices' | 'statement'>('invoices');

  // Modals
  const [paymentInvoice, setPaymentInvoice] = useState<SupplierInvoice | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDesc, setPaymentDesc] = useState('');

  const [allocatingInvoice, setAllocatingInvoice] = useState<SupplierInvoice | null>(null);
  const [selectedPaymentId, setSelectedPaymentId] = useState('');
  const [allocateAmount, setAllocateAmount] = useState('');
  const [allocateNotes, setAllocateNotes] = useState('');

  const [openingModalOpen, setOpeningModalOpen] = useState(false);
  const [openingInvoiceNumber, setOpeningInvoiceNumber] = useState('');
  const [openingDate, setOpeningDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [openingTotal, setOpeningTotal] = useState('');
  const [openingNotes, setOpeningNotes] = useState('');

  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allInvoices, stmt, unalloc] = await Promise.all([
        financeApi.getSupplierInvoices(),
        financeApi.getSupplierStatement(supplier.id).catch(() => null),
        financeApi.getSupplierUnallocatedPayments(supplier.id).catch(() => []),
      ]);
      const myInvoices = allInvoices.filter((inv) => inv.supplier_id === supplier.id);
      setInvoices(myInvoices);
      setStatement(stmt);
      setUnallocatedPayments(unalloc);
    } catch (loadErr) {
      setError(apiError(loadErr));
    } finally {
      setLoading(false);
    }
  }, [supplier.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totalUnallocated = useMemo(
    () => unallocatedPayments.reduce((s, p) => s + Number(p.unallocated_amount || 0), 0),
    [unallocatedPayments]
  );

  const totals = useMemo(() => {
    return invoices.reduce(
      (acc, inv) => ({
        invoiced: acc.invoiced + Number(inv.invoice_total || 0),
        received: acc.received + Number(inv.received_value ?? inv.invoice_total ?? 0),
        paid: acc.paid + Number(inv.paid_total || 0),
        payable: acc.payable + Number(inv.payable_balance ?? 0),
      }),
      { invoiced: 0, received: 0, paid: 0, payable: 0 }
    );
  }, [invoices]);

  // Actions
  const handlePaymentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!paymentInvoice) return;
    setSaving(true);
    setError(null);
    try {
      await financeApi.requestSupplierPayment(paymentInvoice.id, {
        amount: paymentAmount,
        description: paymentDesc.trim() || `سداد لفاتورة المورد ${paymentInvoice.invoice_number}`,
      });
      setPaymentInvoice(null);
      setPaymentAmount('');
      setPaymentDesc('');
      await reload();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAllocateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!allocatingInvoice || !selectedPaymentId) return;
    setSaving(true);
    setError(null);
    try {
      await financeApi.allocateSupplierPayment(allocatingInvoice.id, {
        cash_document_id: selectedPaymentId,
        amount: Number(allocateAmount),
        notes: allocateNotes.trim() || undefined,
      });
      setAllocatingInvoice(null);
      setSelectedPaymentId('');
      setAllocateAmount('');
      setAllocateNotes('');
      await reload();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOpeningSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await financeApi.createOpeningSupplierInvoice({
        supplier_id: supplier.id,
        invoice_number: openingInvoiceNumber.trim(),
        invoice_date: openingDate,
        amount: Number(openingTotal),
        notes: openingNotes.trim() || 'رصيد افتتاحي للمورد',
      });
      setOpeningModalOpen(false);
      setOpeningInvoiceNumber('');
      setOpeningTotal('');
      setOpeningNotes('');
      await reload();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleApproveOpening = async (inv: SupplierInvoice) => {
    setSaving(true);
    setError(null);
    try {
      await financeApi.approveOpeningSupplierInvoice(inv.id);
      await reload();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="customer-account" aria-labelledby="supplier-account-title" dir="rtl">
      <div className="customer-account__topline">
        <button className="customer-back" type="button" onClick={onBack}>
          ‹ العودة إلى المشتريات
        </button>
        <span className={`customer-status ${supplier.is_active ? 'customer-status--active' : 'customer-status--inactive'}`}>
          {supplier.is_active ? 'مورد نشط' : 'مورد موقوف'}
        </span>
      </div>

      <header className="customer-account__header">
        <div className="customer-account__identity">
          <div className="customer-avatar customer-avatar--large" aria-hidden>
            {supplier.name.trim().charAt(0) || 'م'}
          </div>
          <div>
            <span>{supplier.code}</span>
            <h2 id="supplier-account-title">{supplier.name}</h2>
            <p>{supplier.address || 'العنوان غير مسجل'} · {supplier.phone || 'الهاتف غير مسجل'}</p>
          </div>
        </div>
        <div className="customer-account__actions">
          {canCreateInvoices && (
            <button
              className="btn btn--secondary"
              type="button"
              onClick={() => setOpeningModalOpen(true)}
              disabled={saving}
            >
              ＋ رصيد افتتاحي
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="customers-alert" role="alert" style={{ margin: '1rem 0' }}>
          {error}
          <button type="button" onClick={() => void reload()} style={{ marginInlineStart: '1rem' }}>
            إعادة المحاولة
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="customer-account__summary">
        <article>
          <span>إجمالي الفواتير ({invoices.length})</span>
          <strong>{formatMoney(totals.invoiced)}</strong>
        </article>
        <article>
          <span>قيمة ما تم استلامه بالمخزن</span>
          <strong>{formatMoney(totals.received)}</strong>
        </article>
        <article>
          <span>المسدد (معتمد في الخزينة)</span>
          <strong>{formatMoney(totals.paid)}</strong>
        </article>
        <article>
          <span>المستحق للمورد حالياً</span>
          <strong>{formatMoney(totals.payable)}</strong>
        </article>
      </div>

      {/* Unallocated Payments Alert */}
      {totalUnallocated > 0 && (
        <div
          style={{
            padding: '0.85rem 1.25rem',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: '8px',
            color: '#166534',
            marginBottom: '1.25rem',
          }}
        >
          <strong style={{ fontSize: '0.95rem' }}>
            💡 يوجد رصيد دفعات نقدية معلقة غير مخصصة: {formatMoney(totalUnallocated)}
          </strong>
          <span style={{ fontSize: '0.85rem', display: 'block', color: '#15803d', marginTop: '0.2rem' }}>
            موزعة على {unallocatedPayments.length} سند صرف معتمد في الخزينة. يمكنك تخصيصها للفواتير المفتوحة أدناه دون تكرار أي صرف نقدي.
          </span>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="md-tabs" role="tablist" style={{ marginBottom: '1rem' }}>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'invoices'}
          className={`md-tab${activeTab === 'invoices' ? ' md-tab--active' : ''}`}
          onClick={() => setActiveTab('invoices')}
        >
          فواتير الشراء واستلام الخامات ({invoices.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'statement'}
          className={`md-tab${activeTab === 'statement' ? ' md-tab--active' : ''}`}
          onClick={() => setActiveTab('statement')}
        >
          كشف الحساب
        </button>
      </div>

      {loading ? (
        <p style={{ color: '#64748b', padding: '1rem' }}>جاري تحميل بيانات حساب المورد...</p>
      ) : activeTab === 'invoices' ? (
        <div className="warehouse-table-wrap">
          <table className="warehouse-table" aria-label="فواتير المورد">
            <thead>
              <tr>
                <th>رقم الفاتورة</th>
                <th>التاريخ</th>
                <th>إجمالي الفاتورة</th>
                <th>قيمة المستلم</th>
                <th>حالة الاستلام</th>
                <th>المسدد</th>
                <th>المستحق حالياً</th>
                <th>الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                    لا توجد فواتير مسجلة لهذا المورد.
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => {
                  const isOpening = inv.is_opening;
                  const canApproveThisOpening = isOpening && !inv.approved_at && canApproveOpening;
                  const payable = Number(inv.payable_balance ?? 0);
                  return (
                    <tr key={inv.id}>
                      <td>
                        <strong>{inv.invoice_number}</strong>
                        {inv.internal_number && <small style={{ display: 'block', color: '#64748b' }}>{inv.internal_number}</small>}
                        {isOpening && <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e', marginInlineStart: '4px' }}>افتتاحي</span>}
                      </td>
                      <td>{formatDate(inv.invoice_date)}</td>
                      <td><strong>{formatMoney(inv.invoice_total)}</strong></td>
                      <td>{formatMoney(inv.received_value ?? inv.invoice_total)}</td>
                      <td>
                        <span className={`status-pill status-pill--${inv.status}`}>
                          {SUPPLIER_INVOICE_STATUS_LABELS[inv.status] || inv.status}
                        </span>
                      </td>
                      <td>{formatMoney(inv.paid_total)}</td>
                      <td>
                        <strong style={{ color: payable > 0 ? '#b91c1c' : '#166534' }}>
                          {formatMoney(payable)}
                        </strong>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                          {canApproveThisOpening && (
                            <button
                              type="button"
                              className="btn btn--sm btn--primary"
                              onClick={() => void handleApproveOpening(inv)}
                              disabled={saving}
                              title="اعتماد الفاتورة الافتتاحية للمورد وترحيلها"
                            >
                              ✓ اعتماد الافتتاحي
                            </button>
                          )}
                          {payable > 0 && canRequestPayment && (
                            <button
                              type="button"
                              className="btn btn--sm btn--secondary"
                              onClick={() => {
                                setPaymentInvoice(inv);
                                setPaymentAmount(String(payable));
                                setPaymentDesc(`سداد فاتورة ${inv.invoice_number}`);
                              }}
                              disabled={saving}
                            >
                              سداد دفعة
                            </button>
                          )}
                          {payable > 0 && totalUnallocated > 0 && canAllocatePayment && (
                            <button
                              type="button"
                              className="btn btn--sm btn--teal"
                              onClick={() => {
                                setAllocatingInvoice(inv);
                                setAllocateAmount(String(Math.min(payable, totalUnallocated)));
                                setSelectedPaymentId(unallocatedPayments[0]?.cash_document_id || '');
                                setAllocateNotes(`تخصيص على فاتورة ${inv.invoice_number}`);
                              }}
                              disabled={saving}
                              style={{ background: '#0d9488', color: '#fff' }}
                            >
                              تخصيص دفعة معلقة
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="warehouse-table-wrap">
          {statement ? (
            <div>
              <div style={{ padding: '0.75rem 1rem', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <span>إجمالي الفواتير: <strong>{formatMoney(statement.totals.total_invoiced)}</strong></span>
                <span>قيمة المستلم: <strong>{formatMoney(statement.totals.total_received)}</strong></span>
                <span>إجمالي المدفوعات: <strong>{formatMoney(statement.totals.total_paid)}</strong></span>
                <span>المستحق للمورد: <strong style={{ color: statement.totals.balance_due > 0 ? '#b91c1c' : '#166534' }}>{formatMoney(statement.totals.balance_due)}</strong></span>
              </div>
              <table className="warehouse-table" aria-label="فواتير كشف حساب المورد">
                <thead>
                  <tr>
                    <th>رقم الفاتورة</th>
                    <th>الرقم الداخلي</th>
                    <th>التاريخ</th>
                    <th>الحالة</th>
                    <th style={{ textAlign: 'left' }}>إجمالي الفاتورة</th>
                    <th style={{ textAlign: 'left' }}>المسدد</th>
                    <th style={{ textAlign: 'left' }}>المستحق</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.invoices.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                        لا توجد فواتير مسجلة في كشف الحساب.
                      </td>
                    </tr>
                  ) : (
                    statement.invoices.map((inv) => (
                      <tr key={inv.invoice_id}>
                        <td><strong>{inv.invoice_number}</strong></td>
                        <td><code>{inv.internal_number}</code></td>
                        <td>{formatDate(inv.invoice_date || '')}</td>
                        <td>
                          <span className={`status-pill status-pill--${inv.status}`}>
                            {SUPPLIER_INVOICE_STATUS_LABELS[inv.status] || inv.status}
                          </span>
                        </td>
                        <td style={{ textAlign: 'left' }}>{formatMoney(inv.invoice_total)}</td>
                        <td style={{ textAlign: 'left' }}>{formatMoney(inv.paid_total)}</td>
                        <td style={{ textAlign: 'left', fontWeight: 600, color: inv.balance_due > 0 ? '#b91c1c' : '#166534' }}>
                          {formatMoney(inv.balance_due)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
              لا تتوفر بيانات كشف حساب لهذا المورد حالياً.
            </p>
          )}
        </div>
      )}

      {/* Payment Request Modal */}
      {paymentInvoice && (
        <div className="modal-backdrop" onClick={() => setPaymentInvoice(null)} role="dialog" aria-modal="true">
          <div className="modal-card" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: '480px' }}>
            <h3 style={{ margin: '0 0 1rem' }}>سداد دفعة على فاتورة المورد</h3>
            <p className="form-hint" style={{ marginBottom: '1rem' }}>
              فاتورة: <strong>{paymentInvoice.invoice_number}</strong> · المستحق حالياً:{' '}
              <strong>{formatMoney(paymentInvoice.payable_balance ?? 0)}</strong>
            </p>
            <form onSubmit={(e) => void handlePaymentSubmit(e)} style={{ display: 'grid', gap: '0.85rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>مبلغ السداد المطلوب (ج.م) *</span>
                <input
                  className="form-input"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={Number(paymentInvoice.payable_balance ?? 0)}
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>البيان / ملاحظات السداد</span>
                <input
                  className="form-input"
                  value={paymentDesc}
                  onChange={(e) => setPaymentDesc(e.target.value)}
                  placeholder="بيان سبب الصرف أو المرجع"
                />
              </label>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setPaymentInvoice(null)} disabled={saving}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--primary" disabled={saving}>
                  {saving ? 'جاري التسجيل...' : 'تأكيد طلب السداد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Allocation Modal */}
      {allocatingInvoice && (
        <div className="modal-backdrop" onClick={() => setAllocatingInvoice(null)} role="dialog" aria-modal="true">
          <div className="modal-card" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: '520px' }}>
            <h3 style={{ margin: '0 0 1rem' }}>تخصيص دفعة معلقة على الفاتورة</h3>
            <p className="form-hint" style={{ marginBottom: '1rem' }}>
              فاتورة: <strong>{allocatingInvoice.invoice_number}</strong> · المستحق:{' '}
              <strong>{formatMoney(allocatingInvoice.payable_balance ?? 0)}</strong>
            </p>
            <form onSubmit={(e) => void handleAllocateSubmit(e)} style={{ display: 'grid', gap: '0.85rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>اختر سند الصرف المعلق *</span>
                <select
                  className="form-input"
                  required
                  value={selectedPaymentId}
                  onChange={(e) => setSelectedPaymentId(e.target.value)}
                >
                  <option value="">اختر الدفعة غير المخصصة</option>
                  {unallocatedPayments.map((p) => (
                    <option key={p.cash_document_id} value={p.cash_document_id}>
                      {p.document_number} · التاريخ: {formatDate(p.occurred_at)} · المتاح: {formatMoney(p.unallocated_amount)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>المبلغ المراد تخصيصه (ج.م) *</span>
                <input
                  className="form-input"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={allocateAmount}
                  onChange={(e) => setAllocateAmount(e.target.value)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>ملاحظات التخصيص</span>
                <input
                  className="form-input"
                  value={allocateNotes}
                  onChange={(e) => setAllocateNotes(e.target.value)}
                  placeholder="ملاحظات توثيق التخصيص"
                />
              </label>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setAllocatingInvoice(null)} disabled={saving}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--teal" disabled={saving || !selectedPaymentId} style={{ background: '#0d9488', color: '#fff' }}>
                  {saving ? 'جاري التخصيص...' : 'تأكيد التخصيص'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Opening Balance Invoice Modal */}
      {openingModalOpen && (
        <div className="modal-backdrop" onClick={() => setOpeningModalOpen(false)} role="dialog" aria-modal="true">
          <div className="modal-card" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: '480px' }}>
            <h3 style={{ margin: '0 0 1rem' }}>تسجيل رصيد افتتاحي للمورد</h3>
            <p className="form-hint" style={{ marginBottom: '1rem' }}>
              يُنشئ فاتورة افتتاحية للمورد. بعد الحفظ يعتمدها المدير العام أو المالي لتسجيل الرصيد محاسبياً.
            </p>
            <form onSubmit={(e) => void handleOpeningSubmit(e)} style={{ display: 'grid', gap: '0.85rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>رقم الفاتورة الافتتاحية *</span>
                <input
                  className="form-input"
                  required
                  value={openingInvoiceNumber}
                  onChange={(e) => setOpeningInvoiceNumber(e.target.value)}
                  placeholder="مثال: OPEN-SUP-001"
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>تاريخ الرصيد الافتتاحي *</span>
                <input
                  className="form-input"
                  required
                  type="date"
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>إجمالي الرصيد المستحق (ج.م) *</span>
                <input
                  className="form-input"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={openingTotal}
                  onChange={(e) => setOpeningTotal(e.target.value)}
                  placeholder="0.00"
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>ملاحظات</span>
                <input
                  className="form-input"
                  value={openingNotes}
                  onChange={(e) => setOpeningNotes(e.target.value)}
                  placeholder="رصيد افتتاحي مستحق قبل بدء النظام"
                />
              </label>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setOpeningModalOpen(false)} disabled={saving}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--primary" disabled={saving}>
                  {saving ? 'جاري الحفظ...' : 'حفظ الفاتورة الافتتاحية'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
