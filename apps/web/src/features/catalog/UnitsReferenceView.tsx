import React, { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useDialog } from '@/components/feedback/DialogProvider';
import { useAuth } from '@/features/auth/AuthContext';
import { createUnit, deleteUnit, fetchUnitsWithUsage, updateUnit, type UnitWithUsage } from './catalogApi';

interface Props {
  /** يُستدعى بعد أي إضافة أو تعديل أو حذف لتحديث قائمة الوحدات في نماذج الأصناف. */
  onChanged: () => void;
}

const UNIT_DESCRIPTIONS: Record<string, { desc: string; sample: string }> = {
  piece: { desc: 'وحدة العد الفردية؛ الوحدة التاريخية المعتمدة لمنتجات المصنع.', sample: 'أزرار، تيكت، ياقات جاهزة، جلاليب' },
  meter: { desc: 'وحدة قياس الطول المعتمدة للأقمشة وشرائط النسيج.', sample: 'أقمشة، أشرطة، حبال، حشو رول' },
  kg: { desc: 'وحدة قياس الوزن بالكيلو جرام للكميات الكبيرة.', sample: 'أكياس خيوط، أقمشة بالوزن' },
  gram: { desc: 'وحدة قياس الوزن الدقيقة للمواد الكيميائية والأصباغ.', sample: 'كيماويات غسيل، صبغات' },
  roll: { desc: 'وحدة التوريد في صورة بكر ولفات كاملة.', sample: 'بكر خيط خياطة، لزق، بكر ميتو' },
  box: { desc: 'وحدة تعبئة وسيطة للمستلزمات الحجمية.', sample: 'علب سنان، علب دبابيس' },
  pack: { desc: 'عبوة أو باكت مجمّع من عناصر صغيرة.', sample: 'باكت كباسين، باكت مشابك' },
  carton: { desc: 'كرتونة شحن خارجية لحفظ ونقل المنتجات.', sample: 'كرتون كبير، كرتون صغير' },
  pair: { desc: 'زوج؛ للمستلزمات المزدوجة المتطابقة.', sample: 'أساور مزدوجة، قفازات' },
};

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

function usageText(unit: UnitWithUsage): string {
  if (!unit.in_use) return 'غير مستخدمة بعد';
  const parts: string[] = [];
  if (unit.catalog_items) parts.push(`${unit.catalog_items.toLocaleString('ar-EG')} صنف`);
  if (unit.stock_movements) parts.push(`${unit.stock_movements.toLocaleString('ar-EG')} حركة مخزون`);
  if (unit.documents) parts.push(`${unit.documents.toLocaleString('ar-EG')} سطر مستندات`);
  return parts.join(' · ');
}

export const UnitsReferenceView: React.FC<Props> = ({ onChanged }) => {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('catalog:units:manage');
  const dialog = useDialog();

  const [units, setUnits] = useState<UnitWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<UnitWithUsage | null>(null);
  const [formCode, setFormCode] = useState('');
  const [formName, setFormName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUnits(await fetchUnitsWithUsage());
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'تعذر تحميل وحدات القياس.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setFormCode('');
    setFormName('');
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (unit: UnitWithUsage) => {
    setEditing(unit);
    setFormCode(unit.code);
    setFormName(unit.name_ar);
    setFormError(null);
    setModalOpen(true);
  };

  const codeLocked = !!editing?.in_use;
  const normalizedCode = formCode.trim().toLowerCase();
  const normalizedName = formName.trim().replace(/\s+/g, ' ');

  const validate = (): string | null => {
    if (!normalizedName) return 'اكتب اسم الوحدة بالعربية.';
    if (!codeLocked && !CODE_PATTERN.test(normalizedCode)) {
      return 'الكود يبدأ بحرف إنجليزي صغير ويحتوي حروفاً إنجليزية وأرقاماً و _ فقط، مثل: yard أو meter_roll.';
    }
    const duplicateCode = units.find((u) => u.id !== editing?.id && u.code.toLowerCase() === normalizedCode);
    if (!codeLocked && duplicateCode) return `الكود «${normalizedCode}» مستخدم لوحدة «${duplicateCode.name_ar}».`;
    const duplicateName = units.find((u) => u.id !== editing?.id && u.name_ar.trim() === normalizedName);
    if (duplicateName) return `يوجد وحدة بنفس الاسم «${normalizedName}».`;
    return null;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        const payload: { code?: string; name_ar?: string } = {};
        if (normalizedName !== editing.name_ar) payload.name_ar = normalizedName;
        if (!codeLocked && normalizedCode !== editing.code) payload.code = normalizedCode;
        if (Object.keys(payload).length) await updateUnit(editing.id, payload);
        setFeedback(`تم حفظ الوحدة «${normalizedName}».`);
      } else {
        await createUnit({ code: normalizedCode, name_ar: normalizedName });
        setFeedback(`تمت إضافة الوحدة «${normalizedName}». يمكن اختيارها الآن عند تعريف الأصناف.`);
      }
      setModalOpen(false);
      await load();
      onChanged();
    } catch (err: unknown) {
      setFormError(err instanceof ApiError ? err.message : 'تعذر حفظ الوحدة.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (unit: UnitWithUsage) => {
    const confirmed = await dialog.confirm({
      title: `حذف الوحدة «${unit.name_ar}»؟`,
      message: 'الحذف متاح فقط لوحدة لم تُستخدم في أي صنف أو حركة أو مستند (مثلاً أُضيفت بالخطأ). لا يمكن التراجع عنه.',
      confirmLabel: 'حذف الوحدة',
      tone: 'danger',
    });
    if (!confirmed) return;
    setFeedback(null);
    try {
      await deleteUnit(unit.id);
      setFeedback(`تم حذف الوحدة «${unit.name_ar}».`);
      await load();
      onChanged();
    } catch (err: unknown) {
      void dialog.notify({
        title: `تعذر حذف الوحدة «${unit.name_ar}»`,
        message: err instanceof ApiError ? err.message : 'تعذر حذف الوحدة.',
        tone: 'danger',
      });
      await load();
    }
  };

  return (
    <div className="units-view">
      <div className="categories-explorer__toolbar">
        <div>
          <h3 className="categories-explorer__title">وحدات القياس</h3>
          <p className="categories-explorer__subtitle">
            الوحدات المستخدمة في تعريف الأصناف وحركات المخزون والمشتريات.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {canManage && (
            <button type="button" onClick={openCreate} className="btn-teal btn-sm">
              ＋ إضافة وحدة
            </button>
          )}
          <button type="button" onClick={() => void load()} disabled={loading} className="btn-secondary btn-sm">
            ↻ تحديث
          </button>
        </div>
      </div>

      <div className="catalog-alert catalog-alert--info" role="note">
        <span className="catalog-alert__icon" aria-hidden>📏</span>
        <div className="catalog-alert__text">
          <strong>لا تحويل بين الوحدات:</strong> كل صنف يُسجَّل بوحدته فقط، والمتر لا يساوي الياردة أو الرول أو الكيلو.
          الوحدة المستخدمة في صنف أو حركة لا تُحذف ولا يتغير كودها، ويُعدَّل اسمها لتصحيح الكتابة فقط
          — إذا كان المقصود وحدة مختلفة فأضف وحدة جديدة.
        </div>
      </div>

      {feedback && (
        <div className="catalog-alert catalog-alert--success" role="status">
          <span className="catalog-alert__icon" aria-hidden>✓</span>
          <div className="catalog-alert__text">{feedback}</div>
        </div>
      )}

      {error && (
        <div className="catalog-alert catalog-alert--error" role="alert">
          <span className="catalog-alert__icon" aria-hidden>⚠️</span>
          <div className="catalog-alert__text">{error}</div>
        </div>
      )}

      {loading && units.length === 0 ? (
        <div className="catalog-table__state" role="status">
          <div className="catalog-spinner" aria-hidden />
          <p>جاري تحميل الوحدات...</p>
        </div>
      ) : (
        <div className="catalog-table-wrap">
          <table className="catalog-table" aria-label="جدول وحدات القياس">
            <thead>
              <tr>
                <th scope="col" style={{ width: '120px' }}>الكود</th>
                <th scope="col" style={{ width: '150px' }}>الاسم</th>
                <th scope="col">الاستخدام المعتاد</th>
                <th scope="col" style={{ width: '220px' }}>مستخدمة في</th>
                {canManage && <th scope="col" style={{ width: '150px' }}>إجراءات</th>}
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => {
                const info = UNIT_DESCRIPTIONS[unit.code];
                return (
                  <tr key={unit.id}>
                    <td>
                      <code className="catalog-table__code">{unit.code}</code>
                    </td>
                    <td>
                      <strong className="catalog-table__name">{unit.name_ar}</strong>
                    </td>
                    <td className="cell-wrap">
                      {info ? (
                        <>
                          {info.desc}
                          <div className="catalog-table__muted">{info.sample}</div>
                        </>
                      ) : (
                        <span className="catalog-table__muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className={`catalog-pill ${unit.in_use ? 'catalog-pill--active' : 'catalog-pill--inactive'}`}>
                        {unit.in_use ? 'مستخدمة' : 'غير مستخدمة'}
                      </span>
                      {unit.in_use && (
                        <div className="catalog-table__muted" style={{ marginTop: '0.25rem' }}>{usageText(unit)}</div>
                      )}
                    </td>
                    {canManage && (
                      <td>
                        <button type="button" className="btn-link btn-sm" onClick={() => openEdit(unit)}>
                          {unit.in_use ? 'تعديل الاسم' : 'تعديل'}
                        </button>
                        {!unit.in_use && (
                          <button type="button" className="btn-danger btn-sm" onClick={() => void handleDelete(unit)}>
                            حذف
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {units.length === 0 && !loading && (
                <tr>
                  <td colSpan={canManage ? 5 : 4} className="catalog-table__muted" style={{ textAlign: 'center' }}>
                    لا توجد وحدات بعد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <div className="drawer-backdrop" onClick={() => !saving && setModalOpen(false)}>
          <div
            className="modal-box modal-box--medium"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            role="dialog"
            aria-modal="true"
            aria-label={editing ? `تعديل الوحدة ${editing.name_ar}` : 'إضافة وحدة قياس'}
          >
            <header className="modal-box__header">
              <div>
                <span className="modal-box__eyebrow">وحدات القياس</span>
                <h3 className="modal-box__title">{editing ? `تعديل الوحدة: ${editing.name_ar}` : 'إضافة وحدة قياس جديدة'}</h3>
              </div>
              <button type="button" className="drawer-close-btn" onClick={() => setModalOpen(false)} disabled={saving} aria-label="إغلاق">
                ✕
              </button>
            </header>

            <form onSubmit={handleSave} className="modal-box__body" noValidate>
              {formError && (
                <div className="catalog-alert catalog-alert--error" role="alert">
                  <span className="catalog-alert__icon" aria-hidden>⚠️</span>
                  <div className="catalog-alert__text">{formError}</div>
                </div>
              )}

              <div className="drawer-row">
                <label className="drawer-field">
                  <span className="drawer-field__label">اسم الوحدة *</span>
                  <input
                    type="text"
                    placeholder="مثال: ياردة"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="drawer-input"
                    maxLength={64}
                    autoFocus
                  />
                  {editing?.in_use && (
                    <span className="drawer-field__help">
                      الوحدة مستخدمة ({usageText(editing)}). عدّل الاسم لتصحيح الكتابة فقط؛ الكميات المسجلة لا تتغير.
                    </span>
                  )}
                </label>

                <label className="drawer-field">
                  <span className="drawer-field__label">الكود (بالإنجليزية) *</span>
                  <input
                    type="text"
                    placeholder="مثال: yard"
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value)}
                    disabled={codeLocked}
                    className={`drawer-input ${codeLocked ? 'drawer-input--readonly' : ''}`}
                    dir="ltr"
                    maxLength={32}
                  />
                  <span className="drawer-field__help">
                    {codeLocked
                      ? 'لا يتغير كود وحدة مستخدمة حتى تبقى السجلات السابقة كما هي.'
                      : 'حروف إنجليزية صغيرة وأرقام و _ فقط، ولا يتكرر.'}
                  </span>
                </label>
              </div>

              <footer className="modal-box__footer">
                <button type="submit" disabled={saving} className="btn-teal">
                  {saving ? 'جاري الحفظ...' : editing ? 'حفظ التعديل' : '＋ إضافة الوحدة'}
                </button>
                <button type="button" onClick={() => setModalOpen(false)} disabled={saving} className="btn-secondary">
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
