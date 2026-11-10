import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { CatalogItem, fetchCatalogItems, fetchWarehouses, Warehouse } from '@/features/production/productionApi';
import { fetchStockBalances, fetchStockLedger, StockBalance, StockLedgerEntry } from './inventoryApi';

const MAIN_WAREHOUSE_CODE = 'main_raw_materials';

const MANUFACTURING_TYPES = new Set(['fabric', 'raw_material', 'accessory', 'packaging']);
const FACILITY_TYPES = new Set(['maintenance_supply', 'reusable_tool']);

const TYPE_NAMES_AR: Record<string, string> = {
  fabric: 'أقمشة وغزول',
  raw_material: 'خامات تصنيع أساسية',
  accessory: 'إكسسوارات وحليات',
  packaging: 'مواد تعبئة وتغليف',
  maintenance_supply: 'مستلزمات صيانة وقطع غيار',
  reusable_tool: 'عدد وأدوات تشغيل',
};

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'يلزم تسجيل الدخول بحساب مخوّل لعرض أصناف المخزن الرئيسي.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'حسابك لا يملك صلاحية عرض بيانات المخازن.';
  }
  if (error instanceof Error) return error.message;
  return 'تعذر تحميل بيانات مخزن الخامات والمستلزمات.';
}

export function MainWarehouseView() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [stock, setStock] = useState<StockBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // القسم النشط: خامات التصنيع أو خامات ومستلزمات المكان
  const [activeSection, setActiveSection] = useState<'manufacturing' | 'facility'>('manufacturing');
  const [search, setSearch] = useState('');
  const [subTypeFilter, setSubTypeFilter] = useState('all');
  const [selectedLedgerItem, setSelectedLedgerItem] = useState<CatalogItem | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCatalogItems(), fetchWarehouses()])
      .then(async ([catalog, warehouses]) => {
        if (!active) return;
        const selectedWarehouse = warehouses.find((entry) => entry.code === MAIN_WAREHOUSE_CODE) ?? null;
        let balances: StockBalance[] = [];
        if (selectedWarehouse) {
          balances = await fetchStockBalances(selectedWarehouse.id);
        }
        setItems(catalog);
        setStock(balances);
        setWarehouse(selectedWarehouse);
      })
      .catch((loadError: unknown) => {
        if (active) setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  // تصفية أولية: استبعاد المنتجات التامة منعاً باتاً من مخزن الخامات والمستلزمات
  const rawWarehouseItems = useMemo(() => {
    return items.filter((item) => item.item_type !== 'finished_garment');
  }, [items]);

  // الأصناف التابعة لقسم خامات التصنيع
  const manufacturingItems = useMemo(() => {
    return rawWarehouseItems.filter((item) => MANUFACTURING_TYPES.has(item.item_type));
  }, [rawWarehouseItems]);

  // الأصناف التابعة لقسم خامات ومستلزمات المكان وتشغيل المصنع
  const facilityItems = useMemo(() => {
    return rawWarehouseItems.filter((item) => FACILITY_TYPES.has(item.item_type));
  }, [rawWarehouseItems]);

  // الأصناف المعروضة حالياً حسب القسم والبحث والنوع
  const currentSectionItems = activeSection === 'manufacturing' ? manufacturingItems : facilityItems;

  const availableSubTypes = useMemo(() => {
    return [...new Set(currentSectionItems.map((i) => i.item_type))];
  }, [currentSectionItems]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return currentSectionItems.filter((item) => {
      const matchSearch =
        !q ||
        item.name_ar.toLowerCase().includes(q) ||
        item.code.toLowerCase().includes(q);
      const matchType = subTypeFilter === 'all' || item.item_type === subTypeFilter;
      return matchSearch && matchType;
    });
  }, [currentSectionItems, search, subTypeFilter]);

  // خريطة سريعة للأرصدة
  const stockMap = useMemo(() => {
    const map = new Map<string, StockBalance>();
    stock.forEach((s) => map.set(s.item_id, s));
    return map;
  }, [stock]);

  return (
    <section className="warehouse-page" aria-labelledby="warehouse-title" dir="rtl">
      {/* ── ترويسة الصفحة ── */}
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة المخازن · أمين المخازن</span>
          <h2 id="warehouse-title">مخزن الخامات والمستلزمات</h2>
          <p>
            متابعة أرصدة خامات تشغيل الدفعات ومستلزمات المكان، وإثبات حركات الصرف والتوريد.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span className="warehouse-page__status">
            {warehouse ? `المستودع: ${warehouse.name_ar}` : 'المخزن الرئيسي'}
          </span>
        </div>
      </header>

      {/* ── ألسنة التبويب الرئيسية للمخزن ── */}
      <div className="modal-tabs" style={{ marginBottom: '1.25rem' }}>
        <button
          type="button"
          className={`tab-btn ${activeSection === 'manufacturing' ? 'tab-btn--active' : ''}`}
          onClick={() => {
            setActiveSection('manufacturing');
            setSubTypeFilter('all');
          }}
        >
          🧵 خامات التصنيع ومستلزمات الإنتاج ({manufacturingItems.length})
        </button>
        <button
          type="button"
          className={`tab-btn ${activeSection === 'facility' ? 'tab-btn--active' : ''}`}
          onClick={() => {
            setActiveSection('facility');
            setSubTypeFilter('all');
          }}
        >
          🛠️ خامات ومستلزمات المكان وتشغيل المصنع ({facilityItems.length})
        </button>
      </div>

      {/* ── بطاقات الإحصاءات السريعة للقسم ── */}
      <div className="warehouse-summary" aria-label="ملخص أصناف القسم">
        <article>
          <span>إجمالي أصناف القسم</span>
          <strong>{loading ? '—' : currentSectionItems.length}</strong>
        </article>
        <article>
          <span>أصناف نشطة ومتاحة</span>
          <strong>{loading ? '—' : currentSectionItems.filter((i) => i.is_active).length}</strong>
        </article>
        <article>
          <span>نتائج البحث الحالية</span>
          <strong>{loading ? '—' : visibleItems.length}</strong>
        </article>
      </div>

      {/* ── شريط البحث والفلترة ── */}
      <div className="warehouse-toolbar" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1.25rem' }}>
        <label className="warehouse-search" style={{ flex: '1 1 280px' }}>
          <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>
            بحث بالاسم أو الكود:
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="مثال: قماش صيفي، خيط، زرار، كباسين..."
            style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
          />
        </label>

        <label className="warehouse-filter" style={{ minWidth: '180px' }}>
          <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '4px' }}>
            نوع الخامة / المستلزم:
          </span>
          <select
            value={subTypeFilter}
            onChange={(e) => setSubTypeFilter(e.target.value)}
            style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
          >
            <option value="all">كل الأنواع</option>
            {availableSubTypes.map((type) => (
              <option key={type} value={type}>
                {TYPE_NAMES_AR[type] || type}
              </option>
            ))}
          </select>
        </label>

        {(search || subTypeFilter !== 'all') && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setSearch('');
              setSubTypeFilter('all');
            }}
            style={{ alignSelf: 'flex-end', height: '38px' }}
          >
            إعادة ضبط
          </button>
        )}
      </div>

      {error && (
        <div className="warehouse-alert" role="alert" style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── جدول الأصناف الفعلي ── */}
      {loading ? (
        <div className="warehouse-empty" role="status">
          جاري تحميل أرصدة وأصناف مخزن الخامات...
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="warehouse-empty" style={{ background: '#f8fafc', padding: '2rem', textAlign: 'center', borderRadius: '8px', border: '1px dashed #cbd5e1' }}>
          <p style={{ margin: 0, color: '#64748b', fontSize: '1rem' }}>
            لا توجد أصناف مطابقة لخيارات البحث في هذا القسم.
          </p>
        </div>
      ) : (
        <div className="warehouse-table-wrap">
          <table className="warehouse-table">
            <thead>
              <tr>
                <th>كود الصنف</th>
                <th>اسم الصنف</th>
                <th>التصنيف والنوع</th>
                <th>الوحدة</th>
                <th>طبيعة الصنف</th>
                <th>الحالة</th>
                <th>الرصيد الفعلي</th>
                <th>سجل الحركات</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => {
                const stockItem = stockMap.get(item.id);
                const hasBalance = Boolean(stockItem && stockItem.is_established && stockItem.balance !== null);
                return (
                  <tr key={item.id}>
                    <td>
                      <code>{item.code}</code>
                    </td>
                    <td>
                      <strong>{item.name_ar}</strong>
                    </td>
                    <td>
                      <span className="badge-tag">
                        {TYPE_NAMES_AR[item.item_type] || item.item_type}
                      </span>
                    </td>
                    <td>{item.unit_name_ar || '—'}</td>
                    <td>
                      <span style={{ fontSize: '0.85rem', color: item.is_consumable ? '#0d9488' : '#64748b' }}>
                        {item.is_consumable ? 'خامة مستهلكة' : 'أداة قابلة للاستخدام'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`warehouse-item-status${
                          item.is_active ? '' : ' warehouse-item-status--inactive'
                        }`}
                      >
                        {item.is_active ? 'نشط ومتاح' : 'موقوف'}
                      </span>
                    </td>
                    <td>
                      {hasBalance && stockItem && stockItem.balance !== null ? (
                        <strong style={{ color: stockItem.balance > 0 ? '#0d9488' : '#64748b' }}>
                          {stockItem.balance} {item.unit_name_ar}
                        </strong>
                      ) : (
                        <span className="warehouse-balance-pending">٠.٠٠ (غير مثبت)</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        onClick={() => setSelectedLedgerItem(item)}
                      >
                        عرض الحركات
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── درج استعراض سجل حركة الصنف (Stock Ledger History Drawer) ── */}
      {selectedLedgerItem && warehouse && (
        <ItemLedgerModal
          item={selectedLedgerItem}
          warehouseId={warehouse.id}
          warehouseName={warehouse.name_ar}
          onClose={() => setSelectedLedgerItem(null)}
        />
      )}
    </section>
  );
}

function ItemLedgerModal({
  item,
  warehouseId,
  warehouseName,
  onClose,
}: {
  item: CatalogItem;
  warehouseId: string;
  warehouseName: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<StockLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchStockLedger(item.id, warehouseId)
      .then((data) => {
        if (active) setEntries(data);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'تعذر تحميل سجل الحركات.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [item.id, warehouseId]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: '720px' }}>
        <div className="modal-header">
          <div>
            <div className="modal-badge-row">
              <span className="order-code-badge">{item.code}</span>
              <span className="badge-tag">{warehouseName}</span>
            </div>
            <h3 className="modal-title" style={{ marginTop: '6px' }}>سجل حركات: {item.name_ar}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="إغلاق">✕</button>
        </div>

        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {error && <div className="modal-alert modal-alert--danger">{error}</div>}
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>جاري تحميل الحركات…</div>
          ) : entries.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
              لا توجد حركات مسجلة لهذا الصنف في هذا المخزن بعد.
            </div>
          ) : (
            <table className="preview-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>التاريخ والوقت</th>
                  <th>نوع الحركة</th>
                  <th>الكمية</th>
                  <th>رقم المستند المرجعي</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.created_at).toLocaleString('ar-EG')}</td>
                    <td>
                      <span className="badge-tag">
                        {entry.entry_type === 'inbound_receipt' && 'استلام توريد'}
                        {entry.entry_type === 'production_dispatch' && 'صرف للإنتاج'}
                        {entry.entry_type === 'stocktake_adjustment' && 'تسوية جرد'}
                        {entry.entry_type === 'customer_delivery_dispatch' && 'تسليم عميل'}
                        {!['inbound_receipt', 'production_dispatch', 'stocktake_adjustment', 'customer_delivery_dispatch'].includes(entry.entry_type) && entry.entry_type}
                      </span>
                    </td>
                    <td dir="ltr" style={{ textAlign: 'right', fontWeight: 'bold', color: entry.quantity > 0 ? '#0d9488' : '#e11d48' }}>
                      {entry.quantity > 0 ? `+${entry.quantity}` : entry.quantity}
                    </td>
                    <td><code>{entry.reference_doc_id || '—'}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn--secondary" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}
