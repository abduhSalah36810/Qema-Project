import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { CatalogItem, fetchCatalogItems, fetchWarehouses, Warehouse } from '@/features/production/productionApi';
import { fetchStockBalances, fetchStockLedger, StockBalance, StockLedgerEntry } from './inventoryApi';

const MAIN_WAREHOUSE_CODE = 'main_raw_materials';

// أسماء أولية من الصور التي أرسلها المستخدم. لا تمثل أصنافًا معتمدة أو أرصدة مخزنية.
const PHOTO_NAME_DRAFT = [
  'مشابك', 'خيط', 'كباسين', 'قفل جلابية', 'تيكت', 'شريط سنان ترقيم',
  'لزق ص', 'لزق ألوان', 'لزق شفاف كبير', 'حزام رقبة', 'حزام وسط',
  'أساور 22', 'أساور 23', 'أساور 23 دوران', 'أساور 24', 'أساور 24 مشطورة',
  'أساور 25', 'أساور 25 مشطورة', 'أساور 26', 'أساور 26 مشطورة', 'أساور 27',
  'نص ياقة M', 'نص ياقة L', 'نص ياقة X (يحتاج تأكيد)', 'نص ياقة 2XL',
  'ياقة كاملة M', 'ياقة كاملة L', 'ياقة كاملة X', 'جيب 12', 'جيب 13',
  'جيب أولادي 8.5', 'جيب أولادي 9.5', 'جيب أولادي 11+',
  'ياقة أولادي 32', 'ياقة أولادي 34', 'ياقة أولادي 36', 'ياقة أولادي 38', 'ياقة أولادي 39',
  'رقبة بلاستيك', 'رقبة ورق', 'ضربيات أولادي', 'ضربيات رجالي',
  'باتليك صغير', 'باتليك أولادي', 'باتليك كبير أولادي', 'أكياس جلابية',
  'كرتون كبير', 'كرتون صغير', 'توب حشو', 'علبة القلم رجالي', 'علبة القلم أولادي',
  'مقص يدوي', 'ضهرية ورق (تحتاج تأكيد)', 'فصالات (اللفظ يحتاج تأكيد)',
  'متليك كيس (اللفظ يحتاج تأكيد)', 'متليك طويل 10ك (اللفظ يحتاج تأكيد)',
  'متليك كبير (اللفظ يحتاج تأكيد)', 'بكر ميتو (اللفظ يحتاج تأكيد)',
];

const MACHINE_SUPPLY_NAME_DRAFT = [
  'سكينة إبرة واحدة', 'كروشيه إبرة واحدة', 'بلاكة إبرة واحدة', 'سنان إبرة واحدة',
  'بلاكة تخريش 1/4 (تحتاج تأكيد)', 'كتشر إبرة واحدة', 'ريشة مقص إبرة واحد',
  'ضاغط دواسة إبرة واحدة', 'عيار إبرة واحدة', 'مسند إبرة واحدة',
  'كروشيه أوفر صغير', 'كروشيه أوفر كبير', 'كروشيه أوفر سلسلة (تحتاج تأكيد)',
  'إبرة أوفر 156', 'مكوك إبرة واحدة', 'ماكينة أوفر', 'سكينة إبرة واحدة تخريش',
  'حجارة', 'طقم أوفر', 'بلاكة تخريش 1/8 (تحتاج تأكيد)', 'كبس',
  'سنان إبرة تخريش 1/8', 'دواسة', 'أوفر إبرة', 'إبرة أوفر 12', 'سكينة مقص',
  'لقم ماكينة', 'ماتور', 'ملزمة (تحتاج تأكيد)', 'مازورة', 'مقص يدوي',
  'قلم أبيض', 'علبة مسن مقص',
];

const ITEM_TYPE_LABELS: Record<string, string> = {
  fabric: 'قماش وخامات',
  accessory: 'إكسسوارات',
  maintenance_supply: 'مستلزمات صيانة',
  reusable_tool: 'أدوات قابلة لإعادة الاستخدام',
  packaging: 'مواد تعبئة وتغليف',
  finished_garment: 'منتج تام',
};

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'يلزم تسجيل الدخول بحساب مخوّل لعرض أصناف المخزن الرئيسي.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'حسابك لا يملك صلاحية عرض بيانات المخازن.';
  }
  if (error instanceof Error) return error.message;
  return 'تعذر تحميل بيانات المخزن الرئيسي.';
}

export function MainWarehouseView() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [stock, setStock] = useState<StockBalance[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([fetchCatalogItems(), fetchWarehouses()])
      .then(async ([catalog, warehouses]) => {
        if (!active) return;
        const selectedWarehouse = warehouses.find((entry) => entry.code === MAIN_WAREHOUSE_CODE) ?? null;
        const balances = await fetchStockBalances(selectedWarehouse?.id);
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

  const itemTypes = useMemo(() => [...new Set(items.map((item) => item.item_type))].sort(), [items]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ar');
    return items.filter((item) => {
      const matchesSearch = !query || item.name_ar.toLocaleLowerCase('ar').includes(query) || item.code.toLocaleLowerCase('ar').includes(query);
      const matchesType = typeFilter === 'all' || item.item_type === typeFilter;
      return matchesSearch && matchesType;
    });
  }, [items, search, typeFilter]);

  return (
    <section className="warehouse-page" aria-labelledby="warehouse-title" dir="rtl">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة المخزون</span>
          <h2 id="warehouse-title">مخزن الخامات الرئيسي</h2>
          <p>{warehouse?.name_ar ?? 'عرض دليل الأصناف المعرّفة للمخزن الرئيسي'}</p>
        </div>
        <span className="warehouse-page__status">عرض الأصناف</span>
      </header>

      <div className="warehouse-notice" role="note">
        <strong>الرصيد مشتق من سجل الحركات.</strong>
        <span>يظهر الرصيد كغير مثبت إلى أن تسجل حركة افتتاحية أو حركة مخزنية. لم تُحمّل أرصدة فعلية من بيانات تجريبية.</span>
      </div>

      <div className="warehouse-summary" aria-label="ملخص دليل الأصناف">
        <article><span>أصناف الدليل</span><strong>{loading ? '—' : items.length}</strong></article>
        <article><span>أصناف نشطة</span><strong>{loading ? '—' : items.filter((item) => item.is_active).length}</strong></article>
        <article><span>نتائج العرض</span><strong>{loading ? '—' : visibleItems.length}</strong></article>
      </div>

      <div className="warehouse-toolbar">
        <label className="warehouse-search">
          <span>بحث عن صنف</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="الاسم أو كود الصنف" />
        </label>
        <label className="warehouse-filter">
          <span>نوع الصنف</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="all">كل الأنواع</option>
            {itemTypes.map((type) => <option key={type} value={type}>{ITEM_TYPE_LABELS[type] ?? type}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}
      {loading ? (
        <div className="warehouse-empty" role="status">جاري تحميل أصناف المخزن...</div>
      ) : error ? null : visibleItems.length === 0 ? (
        <div className="warehouse-empty">لا توجد أصناف مطابقة. قد تحتاج لإضافة الأصناف بعد استلام شيت المصنع.</div>
      ) : (
        <div className="warehouse-table-wrap">
          <table className="warehouse-table">
            <thead><tr><th>كود الصنف</th><th>اسم الصنف</th><th>التصنيف</th><th>الوحدة الأساسية</th><th>الصفة</th><th>الحالة</th><th>الرصيد</th><th>السجل</th></tr></thead>
            <tbody>
              {visibleItems.map((item) => <WarehouseItemRow key={item.id} item={item} warehouse={warehouse} stock={stock.find((entry) => entry.item_id === item.id && entry.warehouse_id === warehouse?.id)} />)}
            </tbody>
          </table>
        </div>
      )}

      <section className="warehouse-draft" aria-labelledby="warehouse-draft-title">
        <header>
          <div>
            <span className="warehouse-page__eyebrow">قائمة مؤقتة من الصور المرسلة</span>
            <h3 id="warehouse-draft-title">مسودة أسماء المستلزمات</h3>
          </div>
          <span className="warehouse-page__status">بانتظار شيت التفاصيل</span>
        </header>
        <p>الأسماء أدناه للتجهيز والمراجعة فقط؛ لم تُسجل كأصناف فعلية، ولا توجد لها أكواد أو وحدات أو أرصدة حتى يصل الشيت.</p>
        <div className="warehouse-draft__list">
          {PHOTO_NAME_DRAFT.map((name, index) => <span key={`${index}-${name}`}>{name}</span>)}
        </div>
      </section>

      <section className="warehouse-draft" aria-labelledby="machine-draft-title">
        <header>
          <div>
            <span className="warehouse-page__eyebrow">قائمة مؤقتة من صور مستلزمات المكن</span>
            <h3 id="machine-draft-title">مسودة مستلزمات المكن</h3>
          </div>
          <span className="warehouse-page__status">بانتظار شيت التفاصيل</span>
        </header>
        <p>نقلت الأسماء الظاهرة فقط. البنود المعلّمة تحتاج مراجعة؛ ولم أضف الأعداد أو الأسعار الظاهرة لأن رؤوس أعمدتها غير واضحة في الصور.</p>
        <div className="warehouse-draft__list">
          {MACHINE_SUPPLY_NAME_DRAFT.map((name, index) => <span key={`${index}-${name}`}>{name}</span>)}
        </div>
      </section>
    </section>
  );
}

function WarehouseItemRow({ item, warehouse, stock }: { item: CatalogItem; warehouse: Warehouse | null; stock?: StockBalance }) {
  const [entries, setEntries] = useState<StockLedgerEntry[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const loadHistory = async () => {
    if (entries !== null || !warehouse) return;
    try { setEntries(await fetchStockLedger(item.id, warehouse.id)); }
    catch { setHistoryError(true); setEntries([]); }
  };
  return (
    <tr>
      <td><code>{item.code}</code></td>
      <td><strong>{item.name_ar}</strong></td>
      <td>{ITEM_TYPE_LABELS[item.item_type] ?? item.item_type}</td>
      <td>{item.unit_name_ar || '—'}</td>
      <td>{item.is_consumable ? 'مستهلك' : 'قابل لإعادة الاستخدام'}</td>
      <td><span className={`warehouse-item-status${item.is_active ? '' : ' warehouse-item-status--inactive'}`}>{item.is_active ? 'نشط' : 'موقوف'}</span></td>
      <td>{stock?.is_established ? `${stock.balance} ${item.unit_name_ar}` : <span className="warehouse-balance-pending">غير مثبت</span>}</td>
      <td><button type="button" onClick={() => void loadHistory()}>عرض الحركة</button>{entries && <details open><summary>{historyError ? 'تعذر تحميل السجل' : `الحركات (${entries.length})`}</summary>{entries.map((entry) => <div key={entry.id}>{new Date(entry.created_at).toLocaleString('ar-EG')} · {entry.quantity > 0 ? '+' : ''}{entry.quantity} · {entry.reference_doc_id}</div>)}</details>}</td>
    </tr>
  );
}
