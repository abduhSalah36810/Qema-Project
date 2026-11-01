import React from 'react';
import { Unit } from './catalogApi';

interface Props {
  units: Unit[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
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

export const UnitsReferenceView: React.FC<Props> = ({
  units,
  loading,
  error,
  onRefresh,
}) => {
  return (
    <div className="units-view">
      <div className="categories-explorer__toolbar">
        <div>
          <h3 className="categories-explorer__title">دليل وحدات القياس المعتمدة</h3>
          <p className="categories-explorer__subtitle">
            قائمة الوحدات القياسية المستخدمة في تعريف الأصناف وحساب حركات المخزون والمشتريات.
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

      <div className="catalog-alert catalog-alert--info" role="note">
        <span className="catalog-alert__icon" aria-hidden>📏</span>
        <div className="catalog-alert__text">
          <strong>سياسة قياس المخزون (Read-Only Reference):</strong> جميع الحركات المخزنية تُقيد بالوحدة الأساسية للصنف دون تحويلات تلقائية ضمنية (No Implicit Unit Conversions)، حمايةً لدقة موازين المخازن ومنعاً لأخطاء التقريب.
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
          <p>جاري استعراض الوحدات المرجعية...</p>
        </div>
      ) : (
        <div className="catalog-table-wrap">
          <table className="catalog-table" aria-label="جدول وحدات القياس">
            <thead>
              <tr>
                <th scope="col" style={{ width: '140px' }}>كود الوحدة</th>
                <th scope="col" style={{ width: '160px' }}>الاسم بالعربية</th>
                <th scope="col">طبيعة الاستخدام القياسية</th>
                <th scope="col">أمثلة شائعة في المصنع</th>
                <th scope="col" style={{ width: '110px', textAlign: 'center' }}>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {units.map((unit) => {
                const info = UNIT_DESCRIPTIONS[unit.code] || {
                  desc: 'وحدة قياس قياسية معتمدة في النظام.',
                  sample: 'أصناف متنوعة',
                };

                return (
                  <tr key={unit.id}>
                    <td>
                      <code className="catalog-table__code">{unit.code}</code>
                    </td>
                    <td>
                      <strong className="catalog-table__name">{unit.name_ar}</strong>
                    </td>
                    <td>{info.desc}</td>
                    <td>
                      <span className="catalog-table__muted">{info.sample}</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span className="catalog-pill catalog-pill--active">
                        معتمدة
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

