import type { DeliveryRow } from '../mockData';

interface DeliveryListProps {
  deliveries: DeliveryRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  isDemo?: boolean;
}

const STATUS_BADGE_CLASS: Record<DeliveryRow['status'], string> = {
  ready: '',
  preparing: 'badge--blue',
  production: 'badge--wait',
};

export function DeliveryList({
  deliveries,
  loading = false,
  error = null,
  onRetry,
  isDemo = false,
}: DeliveryListProps) {
  return (
    <article className="delivery-card">
      <div className="delivery-card__head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <h2 className="card__title">التسليمات والطلبات القادمة</h2>
            {isDemo && (
              <span
                style={{
                  fontSize: '0.72rem',
                  backgroundColor: '#fef3c7',
                  color: '#92400e',
                  border: '1px solid #fde68a',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '999px',
                  fontWeight: 600,
                }}
              >
                معاينة بصرية تجريبية
              </span>
            )}
          </div>
          <p className="card__sub">مواعيد تسليم طلبيات العملاء المستحقة</p>
        </div>
      </div>

      {error ? (
        <div
          className="warehouse-alert"
          role="alert"
          style={{
            margin: '1rem',
            backgroundColor: '#fff7f7',
            borderColor: '#f0c4c4',
            color: '#9b3333',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            textAlign: 'right',
          }}
        >
          <div>
            <strong>⚠️ تعذر استرجاع التسليمات:</strong> {error}
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: '0.35rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid #9b3333',
                background: '#ffffff',
                color: '#9b3333',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ↻ إعادة المحاولة
            </button>
          )}
        </div>
      ) : loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>⏳</div>
          <p>جاري استرجاع مواعيد التسليم والطلبات...</p>
        </div>
      ) : deliveries.length === 0 ? (
        <div className="warehouse-empty" style={{ margin: '1rem', border: '1px dashed #cbd5e1' }}>
          لا توجد تسليمات قادمة مستحقة خلال الأيام المقبلة.
        </div>
      ) : (
        deliveries.map((d) => (
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
        ))
      )}
    </article>
  );
}
