import React from 'react';
import { ApplicationLine } from './catalogApi';

interface Props {
  lines: ApplicationLine[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelectLineFilter?: (lineId: string) => void;
}

const LINE_ICONS: Record<string, string> = {
  GENERAL: '🌐',
  JALABIYA: '👔',
  MOROCCAN_JALABIYA: '✨',
  SHERWAL: '👖',
  THOBE_ARABI: '👑',
  BOYS_CLOTHING: '🧒',
};

export const ApplicationLinesView: React.FC<Props> = ({
  lines,
  loading,
  error,
  onRefresh,
  onSelectLineFilter,
}) => {
  return (
    <div className="app-lines-view">
      <div className="categories-explorer__toolbar">
        <div>
          <h3 className="categories-explorer__title">خطوط الاستخدام وتطبيقات الملابس</h3>
          <p className="categories-explorer__subtitle">
            خطوط إنتاج المصنع المعتمدة لتصنيف ووسم المواد والخامات حسب الموديلات المستهدفة.
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="btn-secondary btn-sm"
        >
          ↻ تحديث
        </button>
      </div>

      {/* تنبيه نطاق العمل وقواعد الأعمال */}
      <div className="catalog-alert catalog-alert--info" role="note">
        <span className="catalog-alert__icon" aria-hidden>ℹ️</span>
        <div className="catalog-alert__text">
          <strong>إرشاد تشغيلي وتنظيمي:</strong> وسوم خطوط الاستخدام (Application Usages) هي بيانات تنظيمية لتسهيل تصفية الخامات والمستلزمات داخل المصنع، وليست بديلة عن قوالب الإنتاج (Templates) أو شجرة المواد (BOM)، ولا تؤثر على تكاليف الإنتاج أو أرصدة المخزون.
        </div>
      </div>

      {error && (
        <div className="catalog-alert catalog-alert--error" role="alert">
          <span className="catalog-alert__icon" aria-hidden>⚠️</span>
          <div className="catalog-alert__text">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="catalog-table__state" role="status">
          <div className="catalog-spinner" aria-hidden />
          <p>جاري تحميل خطوط الاستخدام...</p>
        </div>
      ) : (
        <div className="app-lines-grid">
          {lines.map((line) => {
            const icon = LINE_ICONS[line.code] || '🧵';

            return (
              <article key={line.id} className="app-line-card">
                <div className="app-line-card__top">
                  <span className="app-line-card__icon" aria-hidden>
                    {icon}
                  </span>
                  <div className="app-line-card__title-wrap">
                    <h4 className="app-line-card__title">{line.name_ar}</h4>
                    {line.name_en && (
                      <span className="app-line-card__sub">{line.name_en}</span>
                    )}
                  </div>
                  <code className="app-line-card__code">{line.code}</code>
                </div>

                <p className="app-line-card__desc">
                  {line.description || 'خط معتمد لإنتاج وتجميع خامات هذا النوع من الملابس.'}
                </p>

                <div className="app-line-card__footer">
                  <span className="catalog-pill catalog-pill--active">
                    {line.is_active ? 'نشط بالتشغيل' : 'موقوف'}
                  </span>

                  {onSelectLineFilter && (
                    <button
                      type="button"
                      onClick={() => onSelectLineFilter(line.id)}
                      className="btn-secondary btn-sm"
                      title="تصفية دليل الأصناف لعرض خامات هذا الخط"
                    >
                      تصفية الأصناف المرتبطة
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

