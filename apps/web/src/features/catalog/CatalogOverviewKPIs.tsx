import React from 'react';

interface Props {
  totalItems: number;
  approvedCount?: number;
  pendingReviewCount?: number;
  draftsCount?: number;
  openRevisionsCount?: number;
  confirmedCount?: number;
  needsReviewCount?: number;
  activeCategoriesCount: number;
  loading?: boolean;
  onFilterApproval?: (status: string) => void;
}

export const CatalogOverviewKPIs: React.FC<Props> = ({
  totalItems,
  approvedCount,
  pendingReviewCount,
  draftsCount,
  openRevisionsCount,
  confirmedCount,
  needsReviewCount,
  activeCategoriesCount,
  loading = false,
  onFilterApproval,
}) => {
  const displayApproved = approvedCount ?? confirmedCount ?? 0;
  const displayPending = pendingReviewCount ?? needsReviewCount ?? 0;
  const displayDrafts = draftsCount ?? 0;
  const displayRevisions = openRevisionsCount ?? 0;

  return (
    <div className="catalog-kpis" aria-label="مؤشرات أداء دليل الأصناف والحوكمة">
      <article
        className="catalog-kpi-card"
        onClick={() => onFilterApproval && onFilterApproval('all')}
        role={onFilterApproval ? 'button' : undefined}
        tabIndex={onFilterApproval ? 0 : undefined}
      >
        <div className="catalog-kpi-card__header">
          <span className="catalog-kpi-card__title">إجمالي أصناف الدليل</span>
          <span className="catalog-kpi-card__icon" aria-hidden>📦</span>
        </div>
        <div className="catalog-kpi-card__value">
          {loading ? '—' : totalItems.toLocaleString('ar-EG')}
        </div>
        <div className="catalog-kpi-card__hint">تشمل كافة الخامات والمستلزمات والمنتجات التامة</div>
      </article>

      <article
        className="catalog-kpi-card catalog-kpi-card--confirmed"
        onClick={() => onFilterApproval && onFilterApproval('approved')}
        role={onFilterApproval ? 'button' : undefined}
        tabIndex={onFilterApproval ? 0 : undefined}
      >
        <div className="catalog-kpi-card__header">
          <span className="catalog-kpi-card__title">أصناف معتمدة للتشغيل</span>
          <span className="catalog-kpi-card__icon" aria-hidden>✅</span>
        </div>
        <div className="catalog-kpi-card__value">
          {loading ? '—' : displayApproved.toLocaleString('ar-EG')}
        </div>
        <div className="catalog-kpi-card__hint">أصناف مفعلة جاهزة للاستخدام في الإنتاج والمشتريات</div>
      </article>

      <article
        className={`catalog-kpi-card catalog-kpi-card--review ${displayPending > 0 ? 'catalog-kpi-card--pulse' : ''}`}
        onClick={() => onFilterApproval && onFilterApproval('pending_review')}
        role={onFilterApproval ? 'button' : undefined}
        tabIndex={onFilterApproval ? 0 : undefined}
      >
        <div className="catalog-kpi-card__header">
          <span className="catalog-kpi-card__title">بانتظار الاعتماد</span>
          <span className="catalog-kpi-card__icon" aria-hidden>⏳</span>
        </div>
        <div className="catalog-kpi-card__value">
          {loading ? '—' : displayPending.toLocaleString('ar-EG')}
        </div>
        <div className="catalog-kpi-card__hint">أصناف قدمت للمراجعة وتتطلب اعتماد الإدارة</div>
      </article>

      <article
        className="catalog-kpi-card catalog-kpi-card--draft"
        onClick={() => onFilterApproval && onFilterApproval('draft')}
        role={onFilterApproval ? 'button' : undefined}
        tabIndex={onFilterApproval ? 0 : undefined}
      >
        <div className="catalog-kpi-card__header">
          <span className="catalog-kpi-card__title">مسودات ومرفوضات</span>
          <span className="catalog-kpi-card__icon" aria-hidden>📝</span>
        </div>
        <div className="catalog-kpi-card__value">
          {loading ? '—' : displayDrafts.toLocaleString('ar-EG')}
        </div>
        <div className="catalog-kpi-card__hint">أصناف قيد التجهيز أو تتطلب استكمال النواقص</div>
      </article>

      {displayRevisions > 0 && (
        <article
          className="catalog-kpi-card catalog-kpi-card--revision"
          role="region"
        >
          <div className="catalog-kpi-card__header">
            <span className="catalog-kpi-card__title">طلبات تعديل مفتوحة</span>
            <span className="catalog-kpi-card__icon" aria-hidden>🔄</span>
          </div>
          <div className="catalog-kpi-card__value">
            {loading ? '—' : displayRevisions.toLocaleString('ar-EG')}
          </div>
          <div className="catalog-kpi-card__hint">تعديلات مقترحة على أصناف معتمدة بانتظار الموافقة</div>
        </article>
      )}

      <article className="catalog-kpi-card catalog-kpi-card--categories">
        <div className="catalog-kpi-card__header">
          <span className="catalog-kpi-card__title">التصنيفات النشطة</span>
          <span className="catalog-kpi-card__icon" aria-hidden>🗂️</span>
        </div>
        <div className="catalog-kpi-card__value">
          {loading ? '—' : activeCategoriesCount.toLocaleString('ar-EG')}
        </div>
        <div className="catalog-kpi-card__hint">شجرة الفئات الرئيسية والفرعية الجاهزة للاستخدام</div>
      </article>
    </div>
  );
};

