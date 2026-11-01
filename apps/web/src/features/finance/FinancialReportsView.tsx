import { useEffect, useState } from 'react';
import { reportsApi, SummaryReport } from '@/features/reports/reportsApi';

export function FinancialReportsView() {
  const [summary, setSummary] = useState<SummaryReport | null>(null);
  const [period, setPeriod] = useState<string>('monthly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await reportsApi.getSummary(period);
      setSummary(data);
      setError('');
    } catch {
      setError('تعذر تحميل بيانات التقارير المالية. تحقق من الصلاحيات والاتصال.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [period]);

  const treasury = summary?.treasury;
  const payables = summary?.payables;

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="fin-reports-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">التحليل والمتابعة المالية</span>
          <h2 id="fin-reports-title">التقارير المالية ومؤشرات الأداء</h2>
          <p>
            لوحة مؤشرات السيولة، التدفقات النقدية التشغيلية، ومستحقات الموردين خلال الفترة المحددة.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontSize: '0.88rem',
            }}
          >
            <option value="weekly">أسبوعي</option>
            <option value="monthly">شهري</option>
            <option value="quarterly">ربع سنوي</option>
            <option value="yearly">سنوي</option>
          </select>
          <button className="btn btn--secondary" onClick={() => void load()}>
            تحديث
          </button>
        </div>
      </header>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}

      {/* تنبيه شفاف لمنع ازدواجية الحساب وعزل التحويلات */}
      <div
        className="warehouse-alert"
        style={{
          backgroundColor: '#eff6ff',
          color: '#1e40af',
          borderColor: '#bfdbfe',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.3rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600 }}>
          <span>📊</span>
          <span>قواعد احتساب المؤشرات المالية التشغيلية</span>
        </div>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#1e3a8a', lineHeight: 1.5 }}>
          تعتمد التقارير أدناه على دفاتر الأستاذ النقدية المعتمدة (Cash Ledger). يتم استبعاد التحويلات الداخلية
          (بين الخزنة والعهد) من إجمالي الإيرادات والمصروفات منعاً لتضخيم التدفق النقدي، ولا يتم احتساب مصروف العهدة مرتين.
        </p>
      </div>

      {loading ? (
        <p style={{ marginTop: '1rem', color: '#64748b' }}>جاري إعداد التقرير المالي…</p>
      ) : summary ? (
        <>
          {/* كروت السيولة والتدفق النقدي */}
          <div className="warehouse-summary" style={{ marginTop: '1.25rem' }}>
            <article>
              <span>رصيد الخزينة الفعلي</span>
              <strong style={{ color: '#0f766e' }}>
                {(treasury?.balance ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
              </strong>
              <small>نقدية متاحة بالخزنة الرئيسية</small>
            </article>

            <article>
              <span>إجمالي أرصدة العهد</span>
              <strong style={{ color: '#0284c7' }}>
                {(treasury?.petty_cash_total ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
              </strong>
              <small>سيولة موزعة على صناديق العهد</small>
            </article>

            <article>
              <span>المقبوضات التشغيلية للفترة</span>
              <strong style={{ color: '#16a34a' }}>
                +{(treasury?.revenues_period ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
              </strong>
              <small>تحصيلات وإيرادات نقدية معتمدة</small>
            </article>

            <article>
              <span>المدفوعات التشغيلية للفترة</span>
              <strong style={{ color: '#dc2626' }}>
                -{(treasury?.expenses_period ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
              </strong>
              <small>سدادات موردين ورواتب ومصروفات</small>
            </article>

            <article>
              <span>صافي التدفق النقدي للفترة</span>
              <strong
                style={{
                  color: (treasury?.net_period ?? 0) >= 0 ? '#16a34a' : '#dc2626',
                }}
              >
                {(treasury?.net_period ?? 0) >= 0 ? '+' : ''}
                {(treasury?.net_period ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
              </strong>
              <small>الفارق بين المقبوضات والمدفوعات</small>
            </article>

            <article>
              <span>مستحقات الموردين غير المسددة</span>
              <strong style={{ color: '#ea580c' }}>
                {(payables?.supplier_payables ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
              </strong>
              <small>أرصدة فواتير خامات مستحقة</small>
            </article>
          </div>

          {/* تفاصيل المتابعة المالية */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: '1rem',
              marginTop: '1.5rem',
            }}
          >
            <section className="warehouse-draft">
              <h3>ملخص التدفق النقدي والسيولة</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#64748b' }}>إجمالي السيولة النقدية المتاحة (خزنة + عهد):</span>
                  <strong>{((treasury?.balance ?? 0) + (treasury?.petty_cash_total ?? 0)).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#64748b' }}>مقبوضات الفترة ({period}):</span>
                  <span style={{ color: '#16a34a', fontWeight: 600 }}>+{(treasury?.revenues_period ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#64748b' }}>مدفوعات الفترة ({period}):</span>
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>-{(treasury?.expenses_period ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0' }}>
                  <span style={{ fontWeight: 600 }}>صافي حركة الخزينة:</span>
                  <span
                    style={{
                      fontWeight: 700,
                      color: (treasury?.net_period ?? 0) >= 0 ? '#16a34a' : '#dc2626',
                    }}
                  >
                    {(treasury?.net_period ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                  </span>
                </div>
              </div>
            </section>

            <section className="warehouse-draft">
              <h3>الالتزامات والذمم التشغيلية</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#64748b' }}>مستحقات فواتير الموردين المفتوحة:</span>
                  <strong style={{ color: '#ea580c' }}>{(payables?.supplier_payables ?? 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
                  <span style={{ color: '#64748b' }}>تاريخ توليد التقرير:</span>
                  <span>{new Date(summary.generated_at).toLocaleString('ar-EG')}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0' }}>
                  <span style={{ color: '#64748b' }}>نطاق الفترة الزمنية:</span>
                  <span style={{ fontWeight: 600 }}>{period === 'monthly' ? 'شهري' : period === 'weekly' ? 'أسبوعي' : period === 'yearly' ? 'سنوي' : 'ربع سنوي'}</span>
                </div>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}

