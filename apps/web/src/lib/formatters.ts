/**
 * توحيد تنسيق الأرقام والعملات والكميات في تطبيق مصنع القمة (بند 11 من تجربة المالك):
 * - الأرقام بصيغة الأرقام المشرقية (ar-EG) الموحدة مع علامة الآلاف ٬ وعلامة الكسور ٫ (وليست الفاصلة اللاتينية).
 * - القيم الصفرية لا تُظهر -0 أو ٠- أو -- بل ٠٫٠٠ ج.م بدقة.
 * - الأرقام السالبة تُظهر علامة السالب بشكل منضبط دون قلب النص في اتجاه RTL: − ١٠٠٬٠٠٠٫٠٠ ج.م.
 * - خلو النصوص من خلط الأرقام اللاتينية والمشرقية داخل الشاشات المالية والتشغيلية.
 */

export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const str = String(value).trim();
  if (str === '') return 0;
  // تحويل الأرقام المشرقية إن وجدت إلى لاتينية قبل التحويل العددي
  const normalized = str
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/٫/g, '.')
    .replace(/[٬,]/g, '');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

/**
 * تنسيق المبالغ المالية بالجنيه المصري (ج.م)
 * أمثلة:
 * 22575 -> "٢٢٬٥٧٥٫٠٠ ج.م"
 * -100000 -> "− ١٠٠٬٠٠٠٫٠٠ ج.م"
 * 0 -> "٠٫٠٠ ج.م"
 */
export function formatMoney(value: unknown): string {
  const n = toNumber(value);
  if (!Number.isFinite(n) || Object.is(n, -0) || Math.abs(n) < 0.000001) {
    return '٠٫٠٠ ج.م';
  }
  const isNegative = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('ar-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return isNegative ? `− ${formatted} ج.م` : `${formatted} ج.م`;
}

/**
 * تنسيق الكميات مع إمكانية تحديد الحد الأقصى للكسور
 * أمثلة:
 * 50 -> "٥٠"
 * 97.5 -> "٩٧٫٥"
 * -3 -> "− ٣"
 * 0 -> "٠"
 */
export function formatQuantity(value: unknown, maxDecimals: number = 3): string {
  const n = toNumber(value);
  if (!Number.isFinite(n) || Object.is(n, -0) || Math.abs(n) < 0.000001) {
    return '٠';
  }
  const isNegative = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('ar-EG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
  return isNegative ? `− ${formatted}` : formatted;
}

/**
 * تنسيق عدد ثابت الخانات (افتراضياً خانتان عشريتان مثل الأرقام المالية)
 */
export function formatNumber(value: unknown, decimals: number = 2): string {
  const n = toNumber(value);
  if (!Number.isFinite(n) || Object.is(n, -0) || Math.abs(n) < 0.000001) {
    return decimals > 0
      ? (0).toLocaleString('ar-EG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : '٠';
  }
  const isNegative = n < 0;
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('ar-EG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return isNegative ? `− ${formatted}` : formatted;
}
