/**
 * تركيز التنقل: يسمح لصندوق المهام بفتح الشاشة المعنية مباشرة على المستند والقسم المطلوب
 * (مثلاً: أمر تشغيل محدد على تبويب استلام المنتج التام) بدل أن يبحث المستخدم عنه.
 */
export type OrderDetailTab = 'items' | 'materials' | 'stages' | 'defects' | 'fg_receipt' | 'wip';

export interface NavFocus {
  orderId?: string;
  orderTab?: OrderDetailTab;
}

export type NavigateFn = (navId: string, focus?: NavFocus) => void;
