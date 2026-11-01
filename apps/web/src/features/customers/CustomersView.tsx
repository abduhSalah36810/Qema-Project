import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { createCustomer, Customer, CustomerInput, fetchCustomers, updateCustomer } from './customersApi';
import { CustomerAccountPage } from './CustomerAccountPage';

const emptyForm: CustomerInput = { code: '', name: '', phone: '', city: '', address: '' };

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'حدث خطأ غير متوقع. حاول مرة أخرى.';
}

export function CustomersView() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Customer['status']>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState<CustomerInput>(emptyForm);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchCustomers(search);
      setCustomers(rows);
      setSelected((current) => current ? rows.find((row) => row.id === current.id) ?? null : null);
    } catch (loadError) {
      setError(errorText(loadError));
      setCustomers([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { void loadCustomers(); }, [loadCustomers]);

  const visibleCustomers = customers.filter((customer) => statusFilter === 'all' || customer.status === statusFilter);
  const activeCount = customers.filter((customer) => customer.status === 'active').length;

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditing(customer);
    setForm({ code: customer.code, name: customer.name, phone: customer.phone ?? '', city: customer.city ?? '', address: customer.address ?? '' });
    setFormOpen(true);
  };

  const saveCustomer = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = editing ? await updateCustomer(editing.id, form) : await createCustomer(form);
      setFormOpen(false);
      setSelected(saved);
      await loadCustomers();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleCustomerUpdated = useCallback((updated: Customer) => {
    setSelected(updated);
    setCustomers((current) => current.map((item) => item.id === updated.id ? updated : item));
  }, []);

  if (selected) {
    return <CustomerAccountPage customer={selected} onBack={() => setSelected(null)} onEditCustomer={(customer) => { setSelected(null); openEdit(customer); }} onCustomerUpdated={handleCustomerUpdated} />;
  }

  return (
    <section className="customers-page" aria-labelledby="customers-title">
      <header className="customers-page__header">
        <div>
          <span className="customers-page__eyebrow">إدارة علاقات العملاء</span>
          <h2 id="customers-title">العملاء</h2>
          <p>دليل العملاء وبيانات التواصل وحالة الحساب.</p>
        </div>
        <button className="btn btn--primary" type="button" onClick={openCreate}>＋ تسجيل عميل</button>
      </header>

      <div className="customers-stats" aria-label="ملخص العملاء">
        <article><span>إجمالي العملاء المعروضين</span><strong>{customers.length}</strong></article>
        <article><span>عملاء نشطون</span><strong>{activeCount}</strong></article>
        <article><span>نتائج البحث</span><strong>{visibleCustomers.length}</strong></article>
      </div>

      {error && <div className="customers-alert" role="alert">{error}</div>}

      <div className="customers-layout">
        <section className="customers-card" aria-label="قائمة العملاء">
          <div className="customers-toolbar">
            <label className="customers-search">
              <span className="sr-only">البحث عن عميل</span>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ابحث بالاسم أو الكود أو الهاتف أو المدينة" />
            </label>
            <label className="customers-filter">
              <span className="sr-only">تصفية الحالة</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                <option value="all">كل الحالات</option><option value="active">نشط</option><option value="inactive">موقوف</option>
              </select>
            </label>
            <button className="btn btn--secondary" type="button" onClick={() => void loadCustomers()} disabled={loading}>تحديث</button>
          </div>

          {loading ? <div className="customers-empty" role="status">جاري تحميل العملاء من قاعدة البيانات…</div> :
            visibleCustomers.length === 0 ? <div className="customers-empty">{search ? 'لا توجد نتائج مطابقة.' : 'لا يوجد عملاء مسجلون بعد.'}</div> : (
              <div className="customers-table-wrap">
                <table className="customers-table">
                  <thead><tr><th>العميل</th><th>الهاتف</th><th>المدينة</th><th>الحالة</th><th>إجراء</th></tr></thead>
                  <tbody>{visibleCustomers.map((customer) => (
                    <tr key={customer.id}>
                      <td><button className="customer-name-button" type="button" onClick={() => setSelected(customer)}><strong>{customer.name}</strong><small>{customer.code}</small></button></td>
                      <td>{customer.phone || '—'}</td><td>{customer.city || '—'}</td>
                      <td><span className={`customer-status customer-status--${customer.status}`}>{customer.status === 'active' ? 'نشط' : 'موقوف'}</span></td>
                      <td><button className="customer-action" type="button" onClick={() => openEdit(customer)}>تعديل</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
        </section>

      </div>

      {formOpen && <div className="customer-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}>
        <form className="customer-modal" onSubmit={(event) => void saveCustomer(event)} aria-labelledby="customer-form-title">
          <header><div><span>ملف العميل</span><h3 id="customer-form-title">{editing ? 'تعديل بيانات العميل' : 'تسجيل عميل جديد'}</h3></div><button type="button" aria-label="إغلاق" onClick={() => setFormOpen(false)}>×</button></header>
          {error && <div className="customers-alert" role="alert">{error}</div>}
          <label>كود العميل<input required maxLength={64} value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} /></label>
          <label>اسم العميل<input required maxLength={128} autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <div className="customer-form-grid"><label>رقم الهاتف<input maxLength={32} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label>المدينة<input maxLength={64} value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></label></div>
          <label>العنوان<textarea rows={3} maxLength={4000} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label>
          <footer><button className="btn btn--secondary" type="button" onClick={() => setFormOpen(false)}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'جاري الحفظ…' : 'حفظ بيانات العميل'}</button></footer>
        </form>
      </div>}
    </section>
  );
}
