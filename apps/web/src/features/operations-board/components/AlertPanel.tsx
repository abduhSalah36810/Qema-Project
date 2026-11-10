import type { AlertItem } from '../mockData';

interface AlertPanelProps {
  title: string;
  subtitle: string;
  items: AlertItem[];
  count?: number;
  showAction?: boolean;
  actionLabel?: string;
  emptyMessage?: string;
  onActionClick?: () => void;
}

const ICON_CLASS: Record<AlertItem['iconVariant'], string> = {
  red:   '',
  amber: 'alert-icon--amber',
  green: 'alert-icon--green',
  blue:  'alert-icon--blue',
};

const VALUE_CLASS: Record<string, string> = {
  amber: 'alert-item__value--amber',
  muted: 'alert-item__value--muted',
};

export function AlertPanel({
  title,
  subtitle,
  items,
  count,
  showAction = false,
  actionLabel = 'مراجعة التنبيهات ←',
  emptyMessage = 'لا توجد تنبيهات مسجلة حالياً.',
  onActionClick,
}: AlertPanelProps) {
  return (
    <article className="side-panel">
      <div className="side-panel__head">
        <div>
          <h2 className="card__title">{title}</h2>
          <p className="card__sub">{subtitle}</p>
        </div>
        {count !== undefined && (
          <small className="side-panel__count">{count} عناصر</small>
        )}
      </div>

      {items.length === 0 ? (
        <div
          style={{
            padding: '1.25rem 1rem',
            textAlign: 'center',
            backgroundColor: '#f8fafc',
            borderRadius: '8px',
            border: '1px dashed #cbd5e1',
            color: '#64748b',
            fontSize: '0.86rem',
            margin: '0.75rem 0',
          }}
        >
          {emptyMessage}
        </div>
      ) : (
        <div className="alert-list" role="list">
          {items.map((item) => (
            <div key={item.id} className="alert-item" role="listitem">
              <div className={`alert-icon ${ICON_CLASS[item.iconVariant]}`} aria-hidden>
                {item.iconChar}
              </div>
              <div>
                <div className="alert-item__title">{item.title}</div>
                <div className="alert-item__sub">{item.subtitle}</div>
              </div>
              <div
                className={[
                  'alert-item__value',
                  item.valueVariant ? VALUE_CLASS[item.valueVariant] : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAction && items.length > 0 && (
        <button
          type="button"
          className="side-panel__action"
          onClick={onActionClick}
        >
          {actionLabel}
        </button>
      )}
    </article>
  );
}
