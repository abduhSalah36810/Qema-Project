import { FormEvent, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import { CatalogItem, fetchCatalogItems } from '@/features/production/productionApi';

type Supplier = { id: string; code: string; name: string; phone: string; address: string; is_active: boolean };
type InvoiceLine = { id: string; item_id: string; item_code: string; item_name_ar: string; unit_id: string; unit_name_ar: string; invoiced_quantity: number; received_quantity: number; unit_price: string; notes: string };
type Invoice = { id: string; internal_number: string; supplier_id: string; supplier_name: string; invoice_number: string; invoice_date: string; invoice_total: string; paid_total: string; balance_due: string; status: string; notes: string; created_by: string; received_by: string | null; received_at: string | null; lines: InvoiceLine[] };
type NewLine = { item_id: string; unit_id: string; invoiced_quantity: number; unit_price: string; notes: string };

export function SupplierPurchasingView() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ code: '', name: '', phone: '', address: '' });
  const [invoiceForm, setInvoiceForm] = useState({ supplier_id: '', invoice_number: '', invoice_total: '', notes: '' });
  const [newLine, setNewLine] = useState({ item_id: '', invoiced_quantity: '', unit_price: '' });
  const [lines, setLines] = useState<NewLine[]>([]);
  const [received, setReceived] = useState<Record<string, Record<string, string>>>({});
  const [paymentAmounts, setPaymentAmounts] = useState<Record<string, string>>({});

  const load = async () => {
    const [supplierRows, invoiceRows, catalog] = await Promise.all([
      apiClient.request<Supplier[]>('/api/v1/finance/suppliers'),
      apiClient.request<Invoice[]>('/api/v1/finance/supplier-invoices'),
      fetchCatalogItems(),
    ]);
    setSuppliers(supplierRows); setInvoices(invoiceRows); setItems(catalog);
  };
  useEffect(() => { void load().catch(() => setError('تعذر تحميل الموردين وفواتيرهم.')); }, []);

  const addSupplier = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await apiClient.request('/api/v1/finance/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(supplierForm) });
      setSupplierForm({ code: '', name: '', phone: '', address: '' }); await load();
    } catch { setError('تعذر حفظ المورد. تحقق من الكود والصلاحية.'); }
    finally { setBusy(false); }
  };

  const addLine = () => {
    const item = items.find((row) => row.id === newLine.item_id);
    const quantity = Number(newLine.invoiced_quantity);
    if (!item || !Number.isFinite(quantity) || quantity <= 0 || Number(newLine.unit_price) < 0) return;
    setLines((current) => [...current, { item_id: item.id, unit_id: item.unit_id, invoiced_quantity: quantity, unit_price: newLine.unit_price, notes: '' }]);
    setNewLine({ item_id: '', invoiced_quantity: '', unit_price: '' });
  };

  const createInvoice = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await apiClient.request('/api/v1/finance/supplier-invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...invoiceForm, invoice_date: new Date().toISOString(), lines }) });
      setInvoiceForm({ supplier_id: '', invoice_number: '', invoice_total: '', notes: '' }); setLines([]); await load();
    } catch { setError('تعذر تسجيل الفاتورة. اختر المورد والبنود وأدخل إجمالي الفاتورة.'); }
    finally { setBusy(false); }
  };

  const confirmReceipt = async (invoice: Invoice) => {
    const lineValues = received[invoice.id] ?? {};
    if (invoice.lines.some((line) => lineValues[line.id] === undefined || lineValues[line.id] === '')) {
      setError('أدخل الكمية المستلمة فعليًا لكل بند قبل التأكيد.'); return;
    }
    setBusy(true); setError('');
    try {
      await apiClient.request(`/api/v1/finance/supplier-invoices/${invoice.id}/receive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: invoice.lines.map((line) => ({ line_id: line.id, received_quantity: Number(lineValues[line.id]) })), notes: '' }),
      });
      await load();
    } catch { setError('تعذر تأكيد الاستلام. راجع الصلاحية والحساب.'); }
    finally { setBusy(false); }
  };

  const requestPayment = async (invoice: Invoice) => {
    setBusy(true); setError('');
    try {
      await apiClient.request(`/api/v1/finance/supplier-invoices/${invoice.id}/payments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: paymentAmounts[invoice.id], description: `سداد فاتورة المورد ${invoice.invoice_number}` }),
      });
      setPaymentAmounts((current) => ({ ...current, [invoice.id]: '' })); await load();
    } catch { setError('تعذر تسجيل دفعة المورد. راجع المبلغ المتبقي والصلاحية.'); }
    finally { setBusy(false); }
  };

  const selectedItem = items.find((item) => item.id === newLine.item_id);
  return <section className="warehouse-draft" aria-labelledby="supplier-title">
    <h3 id="supplier-title">الموردون وفواتير الخامات</h3>
    {error && <div className="warehouse-alert" role="alert">{error}</div>}
    <form className="warehouse-toolbar" onSubmit={(event) => void addSupplier(event)}>
      <label>كود المورد<input required value={supplierForm.code} onChange={(event) => setSupplierForm({ ...supplierForm, code: event.target.value })} /></label>
      <label>اسم المورد<input required value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} /></label>
      <label>الهاتف<input value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} /></label>
      <label>العنوان<input value={supplierForm.address} onChange={(event) => setSupplierForm({ ...supplierForm, address: event.target.value })} /></label>
      <button className="btn btn--secondary" disabled={busy}>حفظ المورد</button>
    </form>
    <form className="warehouse-draft" onSubmit={(event) => void createInvoice(event)}>
      <h4>تسجيل فاتورة مورد</h4>
      <div className="warehouse-toolbar">
        <label>المورد<select required value={invoiceForm.supplier_id} onChange={(event) => setInvoiceForm({ ...invoiceForm, supplier_id: event.target.value })}><option value="">اختر المورد</option>{suppliers.filter((row) => row.is_active).map((row) => <option key={row.id} value={row.id}>{row.name} · {row.code}</option>)}</select></label>
        <label>رقم الفاتورة<input required value={invoiceForm.invoice_number} onChange={(event) => setInvoiceForm({ ...invoiceForm, invoice_number: event.target.value })} /></label>
        <label>إجمالي الفاتورة (ج.م)<input required type="number" min="0.01" step="0.01" value={invoiceForm.invoice_total} onChange={(event) => setInvoiceForm({ ...invoiceForm, invoice_total: event.target.value })} /></label>
        <label>ملاحظات<input value={invoiceForm.notes} onChange={(event) => setInvoiceForm({ ...invoiceForm, notes: event.target.value })} /></label>
      </div>
      <div className="warehouse-toolbar">
        <label>الصنف<select value={newLine.item_id} onChange={(event) => setNewLine({ ...newLine, item_id: event.target.value })}><option value="">اختر الصنف</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name_ar} · {item.code}</option>)}</select></label>
        <label>الكمية بالفاتورة<input type="number" min="0.001" step="0.001" value={newLine.invoiced_quantity} onChange={(event) => setNewLine({ ...newLine, invoiced_quantity: event.target.value })} /></label>
        <label>سعر الوحدة بالجنيه<input type="number" min="0" step="0.0001" value={newLine.unit_price} onChange={(event) => setNewLine({ ...newLine, unit_price: event.target.value })} /></label>
        <span>{selectedItem?.unit_name_ar ?? ''}</span><button type="button" onClick={addLine}>إضافة بند</button>
      </div>
      {lines.map((line, index) => <p key={`${line.item_id}-${index}`}>{items.find((item) => item.id === line.item_id)?.name_ar} · {line.invoiced_quantity} · {line.unit_price} ج.م <button type="button" onClick={() => setLines((current) => current.filter((_, rowIndex) => rowIndex !== index))}>إزالة</button></p>)}
      <button className="btn btn--primary" disabled={busy || lines.length === 0}>حفظ الفاتورة</button>
    </form>
    <h4>الفواتير وأرصدة الموردين</h4>
    {invoices.map((invoice) => <article className="action-box" key={invoice.id}>
      <strong>{invoice.supplier_name} · {invoice.invoice_number} ({invoice.internal_number})</strong>
      <p>الفاتورة: {invoice.invoice_total} ج.م · المدفوع المعتمد: {invoice.paid_total} ج.م · المتبقي: {invoice.balance_due} ج.م · الحالة: {invoice.status === 'received' ? 'تم الاستلام' : 'بانتظار الاستلام'}</p>
      {invoice.lines.map((line) => <label key={line.id} className="warehouse-toolbar">{line.item_name_ar} · بالفاتورة {line.invoiced_quantity} {line.unit_name_ar} · المستلم سابقًا {line.received_quantity}<input aria-label={`الكمية المستلمة ${line.item_name_ar}`} type="number" min="0" step="0.001" disabled={invoice.status !== 'awaiting_receipt'} value={received[invoice.id]?.[line.id] ?? (invoice.status === 'received' ? String(line.received_quantity) : '')} onChange={(event) => setReceived((current) => ({ ...current, [invoice.id]: { ...current[invoice.id], [line.id]: event.target.value } }))} /></label>)}
      {invoice.status === 'awaiting_receipt' && <button disabled={busy} onClick={() => void confirmReceipt(invoice)}>تأكيد الكميات المستلمة</button>}
      {invoice.status === 'received' && <div className="warehouse-toolbar"><label>قيمة دفعة المورد<input type="number" min="0.01" step="0.01" max={invoice.balance_due} value={paymentAmounts[invoice.id] ?? ''} onChange={(event) => setPaymentAmounts({ ...paymentAmounts, [invoice.id]: event.target.value })} /></label><button disabled={busy || Number(paymentAmounts[invoice.id] ?? 0) <= 0} onClick={() => void requestPayment(invoice)}>إنشاء طلب سداد</button></div>}
    </article>)}
  </section>;
}
