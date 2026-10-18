import type { MetricCard } from '../mockData';

interface MetricCardsRowProps {
  metrics: MetricCard[];
}

export function MetricCardsRow({ metrics }: MetricCardsRowProps) {
  return (
    <section className="kpi-grid" aria-label="مؤشرات الوردية الرئيسية">
      {metrics.map((m) => (
        <article key={m.id} className="kpi-card">
          <div className="kpi-card__head">
            <span className="kpi-card__title">{m.title}</span>
            <span className="kpi-card__icon" aria-hidden>{m.icon}</span>
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
    </section>
  );
}
