/**
 * ثوابت ومساعدات صفحة تفاصيل أمر التشغيل (T4.2) — منقولة حرفيًا من OrderDetailModal القديم
 * دون أي تغيير سلوكي، لتتشاركها أقسام الصفحة الجديدة.
 */
import { ApiError } from '@/lib/api';
import type { ProductionOrder, ProductionOrderItem, ReturnCondition } from '../productionApi';

export const STAGE_TITLES_AR: Record<string, string> = {
  cutting: 'القص على الباترون',
  finishing: 'التشطيب',
  snap_installation: 'تركيب الكبسولة',
  ironing: 'الكي',
  packing: 'التعبئة والتغليف',
};

export const STAGE_SEQUENCE = [
  'cutting',
  'finishing',
  'snap_installation',
  'ironing',
  'packing',
];

export const STAGE_STATUS_AR: Record<string, string> = {
  not_started: 'لم تبدأ',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتملة',
  skipped: 'تم تخطيها',
};

export const DELAY_REASONS_AR: Record<string, string> = {
  material_shortage: 'نقص أو تأخر الخامات',
  machine_breakdown: 'عطل ماكينات / صيانة',
  power_outage: 'انقطاع كهرباء / مرافق',
  worker_absence: 'غياب أو نقص عمالة',
  defect_rework: 'إصلاح عيوب وتشغيل تالف',
  client_change: 'تعديل مواصفات من العميل',
  other: 'أسباب أخرى',
};

export const ORDER_STATUS_AR: Record<string, string> = {
  draft: 'مسودة جديدة',
  materials_dispatched: 'خامات بالطريق',
  in_production: 'قيد الإنتاج',
  manufacturing_completed: 'اكتمل التصنيع الميداني',
  receipt_completed: 'تم استلام المنتج التام',
  completed: 'مكتملة التجهيز',
  closed: 'مغلق ومسوى نهائياً',
};

export const FG_RECEIPT_STATUSES = ['in_production', 'manufacturing_completed'];
export const RECONCILIATION_STATUSES = ['in_production', 'manufacturing_completed', 'receipt_completed'];
export const ROLLBACK_STATUSES = ['in_production', 'manufacturing_completed'];
export const EPSILON = 1e-9;

export const REFRESH_FAILED_TEXT =
  'تم تنفيذ العملية على الخادم بنجاح، لكن تعذر تحديث بيانات الأمر في الشاشة. أعد تحميل البيانات للتحقق من الحالة الحالية.';

export function parseApiError(err: unknown, defaultMessage: string): { text: string; isNetworkIssue: boolean } {
  if (err instanceof ApiError) {
    if (err.isNetworkError || err.isTimeout) {
      return {
        text: `${err.message || defaultMessage} (تنبيه: تعذر التأكد من وصول الطلب للخادم بسبب انقطاع الاتصال أو انتهاء المهلة. يرجى التحقق من الشبكة أو إعادة مزامنة البيانات قبل إعادة المحاولة).`,
        isNetworkIssue: true,
      };
    }
    return { text: err.message || defaultMessage, isNetworkIssue: false };
  }
  if (err instanceof Error && err.message) {
    return { text: err.message, isNetworkIssue: false };
  }
  return { text: defaultMessage, isNetworkIssue: false };
}

/** سبب تعطيل أزرار المراحل حسب حالة الأمر (الخادم يرفض أي تحديث خارج in_production). */
export function stageLockReason(status: string): string | null {
  if (status === 'in_production') return null;
  if (status === 'draft') return 'اصرف الخامات وأكد استلامها أولاً؛ تحديث المراحل متاح بعد استلام الخامات في الورشة.';
  if (status === 'materials_dispatched') return 'أكد استلام الخامات في الورشة أولاً؛ تحديث المراحل متاح بعد تأكيد الاستلام.';
  return `لا يمكن تحديث المراحل وحالة الأمر "${ORDER_STATUS_AR[status] || status}".`;
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function itemRemaining(item: ProductionOrderItem): number {
  return Math.max(0, round6(item.target_quantity - (item.received_quantity ?? 0)));
}

/** المتبقي الفعلي لاستكمال المستهدف: يستوعب السليم والمرفوض السابقين (قد يكون سالبًا للتنبيه). */
export function itemTotalRemaining(item: ProductionOrderItem): number {
  return round6(item.target_quantity - (item.received_quantity ?? 0) - (item.rejected_quantity ?? 0));
}

export function toNumber(value: string): number {
  if (value.trim() === '') return 0;
  return Number(value);
}

export type FgLineInput = { accepted: string; rejected: string };
export type ReconInput = { consumed: string; returned: string; scrapped: string; notes: string; condition: ReturnCondition };

export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = { good: 'سليمة', needs_inspection: 'تحتاج فحص', damaged: 'تالفة' };

export const SEASON_AR: Record<string, string> = {
  summer: 'صيفي',
  winter: 'شتوي',
  autumn: 'خريفي',
  spring: 'ربيعي',
};

export const seasonAr = (s?: string | null) => (s ? SEASON_AR[s.toLowerCase()] || s : '—');

export function initialFgLines(
  items: ProductionOrderItem[] | undefined,
  defectsCount?: number
): Record<string, FgLineInput> {
  const result: Record<string, FgLineInput> = {};
  const defectSuggestion = Math.max(0, defectsCount || 0);
  let remainingDefects = defectSuggestion;

  (items || []).forEach((item) => {
    const totalRemaining = Math.max(0, itemTotalRemaining(item));
    const rejectedAlloc = Math.min(remainingDefects, totalRemaining);
    remainingDefects -= rejectedAlloc;
    const acceptedAlloc = Math.max(0, totalRemaining - rejectedAlloc);

    result[item.id] = {
      accepted: String(acceptedAlloc),
      rejected: String(rejectedAlloc),
    };
  });
  return result;
}

export function fmtQty(value: number): string {
  return Number(value || 0).toLocaleString('ar-EG', { maximumFractionDigits: 4 });
}

export function cleanVariant(info: string | undefined, season: string | undefined): string {
  return (info || season || '').replace(/summer/g, 'صيفي').replace(/autumn/g, 'خريفي').replace(/winter/g, 'شتوي');
}

/** سياق مشترك تمرره الصفحة لكل قسم: الأمر + قنوات التحديث والتقارير + قفل الحالة العامة */
export interface SectionContext {
  order: ProductionOrder;
  onOrderUpdated: (updated: ProductionOrder) => void;
  /** بعد نجاح خادمي: إعادة جلب الأمر من الخادم وعرض رسالة النجاح (أو تعذر التحديث) */
  refreshOrder: (successText: string) => Promise<void>;
  /** تحويل أي فشل إلى رسالة خطأ موحدة في أعلى الصفحة */
  reportFailure: (err: unknown, fallback: string) => void;
  /** تعيين رسالة الحالة مباشرة (نجاح/تحذير/خطأ) كما في الـModal القديم */
  setStatus: (message: { type: 'success' | 'error' | 'warning'; text: string; canResync?: boolean } | null) => void;
  /** رفع/تخفيض قفل الحالة العامة (يمنع إغلاق الـModal أثناء تنفيذ عملية) */
  setBusy: (busy: boolean) => void;
}
