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

/**
 * تنسيق التاريخ القياسي في مصر: يوم / شهر / سنة (DD/MM/YYYY)
 * يستخدم علامة LTR Mark (\u200E) لضمان عدم عكس المتصفح لترتيب اليوم والشهر
 * داخل سياقات النصوص والواجهات العربية (RTL).
 * مثال:
 * 2026-05-11 -> "‎11/05/2026‎" (اليوم 11، الشهر 05، السنة 2026)
 */
export function formatDate(value: unknown): string {
  if (!value) return '—';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Fast path for date-only string YYYY-MM-DD avoiding any timezone shifts
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (m) {
      const [, year, month, day] = m;
      return `\u200E${day}/${month}/${year}\u200E`;
    }
  }
  const d =
    typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : value instanceof Date
        ? value
        : null;
  if (!d || Number.isNaN(d.getTime())) return '—';

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  return `\u200E${day}/${month}/${year}\u200E`;
}

/**
 * تنسيق التاريخ والوقت القياسي: يوم / شهر / سنة مع الوقت (12 ساعة)
 * مثال: "‎11/05/2026‎ 2:30 م"
 */
export function formatDateTime(value: unknown): string {
  if (!value) return '—';
  const d =
    typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : value instanceof Date
        ? value
        : null;
  if (!d || Number.isNaN(d.getTime())) return '—';

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const period = hours >= 12 ? 'م' : 'ص';
  hours = hours % 12 || 12;

  return `\u200E${day}/${month}/${year}\u200E ${hours}:${minutes} ${period}`;
}
