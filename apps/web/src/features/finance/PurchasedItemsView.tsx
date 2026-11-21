import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { fetchCatalogItems, type CatalogItem } from '@/features/production/productionApi';
import { financeApi, type PurchasedItemRow, type PurchasedItemsResponse, type Supplier } from './financeApi';

import { formatMoney, formatQuantity as qty } from '@/lib/formatters';

const money = (v: string | number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  return formatMoney(v);
};

const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  awaiting_receipt: { label: 'بانتظار الاستلام', bg: '#fffbeb', color: '#92400e' },
  partially_received: { label: 'مستلمة جزئياً', bg: '#eff6ff', color: '#1d4ed8' },
  received: { label: 'مستلمة بالكامل', bg: '#ecfdf5', color: '#065f46' },
  cancelled: { label: 'ملغاة', bg: '#fef2f2', color: '#991b1b' },
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  fabric: 'قماش',
  accessory: 'إكسسوارات ومستلزمات',
  packaging: 'تغليف وتعبئة',
  tool: 'أدوات ومعدات',
};

export function PurchasedItemsView() {
  const [data, setData] = useState<PurchasedItemsResponse | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [itemId, setItemId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [itemType, setItemType] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const loadLookups = useCallback(async () => {
    try {
      const [supList, itemList] = await Promise.all([
        financeApi.getSuppliers().catch(() => [] as Supplier[]),
        fetchCatalogItems().catch(() => [] as CatalogItem[]),
      ]);
      setSuppliers(supList);
      setCatalogItems(itemList);
    } catch {
      // ignore non-fatal lookup errors
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await financeApi.getPurchasedItems({
        item_id: itemId || undefined,
        supplier_id: supplierId || undefined,
        category_id: categoryId || undefined,
        item_type: itemType || undefined,
        status: statusFilter || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        search: search.trim() || undefined,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل سجل الأصناف المشتراة.');
    } finally {
      setLoading(false);
    }
  }, [itemId, supplierId, categoryId, itemType, statusFilter, dateFrom, dateTo, search]);

  useEffect(() => {
    void loadLookups();
  }, [loadLookups]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const categories = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of data?.items ?? []) {
      if (row.category_id && row.category_name_ar) {
        map.set(row.category_id, row.category_name_ar);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [data]);

  const pricesVisible = data?.summary.prices_visible ?? true;

  const resetFilters = () => {
    setSearch('');
    setItemId('');
    setSupplierId('');
    setCategoryId('');
    setItemType('');
    setStatusFilter('');
    setDateFrom('');
    setDateTo('');
  };

  const selectItemHistory = (row: PurchasedItemRow) => {
    setItemId((prev) => (prev === row.item_id ? '' : row.item_id));
  };

  return (
    <section className="warehouse-page" dir="rtl">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">المشتريات · تحليل ومراجعة المشتريات</span>
          <h2>الأصناف المشتراة وسجل الأسعار</h2>
          <p>استعراض كافة بنود الشراء من فواتير الموردين مباشرة، مع تتبع الكميات المستلمة وسجل أسعار الشراء لكل صنف.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => void loadData()} disabled={loading}>
          {loading ? 'جاري التحديث...' : '↻ تحديث السجل'}
        </button>
      </header>

      {error && <div className="warehouse-alert warehouse-alert--error">{error}</div>}

      {data && (
        <div className="warehouse-kpis-grid">
          <div className="warehouse-kpi-card">
            <span className="warehouse-kpi-card__label">عدد بنود الشراء</span>
            <strong className="warehouse-kpi-card__value">{data.summary.lines_count}</strong>
            <span className="warehouse-kpi-card__sub">بند مسجل في الفواتير المحددة</span>
          </div>
          <div className="warehouse-kpi-card">
            <span className="warehouse-kpi-card__label">عدد الأصناف الفريدة</span>
            <strong className="warehouse-kpi-card__value">{data.summary.distinct_items_count}</strong>
            <span className="warehouse-kpi-card__sub">خامة ومستلزم إنتاج مختلف</span>
          </div>
          <div className="warehouse-kpi-card">
            <span className="warehouse-kpi-card__label">إجمالي الكمية المفوترة</span>
            <strong className="warehouse-kpi-card__value">{qty(data.summary.total_invoiced_quantity)}</strong>
            <span className="warehouse-kpi-card__sub">حسب فواتير الموردين الأصلية</span>
          </div>
          <div className="warehouse-kpi-card warehouse-kpi-card--accent-emerald">
            <span className="warehouse-kpi-card__label">إجمالي الكمية المستلمة فعلياً</span>
            <strong className="warehouse-kpi-card__value" style={{ color: '#047857' }}>
              {qty(data.summary.total_received_quantity)}
            </strong>
            <span className="warehouse-kpi-card__sub">المثبتة بأذون استلام المخزن</span>
          </div>
          {pricesVisible && (
            <div className="warehouse-kpi-card warehouse-kpi-card--accent-blue">
              <span className="warehouse-kpi-card__label">إجمالي قيمة المشتريات المفلترة</span>
              <strong className="warehouse-kpi-card__value" style={{ color: '#1d4ed8' }}>
                {money(data.summary.total_amount)}
              </strong>
              <span className="warehouse-kpi-card__sub">صافي القيمة بعد الخصومات</span>
            </div>
          )}
        </div>
      )}

      <div className="items-filter-bar">
        <div className="items-filter-grid">
          <input
            type="text"
            className="items-filter-input"
            placeholder="بحث بالكود، الصنف، الفاتورة، أو المورد..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="بحث في الأصناف المشتراة"
          />
          <select className="items-filter-select" value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="تصفية حسب الصنف">
            <option value="">كل الأصناف</option>
            {catalogItems.map((it) => (
              <option key={it.id} value={it.id}>
                {it.code} · {it.name_ar}
              </option>
            ))}
          </select>
          <select className="items-filter-select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} aria-label="تصفية حسب المورد">
            <option value="">كل الموردين</option>
            {suppliers.map((sup) => (
              <option key={sup.id} value={sup.id}>
                {sup.name}
              </option>
            ))}
          </select>
          <select className="items-filter-select" value={itemType} onChange={(e) => setItemType(e.target.value)} aria-label="تصفية حسب نوع الصنف">
            <option value="">كل الأنواع</option>
            {Object.entries(ITEM_TYPE_LABELS).map(([k, lbl]) => (
              <option key={k} value={k}>
                {lbl}
              </option>
            ))}
          </select>
          {categories.length > 0 && (
            <select className="items-filter-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="تصفية حسب التصنيف">
              <option value="">كل التصنيفات</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <select className="items-filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="تصفية حسب حالة الفاتورة">
            <option value="">الكل (ما عدا الملغاة)</option>
            <option value="awaiting_receipt">بانتظار الاستلام</option>
            <option value="partially_received">مستلمة جزئياً</option>
            <option value="received">مستلمة بالكامل</option>
            <option value="cancelled">ملغاة</option>
          </select>
          <input className="items-filter-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="من تاريخ" />
          <input className="items-filter-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="إلى تاريخ" />
          <button type="button" className="items-filter-btn items-filter-btn--reset" onClick={resetFilters}>
            ✕ مسح الفلاتر
          </button>
        </div>
        {itemId && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#f0fdfa', border: '1px solid #ccfbf1', borderRadius: 8, fontSize: '0.88rem', color: '#0f766e', display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
            <span>🔍 يتم الآن عرض سجل مشتريات وأسعار الصنف المحدد تاريخياً.</span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setItemId('')}>
              إظهار جميع الأصناف
            </button>
          </div>
        )}
      </div>

      <div className="items-table-card">
        <div className="items-table-scroll">
          <table className="items-table">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>الفاتورة المصدرية</th>
                <th>الحالة</th>
                <th>المورد</th>
                <th>الصنف</th>
                <th>التصنيف / النوع</th>
                <th className="is-num">المفوتر</th>
                <th className="is-num">المستلم</th>
                <th className="is-num">المتبقي</th>
                {pricesVisible && <th className="is-num">سعر الوحدة</th>}
                {pricesVisible && <th className="is-num">صافي الوحدة</th>}
                {pricesVisible && <th className="is-num">الإجمالي</th>}
                <th style={{ textAlign: 'center' }}>سجل الصنف</th>
              </tr>
            </thead>
            <tbody>
              {!loading && (data?.items.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={pricesVisible ? 13 : 10} style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                    لا توجد مشتريات مطابقة لمعايير البحث الحالية.
                  </td>
                </tr>
              ) : (
                (data?.items ?? []).map((row) => {
                  const st = STATUS_LABELS[row.invoice_status] || {
                    label: row.invoice_status,
                    bg: '#f1f5f9',
                    color: '#334155',
                  };
                  return (
                    <tr key={row.line_id}>
                      <td style={{ color: '#64748b', fontSize: '0.84rem' }}>
                        {new Date(row.invoice_date).toLocaleDateString('ar-EG')}
                      </td>
                      <td className="is-wrap">
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.internal_number}</div>
                        <div style={{ fontSize: '0.78rem', color: '#64748b' }}>فاتورة: {row.invoice_number}</div>
                      </td>
                      <td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 10px',
                            borderRadius: 999,
                            fontSize: '0.76rem',
                            fontWeight: 700,
                            background: st.bg,
                            color: st.color,
                            border: `1px solid ${st.color}33`,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {st.label}
                        </span>
                      </td>
                      <td className="is-wrap" style={{ fontWeight: 600 }}>{row.supplier_name}</td>
                      <td className="is-wrap">
                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.item_name_ar}</div>
                        <div style={{ fontSize: '0.78rem', color: '#0f766e', fontWeight: 600 }}>{row.item_code}</div>
                      </td>
                      <td className="is-wrap">
                        <div style={{ fontWeight: 600 }}>{row.category_name_ar || '—'}</div>
                        <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                          {ITEM_TYPE_LABELS[row.item_type] || row.item_type}
                        </div>
                      </td>
                      <td className="is-num" style={{ fontWeight: 600 }}>
                        {qty(row.invoiced_quantity)} <span style={{ fontSize: '0.76rem', color: '#64748b' }}>{row.unit_name_ar}</span>
                      </td>
                      <td className="is-num" style={{ color: '#047857', fontWeight: 700 }}>
                        {qty(row.received_quantity)}
                      </td>
                      <td className="is-num" style={{ color: row.remaining_quantity > 0 ? '#b45309' : '#64748b', fontWeight: row.remaining_quantity > 0 ? 700 : 500 }}>
                        {qty(row.remaining_quantity)}
                      </td>
                      {pricesVisible && <td className="is-num">{money(row.unit_price)}</td>}
                      {pricesVisible && <td className="is-num">{money(row.net_unit_cost)}</td>}
                      {pricesVisible && <td className="is-num" style={{ fontWeight: 800, color: '#1e3a8a' }}>{money(row.line_total)}</td>}
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          style={{ padding: '0 10px', fontSize: '0.78rem' }}
                          onClick={() => selectItemHistory(row)}
                        >
                          {itemId === row.item_id ? '✕ إلغاء' : 'تاريخ الصنف'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

