import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/AuthContext';
import { financeApi, Supplier } from '@/features/finance/financeApi';
import { SupplierAccountPage } from './SupplierAccountPage';

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'حدث خطأ غير متوقع. حاول مرة أخرى.';
}

const emptyForm = { code: '', name: '', phone: '', address: '' };

export function SuppliersDirectoryView() {
  const { hasPermission } = useAuth();
  const canManageSuppliers = hasPermission('suppliers:manage');

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const loadSuppliers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await financeApi.getSuppliers();
      setSuppliers(rows);
      setSelected((curr) => (curr ? rows.find((r) => r.id === curr.id) ?? null : null));
    } catch (err) {
      setError(errorText(err));
      setSuppliers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  const handleCreateSupplier = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await financeApi.createSupplier({
        code: form.code.trim(),
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
      });
      setCreateModalOpen(false);
      setForm(emptyForm);
      await loadSuppliers();
      setSelected(created);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSupplierUpdated = useCallback((updated: Supplier) => {
    setSelected(updated);
    setSuppliers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  const visibleSuppliers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suppliers.filter((s) => {
      const matchesSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        (s.phone && s.phone.includes(q)) ||
        (s.address && s.address.toLowerCase().includes(q));

      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && s.is_active) ||
        (statusFilter === 'inactive' && !s.is_active);

      return matchesSearch && matchesStatus;
    });
  }, [suppliers, search, statusFilter]);

  const activeCount = useMemo(() => suppliers.filter((s) => s.is_active).length, [suppliers]);

  if (selected) {
    return (
      <SupplierAccountPage
        supplier={selected}
        onBack={() => {
          setSelected(null);
          void loadSuppliers();
        }}
        onSupplierUpdated={handleSupplierUpdated}
      />
    );
  }

  return (
    <section className="customers-page" aria-labelledby="suppliers-directory-title" dir="rtl">
      <header className="customers-page__header">
        <div>
          <span className="customers-page__eyebrow">المشتريات والحسابات · إدارة الموردين</span>
          <h2 id="suppliers-directory-title">الموردون</h2>
          <p>دليل الموردين وبيانات الاتصال والأرصدة ومتابعة الفواتير والمسددات.</p>
        </div>
        {canManageSuppliers && (
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => {
              setForm(emptyForm);
              setCreateModalOpen(true);
            }}
          >
            ＋ تسجيل مورد جديد
          </button>
        )}
      </header>

      {/* KPI Stats */}
      <div className="customers-stats" aria-label="ملخص الموردين">
        <article>
          <span>إجمالي الموردين</span>
          <strong>{suppliers.length}</strong>
        </article>
        <article>
          <span>موردون نشطون</span>
          <strong style={{ color: '#16a34a' }}>{activeCount}</strong>
        </article>
        <article>
          <span>نتائج البحث</span>
          <strong>{visibleSuppliers.length}</strong>
        </article>
      </div>

      {error && (
        <div className="customers-alert" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {/* Search and Filters */}
      <div className="customers-search" style={{ marginBottom: '1.25rem' }}>
        <input
          type="search"
          placeholder="بحث بالاسم، الكود، رقم الهاتف، أو المدينة…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="بحث في الموردين"
          style={{ fontSize: '0.95rem', minHeight: '44px' }}
        />
        <div className="md-tabs" role="tablist" style={{ borderBottom: 'none' }}>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'all'}
            className={`md-tab${statusFilter === 'all' ? ' md-tab--active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            الكل ({suppliers.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'active'}
            className={`md-tab${statusFilter === 'active' ? ' md-tab--active' : ''}`}
            onClick={() => setStatusFilter('active')}
          >
            نشطون ({activeCount})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'inactive'}
            className={`md-tab${statusFilter === 'inactive' ? ' md-tab--active' : ''}`}
            onClick={() => setStatusFilter('inactive')}
          >
            موقوفون ({suppliers.length - activeCount})
          </button>
        </div>
      </div>

      {/* Suppliers Table */}
      {loading ? (
        <p style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>جاري تحميل دليل الموردين…</p>
      ) : visibleSuppliers.length === 0 ? (
        <div
          style={{
            padding: '3rem 1.5rem',
            textAlign: 'center',
            backgroundColor: '#f8fafc',
            borderRadius: '10px',
            border: '1px dashed #cbd5e1',
          }}
        >
          <p style={{ fontSize: '1.1rem', fontWeight: 600, color: '#334155', margin: '0 0 0.5rem' }}>
            لا يوجد موردون مطابقون لخيارات البحث.
          </p>
          <span style={{ color: '#64748b', fontSize: '0.9rem' }}>
            {search ? 'جرّب تغيير كلمات البحث أو مسح الفلاتر.' : 'يمكنك إضافة مورد جديد عبر زر «تسجيل مورد جديد» أعلاه.'}
          </span>
        </div>
      ) : (
        <div className="warehouse-table-wrap">
          <table className="warehouse-table" aria-label="جدول الموردين">
            <thead>
              <tr>
                <th>كود المورد</th>
                <th>اسم المورد</th>
                <th>رقم الهاتف</th>
                <th>العنوان / المدينة</th>
                <th>الحالة</th>
                <th style={{ textAlign: 'center' }}>الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {visibleSuppliers.map((s) => (
                <tr
                  key={s.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(s)}
                  title="اضغط لعرض كشف الحساب وتفاصيل التعامل"
                >
                  <td>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#0f766e', fontSize: '0.95rem' }}>
                      {s.code}
                    </span>
                  </td>
                  <td>
                    <strong style={{ fontSize: '1rem', color: '#0f172a' }}>{s.name}</strong>
                  </td>
                  <td>
                    <span dir="ltr" style={{ fontSize: '0.92rem', color: '#334155' }}>
                      {s.phone || '—'}
                    </span>
                  </td>
                  <td style={{ color: '#475569', fontSize: '0.92rem' }}>{s.address || '—'}</td>
                  <td>
                    <span
                      className={`customer-status ${s.is_active ? 'customer-status--active' : 'customer-status--inactive'}`}
                      style={{ fontSize: '0.82rem' }}
                    >
                      {s.is_active ? 'نشط' : 'موقوف'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(s);
                      }}
                      style={{
                        padding: '0.35rem 0.85rem',
                        fontSize: '0.88rem',
                        fontWeight: 600,
                        borderColor: '#0f766e',
                        color: '#0f766e',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      📄 كشف الحساب والتفاصيل ‹
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal: Create Supplier */}
      {createModalOpen && (
        <div className="customer-modal-backdrop" onClick={() => setCreateModalOpen(false)}>
          <section
            className="customer-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-supplier-title"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '580px', width: '100%', borderRadius: '14px' }}
          >
            <header>
              <div>
                <span style={{ color: '#0f766e', fontSize: '0.82rem', fontWeight: 600 }}>إدارة الموردين</span>
                <h3 id="new-supplier-title" style={{ margin: '4px 0 0', fontSize: '1.25rem' }}>
                  تسجيل مورد جديد
                </h3>
              </div>
              <button type="button" aria-label="إغلاق" onClick={() => setCreateModalOpen(false)}>
                ×
              </button>
            </header>

            {error && <div className="customers-alert" role="alert">{error}</div>}

            <form onSubmit={(e) => void handleCreateSupplier(e)} style={{ display: 'grid', gap: '1rem', marginTop: '0.5rem' }}>
              <label>
                <span>
                  كود المورد{' '}
                  <small style={{ color: '#64748b', fontWeight: 'normal' }}>
                    (تلقائي فريد إذا تُرِك فارغاً)
                  </small>
                </span>
                <input
                  placeholder="اتركه فارغاً لتوليد كود تلقائي SUP-..."
                  maxLength={64}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  style={{ height: '42px', fontSize: '0.95rem' }}
                />
              </label>

              <label>
                <span>
                  اسم المورد <span style={{ color: '#dc2626' }}>*</span>
                </span>
                <input
                  required
                  maxLength={128}
                  autoFocus
                  placeholder="مثال: شركة النسيج الحديث"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  style={{ height: '42px', fontSize: '0.95rem' }}
                />
              </label>

              <label>
                <span>رقم الهاتف</span>
                <input
                  maxLength={32}
                  placeholder="01xxxxxxxxx"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  style={{ height: '42px', fontSize: '0.95rem' }}
                />
              </label>

              <label>
                <span>العنوان / المدينة</span>
                <textarea
                  rows={3}
                  maxLength={4000}
                  placeholder="العنوان التفصيلي والمدينة"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  style={{ fontSize: '0.95rem' }}
                />
              </label>

              <footer style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '10px' }}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setCreateModalOpen(false)}
                  disabled={saving}
                >
                  إلغاء
                </button>
                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={saving || !form.name.trim()}
                  style={{ padding: '0.6rem 1.5rem', fontWeight: 600 }}
                >
                  {saving ? 'جاري الحفظ…' : 'حفظ المورد'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
