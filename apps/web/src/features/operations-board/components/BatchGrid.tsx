import type { BatchRow } from '../mockData';

interface BatchGridProps {
  batches: BatchRow[];
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

export function BatchGrid({ batches }: BatchGridProps) {
  return (
    <article className="card">
      <div className="card__head">
        <div>
          <h2 className="card__title">الدفعات على خط الإنتاج</h2>
          <p className="card__sub">حالة التنفيذ والكميات المستهدفة للوردية الحالية</p>
        </div>
        <span className="live-dot">تحديث الوردية</span>
      </div>

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
                <span className="progress-meta__done">{b.doneCount} قطعة</span>
                <span>من {b.targetCount}</span>
              </div>
              <div className="progress-bar" role="progressbar" aria-valuenow={b.progressPercent} aria-valuemin={0} aria-valuemax={100}>
                <span
                  className={[
                    'progress-bar__fill',
                    b.progressVariant === 'amber' ? 'progress-bar__fill--amber' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ width: `${b.progressPercent}%` }}
                />
              </div>
            </div>

            {/* المشرف */}
            <div className="batch-owner">
              <span className="batch-owner__name">{b.supervisorName}</span>
              {b.supervisorRole}
            </div>

            {/* الحالة */}
            <span className={`badge ${STATUS_CLASS[b.status]}`}>
              {b.statusLabel}
            </span>
          </div>
        ))}
      </div>

      <div className="card__foot">
        <button className="card__foot-btn">عرض جميع الدفعات ←</button>
      </div>
    </article>
  );
}
