import { useEffect, useState } from 'react';
import { CatalogItem, fetchCatalogItems } from '@/features/production/productionApi';

export function MachineryView() {
  const [maintenanceSupplies, setMaintenanceSupplies] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchCatalogItems()
      .then((items) => {
        if (!active) return;
        const supplies = items.filter(
          (item) => item.item_type === 'maintenance_supply' || item.item_type === 'reusable_tool'
        );
        setMaintenanceSupplies(supplies);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'تعذر تحميل مستلزمات الصيانة المسجلة.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="machinery-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة الأصول التشغيلية والمعدات</span>
          <h2 id="machinery-title">الماكينات ومعدات التشغيل</h2>
          <p>
            متابعة الحالة التشغيلية لخطوط الماكينات، جدولة الصيانة الدورية، وصرف قطع الغيار.
          </p>
        </div>
      </header>

      {/* شريط حالة المرحلة والشفافية التشغيلية */}
      <div
        className="warehouse-alert"
        style={{
          backgroundColor: '#eff6ff',
          color: '#1e40af',
          borderColor: '#bfdbfe',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
          <span>ℹ️</span>
          <span>حالة الوحدة: قيد التطوير الهيكلي (المرحلة الرابعة)</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.88rem', color: '#1e3a8a', lineHeight: 1.5 }}>
          تم تصميم الهيكل المعماري والنموذج التشغيلي لجدول الماكينات <code>machines</code> وسجلات الصيانة <code>machine_maintenance_records</code>.
          وفقاً لقواعد المشروع، سيتم تفعيل هذه الجداول عبر <strong>Migration 0010</strong> في المرحلة الرابعة بعد اعتماد واجهات المرحلة الأولى.
          البيانات المعروضة أدناه هي مستلزمات وقطع غيار الصيانة الفعلية المسجلة حالياً في دليل المخازن.
        </p>
      </div>

      {/* بطاقات محاور إدارة الماكينات المعتمدة */}
      <div className="warehouse-summary">
        <article>
          <span>بطاقات الماكينات المخططة</span>
          <strong>كود، نوع، وقسم التشغيل</strong>
          <small>مقصات، ماكينات خياطة، أوفر، كبس، وسناين</small>
        </article>
        <article>
          <span>سجلات الصيانة التشغيلية</span>
          <strong>صيانة دورية وطارئة</strong>
          <small>توثيق الفني، تاريخ الصيانة، وساعات التوقف</small>
        </article>
        <article>
          <span>صرف قطع الغيار</span>
          <strong>مرتبط بمخزن الخامات</strong>
          <small>حركة مخزنية موثقة لكل طلب صيانة</small>
        </article>
        <article>
          <span>تكاليف الصيانة النقدية</span>
          <strong>مستند صرف وحيد بالخزنة</strong>
          <small>منع تكرار القيد أو ازدواجية المصروف</small>
        </article>
      </div>

      {/* عرض قطع الغيار ومستلزمات الصيانة الفعلية في الكتالوج */}
      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>قطع الغيار ومستلزمات الصيانة في دليل المخزن</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              أصناف مسجلة فعلياً في قاعدة البيانات سيتم استخدامها في تذاكر الصيانة الدورية.
            </p>
          </div>
          <span
            style={{
              fontSize: '0.8rem',
              backgroundColor: '#e2e8f0',
              padding: '0.25rem 0.65rem',
              borderRadius: '999px',
              fontWeight: 600,
            }}
          >
            {maintenanceSupplies.length} صنف مسجل
          </span>
        </div>

        {error && <div className="warehouse-alert" role="alert">{error}</div>}

        {loading ? (
          <p style={{ color: '#64748b' }}>جاري تحميل مستلزمات الصيانة...</p>
        ) : maintenanceSupplies.length === 0 ? (
          <p style={{ color: '#64748b' }}>لا توجد أصناف صيانة مسجلة حالياً في دليل المخزن.</p>
        ) : (
          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>كود الصنف</th>
                  <th>اسم الصنف</th>
                  <th>التصنيف</th>
                  <th>وحدة القياس</th>
                  <th>الحالة في الدليل</th>
                </tr>
              </thead>
              <tbody>
                {maintenanceSupplies.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <code>{item.code}</code>
                    </td>
                    <td>
                      <strong>{item.name_ar}</strong>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.78rem',
                          padding: '0.15rem 0.5rem',
                          borderRadius: '4px',
                          backgroundColor: item.item_type === 'maintenance_supply' ? '#fef3c7' : '#e0e7ff',
                          color: item.item_type === 'maintenance_supply' ? '#92400e' : '#3730a3',
                        }}
                      >
                        {item.item_type === 'maintenance_supply' ? 'مستلزم صيانة' : 'أداة قابلة للاستخدام'}
                      </span>
                    </td>
                    <td>{item.unit_name_ar || '—'}</td>
                    <td>
                      <span style={{ color: item.is_active ? '#059669' : '#94a3b8' }}>
                        {item.is_active ? 'نشط' : 'معطل'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

