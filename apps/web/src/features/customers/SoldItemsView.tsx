import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  fetchCustomers,
  fetchOrderableProducts,
  fetchSoldItems,
  type Customer,
  type OrderableProduct,
  type SoldItemsResponse,
} from './customersApi';

const money = (v: number | undefined) =>
  `${Number(v || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

const qty = (v: number | undefined) => Number(v || 0).toLocaleString('ar-EG', { maximumFractionDigits: 3 });

const ORDER_TYPE_LABELS: Record<string, string> = {
  ready_goods: 'مبيعات مخزون جاهز',
  custom_manufacturing: 'تصنيع خاص للعميل',
};

export function SoldItemsView() {
  const [data, setData] = useState<SoldItemsResponse | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<OrderableProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [productId, setProductId] = useState('');
  const [orderType, setOrderType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const loadLookups = useCallback(async () => {
    try {
      const [custList, prodList] = await Promise.all([
        fetchCustomers().catch(() => [] as Customer[]),
        fetchOrderableProducts().catch(() => [] as OrderableProduct[]),
      ]);
      setCustomers(custList);
      setProducts(prodList);
    } catch {
      // non-fatal lookup fallback
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchSoldItems({
        customer_id: customerId || undefined,
        product_id: productId || undefined,
        order_type: orderType || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        search: search.trim() || undefined,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل سجل الأصناف المباعة.');
    } finally {
      setLoading(false);
    }
  }, [customerId, productId, orderType, dateFrom, dateTo, search]);

  useEffect(() => {
    void loadLookups();
  }, [loadLookups]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const resetFilters = () => {
    setSearch('');
    setCustomerId('');
    setProductId('');
    setOrderType('');
    setDateFrom('');
    setDateTo('');
  };

  return (
    <section className="warehouse-page" dir="rtl">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">المبيعات · تحليل المبيعات والتسليمات الفعلية</span>
          <h2>الأصناف المباعة</h2>
          <p>متابعة كافة الموديلات والمقاسات المسلمة فعلياً للعملاء، بعد احتساب خصم الطلب وخصم المرتجعات بدقة.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => void loadData()} disabled={loading}>
          {loading ? 'جاري التحديث...' : '↻ تحديث السجل'}
        </button>
      </header>

      {error && <div className="warehouse-alert warehouse-alert--error">{error}</div>}

      {data && (
        <div className="warehouse-kpis-grid">
          <div className="warehouse-kpi-card">
            <span className="warehouse-kpi-card__label">عدد حركات البيع</span>
            <strong className="warehouse-kpi-card__value">{data.summary.lines_count}</strong>
            <span className="warehouse-kpi-card__sub">بند تسليم مسجل للعملاء</span>
          </div>
          <div className="warehouse-kpi-card">
            <span className="warehouse-kpi-card__label">عدد الموديلات المباعة</span>
            <strong className="warehouse-kpi-card__value">{data.summary.distinct_products_count}</strong>
            <span className="warehouse-kpi-card__sub">موديل ومنتج نهائي فريد</span>
          </div>
          <div className="warehouse-kpi-card warehouse-kpi-card--accent-emerald">
            <span className="warehouse-kpi-card__label">المسلّم / المرتجع / الصافي</span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
              <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#334155' }}>
                {qty(data.summary.total_delivered_quantity)}
              </span>
              <span style={{ fontSize: '0.86rem', color: '#64748b' }}>−</span>
              <span style={{ fontSize: '1.15rem', fontWeight: 700, color: '#b45309' }}>
                {qty(data.summary.total_returned_quantity)}
              </span>
              <span style={{ fontSize: '0.86rem', color: '#64748b' }}>=</span>
              <strong style={{ fontSize: '1.45rem', fontWeight: 800, color: '#047857' }}>
                {qty(data.summary.total_net_sold_quantity)}
              </strong>
            </div>
            <span className="warehouse-kpi-card__sub">إجمالي عدد القطع الصافية المستقرة لدى العملاء</span>
          </div>
          <div className="warehouse-kpi-card warehouse-kpi-card--accent-blue">
            <span className="warehouse-kpi-card__label">صافي قيمة المبيعات</span>
            <strong className="warehouse-kpi-card__value" style={{ color: '#1d4ed8' }}>
              {money(data.summary.total_net_sold_value)}
            </strong>
            <span className="warehouse-kpi-card__sub">بعد خصومات الطلبات والمردودات المعتمدة</span>
          </div>
        </div>
      )}

      <div className="items-filter-bar">
        <div className="items-filter-grid">
          <input
            type="text"
            className="items-filter-input"
            placeholder="بحث بالموديل، العميل، رقم الطلب أو إذن التسليم..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="بحث في الأصناف المباعة"
          />
          <select className="items-filter-select" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="تصفية حسب العميل">
            <option value="">كل العملاء</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="items-filter-select" value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="تصفية حسب الموديل">
            <option value="">كل الموديلات</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name_ar}
              </option>
            ))}
          </select>
          <select className="items-filter-select" value={orderType} onChange={(e) => setOrderType(e.target.value)} aria-label="تصفية حسب نوع البيع">
            <option value="">كل أنواع الطلبات</option>
            <option value="ready_goods">مبيعات مخزون جاهز</option>
            <option value="custom_manufacturing">تصنيع خاص للعميل</option>
          </select>
          <input className="items-filter-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="من تاريخ التسليم" />
          <input className="items-filter-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="إلى تاريخ التسليم" />
          <button type="button" className="items-filter-btn items-filter-btn--reset" onClick={resetFilters}>
            ✕ مسح الفلاتر
          </button>
        </div>
      </div>

      <div className="items-table-card">
        <div className="items-table-scroll">
          <table className="items-table">
            <thead>
              <tr>
                <th>تاريخ التسليم</th>
                <th>المستند / الطلب</th>
                <th>العميل</th>
                <th>الموديل والمقاس</th>
                <th>النوع</th>
                <th className="is-num">المسلّم</th>
                <th className="is-num">المرتجع</th>
                <th className="is-num">الصافي</th>
                <th className="is-num">سعر الوحدة</th>
                <th className="is-num">صافي الوحدة</th>
                <th className="is-num">صافي البيع</th>
              </tr>
            </thead>
            <tbody>
              {!loading && (data?.items.length ?? 0) === 0 ? (
                <tr>
                  <td colSpan={11} style={{ textAlign: 'center', padding: 36, color: '#64748b' }}>
                    لا توجد مبيعات مسلمة مطابقة لمعايير البحث الحالية.
                  </td>
                </tr>
              ) : (
                (data?.items ?? []).map((row) => (
                  <tr key={row.delivery_line_id}>
                    <td style={{ color: '#64748b', fontSize: '0.84rem' }}>
                      {new Date(row.delivered_at).toLocaleDateString('ar-EG')}
                    </td>
                    <td className="is-wrap">
                      <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.delivery_number}</div>
                      <div style={{ fontSize: '0.78rem', color: '#64748b' }}>طلب: {row.order_number}</div>
                    </td>
                    <td className="is-wrap">
                      <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.customer_name}</div>
                      <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{row.customer_code}</div>
                    </td>
                    <td className="is-wrap">
                      <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.product_name}</div>
                      <div style={{ fontSize: '0.78rem', color: '#0f766e', fontWeight: 600 }}>
                        {row.product_code} {row.variant_info ? `· ${row.variant_info}` : ''}
                      </div>
                    </td>
                    <td>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '3px 10px',
                          borderRadius: 999,
                          fontSize: '0.76rem',
                          fontWeight: 700,
                          background: row.order_type === 'ready_goods' ? '#f0fdfa' : '#eff6ff',
                          color: row.order_type === 'ready_goods' ? '#0f766e' : '#1d4ed8',
                          border: `1px solid ${row.order_type === 'ready_goods' ? '#99f6e4' : '#bfdbfe'}`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {ORDER_TYPE_LABELS[row.order_type] || row.order_type}
                      </span>
                    </td>
                    <td className="is-num" style={{ fontWeight: 600 }}>{qty(row.delivered_quantity)}</td>
                    <td className="is-num" style={{ color: row.returned_quantity > 0 ? '#b45309' : '#64748b', fontWeight: row.returned_quantity > 0 ? 700 : 500 }}>
                      {qty(row.returned_quantity)}
                    </td>
                    <td className="is-num" style={{ color: '#047857', fontWeight: 800 }}>
                      {qty(row.net_sold_quantity)}
                    </td>
                    <td className="is-num">{money(row.unit_price)}</td>
                    <td className="is-num">{money(row.net_unit_price)}</td>
                    <td className="is-num" style={{ fontWeight: 800, color: '#1e3a8a' }}>
                      {money(row.net_sold_value)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

