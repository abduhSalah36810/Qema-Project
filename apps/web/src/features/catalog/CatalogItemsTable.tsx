import React, { useState } from 'react';
import {
  CatalogFilterParams,
  CatalogItem,
  ItemCategory,
  Unit,
} from './catalogApi';
import { ClassificationBadge } from './ClassificationBadge';
import { ApprovalStatusBadge } from './ApprovalStatusBadge';

interface Props {
  items: CatalogItem[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelectItem: (id: string) => void;
  onOpenCreateModal: () => void;
  categories: ItemCategory[];
  units: Unit[];
  filterParams: CatalogFilterParams;
  onFilterChange: (newParams: Partial<CatalogFilterParams>) => void;
  onResetFilters: () => void;
  pageSize: number;
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  fabric: 'أقمشة وخامات',
  accessory: 'إكسسوارات وحليات',
  maintenance_supply: 'مستلزمات صيانة',
  reusable_tool: 'أدوات تشغيل',
  packaging: 'مواد تعبئة وتغليف',
  finished_garment: 'منتج تام مصنّع',
};

export const CatalogItemsTable: React.FC<Props> = ({
  items,
  loading,
  error,
  onRefresh,
  onSelectItem,
  onOpenCreateModal,
  categories,
  units,
  filterParams,
  onFilterChange,
  onResetFilters,
  pageSize,
}) => {
  const [searchInput, setSearchInput] = useState(filterParams.search || '');

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onFilterChange({ search: searchInput, offset: 0 });
  };

  const handleReset = () => {
    setSearchInput('');
    onResetFilters();
  };

  const currentOffset = filterParams.offset || 0;
  const hasNextPage = items.length === pageSize;
  const hasPrevPage = currentOffset > 0;

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  return (
    <div className="catalog-table-container">
      {/* شريط الأدوات والفلترة المتقدمة */}
      <div className="catalog-toolbar">
        <form onSubmit={handleSearchSubmit} className="catalog-toolbar__search">
          <input
            type="text"
            placeholder="ابحث بكود الصنف أو اسمه بالعربية..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="catalog-search-input"
          />
          <button type="submit" className="btn-secondary catalog-search-btn">
            بحث
          </button>
        </form>

        <div className="catalog-toolbar__filters">
          {/* فلتر التصنيف */}
          <select
            value={filterParams.category_id || 'all'}
            onChange={(e) => onFilterChange({ category_id: e.target.value, offset: 0 })}
            className="catalog-filter-select"
            aria-label="تصفية حسب التصنيف"
          >
            <option value="all">كل التصنيفات</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parent_id ? `↳ ${c.name_ar}` : `■ ${c.name_ar}`}
              </option>
            ))}
          </select>

          {/* فلتر نوع الصنف */}
          <select
            value={filterParams.item_type || 'all'}
            onChange={(e) => onFilterChange({ item_type: e.target.value, offset: 0 })}
            className="catalog-filter-select"
            aria-label="تصفية حسب نوع الصنف"
          >
            <option value="all">كل الأنواع</option>
            {Object.entries(ITEM_TYPE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>

          {/* فلتر حالة دورة الاعتماد */}
          <select
            value={filterParams.approval_status || 'all'}
            onChange={(e) =>
              onFilterChange({ approval_status: e.target.value, offset: 0 })
            }
            className="catalog-filter-select"
            aria-label="تصفية حسب حالة دورة الاعتماد"
          >
            <option value="all">كل حالات الاعتماد</option>
            <option value="approved">معتمد للتشغيل (Approved)</option>
            <option value="pending_review">قيد الاعتماد (Pending Review)</option>
            <option value="draft">مسودة (Draft)</option>
            <option value="rejected">مرفوض (Rejected)</option>
          </select>

          {/* فلتر حالة المراجعة */}
          <select
            value={filterParams.classification_status || 'all'}
            onChange={(e) =>
              onFilterChange({ classification_status: e.target.value, offset: 0 })
            }
            className="catalog-filter-select"
            aria-label="تصفية حسب حالة التصنيف"
          >
            <option value="all">كل حالات التصنيف</option>
            <option value="confirmed">تصنيف مؤكد (Confirmed)</option>
            <option value="suggested">تصنيف مقترح (Suggested)</option>
            <option value="needs_review">يحتاج مراجعة (Needs Review)</option>
            <option value="not_applicable">غير خاضع (N/A)</option>
          </select>

          {/* فلتر الوحدة */}
          <select
            value={filterParams.unit_id || 'all'}
            onChange={(e) => onFilterChange({ unit_id: e.target.value, offset: 0 })}
            className="catalog-filter-select"
            aria-label="تصفية حسب الوحدة"
          >
            <option value="all">كل الوحدات</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name_ar}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={handleReset}
            className="btn-link catalog-toolbar__reset"
            title="إعادة ضبط جميع الفلاتر"
          >
            إعادة ضبط
          </button>
        </div>

        <div className="catalog-toolbar__actions">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="btn-secondary"
            title="تحديث قائمة الأصناف"
          >
            ↻ تحديث
          </button>

          <button
            type="button"
            onClick={onOpenCreateModal}
            className="btn-teal"
          >
            ＋ إضافة صنف جديد
          </button>
        </div>
      </div>

      {/* رسالة الخطأ إن وجدت */}
      {error && (
        <div className="catalog-alert catalog-alert--error" role="alert">
          <span className="catalog-alert__icon" aria-hidden>⚠️</span>
          <div className="catalog-alert__text">{error}</div>
          <button type="button" onClick={onRefresh} className="btn-secondary btn-sm">
            إعادة المحاولة
          </button>
        </div>
      )}

      {/* محتوى الجدول وحالات التحميل والفراغ */}
      {loading ? (
        <div className="catalog-table__state" role="status">
          <div className="catalog-spinner" aria-hidden />
          <p>جاري تحميل أصناف الدليل من الخادم...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="catalog-table__state catalog-table__state--empty">
          <span className="catalog-table__empty-icon" aria-hidden>🔍</span>
          <h3>لا توجد أصناف مطابقة لمعايير البحث الحالية</h3>
          <p>جرّب تعديل مصطلح البحث، أو تفريغ الفلاتر، أو إضافة أصناف جديدة للدليل.</p>
          <button type="button" onClick={handleReset} className="btn-secondary">
            تفريغ الفلاتر
          </button>
        </div>
      ) : (
        <div className="catalog-table-wrap">
          <table className="catalog-table" aria-label="جدول أصناف الدليل">
            <thead>
              <tr>
                <th scope="col" style={{ width: '130px' }}>كود الصنف</th>
                <th scope="col">اسم الصنف</th>
                <th scope="col">التصنيف الهرمي</th>
                <th scope="col">نوع الصنف</th>
                <th scope="col" style={{ width: '80px' }}>الوحدة</th>
                <th scope="col" style={{ width: '130px' }}>حالة الاعتماد</th>
                <th scope="col" style={{ width: '120px' }}>جودة التصنيف</th>
                <th scope="col" style={{ width: '90px' }}>حد الطلب</th>
                <th scope="col" style={{ width: '100px', textAlign: 'center' }}>الإجراء</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const category = item.category_id ? categoryMap.get(item.category_id) : null;
                const isFinishedGood = item.code.startsWith('FG-VAR-');

                return (
                  <tr
                    key={item.id}
                    className={item.is_active ? '' : 'catalog-table__row--inactive'}
                  >
                    <td>
                      <code className="catalog-table__code">{item.code}</code>
                    </td>
                    <td>
                      <div className="catalog-table__name-cell">
                        <strong className="catalog-table__name">{item.name_ar}</strong>
                        {isFinishedGood && (
                          <span className="catalog-tag-fg" title="منتج تام مصنّع">
                            منتج تام
                          </span>
                        )}
                        {!item.is_active && (
                          <span className="catalog-tag-inactive">معطل</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {category ? (
                        <div className="catalog-table__cat">
                          <span>{category.name_ar}</span>
                          <code className="catalog-table__subcode">{category.code}</code>
                        </div>
                      ) : (
                        <span className="catalog-table__muted">— غير مصنف —</span>
                      )}
                    </td>
                    <td>
                      <span className="catalog-table__type">
                        {ITEM_TYPE_LABELS[item.item_type] ?? item.item_type}
                      </span>
                    </td>
                    <td>{item.unit_name_ar || '—'}</td>
                    <td>
                      <ApprovalStatusBadge
                        status={item.approval_status}
                        hasPendingRevision={item.has_pending_revision}
                      />
                    </td>
                    <td>
                      <ClassificationBadge status={item.classification_status} />
                    </td>
                    <td>
                      {item.reorder_level > 0 ? (
                        <span className="catalog-table__reorder" title="حد إعادة الطلب الفعّال">
                          {item.reorder_level} {item.unit_name_ar || ''}
                        </span>
                      ) : (
                        <span className="catalog-table__muted">غير مفعّل</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={() => onSelectItem(item.id)}
                        className="btn-secondary btn-sm"
                        title="عرض وتعديل بطاقة الصنف"
                      >
                        عرض وتعديل
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* شريط التنقل بين الصفحات (Pagination) */}
      <footer className="catalog-pagination">
        <div className="catalog-pagination__info">
          عرض الصفحة الحالية · عدد النتائج المعروضة: <strong>{items.length}</strong> صنف
        </div>

        <div className="catalog-pagination__controls">
          <button
            type="button"
            disabled={!hasPrevPage || loading}
            onClick={() =>
              onFilterChange({ offset: Math.max(0, currentOffset - pageSize) })
            }
            className="btn-secondary btn-sm"
          >
            ← الصفحة السابقة
          </button>

          <span className="catalog-pagination__page">
            صفحة {Math.floor(currentOffset / pageSize) + 1}
          </span>

          <button
            type="button"
            disabled={!hasNextPage || loading}
            onClick={() => onFilterChange({ offset: currentOffset + pageSize })}
            className="btn-secondary btn-sm"
          >
            الصفحة التالية →
          </button>
        </div>
      </footer>
    </div>
  );
};

