import { useCallback, useEffect, useState } from 'react';
import { fetchWarehouses, Warehouse } from '@/features/production/productionApi';
import { fetchStockBalances, StockBalance } from './inventoryApi';

const FINISHED_GOODS_CODE = 'finished_goods';

export function FinishedGoodsView() {
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const warehouses = await fetchWarehouses();
      const fgWarehouse = warehouses.find((w) => w.code === FINISHED_GOODS_CODE) ?? null;
      setWarehouse(fgWarehouse);

      if (fgWarehouse) {
        const stock = await fetchStockBalances(fgWarehouse.id);
        // فلترة الأرصدة التابعة لمستودع المنتج التام فقط
        setBalances(stock.filter((s) => s.warehouse_id === fgWarehouse.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات مخزن المنتجات التامة.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredBalances = balances.filter(
    (b) =>
      b.item_name_ar.toLowerCase().includes(search.toLowerCase()) ||
      b.item_code.toLowerCase().includes(search.toLowerCase())
  );

  const totalStockQuantity = balances.reduce((sum, b) => sum + (b.balance ?? 0), 0);
  const canonicalCount = balances.filter((b) => b.item_code.startsWith('FG-VAR-')).length;
  const legacyCount = balances.filter((b) => !b.item_code.startsWith('FG-VAR-')).length;

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="fg-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة مخزون الإنتاج الجاهز والتسليم</span>
          <h2 id="fg-title">مخزن المنتجات التامة</h2>
          <p>
            متابعة أرصدة الجلابيب التامة الموحدة بدفتر الأستاذ (Product + ProductVariant)، وجاهزيتها للتسليم للعملاء.
          </p>
        </div>
        <button className="btn btn--secondary" onClick={() => void loadData()} disabled={loading}>
          تحديث البيانات
        </button>
      </header>

      {/* شريط الإشعار المعماري للمرحلة الثانية */}
      <div
        className="warehouse-alert"
        style={{
          backgroundColor: '#f0fdfa',
          color: '#0f766e',
          borderColor: '#99f6e4',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
          <span>✓</span>
          <span>المعمارية المعتمدة: التكويد المعياري الموحد للمتغيرات (FG-VAR) وحظر الرصيد السالب</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.88rem', color: '#115e59', lineHeight: 1.5 }}>
          تم توحيد قيد الاستلام من الإنتاج وخصم تسليم العميل على الصنف المعياري الموحد (<code>FG-VAR-&#123;variant_id&#125;</code>)
          المستند لدفتر حركات المخزون <code>StockLedgerEntry</code>. لا يُسمح بتسجيل أي تسليم دون توفر رصيد معتمد في المخزن.
        </p>
      </div>

      {/* كروت المؤشرات الأساسية */}
      <div className="warehouse-summary">
        <article>
          <span>المستودع الفعلي</span>
          <strong>{warehouse?.name_ar || 'مخزن المنتجات التامة'}</strong>
          <small>كود: {warehouse?.code || FINISHED_GOODS_CODE}</small>
        </article>
        <article>
          <span>إجمالي القطع التامة المتاحة</span>
          <strong style={{ color: '#0f766e' }}>
            {totalStockQuantity.toLocaleString('ar-EG')} قطعة
          </strong>
          <small>مشتقة مباشرة من قيود الدفتر</small>
        </article>
        <article>
          <span>الأصناف المعيارية الموحدة</span>
          <strong style={{ color: '#0284c7' }}>{canonicalCount}</strong>
          <small>أصناف معتمدة بنمط FG-VAR</small>
        </article>
        {legacyCount > 0 && (
          <article style={{ borderColor: '#fde68a' }}>
            <span>أصناف موروثة غير معيارية</span>
            <strong style={{ color: '#d97706' }}>{legacyCount}</strong>
            <small>تتطلب تسوية أو ترحيل</small>
          </article>
        )}
      </div>

      {/* جدول الأرصدة الحالية */}
      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>أرصدة الأصناف التامة بالمستودع</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              الأرصدة مشتقة لحظيًا من قيود دفتر حركات المخزون (Stock Ledger Entries).
            </p>
          </div>
          <input
            type="search"
            placeholder="بحث بالكود أو الاسم..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: '0.45rem 0.85rem',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontSize: '0.88rem',
            }}
          />
        </div>

        {error && <div className="warehouse-alert" role="alert">{error}</div>}

        {loading ? (
          <p style={{ color: '#64748b' }}>جاري تحميل أرصدة المنتجات التامة...</p>
        ) : filteredBalances.length === 0 ? (
          <div
            style={{
              padding: '2rem',
              textAlign: 'center',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px dashed #cbd5e1',
            }}
          >
            <span style={{ fontSize: '2rem' }}>📦</span>
            <p style={{ margin: '0.5rem 0 0', fontWeight: 600, color: '#334155' }}>
              لا توجد أرصدة مخزنية مسجلة حالياً
            </p>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              عند استلام دفعة إنتاج منتهية في مخزن التام، ستظهر الأرصدة التراكمية هنا تلقائياً وفق الموديل والمقاس.
            </p>
          </div>
        ) : (
          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>كود الصنف</th>
                  <th>اسم المنتج التام والمقاس</th>
                  <th>نوع التكويد</th>
                  <th>وحدة القياس</th>
                  <th>الرصيد المتاح للبيع</th>
                  <th>حالة التوفر</th>
                </tr>
              </thead>
              <tbody>
                {filteredBalances.map((b) => {
                  const isCanonical = b.item_code.startsWith('FG-VAR-');
                  const currentBal = b.balance ?? 0;
                  return (
                    <tr key={`${b.warehouse_id}-${b.item_id}`}>
                      <td>
                        <code>{b.item_code}</code>
                      </td>
                      <td>
                        <strong>{b.item_name_ar}</strong>
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '0.15rem 0.5rem',
                            borderRadius: '4px',
                            backgroundColor: isCanonical ? '#dcfce7' : '#fef3c7',
                            color: isCanonical ? '#166534' : '#92400e',
                          }}
                        >
                          {isCanonical ? 'معياري موحد (FG-VAR)' : 'كود موروث قديم'}
                        </span>
                      </td>
                      <td>{b.unit_name_ar || 'قطعة'}</td>
                      <td>
                        <span
                          style={{
                            fontWeight: 700,
                            fontSize: '0.95rem',
                            color: currentBal > 0 ? '#0f766e' : '#dc2626',
                          }}
                        >
                          {b.balance !== null ? Number(b.balance).toLocaleString('ar-EG') : '—'}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: '0.8rem',
                            color: currentBal > 0 ? '#059669' : '#94a3b8',
                            fontWeight: 600,
                          }}
                        >
                          {currentBal > 0 ? '✓ متوفر للتسليم' : 'نفد المخزون'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
