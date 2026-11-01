import React, { useState } from 'react';
import {
  ItemCategory,
  ItemCategoryTree,
  ItemCategoryInput,
  createCategory,
  updateCategory,
  deleteCategory,
} from './catalogApi';
import { ApiError } from '@/lib/api';

interface Props {
  tree: ItemCategoryTree[];
  flatCategories: ItemCategory[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSelectCategoryFilter?: (categoryId: string) => void;
}

const SEEDED_CODES = new Set([
  'FABRICS_MAIN', 'GARMENT_COMPONENTS', 'SEWING_SUPPLIES', 'INTERLINING_REINFORCEMENT',
  'TRIMS_FASTENERS', 'CUTTING_SUPPLIES', 'FINISHING_PRESSING', 'PACKAGING_MATERIALS',
  'TOOLS_CONSUMABLES', 'MACHINERY_MAINTENANCE',
  'FAB_MAIN', 'FAB_CONTRAST', 'FAB_LINING', 'CMP_CUFFS', 'CMP_COLLARS_MANDARIN',
  'CMP_COLLARS_FULL', 'CMP_POCKETS', 'CMP_PLACKETS', 'SEW_THREAD_SEWING',
  'SEW_THREAD_OVERLOCK', 'SEW_THREAD_EMBROIDERY', 'INT_ROLLS', 'INT_PRECUT',
  'INT_STIFFENERS', 'TRM_BUTTONS', 'TRM_SNAPS', 'TRM_HOOKS', 'TRM_ZIPPERS',
  'TRM_CORDS_RIBBONS', 'CUT_NUMBERING', 'CUT_PAPER', 'CUT_MARKING',
  'FIN_IRONING_COVERS', 'FIN_CHEMICALS', 'PKG_BAGS', 'PKG_BOXES', 'PKG_CARTONS',
  'PKG_COLLAR_SUPPORTS', 'PKG_LABELS_TAGS', 'PKG_TAPES_TIES', 'TOL_CUTTING',
  'TOL_MEASURING', 'TOL_HAND_TOOLS', 'MNT_NEEDLES', 'MNT_HOOKS_LOOPERS',
  'MNT_KNIVES_BLADES', 'MNT_FEET_PLATES', 'MNT_LUBRICANTS', 'MNT_PARTS_ELECTRICAL',
]);

export const CategoriesExplorer: React.FC<Props> = ({
  tree,
  flatCategories,
  loading,
  error,
  onRefresh,
  onSelectCategoryFilter,
}) => {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ItemCategory | null>(null);
  const [parentForNew, setParentForNew] = useState<string | null>(null);

  // Form state
  const [formCode, setFormCode] = useState('');
  const [formNameAr, setFormNameAr] = useState('');
  const [formNameEn, setFormNameEn] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formParentId, setFormParentId] = useState<string>('');
  const [formSortOrder, setFormSortOrder] = useState<number>(0);
  const [formIsActive, setFormIsActive] = useState<boolean>(true);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedIds(new Set(flatCategories.map((c) => c.id)));
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  const openCreateModal = (parentId: string | null = null) => {
    setEditingCategory(null);
    setParentForNew(parentId);
    setFormCode('');
    setFormNameAr('');
    setFormNameEn('');
    setFormDescription('');
    setFormParentId(parentId || '');
    setFormSortOrder(0);
    setFormIsActive(true);
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (category: ItemCategory) => {
    setEditingCategory(category);
    setParentForNew(null);
    setFormCode(category.code);
    setFormNameAr(category.name_ar);
    setFormNameEn(category.name_en || '');
    setFormDescription(category.description || '');
    setFormParentId(category.parent_id || '');
    setFormSortOrder(category.sort_order || 0);
    setFormIsActive(category.is_active);
    setFormError(null);
    setModalOpen(true);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    setFeedbackMsg(null);

    try {
      if (editingCategory) {
        // Prevent cyclic parent assignment
        if (formParentId === editingCategory.id) {
          setFormError('لا يمكن للتصنيف أن يكون أباً لنفسه.');
          setSaving(false);
          return;
        }

        await updateCategory(editingCategory.id, {
          name_ar: formNameAr.trim(),
          name_en: formNameEn.trim() || null,
          description: formDescription.trim(),
          parent_id: formParentId || null,
          sort_order: Number(formSortOrder) || 0,
          is_active: formIsActive,
        });
        setFeedbackMsg(`تم تحديث التصنيف (${formNameAr}) بنجاح.`);
      } else {
        const cleanCode = formCode.trim().toUpperCase();
        if (!cleanCode) {
          setFormError('يرجى إدخال كود التصنيف.');
          setSaving(false);
          return;
        }

        const input: ItemCategoryInput = {
          code: cleanCode,
          name_ar: formNameAr.trim(),
          name_en: formNameEn.trim() || null,
          description: formDescription.trim(),
          parent_id: formParentId || null,
          sort_order: Number(formSortOrder) || 0,
          is_active: formIsActive,
        };
        await createCategory(input);
        setFeedbackMsg(`تم إنشاء التصنيف (${formNameAr}) بنجاح.`);
      }

      setModalOpen(false);
      onRefresh();
    } catch (err: unknown) {
      setFormError(err instanceof ApiError ? err.message : 'تعذر حفظ التصنيف.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (category: ItemCategory) => {
    setFeedbackMsg(null);
    try {
      await updateCategory(category.id, { is_active: !category.is_active });
      setFeedbackMsg(`تم ${category.is_active ? 'تعطيل' : 'تفعيل'} التصنيف (${category.name_ar}).`);
      onRefresh();
    } catch (err: unknown) {
      alert(err instanceof ApiError ? err.message : 'تعذر تغيير حالة تفعيل التصنيف.');
    }
  };

  const handleDeleteCategory = async (category: ItemCategory) => {
    if (SEEDED_CODES.has(category.code)) {
      alert('التصنيفات المعيارية الأساسية لا يمكن حذفها لضمان استقرار النظام. يمكنك تعطيلها بدلاً من ذلك.');
      return;
    }

    if (
      !window.confirm(
        `هل أنت متأكد من حذف التصنيف (${category.name_ar})؟ لن يُسمح بالحذف إذا كان مرتبطاً بأي أصناف أو تصنيفات فرعية.`
      )
    ) {
      return;
    }

    setFeedbackMsg(null);
    try {
      await deleteCategory(category.id);
      setFeedbackMsg(`تم حذف التصنيف (${category.name_ar}) بنجاح.`);
      onRefresh();
    } catch (err: unknown) {
      alert(err instanceof ApiError ? err.message : 'تعذر حذف التصنيف.');
    }
  };

  return (
    <div className="categories-explorer">
      {/* رأس المستكشف وشريط الإجراءات */}
      <div className="categories-explorer__toolbar">
        <div>
          <h3 className="categories-explorer__title">شجرة التصنيفات الهرمية</h3>
          <p className="categories-explorer__subtitle">
            تنظيم متكامل للمواد والخامات والمستلزمات في فئات رئيسية وفرعية تدعم جميع خطوط الإنتاج.
          </p>
        </div>

        <div className="categories-explorer__actions">
          <button
            type="button"
            onClick={expandAll}
            className="btn-secondary btn-sm"
            title="توسيع كل الفروع"
          >
            ⤢ توسيع الكل
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="btn-secondary btn-sm"
            title="طي كل الفروع"
          >
            ⤡ طي الكل
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="btn-secondary btn-sm"
          >
            ↻ تحديث
          </button>
          <button
            type="button"
            onClick={() => openCreateModal(null)}
            className="btn-teal btn-sm"
          >
            ＋ إضافة تصنيف رئيسي
          </button>
        </div>
      </div>

      {feedbackMsg && (
        <div className="catalog-alert catalog-alert--success" role="status">
          <span className="catalog-alert__icon" aria-hidden>✓</span>
          <div className="catalog-alert__text">{feedbackMsg}</div>
        </div>
      )}

      {error && (
        <div className="catalog-alert catalog-alert--error" role="alert">
          <span className="catalog-alert__icon" aria-hidden>⚠️</span>
          <div className="catalog-alert__text">{error}</div>
        </div>
      )}

      {/* محتوى الشجرة الهرمية */}
      {loading ? (
        <div className="catalog-table__state" role="status">
          <div className="catalog-spinner" aria-hidden />
          <p>جاري تحميل شجرة التصنيفات...</p>
        </div>
      ) : tree.length === 0 ? (
        <div className="catalog-table__state catalog-table__state--empty">
          <p>لم يتم العثور على أي تصنيفات مسجلة في النظام.</p>
        </div>
      ) : (
        <div className="categories-tree">
          {tree.map((root) => {
            const isExpanded = expandedIds.has(root.id);
            const isSeeded = SEEDED_CODES.has(root.code);
            const hasChildren = root.subcategories && root.subcategories.length > 0;

            return (
              <div
                key={root.id}
                className={`tree-node tree-node--root ${
                  root.is_active ? '' : 'tree-node--inactive'
                }`}
              >
                <div className="tree-node__content">
                  <div className="tree-node__start">
                    {hasChildren ? (
                      <button
                        type="button"
                        onClick={() => toggleExpand(root.id)}
                        className="tree-node__toggle"
                        aria-label={isExpanded ? 'طي التصنيف' : 'توسيع التصنيف'}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                    ) : (
                      <span className="tree-node__leaf-dot" aria-hidden />
                    )}

                    <div className="tree-node__info">
                      <div className="tree-node__headline">
                        <strong className="tree-node__name">{root.name_ar}</strong>
                        {root.name_en && (
                          <span className="tree-node__name-en">({root.name_en})</span>
                        )}
                        <code className="tree-node__code">{root.code}</code>
                        {isSeeded && (
                          <span className="tree-node__pill-seeded" title="تصنيف معياري أساسي">
                            معياري
                          </span>
                        )}
                        {!root.is_active && (
                          <span className="catalog-tag-inactive">معطل</span>
                        )}
                      </div>
                      {root.description && (
                        <p className="tree-node__desc">{root.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="tree-node__actions">
                    {hasChildren && (
                      <span className="tree-node__count">
                        {root.subcategories.length} فئات فرعية
                      </span>
                    )}

                    {onSelectCategoryFilter && (
                      <button
                        type="button"
                        onClick={() => onSelectCategoryFilter(root.id)}
                        className="btn-link btn-sm"
                        title="عرض الأصناف التابعة لهذا التصنيف"
                      >
                        عرض الأصناف
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => openCreateModal(root.id)}
                      className="btn-secondary btn-sm"
                      title="إضافة تصنيف فرعي داخل هذه الفئة"
                    >
                      ＋ فرعي
                    </button>

                    <button
                      type="button"
                      onClick={() => openEditModal(root)}
                      className="btn-secondary btn-sm"
                      title="تعديل بيانات التصنيف"
                    >
                      تعديل
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleToggleActive(root)}
                      className="btn-secondary btn-sm"
                      title={root.is_active ? 'تعطيل التصنيف' : 'تفعيل التصنيف'}
                    >
                      {root.is_active ? 'تعطيل' : 'تفعيل'}
                    </button>

                    {!isSeeded && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteCategory(root)}
                        className="btn-danger btn-sm"
                        title="حذف التصنيف المخصص"
                      >
                        حذف
                      </button>
                    )}
                  </div>
                </div>

                {/* التصنيفات الفرعية (Nested Subcategories) */}
                {hasChildren && isExpanded && (
                  <div className="tree-node__children">
                    {root.subcategories.map((sub) => {
                      const isSubSeeded = SEEDED_CODES.has(sub.code);

                      return (
                        <div
                          key={sub.id}
                          className={`tree-node tree-node--sub ${
                            sub.is_active ? '' : 'tree-node--inactive'
                          }`}
                        >
                          <div className="tree-node__content">
                            <div className="tree-node__start">
                              <span className="tree-node__leaf-dot" aria-hidden />
                              <div className="tree-node__info">
                                <div className="tree-node__headline">
                                  <strong className="tree-node__name">
                                    {sub.name_ar}
                                  </strong>
                                  {sub.name_en && (
                                    <span className="tree-node__name-en">
                                      ({sub.name_en})
                                    </span>
                                  )}
                                  <code className="tree-node__code">{sub.code}</code>
                                  {isSubSeeded && (
                                    <span
                                      className="tree-node__pill-seeded"
                                      title="تصنيف معياري"
                                    >
                                      معياري
                                    </span>
                                  )}
                                  {!sub.is_active && (
                                    <span className="catalog-tag-inactive">معطل</span>
                                  )}
                                </div>
                                {sub.description && (
                                  <p className="tree-node__desc">{sub.description}</p>
                                )}
                              </div>
                            </div>

                            <div className="tree-node__actions">
                              {onSelectCategoryFilter && (
                                <button
                                  type="button"
                                  onClick={() => onSelectCategoryFilter(sub.id)}
                                  className="btn-link btn-sm"
                                  title="عرض الأصناف التابعة لهذا التصنيف"
                                >
                                  عرض الأصناف
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => openEditModal(sub)}
                                className="btn-secondary btn-sm"
                              >
                                تعديل
                              </button>

                              <button
                                type="button"
                                onClick={() => void handleToggleActive(sub)}
                                className="btn-secondary btn-sm"
                              >
                                {sub.is_active ? 'تعطيل' : 'تفعيل'}
                              </button>

                              {!isSubSeeded && (
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteCategory(sub)}
                                  className="btn-danger btn-sm"
                                >
                                  حذف
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* نافذة إنشاء / تعديل تصنيف */}
      {modalOpen && (
        <div className="drawer-backdrop" onClick={() => setModalOpen(false)}>
          <div
            className="modal-box modal-box--medium"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
          >
            <header className="modal-box__header">
              <div>
                <span className="modal-box__eyebrow">إدارة شجرة التصنيفات</span>
                <h3 className="modal-box__title">
                  {editingCategory
                    ? `تعديل التصنيف: ${editingCategory.name_ar}`
                    : parentForNew
                    ? 'إضافة تصنيف فرعي جديد'
                    : 'إضافة تصنيف رئيسي جديد'}
                </h3>
              </div>
              <button
                type="button"
                className="drawer-close-btn"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </button>
            </header>

            <form onSubmit={handleSaveCategory} className="modal-box__body">
              {formError && (
                <div className="catalog-alert catalog-alert--error" role="alert">
                  <span className="catalog-alert__icon" aria-hidden>⚠️</span>
                  <div className="catalog-alert__text">{formError}</div>
                </div>
              )}

              <div className="drawer-row">
                <label className="drawer-field">
                  <span className="drawer-field__label">كود التصنيف (Code) *</span>
                  <input
                    type="text"
                    required
                    disabled={!!editingCategory}
                    placeholder="مثال: FAB_SILK أو CMP_COLLARS"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value)}
                    className={`drawer-input ${
                      editingCategory ? 'drawer-input--readonly' : ''
                    }`}
                    dir="ltr"
                  />
                  {editingCategory && (
                    <span className="drawer-field__help">كود التصنيف لا يتغير لضمان استقرار الربط.</span>
                  )}
                </label>

                <label className="drawer-field">
                  <span className="drawer-field__label">الاسم بالعربية *</span>
                  <input
                    type="text"
                    required
                    placeholder="مثال: أقمشة الحرير الطبيعي والصناعي"
                    value={formNameAr}
                    onChange={(e) => setFormNameAr(e.target.value)}
                    className="drawer-input"
                  />
                </label>
              </div>

              <div className="drawer-row">
                <label className="drawer-field">
                  <span className="drawer-field__label">الاسم بالإنجليزية (اختياري)</span>
                  <input
                    type="text"
                    placeholder="مثال: Silk Fabrics"
                    value={formNameEn}
                    onChange={(e) => setFormNameEn(e.target.value)}
                    className="drawer-input"
                    dir="ltr"
                  />
                </label>

                <label className="drawer-field">
                  <span className="drawer-field__label">التصنيف الأب (Parent)</span>
                  <select
                    value={formParentId}
                    onChange={(e) => setFormParentId(e.target.value)}
                    className="drawer-select"
                  >
                    <option value="">— تصنيف رئيسي (Root) بدون أب —</option>
                    {flatCategories
                      .filter((c) => !editingCategory || c.id !== editingCategory.id)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.parent_id ? `↳ ${c.name_ar}` : `■ ${c.name_ar}`} ({c.code})
                        </option>
                      ))}
                  </select>
                </label>
              </div>

              <label className="drawer-field">
                <span className="drawer-field__label">الوصف التفصيلي</span>
                <textarea
                  rows={2}
                  placeholder="وصف طبيعة المواد أو المكونات التابعة لهذا التصنيف..."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="drawer-input drawer-input--textarea"
                />
              </label>

              <div className="drawer-row">
                <label className="drawer-field">
                  <span className="drawer-field__label">ترتيب العرض (Sort Order)</span>
                  <input
                    type="number"
                    value={formSortOrder}
                    onChange={(e) => setFormSortOrder(parseInt(e.target.value, 10) || 0)}
                    className="drawer-input"
                  />
                </label>

                <div className="drawer-row--checks" style={{ marginTop: '1.6rem' }}>
                  <label className="drawer-checkbox">
                    <input
                      type="checkbox"
                      checked={formIsActive}
                      onChange={(e) => setFormIsActive(e.target.checked)}
                    />
                    <span>تصنيف نشط ومتاح للاستخدام</span>
                  </label>
                </div>
              </div>

              <footer className="modal-box__footer">
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-teal"
                >
                  {saving ? 'جاري الحفظ...' : editingCategory ? 'حفظ التعديلات' : '＋ إضافة التصنيف'}
                </button>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                  className="btn-secondary"
                >
                  إلغاء
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

