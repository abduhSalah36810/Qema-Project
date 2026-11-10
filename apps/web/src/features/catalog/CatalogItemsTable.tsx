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
  canCreate?: boolean;
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
  canCreate = false,
}) => {
  const [searchInput, setSearchInput] = useState(filterParams.search || '');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

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

  // تحديد القيمة المجمعة الحالية (إما نوع أو تصنيف)
  const combinedFilterValue = filterParams.category_id && filterParams.category_id !== 'all'
    ? `cat:${filterParams.category_id}`
    : filterParams.item_type && filterParams.item_type !== 'all'
    ? `type:${filterParams.item_type}`
    : 'all';

  const handleCombinedFilterChange = (val: string) => {
    if (val === 'all') {
      onFilterChange({ category_id: 'all', item_type: 'all', offset: 0 });
    } else if (val.startsWith('type:')) {
      const typeKey = val.replace('type:', '');
      onFilterChange({ item_type: typeKey, category_id: 'all', offset: 0 });
    } else if (val.startsWith('cat:')) {
      const catId = val.replace('cat:', '');
      onFilterChange({ category_id: catId, item_type: 'all', offset: 0 });
    }
  };

  return (
    <div className="catalog-table-container">
      {/* شريط الأدوات والفلترة الموحد والمنظم */}
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
          {/* فلتر مدمج: التصنيف والنوع في قائمة واحدة منطقية */}
          <select
            value={combinedFilterValue}
            onChange={(e) => handleCombinedFilterChange(e.target.value)}
            className="catalog-filter-select"
            aria-label="تصفية حسب التصنيف أو النوع"
          >
            <option value="all">كل التصنيفات والأنواع</option>
            <optgroup label="── أنواع الأصناف الأساسية ──">
              {Object.entries(ITEM_TYPE_LABELS).map(([k, label]) => (
                <option key={`type:${k}`} value={`type:${k}`}>
                  {label}
                </option>
              ))}
            </optgroup>
            <optgroup label="── شجرة التصنيفات المعتمدة ──">
              {categories.map((c) => (
                <option key={`cat:${c.id}`} value={`cat:${c.id}`}>
                  {c.parent_id ? `↳ ${c.name_ar}` : `■ ${c.name_ar}`}
                </option>
              ))}
            </optgroup>
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

          {/* زر إظهار خيارات التدقيق والاعتماد المتقدمة */}
          <button
            type="button"
            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
            className="btn-secondary btn-sm"
            style={{ fontSize: '0.8rem', padding: '4px 8px' }}
            title="إظهار أو إخفاء فلاتر الاعتماد والمراجعة"
          >
            {showAdvancedFilters ? '▲ إخفاء الفلاتر المتقدمة' : '⚙️ خيارات متقدمة'}
          </button>

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

          {canCreate && (
            <button
              type="button"
              onClick={onOpenCreateModal}
              className="btn-teal"
            >
              ＋ إضافة صنف جديد
            </button>
          )}
        </div>
      </div>

      {/* صف الفلاتر المتقدمة (حالة الاعتماد والمراجعة) - يظهر فقط عند الحاجة لتقليل التشتت */}
      {showAdvancedFilters && (
        <div style={{ display: 'flex', gap: '0.75rem', padding: '0.5rem 0.75rem', background: '#f8fafc', borderRadius: '4px', marginBottom: '0.75rem', border: '1px solid #e2e8f0', alignItems: 'center', fontSize: '0.85rem' }}>
          <span style={{ color: '#64748b', fontWeight: 600 }}>فلاتر إضافية:</span>
          {/* فلتر حالة دورة الاعتماد */}
          <select
            value={filterParams.approval_status || 'all'}
            onChange={(e) =>
              onFilterChange({ approval_status: e.target.value, offset: 0 })
            }
            className="catalog-filter-select"
            aria-label="تصفية حسب حالة دورة الاعتماد"
            style={{ fontSize: '0.8rem' }}
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
            style={{ fontSize: '0.8rem' }}
          >
            <option value="all">كل حالات التصنيف</option>
            <option value="confirmed">تصنيف مؤكد (Confirmed)</option>
            <option value="suggested">تصنيف مقترح (Suggested)</option>
            <option value="needs_review">يحتاج مراجعة (Needs Review)</option>
            <option value="not_applicable">غير خاضع (N/A)</option>
          </select>
        </div>
      )}

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
                      {/* كود المنتج التام يُولَّد تلقائياً من معرف داخلي؛ لا يُعرض للمستخدم */}
                      {isFinishedGood ? <span className="catalog-table__muted">تلقائي</span> : <code className="catalog-table__code">{item.code}</code>}
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
                        {item.is_active && item.approval_status === 'approved' && item.item_type !== 'finished_garment' && !isFinishedGood && (
                          <span className="catalog-tag-bom" title="صنف معتمد نشط: يمكن اختياره في مستلزمات تصنيع الموديلات">
                            يصلح للمستلزمات
                          </span>
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

