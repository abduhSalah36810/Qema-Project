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
import { formatMoney, formatDate } from '@/lib/formatters';

interface SupplierAccountPageProps {
  supplier: Supplier;
  onBack: () => void;
  onSupplierUpdated?: (supplier: Supplier) => void;
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
          ‹ العودة إلى قائمة الموردين
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
        <div className="customer-account__actions" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {canRequestPayment && invoices.some((inv) => Number(inv.payable_balance ?? 0) > 0.001) && (
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                const firstOpen = invoices.find((inv) => Number(inv.payable_balance ?? 0) > 0.001);
                if (firstOpen) {
                  setPaymentInvoice(firstOpen);
                  setPaymentAmount(String(Number(firstOpen.payable_balance ?? 0)));
                  setPaymentDesc(`سداد دفعة للمورد ${supplier.name} عن فاتورة ${firstOpen.invoice_number}`);
                }
              }}
              disabled={saving}
              style={{ fontWeight: 600 }}
            >
              ＋ تسجيل دفعة مورد
            </button>
          )}
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
        <div className="modal-backdrop" onClick={() => setPaymentInvoice(null)} role="dialog" aria-modal="true" aria-labelledby="pay-modal-title">
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            style={{
              maxWidth: '680px',
              width: '100%',
              borderRadius: '14px',
              boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)',
              overflow: 'hidden',
              border: '1px solid #e2e8f0',
              background: '#ffffff',
            }}
          >
            {/* Header */}
            <header
              style={{
                padding: '1.25rem 1.75rem',
                backgroundColor: '#f8fafc',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h3 id="pay-modal-title" style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' }}>
                  تسجيل دفعة مورد · طلب سداد
                </h3>
                <span style={{ fontSize: '0.875rem', color: '#64748b', display: 'block', marginTop: '0.25rem' }}>
                  المورد: <strong style={{ color: '#0f172a' }}>{supplier.name}</strong> ({supplier.code})
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPaymentInvoice(null)}
                disabled={saving}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  lineHeight: 1,
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '6px',
                }}
                aria-label="إغلاق"
              >
                ✕
              </button>
            </header>

            {/* Financial Details Bar */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '0.75rem',
                padding: '1.25rem 1.75rem',
                backgroundColor: '#f1f5f9',
                borderBottom: '1px solid #e2e8f0',
              }}
            >
              <div style={{ backgroundColor: '#ffffff', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b', display: 'block' }}>رقم الفاتورة</span>
                <strong style={{ fontSize: '0.95rem', color: '#0f172a' }}>{paymentInvoice.invoice_number}</strong>
                <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.75rem' }}>{paymentInvoice.internal_number}</small>
              </div>
              <div style={{ backgroundColor: '#ffffff', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b', display: 'block' }}>إجمالي الفاتورة</span>
                <strong style={{ fontSize: '1rem', color: '#0f172a' }}>{formatMoney(paymentInvoice.invoice_total)}</strong>
              </div>
              <div style={{ backgroundColor: '#ffffff', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b', display: 'block' }}>المسدد حتى الآن</span>
                <strong style={{ fontSize: '1rem', color: '#16a34a' }}>{formatMoney(paymentInvoice.paid_total)}</strong>
              </div>
              <div style={{ backgroundColor: '#ecfdf5', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #6ee7b7' }}>
                <span style={{ fontSize: '0.8rem', color: '#065f46', display: 'block', fontWeight: 600 }}>المستحق للسداد</span>
                <strong style={{ fontSize: '1.15rem', color: '#047857' }}>
                  {formatMoney(paymentInvoice.payable_balance ?? 0)}
                </strong>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={(e) => void handlePaymentSubmit(e)} style={{ padding: '1.5rem 1.75rem', display: 'grid', gap: '1.25rem' }}>
              {invoices.filter((inv) => Number(inv.payable_balance ?? 0) > 0.001).length > 1 && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>الفاتورة المحددة للسداد:</span>
                  <select
                    className="form-input"
                    value={paymentInvoice.id}
                    onChange={(e) => {
                      const found = invoices.find((inv) => inv.id === e.target.value);
                      if (found) {
                        setPaymentInvoice(found);
                        setPaymentAmount(String(Number(found.payable_balance ?? 0)));
                        setPaymentDesc(`سداد دفعة للمورد ${supplier.name} عن فاتورة ${found.invoice_number}`);
                      }
                    }}
                    style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                  >
                    {invoices.filter((inv) => Number(inv.payable_balance ?? 0) > 0.001).map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        فاتورة {inv.invoice_number} · المستحق: {formatMoney(inv.payable_balance ?? 0)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* Amount input + Quick Buttons */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
                  <label htmlFor="pay-amount-input" style={{ fontSize: '0.95rem', fontWeight: 600, color: '#1e293b' }}>
                    مبلغ السداد المطلوب (ج.م) <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  {/* Quick percentage buttons */}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ padding: '0.25rem 0.65rem', fontSize: '0.82rem', borderRadius: '6px', fontWeight: 600 }}
                      onClick={() => setPaymentAmount(String(Number(paymentInvoice.payable_balance ?? 0)))}
                    >
                      كامل المستحق (100%)
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ padding: '0.25rem 0.65rem', fontSize: '0.82rem', borderRadius: '6px' }}
                      onClick={() => setPaymentAmount((Number(paymentInvoice.payable_balance ?? 0) / 2).toFixed(2))}
                    >
                      النصف (50%)
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ padding: '0.25rem 0.65rem', fontSize: '0.82rem', borderRadius: '6px' }}
                      onClick={() => setPaymentAmount((Number(paymentInvoice.payable_balance ?? 0) / 4).toFixed(2))}
                    >
                      الربع (25%)
                    </button>
                  </div>
                </div>

                <div>
                  <input
                    id="pay-amount-input"
                    className="form-input"
                    required
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={Number(paymentInvoice.payable_balance ?? 0)}
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    style={{
                      fontSize: '1.25rem',
                      fontWeight: 700,
                      padding: '0.75rem 1rem',
                      width: '100%',
                      borderRadius: '8px',
                      border: '2px solid #cbd5e1',
                      color: '#0f172a',
                    }}
                    placeholder="0.00"
                    autoFocus
                  />
                </div>

                {/* Remaining preview */}
                {Number(paymentAmount) > 0 && (
                  <div style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '6px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>
                      المتبقي على الفاتورة بعد السداد:{' '}
                      <strong style={{ color: '#0f172a' }}>
                        {formatMoney(Math.max(0, Number(paymentInvoice.payable_balance ?? 0) - Number(paymentAmount)))}
                      </strong>
                    </span>
                    {Number(paymentAmount) > Number(paymentInvoice.payable_balance ?? 0) && (
                      <span style={{ color: '#dc2626', fontWeight: 600 }}>⚠️ المبلغ أكبر من المستحق!</span>
                    )}
                  </div>
                )}
              </div>

              {/* Description / Notes */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>البيان وملاحظات السداد</span>
                <input
                  className="form-input"
                  value={paymentDesc}
                  onChange={(e) => setPaymentDesc(e.target.value)}
                  placeholder="بيان سبب الصرف أو المرجع"
                  style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              {/* Status Notice */}
              <div
                style={{
                  padding: '0.85rem 1rem',
                  borderRadius: '8px',
                  backgroundColor: roles.includes('finance_manager') ? '#f0fdf4' : '#eff6ff',
                  border: `1px solid ${roles.includes('finance_manager') ? '#86efac' : '#bfdbfe'}`,
                  fontSize: '0.85rem',
                  color: roles.includes('finance_manager') ? '#166534' : '#1e40af',
                }}
              >
                {roles.includes('finance_manager') ? (
                  <span>
                    ⚡ <strong>اعتماد فوري:</strong> بصفتك المدير المالي، سيتم اعتماد سند الصرف وترحيله فورياً في الخزينة وخصم المبلغ من مستحقات المورد.
                  </span>
                ) : (
                  <span>
                    ℹ️ سيتم تسجيل طلب السداد كإذن صرف معلق، ويتم خصم النقدية بعد اعتماد السند من شاشة الخزينة والاعتمادات.
                  </span>
                )}
              </div>

              {/* Actions */}
              <div
                style={{
                  display: 'flex',
                  gap: '12px',
                  justifyContent: 'flex-end',
                  paddingTop: '0.75rem',
                  borderTop: '1px solid #f1f5f9',
                }}
              >
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setPaymentInvoice(null)}
                  disabled={saving}
                  style={{ padding: '0.65rem 1.35rem', fontSize: '0.95rem' }}
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={saving || !paymentAmount || Number(paymentAmount) <= 0 || Number(paymentAmount) > Number(paymentInvoice.payable_balance ?? 0) + 0.001}
                  style={{ padding: '0.65rem 1.85rem', fontSize: '0.95rem', fontWeight: 600 }}
                >
                  {saving ? 'جاري التسجيل...' : '✓ تأكيد طلب السداد'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Allocation Modal */}
      {allocatingInvoice && (
        <div className="modal-backdrop" onClick={() => setAllocatingInvoice(null)} role="dialog" aria-modal="true" aria-labelledby="alloc-modal-title">
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            style={{
              maxWidth: '680px',
              width: '100%',
              borderRadius: '14px',
              boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)',
              overflow: 'hidden',
              border: '1px solid #e2e8f0',
              background: '#ffffff',
            }}
          >
            <header
              style={{
                padding: '1.25rem 1.75rem',
                backgroundColor: '#f8fafc',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h3 id="alloc-modal-title" style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' }}>
                  تخصيص دفعة معلقة على الفاتورة
                </h3>
                <span style={{ fontSize: '0.875rem', color: '#64748b', display: 'block', marginTop: '0.25rem' }}>
                  فاتورة: <strong style={{ color: '#0f172a' }}>{allocatingInvoice.invoice_number}</strong> · المستحق:{' '}
                  <strong style={{ color: '#047857' }}>{formatMoney(allocatingInvoice.payable_balance ?? 0)}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAllocatingInvoice(null)}
                disabled={saving}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  lineHeight: 1,
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '6px',
                }}
                aria-label="إغلاق"
              >
                ✕
              </button>
            </header>

            <form onSubmit={(e) => void handleAllocateSubmit(e)} style={{ padding: '1.5rem 1.75rem', display: 'grid', gap: '1.25rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>اختر سند الصرف المعلق *</span>
                <select
                  className="form-input"
                  required
                  value={selectedPaymentId}
                  onChange={(e) => setSelectedPaymentId(e.target.value)}
                  style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                >
                  <option value="">اختر الدفعة غير المخصصة</option>
                  {unallocatedPayments.map((p) => (
                    <option key={p.cash_document_id} value={p.cash_document_id}>
                      {p.document_number} · التاريخ: {formatDate(p.occurred_at)} · المتاح: {formatMoney(p.unallocated_amount)}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>المبلغ المراد تخصيصه (ج.م) *</span>
                <input
                  className="form-input"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={allocateAmount}
                  onChange={(e) => setAllocateAmount(e.target.value)}
                  style={{ fontSize: '1.15rem', fontWeight: 700, padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>ملاحظات التخصيص</span>
                <input
                  className="form-input"
                  value={allocateNotes}
                  onChange={(e) => setAllocateNotes(e.target.value)}
                  placeholder="ملاحظات توثيق التخصيص"
                  style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', paddingTop: '0.75rem', borderTop: '1px solid #f1f5f9' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setAllocatingInvoice(null)} disabled={saving} style={{ padding: '0.65rem 1.35rem', fontSize: '0.95rem' }}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--teal" disabled={saving || !selectedPaymentId} style={{ background: '#0d9488', color: '#fff', padding: '0.65rem 1.85rem', fontSize: '0.95rem', fontWeight: 600 }}>
                  {saving ? 'جاري التخصيص...' : 'تأكيد التخصيص'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Opening Balance Invoice Modal */}
      {openingModalOpen && (
        <div className="modal-backdrop" onClick={() => setOpeningModalOpen(false)} role="dialog" aria-modal="true" aria-labelledby="opening-modal-title">
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            style={{
              maxWidth: '620px',
              width: '100%',
              borderRadius: '14px',
              boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.25)',
              overflow: 'hidden',
              border: '1px solid #e2e8f0',
              background: '#ffffff',
            }}
          >
            <header
              style={{
                padding: '1.25rem 1.75rem',
                backgroundColor: '#f8fafc',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h3 id="opening-modal-title" style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' }}>
                  تسجيل رصيد افتتاحي للمورد
                </h3>
                <span style={{ fontSize: '0.85rem', color: '#64748b', display: 'block', marginTop: '0.25rem' }}>
                  يُنشئ فاتورة افتتاحية للمورد. بعد الحفظ يعتمدها المدير المالي لتسجيل الرصيد محاسبياً.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOpeningModalOpen(false)}
                disabled={saving}
                style={{
                  background: 'transparent',
                  border: 'none',
                  fontSize: '1.5rem',
                  lineHeight: 1,
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '0.25rem 0.5rem',
                  borderRadius: '6px',
                }}
                aria-label="إغلاق"
              >
                ✕
              </button>
            </header>

            <form onSubmit={(e) => void handleOpeningSubmit(e)} style={{ padding: '1.5rem 1.75rem', display: 'grid', gap: '1.25rem' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>رقم الفاتورة الافتتاحية *</span>
                <input
                  className="form-input"
                  required
                  value={openingInvoiceNumber}
                  onChange={(e) => setOpeningInvoiceNumber(e.target.value)}
                  placeholder="مثال: OPEN-SUP-001"
                  style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>تاريخ الرصيد الافتتاحي *</span>
                <input
                  className="form-input"
                  required
                  type="date"
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                  style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>إجمالي الرصيد المستحق (ج.م) *</span>
                <input
                  className="form-input"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={openingTotal}
                  onChange={(e) => setOpeningTotal(e.target.value)}
                  placeholder="0.00"
                  style={{ fontSize: '1.15rem', fontWeight: 700, padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e293b' }}>ملاحظات</span>
                <input
                  className="form-input"
                  value={openingNotes}
                  onChange={(e) => setOpeningNotes(e.target.value)}
                  placeholder="رصيد افتتاحي مستحق قبل بدء النظام"
                  style={{ fontSize: '0.95rem', padding: '0.65rem 0.85rem', borderRadius: '8px', border: '1px solid #cbd5e1' }}
                />
              </label>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', paddingTop: '0.75rem', borderTop: '1px solid #f1f5f9' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setOpeningModalOpen(false)} disabled={saving} style={{ padding: '0.65rem 1.35rem', fontSize: '0.95rem' }}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--primary" disabled={saving} style={{ padding: '0.65rem 1.85rem', fontSize: '0.95rem', fontWeight: 600 }}>
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
