import React from 'react';
import { ApprovalStatus } from './catalogApi';

interface Props {
  status: ApprovalStatus | string;
  hasPendingRevision?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; en: string; variant: 'draft' | 'pending' | 'approved' | 'rejected' }
> = {
  draft: {
    label: 'مسودة',
    en: 'Draft',
    variant: 'draft',
  },
  pending_review: {
    label: 'قيد الاعتماد',
    en: 'Pending Review',
    variant: 'pending',
  },
  approved: {
    label: 'معتمد',
    en: 'Approved',
    variant: 'approved',
  },
  rejected: {
    label: 'مرفوض',
    en: 'Rejected',
    variant: 'rejected',
  },
};

export const ApprovalStatusBadge: React.FC<Props> = ({
  status,
  hasPendingRevision = false,
  className = '',
}) => {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    en: '',
    variant: 'draft',
  };

  return (
    <span className={`approval-badge-group ${className}`.trim()}>
      <span
        className={`approval-badge approval-badge--${config.variant}`}
        title={`حالة الاعتماد: ${config.label} (${config.en})`}
      >
        <span className="approval-badge__dot" aria-hidden />
        <span className="approval-badge__label">{config.label}</span>
      </span>

      {hasPendingRevision && (
        <span
          className="approval-badge approval-badge--revision"
          title="توجد مراجعة تعديل مفتوحة بانتظار الاعتماد"
        >
          <span className="approval-badge__dot" aria-hidden />
          <span className="approval-badge__label">طلب تعديل</span>
        </span>
      )}
    </span>
  );
};

