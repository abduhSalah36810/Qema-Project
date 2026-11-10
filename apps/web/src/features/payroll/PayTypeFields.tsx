import type { PayType } from './payrollApi';

/**
 * قسم «نظام الأجر» في نموذج الموظف: شهري (راتب أساسي) أو يومية (أجر اليوم).
 * القيم هنا أساس الحساب فقط؛ لا تُطبَّق منها أي حوافز أو خصومات تلقائياً.
 */
export interface PayFormValues {
  pay_type: PayType;
  base_salary: string;
  daily_rate: string;
}

export const EMPTY_PAY_VALUES: PayFormValues = { pay_type: 'monthly', base_salary: '', daily_rate: '' };

export function validatePay(values: PayFormValues): string | null {
  if (values.pay_type === 'monthly') {
    const salary = Number(values.base_salary);
    if (values.base_salary.trim() === '' || !Number.isFinite(salary) || salary < 0) return 'أدخل الراتب الأساسي الشهري (صفر أو أكبر).';
  } else {
    const rate = Number(values.daily_rate);
    if (values.daily_rate.trim() === '' || !Number.isFinite(rate) || rate <= 0) return 'أدخل قيمة أجر اليوم (أكبر من صفر).';
  }
  return null;
}

/** حقول الطلب المرسلة للخادم حسب نظام الأجر */
export function payPayload(values: PayFormValues): { pay_type: PayType; base_salary: number; daily_rate: number | null } {
  return values.pay_type === 'monthly'
    ? { pay_type: 'monthly', base_salary: Number(values.base_salary), daily_rate: null }
    : { pay_type: 'daily', base_salary: 0, daily_rate: Number(values.daily_rate) };
}

export function payTypeSummary(e: { pay_type?: PayType; base_salary: number; daily_rate?: number | null }): string {
  const fmt = (n: number) => Number(n || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 });
  return e.pay_type === 'daily' ? `يومية · ${fmt(e.daily_rate ?? 0)} ج.م لليوم` : `شهري · ${fmt(e.base_salary)} ج.م`;
}

export function PayTypeFields({ values, onChange }: { values: PayFormValues; onChange: (next: PayFormValues) => void }) {
  return (
    <fieldset className="pay-type-fields">
      <legend>نظام الأجر</legend>
      <div className="pay-type-fields__choices" role="radiogroup" aria-label="نوع الأجر">
        {(['monthly', 'daily'] as PayType[]).map((type) => (
          <label key={type} className={`pay-type-choice ${values.pay_type === type ? 'pay-type-choice--active' : ''}`}>
            <input
              type="radio"
              name="pay_type"
              value={type}
              checked={values.pay_type === type}
              onChange={() => onChange({ ...values, pay_type: type })}
            />
            <span>
              <strong>{type === 'monthly' ? 'راتب شهري' : 'أجر يومية'}</strong>
              <small>{type === 'monthly' ? 'راتب ثابت للشهر، وأساس لحساب الحوافز والخصومات بالنسبة.' : 'أجر اليوم × أيام العمل الفعلية التي تُدخلها في كل فترة.'}</small>
            </span>
          </label>
        ))}
      </div>
      {values.pay_type === 'monthly' ? (
        <label className="form-field">
          <span className="form-label">الراتب الأساسي الشهري (ج.م) <span className="field-required" aria-hidden>*</span></span>
          <input
            className="form-input"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            placeholder="مثال: 6000"
            value={values.base_salary}
            onChange={(e) => onChange({ ...values, base_salary: e.target.value })}
          />
        </label>
      ) : (
        <label className="form-field">
          <span className="form-label">أجر اليوم (ج.م) <span className="field-required" aria-hidden>*</span></span>
          <input
            className="form-input"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            placeholder="مثال: 300"
            value={values.daily_rate}
            onChange={(e) => onChange({ ...values, daily_rate: e.target.value })}
          />
        </label>
      )}
      <small className="form-hint">العملة: الجنيه المصري (ج.م). تعديل هذه القيم لا يغير كشوف الرواتب السابقة.</small>
    </fieldset>
  );
}
