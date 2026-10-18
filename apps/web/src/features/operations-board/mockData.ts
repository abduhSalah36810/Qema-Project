/**
 * بيانات تجريبية للوحة التشغيل — للعرض والتطوير فقط
 * هذه الأرقام والأسماء وهمية تمامًا ولا تمثل أي عملية حقيقية.
 * لا تُنقل إلى قاعدة البيانات أو تُستخدم كبيانات افتتاحية للإنتاج.
 */

export interface FlowStep {
  id: string;
  number: string;
  label: string;
  title: string;
  description: string;
  state: 'done' | 'current' | 'pending';
}

export interface BatchRow {
  id: string;
  batchCode: string;
  line: string;
  productName: string;
  dotColor?: 'sand' | 'olive' | 'teal' | undefined;
  doneCount: number;
  targetCount: number;
  progressPercent: number;
  progressVariant?: 'amber';
  supervisorName: string;
  supervisorRole: string;
  status: 'active' | 'wait' | 'late';
  statusLabel: string;
}

export interface DeliveryRow {
  id: string;
  customerName: string;
  orderCode: string;
  itemsSummary: string;
  dueDate: string;
  status: 'ready' | 'preparing' | 'production';
  statusLabel: string;
}

export interface AlertItem {
  id: string;
  iconVariant: 'red' | 'amber' | 'green' | 'blue';
  iconChar: string;
  title: string;
  subtitle: string;
  value: string;
  valueVariant?: 'amber' | 'muted';
}

// ─── خط مراحل التشغيل ───────────────────────────────────────────
export const DEMO_FLOW_STEPS: FlowStep[] = [
  {
    id: 'step-1',
    number: '✓',
    label: 'المرحلة ٠١',
    title: 'الخامات',
    description: '١٢٤ صنفًا · ٣ نواقص حرجة',
    state: 'done',
  },
  {
    id: 'step-2',
    number: '٢',
    label: 'المرحلة ٠٢',
    title: 'دفعات الإنتاج',
    description: '٤ دفعات تعمل الآن · ٣٨ إجماليًا',
    state: 'current',
  },
  {
    id: 'step-3',
    number: '٣',
    label: 'المرحلة ٠٣',
    title: 'المنتج التام',
    description: '٣ دفعات جاهزة للاستلام',
    state: 'pending',
  },
  {
    id: 'step-4',
    number: '٤',
    label: 'المرحلة ٠٤',
    title: 'التسليم',
    description: '٥ طلبات موعدها هذا الأسبوع',
    state: 'pending',
  },
];

// ─── الدفعات النشطة ──────────────────────────────────────────────
export const DEMO_BATCHES: BatchRow[] = [
  {
    id: 'b-1',
    batchCode: 'دفعة د/٢٤٨',
    line: 'خط الخياطة ١',
    productName: 'بنطلون جينز كلاسيك',
    doneCount: 216,
    targetCount: 300,
    progressPercent: 72,
    supervisorName: 'أ. محمد',
    supervisorRole: 'مشرف الخط',
    status: 'active',
    statusLabel: 'تعمل الآن',
  },
  {
    id: 'b-2',
    batchCode: 'دفعة د/٢٥١',
    line: 'خط الخياطة ٢',
    productName: 'جاكيت جينز قصير',
    dotColor: 'sand',
    doneCount: 98,
    targetCount: 180,
    progressPercent: 54,
    progressVariant: 'amber',
    supervisorName: 'أ. سامي',
    supervisorRole: 'مشرف الخط',
    status: 'wait',
    statusLabel: 'بانتظار خامة',
  },
  {
    id: 'b-3',
    batchCode: 'دفعة د/٢٥٣',
    line: 'خط القص',
    productName: 'قميص كاجوال',
    dotColor: 'olive',
    doneCount: 140,
    targetCount: 200,
    progressPercent: 70,
    supervisorName: 'أ. منى',
    supervisorRole: 'مشرفة الخط',
    status: 'active',
    statusLabel: 'تعمل الآن',
  },
  {
    id: 'b-4',
    batchCode: 'دفعة د/٢٥٥',
    line: 'خط التشطيب',
    productName: 'بنطلون جينز أطفال',
    doneCount: 60,
    targetCount: 160,
    progressPercent: 38,
    progressVariant: 'amber',
    supervisorName: 'أ. عمر',
    supervisorRole: 'مشرف الخط',
    status: 'late',
    statusLabel: 'متأخرة',
  },
];

// ─── التسليمات القادمة ───────────────────────────────────────────
export const DEMO_DELIVERIES: DeliveryRow[] = [
  {
    id: 'd-1',
    customerName: 'شركة الندى للملابس',
    orderCode: 'طلب ط/٨٥٤',
    itemsSummary: '١٢٠ قطعة متنوعة',
    dueDate: 'غدًا',
    status: 'ready',
    statusLabel: 'جاهز للتسليم',
  },
  {
    id: 'd-2',
    customerName: 'محلات بيت الأناقة',
    orderCode: 'طلب ط/٨٥٩',
    itemsSummary: '٨٠ قطعة',
    dueDate: 'الأربعاء',
    status: 'preparing',
    statusLabel: 'قيد التجهيز',
  },
  {
    id: 'd-3',
    customerName: 'مؤسسة المروة',
    orderCode: 'طلب ط/٨٦١',
    itemsSummary: '٢٤٠ قطعة',
    dueDate: 'الخميس',
    status: 'production',
    statusLabel: 'قيد الإنتاج',
  },
];

// ─── تنبيهات «تحتاج قرارك» ──────────────────────────────────────
export const DEMO_ALERTS: AlertItem[] = [
  {
    id: 'a-1',
    iconVariant: 'red',
    iconChar: '!',
    title: 'قماش جينز أزرق',
    subtitle: 'المخزون ٢٨ م · المطلوب ٥٠ م',
    value: 'حرج',
  },
  {
    id: 'a-2',
    iconVariant: 'amber',
    iconChar: '!',
    title: 'دفعة د/٢٥٥ متأخرة',
    subtitle: 'تأخير متوقع: يوم واحد',
    value: 'إنتاج',
    valueVariant: 'amber',
  },
  {
    id: 'a-3',
    iconVariant: 'amber',
    iconChar: '↗',
    title: 'طلب الندى مستحق غدًا',
    subtitle: 'مراجعة الكميات قبل التحميل',
    value: 'تسليم',
    valueVariant: 'amber',
  },
];

// ─── ملخص حركة اليوم ─────────────────────────────────────────────
export const DEMO_TODAY_ACTIVITY: AlertItem[] = [
  {
    id: 'act-1',
    iconVariant: 'green',
    iconChar: '✓',
    title: 'استلام خامات',
    subtitle: 'قماش قطني · ٢٤٠ متر',
    value: '١٠:٤٢',
    valueVariant: 'muted',
  },
  {
    id: 'act-2',
    iconVariant: 'blue',
    iconChar: '↗',
    title: 'تسليم طلب جزئي',
    subtitle: 'عميل — ٤٠ قطعة',
    value: '٩:١٥',
    valueVariant: 'muted',
  },
  {
    id: 'act-3',
    iconVariant: 'amber',
    iconChar: '＋',
    title: 'فتح دفعة جديدة',
    subtitle: 'دفعة د/٢٥٥ · ١٦٠ قطعة',
    value: '٨:٣٠',
    valueVariant: 'muted',
  },
];
