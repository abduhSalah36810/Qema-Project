import type { BatchRow } from '../mockData';

interface BatchGridProps {
  batches: BatchRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  isDemo?: boolean;
}

const STATUS_CLASS: Record<BatchRow['status'], string> = {
  active: '',
  wait: 'badge--wait',
  late: 'badge--late',
};

const DOT_CLASS: Record<string, string> = {
  sand: 'batch-dot--sand',
  olive: 'batch-dot--olive',
  teal: 'batch-dot--teal',
};

export function BatchGrid({
  batches,
  loading = false,
  error = null,
  onRetry,
  isDemo = false,
}: BatchGridProps) {
  return (
    <article className="card">
      <div className="card__head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <h2 className="card__title">الدفعات على خط الإنتاج</h2>
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
          <p className="card__sub">حالة التنفيذ والكميات المستهدفة للوردية الحالية</p>
        </div>
        <span className="live-dot">{loading ? 'جاري الفحص...' : 'تحديث الوردية'}</span>
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
            <strong>⚠️ تعذر استرجاع أوامر التشغيل:</strong> {error}
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
          <p>جاري استرجاع أوامر التشغيل وحالة المراحل...</p>
        </div>
      ) : batches.length === 0 ? (
        <div className="warehouse-empty" style={{ margin: '1rem', border: '1px dashed #cbd5e1' }}>
          لا توجد دفعات تشغيل نشطة على خط الإنتاج حالياً. يمكنك بدء دفعة جديدة من الزر العلوي.
        </div>
      ) : (
        <div className="batch-list" role="list">
          {batches.map((b) => (
            <div key={b.id} className="batch-row" role="listitem">
              {/* الكود والاسم */}
              <div>
                <div className="batch-row__id">
                  {b.batchCode} &nbsp;·&nbsp; {b.line}
                </div>
                <div className="batch-row__name">
                  <span
                    className={[
                      'batch-dot',
                      b.dotColor ? DOT_CLASS[b.dotColor] : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-hidden
                  />
                  {b.productName}
                </div>
              </div>

              {/* شريط التقدم */}
              <div className="progress-wrap">
                <div className="progress-meta">
                  <span className="progress-meta__done">
                    {b.doneCount.toLocaleString('ar-EG')} قطعة
                  </span>
                  <span>من {b.targetCount.toLocaleString('ar-EG')}</span>
                </div>
                <div
                  className="progress-bar"
                  role="progressbar"
                  aria-valuenow={b.progressPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span
                    className={[
                      'progress-bar__fill',
                      b.progressVariant === 'amber' ? 'progress-bar__fill--amber' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{ width: `${Math.min(100, Math.max(0, b.progressPercent))}%` }}
                  />
                </div>
              </div>

              {/* المشرف والحالة */}
              <div className="batch-row__tail">
                <div>
                  <div className="batch-row__sup-name">{b.supervisorName}</div>
                  <div className="batch-row__sup-role">{b.supervisorRole}</div>
                </div>
                <span
                  className={['badge', STATUS_CLASS[b.status]]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {b.statusLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
