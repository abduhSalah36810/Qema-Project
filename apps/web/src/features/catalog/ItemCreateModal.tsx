import React, { useState } from 'react';
import {
  CatalogItemCreateInput,
  ClassificationStatus,
  ItemCategory,
  Unit,
  ApplicationLine,
  createCatalogItem,
} from './catalogApi';
import { ApiError } from '@/lib/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onItemCreated: () => void;
  categories: ItemCategory[];
  units: Unit[];
  applicationLines: ApplicationLine[];
}

const ITEM_TYPES: Array<{ value: string; label: string }> = [
  { value: 'fabric', label: 'أقمشة وخامات أساسية ومساعدة (Fabric)' },
  { value: 'accessory', label: 'إكسسوارات ومستلزمات خياطة (Accessory)' },
  { value: 'maintenance_supply', label: 'قطع غيار ومستلزمات صيانة (Maintenance Supply)' },
  { value: 'reusable_tool', label: 'أدوات ومعدات تشغيل قابلة لإعادة الاستخدام (Reusable Tool)' },
  { value: 'packaging', label: 'مواد تعبئة وتغليف وشحن (Packaging)' },
];

export const ItemCreateModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onItemCreated,
  categories,
  units,
  applicationLines,
}) => {
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [itemType, setItemType] = useState('fabric');
  const [unitId, setUnitId] = useState(units[0]?.id || '');

  React.useEffect(() => {
    if (!unitId && units.length > 0) {
      setUnitId(units[0].id);
    }
  }, [units, unitId]);
  const [categoryId, setCategoryId] = useState('');
  const [classificationStatus, setClassificationStatus] =
    useState<ClassificationStatus>('needs_review');
  const [reorderLevel, setReorderLevel] = useState<number>(0);
  const [isConsumable, setIsConsumable] = useState(true);
  const [isActive, setIsActive] = useState(true);

  // Dimensions
  const [widthCm, setWidthCm] = useState('');
  const [weightGsm, setWeightGsm] = useState('');
  const [lengthCm, setLengthCm] = useState('');
  const [diameterMm, setDiameterMm] = useState('');

  // Selected applications
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanCode = code.trim().toUpperCase();
    if (!cleanCode) {
      setError('يرجى إدخال كود الصنف.');
      return;
    }

    if (cleanCode.startsWith('FG-VAR-') || cleanCode.startsWith('FG-')) {
      setError('لا يُسمح بإنشاء منتجات تامة (FG-*) من هذه الواجهة. أصناف المنتجات التامة تنشأ تلقائياً عند تعريف الموديلات والمقاسات.');
      return;
    }

    if (!nameAr.trim()) {
      setError('يرجى إدخال اسم الصنف بالعربية.');
      return;
    }

    if (!unitId) {
      setError('يرجى اختيار وحدة القياس الأساسية.');
      return;
    }

    const attributes: Record<string, unknown> = {};
    if (widthCm.trim()) attributes.width_cm = parseFloat(widthCm);
    if (weightGsm.trim()) attributes.weight_gsm = parseFloat(weightGsm);
    if (lengthCm.trim()) attributes.length_cm = parseFloat(lengthCm);
    if (diameterMm.trim()) attributes.diameter_mm = parseFloat(diameterMm);

    const payload: CatalogItemCreateInput = {
      code: cleanCode,
      name_ar: nameAr.trim(),
      item_type: itemType,
      unit_id: unitId,
      category_id: categoryId || null,
      classification_status: classificationStatus,
      attributes,
      reorder_level: Math.max(0, Number(reorderLevel) || 0),
      is_consumable: isConsumable,
      is_active: isActive,
      application_line_ids: selectedAppIds.length > 0 ? selectedAppIds : undefined,
    };

    setSaving(true);
    try {
      await createCatalogItem(payload);
      onItemCreated();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر إضافة الصنف إلى الدليل.');
    } finally {
      setSaving(false);
    }
  };

  const toggleApplication = (appId: string) => {
    setSelectedAppIds((prev) =>
      prev.includes(appId) ? prev.filter((id) => id !== appId) : [...prev, appId]
    );
  };

  return (
    <div className="drawer-backdrop" onClick={onClose} aria-modal="true" role="dialog">
      <div
        className="modal-box modal-box--large"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <header className="modal-box__header">
          <div>
            <span className="modal-box__eyebrow">إدارة دليل الخامات والمستلزمات</span>
            <h2 className="modal-box__title">إضافة صنف جديد للدليل</h2>
          </div>
          <button
            type="button"
            className="drawer-close-btn"
            onClick={onClose}
            aria-label="إلغاء وإغلاق النافذة"
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} className="modal-box__body">
          {error && (
            <div className="catalog-alert catalog-alert--error" role="alert">
              <span className="catalog-alert__icon" aria-hidden>⚠️</span>
              <div className="catalog-alert__text">{error}</div>
            </div>
          )}

          <div className="drawer-section">
            <legend className="drawer-section__legend">البيانات الأساسية</legend>

            <div className="drawer-row">
              <label className="drawer-field">
                <span className="drawer-field__label">كود الصنف (فريد بالإنجليزية) *</span>
                <input
                  type="text"
                  required
                  placeholder="مثال: FAB-COTTON-01 أو TRM-BTN-18"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="drawer-input"
                  dir="ltr"
                />
              </label>

              <label className="drawer-field">
                <span className="drawer-field__label">اسم الصنف بالعربية *</span>
                <input
                  type="text"
                  required
                  placeholder="مثال: قماش قطن مصري 100% أو زرار صدف 18مم"
                  value={nameAr}
                  onChange={(e) => setNameAr(e.target.value)}
                  className="drawer-input"
                />
              </label>
            </div>

            <div className="drawer-row">
              <label className="drawer-field">
                <span className="drawer-field__label">نوع الصنف التشغيلي *</span>
                <select
                  value={itemType}
                  onChange={(e) => setItemType(e.target.value)}
                  className="drawer-select"
                >
                  {ITEM_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="drawer-field">
                <span className="drawer-field__label">الوحدة الأساسية *</span>
                <select
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  required
                  className="drawer-select"
                >
                  <option value="">— اختر وحدة القياس —</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name_ar} ({u.code})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="drawer-row">
              <label className="drawer-field">
                <span className="drawer-field__label">التصنيف الهرمي (Category)</span>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="drawer-select"
                >
                  <option value="">— بدون تصنيف محدد (غير مصنف) —</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.parent_id ? `↳ ${c.name_ar}` : `■ ${c.name_ar}`} ({c.code})
                    </option>
                  ))}
                </select>
              </label>

              <label className="drawer-field">
                <span className="drawer-field__label">حالة المراجعة والتوثيق</span>
                <select
                  value={classificationStatus}
                  onChange={(e) =>
                    setClassificationStatus(e.target.value as ClassificationStatus)
                  }
                  className="drawer-select"
                >
                  <option value="needs_review">قيد المراجعة (Needs Review)</option>
                  <option value="suggested">مقترح بالدليل (Suggested)</option>
                  <option value="confirmed">معتمد وموثق (Confirmed)</option>
                </select>
              </label>
            </div>

            <div className="drawer-row drawer-row--checks">
              <label className="drawer-checkbox">
                <input
                  type="checkbox"
                  checked={isConsumable}
                  onChange={(e) => setIsConsumable(e.target.checked)}
                />
                <span>صنف مستهلك في التشغيل (Consumable)</span>
              </label>

              <label className="drawer-checkbox">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                <span>تفعيل الصنف فوراً في العمليات</span>
              </label>
            </div>
          </div>

          <div className="drawer-section">
            <legend className="drawer-section__legend">حد إعادة الطلب والمواصفات</legend>

            <div className="drawer-row">
              <label className="drawer-field">
                <span className="drawer-field__label">حد إعادة الطلب (Reorder Level)</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={reorderLevel}
                  onChange={(e) => setReorderLevel(parseFloat(e.target.value) || 0)}
                  className="drawer-input"
                />
                <span className="drawer-field__help">
                  0 يعني عدم إطلاق تنبيه عند انخفاض الرصيد
                </span>
              </label>
            </div>

            <div className="drawer-grid-4">
              <label className="drawer-field">
                <span className="drawer-field__label">العرض (سم)</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="150"
                  value={widthCm}
                  onChange={(e) => setWidthCm(e.target.value)}
                  className="drawer-input"
                />
              </label>

              <label className="drawer-field">
                <span className="drawer-field__label">الوزن (جرام/م²)</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="180"
                  value={weightGsm}
                  onChange={(e) => setWeightGsm(e.target.value)}
                  className="drawer-input"
                />
              </label>

              <label className="drawer-field">
                <span className="drawer-field__label">الطول (سم)</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="50"
                  value={lengthCm}
                  onChange={(e) => setLengthCm(e.target.value)}
                  className="drawer-input"
                />
              </label>

              <label className="drawer-field">
                <span className="drawer-field__label">القطر (مم)</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="14"
                  value={diameterMm}
                  onChange={(e) => setDiameterMm(e.target.value)}
                  className="drawer-input"
                />
              </label>
            </div>
          </div>

          <div className="drawer-section">
            <legend className="drawer-section__legend">خطوط الاستخدام وتطبيقات الملابس</legend>
            <p className="drawer-section__desc">
              حدد خطوط الملابس المناسبة لهذا الصنف (اختياري، وسوم تنظيمية للمصنع):
            </p>

            <div className="modal-apps-grid">
              {applicationLines.map((line) => {
                const checked = selectedAppIds.includes(line.id);
                return (
                  <label
                    key={line.id}
                    className={`modal-app-card ${
                      checked ? 'modal-app-card--selected' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleApplication(line.id)}
                    />
                    <div className="modal-app-card__info">
                      <strong>{line.name_ar}</strong>
                      <code>{line.code}</code>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          <footer className="modal-box__footer">
            <button
              type="submit"
              disabled={saving}
              className="btn-teal"
            >
              {saving ? 'جاري الإضافة...' : '＋ إضافة الصنف للدليل'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="btn-secondary"
            >
              إلغاء
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
