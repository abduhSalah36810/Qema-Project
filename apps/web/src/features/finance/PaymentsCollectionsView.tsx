import { useEffect, useState } from 'react';
import { financeApi, SupplierInvoice, CashDocument } from './financeApi';

export function PaymentsCollectionsView() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [cashDocs, setCashDocs] = useState<CashDocument[]>([]);
  const [activeTab, setActiveTab] = useState<'supplier_payments' | 'collections'>('supplier_payments');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [invoiceRows, docRows] = await Promise.all([
        financeApi.getSupplierInvoices(),
        financeApi.getCashDocuments(),
      ]);
      setInvoices(invoiceRows);
      setCashDocs(docRows);
      setError('');
    } catch {
      setError('تعذر تحميل بيانات المدفوعات والتحصيلات.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const totalSupplierInvoiced = invoices.reduce((sum, inv) => sum + Number(inv.invoice_total), 0);
  const totalSupplierPaid = invoices.reduce((sum, inv) => sum + Number(inv.paid_total), 0);
  const totalSupplierDue = invoices.reduce((sum, inv) => sum + Number(inv.balance_due), 0);

  const approvedCollections = cashDocs
    .filter((d) => d.document_type === 'income' && d.status === 'approved')
    .reduce((sum, d) => sum + Number(d.amount), 0);

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="payments-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة حركة السيولة النقدية</span>
          <h2 id="payments-title">المدفوعات والتحصيلات</h2>
          <p>متابعة وتوثيق سدادات الموردين والتحصيلات النقدية من العملاء ومستحقات الدفع.</p>
        </div>
        <button className="btn btn--secondary" onClick={() => void load()}>
          تحديث
        </button>
      </header>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}

      <div className="warehouse-summary">
        <article>
          <span>إجمالي مسدد للموردين</span>
          <strong style={{ color: '#059669' }}>
            {totalSupplierPaid.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
          </strong>
          <small>من إجمالي فواتير: {totalSupplierInvoiced.toLocaleString('ar-EG')} ج.م</small>
        </article>
        <article>
          <span>مستحقات معلقة للموردين</span>
          <strong style={{ color: '#dc2626' }}>
            {totalSupplierDue.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
          </strong>
          <small>متبقي واجب السداد</small>
        </article>
        <article>
          <span>إجمالي التحصيلات المقبوضة</span>
          <strong style={{ color: '#0f766e' }}>
            {approvedCollections.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
          </strong>
          <small>مقبوضات الخزينة المعتمدة</small>
        </article>
      </div>

      {/* شريط التبويب */}
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
        <button
          className={`btn ${activeTab === 'supplier_payments' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => setActiveTab('supplier_payments')}
        >
          سدادات ومستحقات الموردين ({invoices.length})
        </button>
        <button
          className={`btn ${activeTab === 'collections' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => setActiveTab('collections')}
        >
          تحصيلات ومقبوضات الخزينة ({cashDocs.filter((d) => d.document_type === 'income').length})
        </button>
      </div>

      {/* محتوى التبويب */}
      <section className="warehouse-draft" style={{ marginTop: '1rem' }}>
        {loading ? (
          <p>جاري التحميل…</p>
        ) : activeTab === 'supplier_payments' ? (
          <div>
            <h3>حالة سدادات فواتير الموردين</h3>
            {invoices.length === 0 ? (
              <p style={{ color: '#64748b' }}>لا توجد فواتير موردين مسجلة حتى الآن.</p>
            ) : (
              <div className="warehouse-table-wrap">
                <table className="warehouse-table">
                  <thead>
                    <tr>
                      <th>رقم الفاتورة الداخلي</th>
                      <th>رقم فاتورة المورد</th>
                      <th>المورد</th>
                      <th>إجمالي الفاتورة</th>
                      <th>المسدد</th>
                      <th>المتبقي</th>
                      <th>حالة الفاتورة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td>
                          <code>{inv.internal_number}</code>
                        </td>
                        <td>{inv.invoice_number}</td>
                        <td>
                          <strong>{inv.supplier_name}</strong>
                        </td>
                        <td>{Number(inv.invoice_total).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</td>
                        <td>
                          <span style={{ color: '#059669', fontWeight: 600 }}>
                            {Number(inv.paid_total).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                          </span>
                        </td>
                        <td>
                          <span style={{ color: Number(inv.balance_due) > 0 ? '#dc2626' : '#64748b', fontWeight: 600 }}>
                            {Number(inv.balance_due).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                          </span>
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: '0.8rem',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '4px',
                              backgroundColor:
                                inv.status === 'paid' ? '#dcfce7' : inv.status === 'partially_paid' ? '#fef3c7' : '#fee2e2',
                              color:
                                inv.status === 'paid' ? '#166534' : inv.status === 'partially_paid' ? '#92400e' : '#991b1b',
                            }}
                          >
                            {inv.status === 'paid' ? 'مسددة بالكامل' : inv.status === 'partially_paid' ? 'مسددة جزئياً' : 'مستحقة بالكامل'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div>
            <h3>سجل التحصيلات والمقبوضات النقدية</h3>
            <div className="warehouse-table-wrap">
              <table className="warehouse-table">
                <thead>
                  <tr>
                    <th>رقم المستند</th>
                    <th>المبلغ</th>
                    <th>البيان</th>
                    <th>التاريخ</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {cashDocs
                    .filter((d) => d.document_type === 'income')
                    .map((doc) => (
                      <tr key={doc.id}>
                        <td>
                          <code>{doc.document_number}</code>
                        </td>
                        <td>
                          <strong style={{ color: '#059669' }}>
                            +{Number(doc.amount).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                          </strong>
                        </td>
                        <td>{doc.description}</td>
                        <td>{new Date(doc.occurred_at).toLocaleDateString('ar-EG')}</td>
                        <td>
                          <span
                            style={{
                              fontSize: '0.8rem',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '4px',
                              backgroundColor: doc.status === 'approved' ? '#dcfce7' : '#fef3c7',
                              color: doc.status === 'approved' ? '#166534' : '#92400e',
                            }}
                          >
                            {doc.status === 'approved' ? 'معتمد ومحصل' : 'قيد المراجعة'}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}

