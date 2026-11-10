import React from 'react';
import { ClassificationStatus } from './catalogApi';

interface Props {
  status: ClassificationStatus | string;
  className?: string;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; en: string; variant: 'confirmed' | 'suggested' | 'review' | 'na' }
> = {
  confirmed: {
    label: 'معتمد',
    en: 'Confirmed',
    variant: 'confirmed',
  },
  suggested: {
    label: 'مقترح',
    en: 'Suggested',
    variant: 'suggested',
  },
  needs_review: {
    label: 'قيد المراجعة',
    en: 'Needs Review',
    variant: 'review',
  },
  not_applicable: {
    label: 'غير خاضع',
    en: 'N/A',
    variant: 'na',
  },
};

export const ClassificationBadge: React.FC<Props> = ({ status, className = '' }) => {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    en: '',
    variant: 'review',
  };

  return (
    <span
      className={`catalog-badge catalog-badge--${config.variant} ${className}`.trim()}
      title={`${config.label} (${config.en})`}
    >
      <span className="catalog-badge__dot" aria-hidden />
      <span className="catalog-badge__label">{config.label}</span>
      {config.en && <span className="catalog-badge__sub">({config.en})</span>}
    </span>
  );
};

