/**
 * فئات بنود الحوافز والخصومات وطرق حسابها (مطابقة للخادم: payroll_schemas.ITEM_CATEGORIES).
 */
import type { CalcMethod, ItemCategory } from './payrollApi';

export const ITEM_CATEGORIES: Record<ItemCategory, { kind: 'incentive' | 'deduction'; label: string; methods: CalcMethod[]; unit?: string }> = {
  incentive_fixed: { kind: 'incentive', label: 'حافز بمبلغ ثابت', methods: ['fixed'] },
  incentive_percent: { kind: 'incentive', label: 'حافز بنسبة من الأجر الأساسي', methods: ['percent'] },
  incentive_other: { kind: 'incentive', label: 'إضافة أخرى', methods: ['fixed', 'quantity', 'percent'] },
  absence_permitted: { kind: 'deduction', label: 'غياب بإذن', methods: ['quantity', 'fixed'], unit: 'يوم' },
  absence_unpermitted: { kind: 'deduction', label: 'غياب بدون إذن', methods: ['quantity', 'fixed'], unit: 'يوم' },
  late_hours: { kind: 'deduction', label: 'تأخير بالساعات', methods: ['quantity', 'fixed'], unit: 'ساعة' },
  penalty: { kind: 'deduction', label: 'غرامة / جزاء', methods: ['fixed', 'percent'] },
  other_deduction: { kind: 'deduction', label: 'خصم آخر', methods: ['fixed', 'quantity', 'percent'] },
};

export const CALC_METHOD_LABELS: Record<CalcMethod, string> = {
  fixed: 'مبلغ ثابت',
  percent: 'نسبة من الأساسي',
  quantity: 'عدد × قيمة الوحدة',
};

