import type { DeliveryRow } from '../mockData';

interface DeliveryListProps {
  deliveries: DeliveryRow[];
}

const STATUS_BADGE_CLASS: Record<DeliveryRow['status'], string> = {
  ready: '',
  preparing: 'badge--blue',
  production: 'badge--wait',
};

export function DeliveryList({ deliveries }: DeliveryListProps) {
  return (
    <article className="delivery-card">
      <div className="delivery-card__head">
        <div>
          <h2 className="card__title">التسليمات القادمة</h2>
          <p className="card__sub">الطلبات المستحقة خلال الأيام المقبلة</p>
        </div>
        <button className="delivery-card__link">كل الطلبات ←</button>
      </div>

      {deliveries.map((d) => (
        <div key={d.id} className="ship-row">
          <div>
            <div className="ship-row__name">{d.customerName}</div>
            <div className="ship-row__sub">
              {d.orderCode} · {d.itemsSummary}
            </div>
          </div>
          <div className="ship-row__time">{d.dueDate}</div>
          <span
            className={['badge', STATUS_BADGE_CLASS[d.status]]
              .filter(Boolean)
              .join(' ')}
          >
            {d.statusLabel}
          </span>
        </div>
      ))}
    </article>
  );
}
