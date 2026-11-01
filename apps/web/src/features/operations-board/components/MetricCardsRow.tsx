import type { MetricCard } from '../mockData';

interface MetricCardsRowProps {
  metrics: MetricCard[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  sectionTitle?: string;
}

export function MetricCardsRow({
  metrics,
  loading = false,
  error = null,
  onRetry,
  sectionTitle,
}: MetricCardsRowProps) {
  if (error) {
    return (
      <section style={{ marginBottom: '1.25rem' }} aria-label="خطأ تحميل المؤشرات">
        {sectionTitle && (
          <h3 style={{ fontSize: '0.95rem', color: '#475569', marginBottom: '0.5rem', fontWeight: 600 }}>
            {sectionTitle}
          </h3>
        )}
        <div
          className="warehouse-alert"
          role="alert"
          style={{
            backgroundColor: '#fff7f7',
            borderColor: '#f0c4c4',
            color: '#9b3333',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '1rem 1.25rem',
            borderRadius: '10px',
            textAlign: 'right',
          }}
        >
          <div>
            <strong>⚠️ تعذر تحميل المؤشرات الحية:</strong> {error}
            <div style={{ fontSize: '0.8rem', color: '#7f1d1d', marginTop: '0.2rem' }}>
              لا يتم عرض بيانات تجريبية بديلة للحفاظ على مصداقية الأرقام التشغيلية.
            </div>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: '0.4rem 0.85rem',
                borderRadius: '6px',
                border: '1px solid #9b3333',
                background: '#ffffff',
                color: '#9b3333',
                fontWeight: 600,
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              ↻ إعادة المحاولة
            </button>
          )}
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section style={{ marginBottom: '1.25rem' }} aria-label="تحميل المؤشرات">
        {sectionTitle && (
          <h3 style={{ fontSize: '0.95rem', color: '#475569', marginBottom: '0.5rem', fontWeight: 600 }}>
            {sectionTitle}
          </h3>
        )}
        <div className="kpi-grid">
          {[1, 2, 3, 4].map((i) => (
            <article key={i} className="kpi-card" style={{ opacity: 0.7 }}>
              <div
                style={{
                  height: '14px',
                  background: '#e2e8f0',
                  borderRadius: '4px',
                  width: '55%',
                  marginBottom: '14px',
                }}
              />
              <div
                style={{
                  height: '28px',
                  background: '#cbd5e1',
                  borderRadius: '6px',
                  width: '45%',
                  marginBottom: '10px',
                }}
              />
              <div
                style={{
                  height: '12px',
                  background: '#e2e8f0',
                  borderRadius: '4px',
                  width: '75%',
                }}
              />
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section style={{ marginBottom: '1.25rem' }} aria-label={sectionTitle || 'المؤشرات الرئيسية'}>
      {sectionTitle && (
        <h3 style={{ fontSize: '0.95rem', color: '#475569', marginBottom: '0.5rem', fontWeight: 600 }}>
          {sectionTitle}
        </h3>
      )}
      <div className="kpi-grid" aria-label="مؤشرات الوردية الرئيسية">
        {metrics.map((m) => (
          <article key={m.id} className="kpi-card">
            <div className="kpi-card__head">
              <span className="kpi-card__title">{m.title}</span>
              <span className="kpi-card__icon" aria-hidden>
                {m.icon}
              </span>
            </div>
            <div className="kpi-card__value">{m.value}</div>
            <div className="kpi-card__foot">
              <span className="kpi-card__sub">{m.sub}</span>
              {m.badge && (
                <span className={`kpi-card__badge kpi-card__badge--${m.badgeVariant || 'info'}`}>
                  {m.badge}
                </span>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
