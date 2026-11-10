/**
 * عميل الـ API لصندوق المهام الموحد (Task Inbox API)
 * ─────────────────────────────────────────────────────────────────────────────
 * يجلب المعاملات الحية من خادم الـ API ويحوّلها إلى مهام تشغيلية بحسب صلاحيات
 * المستخدم الفعلية القادمة من GET /api/v1/auth/me (Deny-by-default).
 * كل مصدر يُجلب مرة واحدة ومستقلاً؛ فشل مصدر لا يُخفى بصمت بل يُعاد كخطأ مع
 * الاستمرار في عرض مهام المصادر الأخرى.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { apiClient, ApiError } from '@/lib/api';
import type { NavFocus, OrderDetailTab } from '@/lib/navigation';

export interface TaskItem {
  id: string;
  category: 'warehouse' | 'production' | 'finance' | 'governance';
  title: string;
  description: string;
  referenceDoc: string;
  priority: 'high' | 'medium' | 'normal';
  currentStatus: string;
  createdAt: string;
  assignedTo?: string;
  actionNavId: string;
  actionLabel: string;
  badgeText: string;
  // بيانات الحوكمة والتفاصيل المالية الإضافية
  docType?: string;
  amount?: number;
  requester?: string;
  waitingReason?: string;
  /** مهمة متابعة فقط: الخطوة التالية عند مستخدم آخر (لا يستطيع صاحبها تنفيذها) */
  awaitingOther?: boolean;
  /** مستند نقدي يمكن اعتماده/رفضه مباشرة عبر /finance/cash-documents/{id}/decision */
  canDirectApprove?: boolean;
  directEntityId?: string;
  /**
   * قسم المهمة في الصفحة الرئيسية:
   * action = مطلوب منك الآن، waiting = أرسلته وينتظر غيرك، attention = عاد إليك مرفوضاً أو يحتاج انتباهك.
   */
  section?: TaskSection;
  /** الدور المسؤول عن الخطوة التالية بلغة المصنع */
  nextRole?: string;
  /** سبب الرفض عند عودة مستند لمنشئه */
  rejectionReason?: string;
  /** فتح الشاشة على المستند والقسم المطلوب مباشرة */
  focus?: NavFocus;
}

export type TaskSection = 'action' | 'waiting' | 'attention';

export interface TaskSourceError {
  source: string;
  message: string;
}

export interface InboxResult {
  tasks: TaskItem[];
  errors: TaskSourceError[];
}

interface ProductionOrderRaw {
  id: string;
  order_number: string;
  status: string;
  product_name_ar?: string;
  target_quantity: number;
  assigned_to?: string;
  created_at: string;
  pending_transfer_dispatched_by?: string | null;
  returns_awaiting_receipt?: number;
  returns_awaiting_resolution?: number;
  returns_pending_declared_by?: string[];
  returns_pending_received_by?: string[];
}

interface SupplierInvoiceRaw {
  id: string;
  internal_number: string;
  invoice_number: string;
  supplier_name: string;
  status: string;
  invoice_date: string;
  balance_due: number | string;
  payable_balance?: number | string;
  pending_payments_total?: number | string;
  payments?: Array<{ id: string; status: string; created_by: string; created_at: string }>;
}

interface CashDocumentRaw {
  id: string;
  document_number: string;
  document_type: string;
  amount: number | string;
  description: string;
  status: string;
  occurred_at: string;
  created_by: string;
  source_system?: string | null;
  rejection_reason?: string | null;
  approved_at?: string | null;
}

interface StocktakeSessionRaw {
  id: string;
  session_number: string;
  warehouse_name_ar?: string;
  status: string;
  counting_date: string;
}

interface PendingCatalogItemRaw {
  id: string;
  code: string;
  name_ar: string;
  created_at: string;
}

interface PendingRevisionRaw {
  id: string;
  item_code: string;
  revision_number: number;
  change_summary: string;
  created_at: string;
}

const CASH_DOC_TYPE_LABELS: Record<string, string> = {
  income: 'سند قبض نقدي',
  expense: 'سند صرف نقدي',
  transfer: 'تحويل نقدي داخلي',
};

const CASH_SOURCE_LABELS: Record<string, string> = {
  supplier_payment: 'سداد مورد',
  customer_payment: 'تحصيل عميل',
  payroll: 'صرف رواتب',
  custody_settlement: 'تسوية عهدة',
  daily_expense: 'مصروف عهدة',
};

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'تعذر تحميل البيانات من الخادم.';
}

function toNumber(value: number | string | undefined | null): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function productLabel(ord: ProductionOrderRaw): string {
  return ord.product_name_ar || 'أمر تشغيل';
}

function returnTasks(ord: ProductionOrderRaw, perms: Set<string>, userId?: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  const base = { referenceDoc: ord.order_number, createdAt: ord.created_at, assignedTo: ord.assigned_to, focus: { orderId: ord.id } };
  const awaitingReceipt = ord.returns_awaiting_receipt ?? 0;
  const awaitingResolution = ord.returns_awaiting_resolution ?? 0;
  if (awaitingReceipt > 0) {
    const declaredByMe = Boolean(userId && (ord.returns_pending_declared_by ?? []).includes(userId));
    if (perms.has('warehouse:returns:receive') && !declaredByMe) {
      tasks.push({
        ...base,
        id: `po-return-receive-${ord.id}`,
        category: 'warehouse',
        title: 'فحص واستلام مرتجع خامات من الورشة',
        description: `مرتجع خامات من أمر التشغيل (${productLabel(ord)}) بالطريق. افحصه وأكد المقبول والمرفوض؛ لا يدخل رصيد الخامات قبل تأكيدك.`,
        priority: 'high',
        currentStatus: 'مرتجع بالطريق · بانتظار فحص المخزن',
        actionNavId: 'batches',
        actionLabel: 'فحص واستلام المرتجع',
        badgeText: 'مرتجع ورشة',
      });
    } else if (declaredByMe) {
      tasks.push({
        ...base,
        id: `po-return-waiting-${ord.id}`,
        category: 'production',
        title: 'مرتجع سجّلتَه · بانتظار فحص المخزن',
        description: `سجّلتَ مرتجع خامات من أمر التشغيل (${productLabel(ord)}). يفحصه ويستلمه أمين المخزن.`,
        priority: 'normal',
        currentStatus: 'بانتظار الطرف الآخر',
        actionNavId: 'batches',
        actionLabel: 'عرض الأمر',
        badgeText: 'بانتظار المخزن',
        waitingReason: 'لا يجوز لمن سجّل المرتجع أن يؤكد استلامه بنفسه.',
        awaitingOther: true,
      });
    }
  }
  if (awaitingResolution > 0) {
    const receivedByMe = Boolean(userId && (ord.returns_pending_received_by ?? []).includes(userId));
    if (perms.has('production:returns:resolve') && !receivedByMe) {
      tasks.push({
        ...base,
        id: `po-return-resolve-${ord.id}`,
        category: 'production',
        title: 'قرار في عجز أو مرفوض مرتجع الورشة',
        description: `مرتجع أمر التشغيل (${productLabel(ord)}) به عجز أو كميات مرفوضة. قرر مصيرها بسبب مكتوب؛ الأمر لا يُغلق قبل ذلك.`,
        priority: 'high',
        currentStatus: 'بانتظار قرار التسوية',
        actionNavId: 'batches',
        actionLabel: 'تسوية المرتجع',
        badgeText: 'تسوية مرتجع',
      });
    } else if (receivedByMe) {
      tasks.push({
        ...base,
        id: `po-return-resolution-waiting-${ord.id}`,
        category: 'warehouse',
        title: 'مرتجع أثبتَّ فيه عجزاً أو رفضاً · بانتظار القرار',
        description: `يقرر مسؤول الإنتاج أو المدير العام مصير العجز والمرفوض في مرتجع أمر التشغيل (${productLabel(ord)}).`,
        priority: 'normal',
        currentStatus: 'بانتظار الطرف الآخر',
        actionNavId: 'batches',
        actionLabel: 'عرض الأمر',
        badgeText: 'بانتظار القرار',
        waitingReason: 'من أثبت العجز أو الرفض لا يسوّيه بنفسه.',
        awaitingOther: true,
      });
    }
  }
  return tasks;
}

function ordersToTasks(orders: ProductionOrderRaw[], perms: Set<string>, userId?: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const ord of orders) {
    tasks.push(...returnTasks(ord, perms, userId));
    const base = {
      referenceDoc: ord.order_number,
      createdAt: ord.created_at,
      assignedTo: ord.assigned_to,
      focus: { orderId: ord.id },
    };
    if (ord.status === 'draft' && perms.has('warehouse:dispatch')) {
      tasks.push({
        ...base,
        id: `po-dispatch-${ord.id}`,
        category: 'warehouse',
        title: 'صرف خامات أمر التشغيل',
        description: `أمر التشغيل (${productLabel(ord)}) بالكمية المستهدفة ${toNumber(ord.target_quantity).toLocaleString('ar-EG')} قطعة بانتظار صرف الخامات من مخزن الخامات.`,
        priority: 'high',
        currentStatus: 'مسودة · بانتظار صرف الخامات',
        actionNavId: 'batches',
        actionLabel: 'صرف الخامات',
        badgeText: 'صرف خامات',
      });
    } else if (ord.status === 'materials_dispatched' && userId && ord.pending_transfer_dispatched_by === userId) {
      // من صرف الخامات لا يؤكد استلامها: تظهر له متابعة بانتظار الطرف الآخر، لا مهمة تنفيذية
      tasks.push({
        ...base,
        id: `po-wip-waiting-${ord.id}`,
        category: 'production',
        title: 'خامات صرفتَها · بانتظار تأكيد استلام الورشة',
        description: `صرفتَ خامات أمر التشغيل (${productLabel(ord)}). يؤكد استلامها في الورشة مسؤول الإنتاج أو مستخدم آخر مخوّل.`,
        priority: 'normal',
        currentStatus: 'بانتظار الطرف الآخر',
        actionNavId: 'batches',
        actionLabel: 'عرض الأمر',
        badgeText: 'بانتظار الاستلام',
        waitingReason: 'لا يجوز لمن صرف الخامات أن يؤكد استلامها بنفسه.',
        awaitingOther: true,
      });
    } else if (ord.status === 'materials_dispatched' && perms.has('production:wip:receive')) {
      tasks.push({
        ...base,
        id: `po-wip-${ord.id}`,
        category: 'production',
        title: 'تأكيد استلام الخامات في الورشة',
        description: `صُرفت خامات أمر التشغيل (${productLabel(ord)}). عُدّها في الورشة وأكد المستلم لتبدأ مراحل التصنيع.`,
        priority: 'high',
        currentStatus: 'خامات منصرفة · بانتظار الاستلام',
        actionNavId: 'batches',
        actionLabel: 'تأكيد استلام الخامات',
        badgeText: 'استلام الورشة',
      });
    } else if (ord.status === 'in_production' && perms.has('production:stages:manage')) {
      tasks.push({
        ...base,
        id: `po-stages-${ord.id}`,
        category: 'production',
        title: 'متابعة مراحل التصنيع',
        description: `أمر التشغيل (${productLabel(ord)}) قيد التصنيع؛ سجّل إنجاز المراحل عند اكتمالها.`,
        priority: 'normal',
        currentStatus: 'قيد التصنيع',
        actionNavId: 'batches',
        actionLabel: 'متابعة المراحل',
        badgeText: 'مراحل التصنيع',
      });
    } else if (ord.status === 'manufacturing_completed' && perms.has('warehouse:finished_goods:receive')) {
      tasks.push({
        ...base,
        id: `po-fg-${ord.id}`,
        category: 'warehouse',
        title: 'استلام المنتج التام بالمخزن',
        description: `اكتمل تصنيع أمر التشغيل (${productLabel(ord)}) ويحتاج فحص واستلام القطع المقبولة والمرفوضة لكل صنف.`,
        priority: 'high',
        currentStatus: 'اكتمل التصنيع · بانتظار الاستلام',
        actionNavId: 'batches',
        actionLabel: 'استلام المنتج التام',
        badgeText: 'منتج تام',
      });
    } else if (
      ord.status === 'receipt_completed' &&
      perms.has('production:orders:manage') &&
      perms.has('production:orders:close') &&
      // الإغلاق محجوب بالمرتجعات المعلقة: مهمتها الفعلية هي المرتجع (أعلاه) لا الإغلاق
      (ord.returns_awaiting_receipt ?? 0) + (ord.returns_awaiting_resolution ?? 0) === 0
    ) {
      tasks.push({
        ...base,
        id: `po-close-${ord.id}`,
        category: 'production',
        title: 'تسوية خامات الورشة وإغلاق أمر التشغيل',
        description: `تم استلام المنتج التام لأمر التشغيل (${productLabel(ord)}). سجّل تسوية الخامات (مستهلك/مرتجع/هالك) ثم أغلق الأمر.`,
        priority: 'medium',
        currentStatus: 'اكتمل الاستلام · بانتظار التسوية والإغلاق',
        actionNavId: 'batches',
        actionLabel: 'التسوية والإغلاق',
        badgeText: 'إغلاق أمر',
      });
    }
  }
  return tasks;
}

function invoicesToTasks(invoices: SupplierInvoiceRaw[], perms: Set<string>, userId?: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const inv of invoices) {
    // طلبات السداد التي أرسلها المستخدم ولا يرى الخزينة (أمين المخزن): متابعة بلا مبالغ
    if (userId && !perms.has('finance:cash:view')) {
      for (const pay of inv.payments ?? []) {
        if (pay.created_by !== userId) continue;
        if (pay.status === 'pending') {
          tasks.push({
            id: `inv-payreq-waiting-${pay.id}`,
            category: 'finance',
            title: 'طلب سداد أرسلتَه · بانتظار الخزينة',
            description: `طلب سداد فاتورة ${inv.supplier_name}. يعتمده المسؤول المالي من الخزينة؛ لا يلزمك أي إجراء.`,
            referenceDoc: inv.internal_number || inv.invoice_number,
            priority: 'normal',
            currentStatus: 'بانتظار اعتماد الخزينة',
            createdAt: pay.created_at,
            actionNavId: 'finance-suppliers',
            actionLabel: 'عرض الفاتورة',
            badgeText: 'طلب سداد',
            waitingReason: 'الاعتماد المالي من الخزينة فقط ولغير منشئ الطلب.',
            awaitingOther: true,
          });
        } else if (pay.status === 'rejected') {
          tasks.push({
            id: `inv-payreq-rejected-${pay.id}`,
            category: 'finance',
            title: 'رُفض طلب سداد أرسلتَه',
            description: `رفضت الخزينة طلب سداد فاتورة ${inv.supplier_name}. راجع المالية قبل إرسال طلب جديد.`,
            referenceDoc: inv.internal_number || inv.invoice_number,
            priority: 'medium',
            currentStatus: 'مرفوض',
            createdAt: pay.created_at,
            actionNavId: 'finance-suppliers',
            actionLabel: 'عرض الفاتورة',
            badgeText: 'طلب سداد مرفوض',
            section: 'attention',
          });
        }
      }
    }
    if (
      (inv.status === 'awaiting_receipt' || inv.status === 'partially_received') &&
      perms.has('suppliers:receive')
    ) {
      tasks.push({
        id: `inv-receive-${inv.id}`,
        category: 'warehouse',
        title: 'استلام وفحص توريد خامات',
        description: `فاتورة توريد من ${inv.supplier_name} ${inv.status === 'partially_received' ? 'استُلم جزء منها ويتبقى استلام الباقي' : 'تنتظر الفحص وتأكيد الاستلام'} بمخزن الخامات.`,
        referenceDoc: inv.internal_number || inv.invoice_number,
        priority: 'high',
        currentStatus: inv.status === 'partially_received' ? 'استلام جزئي' : 'بانتظار الاستلام',
        createdAt: inv.invoice_date,
        actionNavId: 'finance-suppliers',
        actionLabel: 'فحص واستلام التوريد',
        badgeText: 'توريد معلق',
      });
    }
    // المستحق الذي لم يُطلب سداده بعد (الطلبات المعلقة في الخزينة لا تُعد مهمة جديدة)
    const payable = toNumber(inv.payable_balance ?? inv.balance_due) - toNumber(inv.pending_payments_total);
    if (
      (inv.status === 'received' || inv.status === 'partially_received') &&
      payable > 0.005 &&
      perms.has('suppliers:payments:request') &&
      perms.has('finance:cash:view')
    ) {
      tasks.push({
        id: `inv-pay-${inv.id}`,
        category: 'finance',
        title: 'مستحق سداد لفاتورة مورد',
        description: `فاتورة المورد (${inv.supplier_name}) عليها رصيد مستحق عن الكميات المستلمة.`,
        referenceDoc: inv.invoice_number || inv.internal_number,
        priority: 'medium',
        currentStatus: inv.status === 'received' ? 'مستلمة بالكامل' : 'استلام جزئي',
        createdAt: inv.invoice_date,
        actionNavId: 'finance-suppliers',
        actionLabel: 'تسجيل دفعة سداد',
        badgeText: 'مستحق مورد',
        docType: 'فاتورة توريد خامات',
        amount: payable,
        requester: inv.supplier_name,
        waitingReason: 'بانتظار تسجيل دفعة السداد ثم اعتمادها في الخزينة',
      });
    }
  }
  return tasks;
}

function stocktakesToTasks(sessions: StocktakeSessionRaw[], perms: Set<string>): TaskItem[] {
  const tasks: TaskItem[] = [];
  for (const st of sessions) {
    const warehouse = st.warehouse_name_ar || 'المخزن';
    if ((st.status === 'draft' || st.status === 'counting') && perms.has('inventory:stocktake:count')) {
      tasks.push({
        id: `st-count-${st.id}`,
        category: 'warehouse',
        title: 'استكمال العد الفعلي لجلسة الجرد',
        description: `جلسة جرد في (${warehouse}) تحتاج تسجيل العد الميداني ثم تقديمها للمراجعة.`,
        referenceDoc: st.session_number,
        priority: 'medium',
        currentStatus: st.status === 'draft' ? 'مسودة' : 'جاري العد',
        createdAt: st.counting_date,
        actionNavId: 'warehouse-stocktake',
        actionLabel: 'تسجيل العد الفعلي',
        badgeText: 'جرد ميداني',
      });
    } else if (
      (st.status === 'submitted' || st.status === 'under_review') &&
      (perms.has('inventory:stocktake:review') || perms.has('inventory:stocktake:approve'))
    ) {
      tasks.push({
        id: `st-review-${st.id}`,
        category: 'governance',
        title: perms.has('inventory:stocktake:approve') ? 'مراجعة واعتماد فروقات الجرد' : 'مراجعة فروقات الجرد',
        description: `جلسة جرد (${warehouse}) ${st.status === 'under_review' ? 'قيد المراجعة بعد طلب إعادة عد' : 'مقدمة للمراجعة'} وتحتاج قرارك.`,
        referenceDoc: st.session_number,
        priority: 'high',
        currentStatus: st.status === 'under_review' ? 'قيد المراجعة' : 'مقدمة للمراجعة',
        createdAt: st.counting_date,
        actionNavId: 'warehouse-stocktake',
        actionLabel: 'مراجعة الفروقات',
        badgeText: 'مراجعة جرد',
      });
    } else if (st.status === 'approved' && perms.has('inventory:stocktake:post')) {
      tasks.push({
        id: `st-post-${st.id}`,
        category: 'governance',
        title: 'ترحيل تسويات الجرد المعتمدة',
        description: `جلسة الجرد (${st.session_number}) معتمدة وجاهزة لترحيل التسويات إلى دفتر المخزون.`,
        referenceDoc: st.session_number,
        priority: 'high',
        currentStatus: 'معتمدة · بانتظار الترحيل',
        createdAt: st.counting_date,
        actionNavId: 'warehouse-stocktake',
        actionLabel: 'ترحيل التسويات',
        badgeText: 'تسوية مخزنية',
      });
    }
  }
  return tasks;
}

function cashDocsToTasks(docs: CashDocumentRaw[]): TaskItem[] {
  return docs
    .filter((d) => d.status === 'pending')
    .map((d) => {
      const typeLabel = CASH_DOC_TYPE_LABELS[d.document_type] ?? 'مستند نقدي';
      const sourceLabel = d.source_system ? CASH_SOURCE_LABELS[d.source_system] : undefined;
      const docLabel = sourceLabel ? `${typeLabel} · ${sourceLabel}` : typeLabel;
      return {
        id: `cash-${d.id}`,
        category: 'finance' as const,
        title: `اعتماد ${docLabel}`,
        description: d.description || 'مستند نقدي معلق ينتظر الاعتماد في الخزينة.',
        referenceDoc: d.document_number,
        priority: 'high' as const,
        currentStatus: 'معلق بانتظار الاعتماد',
        createdAt: d.occurred_at,
        actionNavId: 'finance-treasury',
        actionLabel: 'فتح الخزينة',
        badgeText: docLabel,
        docType: docLabel,
        amount: toNumber(d.amount),
        requester: d.created_by,
        waitingReason: 'لا يتغير أي رصيد قبل الاعتماد؛ منشئ المستند لا يستطيع اعتماده.',
        canDirectApprove: true,
        directEntityId: d.id,
      };
    });
}

function catalogToTasks(items: PendingCatalogItemRaw[], revisions: PendingRevisionRaw[]): TaskItem[] {
  return [
    ...items.map((item) => ({
      id: `cat-${item.id}`,
      category: 'governance' as const,
      title: 'اعتماد صنف جديد بالدليل',
      description: `مسودة الصنف (${item.name_ar}) مقدمة وتنتظر الاعتماد أو الرفض.`,
      referenceDoc: item.code,
      priority: 'high' as const,
      currentStatus: 'بانتظار الاعتماد',
      createdAt: item.created_at,
      actionNavId: 'warehouse-catalog',
      actionLabel: 'اعتماد / رفض الصنف',
      badgeText: 'حوكمة الأصناف',
    })),
    ...revisions.map((rev) => ({
      id: `rev-${rev.id}`,
      category: 'governance' as const,
      title: `طلب تعديل صنف: ${rev.item_code}`,
      description: `${rev.change_summary || 'طلب تعديل لبيانات صنف معتمد'} (إصدار ${rev.revision_number}).`,
      referenceDoc: rev.item_code,
      priority: 'medium' as const,
      currentStatus: 'طلب تعديل معلق',
      createdAt: rev.created_at,
      actionNavId: 'warehouse-catalog',
      actionLabel: 'مراجعة طلب التعديل',
      badgeText: 'تعديل صنف',
    })),
  ];
}

function myCashDocsToTasks(docs: CashDocumentRaw[], userId: string): TaskItem[] {
  const recentLimit = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const tasks: TaskItem[] = [];
  for (const d of docs) {
    if (d.created_by !== userId) continue;
    const typeLabel = CASH_DOC_TYPE_LABELS[d.document_type] ?? 'مستند نقدي';
    const sourceLabel = d.source_system ? CASH_SOURCE_LABELS[d.source_system] : undefined;
    const docLabel = sourceLabel ? `${typeLabel} · ${sourceLabel}` : typeLabel;
    if (d.status === 'pending') {
      tasks.push({
        id: `mycash-waiting-${d.id}`,
        category: 'finance',
        title: `${docLabel} أرسلتَه · بانتظار الاعتماد`,
        description: d.description || 'مستند نقدي ينتظر اعتماد مسؤول مالي آخر.',
        referenceDoc: d.document_number,
        priority: 'normal',
        currentStatus: 'بانتظار اعتماد الخزينة',
        createdAt: d.occurred_at,
        actionNavId: 'finance-treasury',
        actionLabel: 'عرض في الخزينة',
        badgeText: docLabel,
        amount: toNumber(d.amount),
        waitingReason: 'منشئ المستند لا يعتمده؛ يعتمده مسؤول مالي آخر أو المدير العام.',
        awaitingOther: true,
      });
    } else if (d.status === 'rejected' && new Date(d.occurred_at).getTime() >= recentLimit) {
      tasks.push({
        id: `mycash-rejected-${d.id}`,
        category: 'finance',
        title: `عاد إليك مرفوضاً: ${docLabel}`,
        description: d.description || 'رُفض المستند في الخزينة.',
        referenceDoc: d.document_number,
        priority: 'medium',
        currentStatus: 'مرفوض',
        createdAt: d.occurred_at,
        actionNavId: d.source_system === 'supplier_payment' ? 'finance-suppliers' : 'finance-operations',
        actionLabel: 'مراجعة وإعادة الإرسال',
        badgeText: 'مرفوض',
        amount: toNumber(d.amount),
        rejectionReason: d.rejection_reason || undefined,
        section: 'attention',
      });
    }
  }
  return tasks;
}

interface CatalogItemRaw {
  id: string;
  code: string;
  name_ar: string;
  approval_status: string;
  rejection_reason?: string | null;
  submitted_by?: string | null;
  submitted_at?: string | null;
}

function myCatalogToTasks(pending: CatalogItemRaw[], rejected: CatalogItemRaw[], userId: string): TaskItem[] {
  const mine = (item: CatalogItemRaw) => item.submitted_by === userId;
  return [
    ...pending.filter(mine).map((item) => ({
      id: `mycat-waiting-${item.id}`,
      category: 'governance' as const,
      title: 'صنف قدّمتَه · بانتظار الاعتماد',
      description: `الصنف (${item.name_ar}) بانتظار اعتماد المدير العام قبل استخدامه في الشراء والإنتاج.`,
      referenceDoc: item.code,
      priority: 'normal' as const,
      currentStatus: 'بانتظار الاعتماد',
      createdAt: item.submitted_at || new Date().toISOString(),
      actionNavId: 'warehouse-catalog',
      actionLabel: 'عرض الصنف',
      badgeText: 'دليل الأصناف',
      awaitingOther: true,
    })),
    ...rejected.filter(mine).map((item) => ({
      id: `mycat-rejected-${item.id}`,
      category: 'governance' as const,
      title: 'عاد إليك مرفوضاً: صنف بالدليل',
      description: `رُفض اعتماد الصنف (${item.name_ar}). عدّل البيانات حسب السبب ثم أعد تقديمه.`,
      referenceDoc: item.code,
      priority: 'medium' as const,
      currentStatus: 'مرفوض',
      createdAt: item.submitted_at || new Date().toISOString(),
      actionNavId: 'warehouse-catalog',
      actionLabel: 'تعديل وإعادة التقديم',
      badgeText: 'صنف مرفوض',
      rejectionReason: item.rejection_reason || undefined,
      section: 'attention' as const,
    })),
  ];
}

const NEXT_ROLE_BY_PREFIX: Array<[string, string, OrderDetailTab?]> = [
  ['po-return-resolution-waiting-', 'مسؤول الإنتاج أو المدير العام', 'wip'],
  ['po-return-resolve-', 'مسؤول الإنتاج أو المدير العام', 'wip'],
  ['po-return-receive-', 'أمين المخزن', 'wip'],
  ['po-return-waiting-', 'أمين المخزن', 'wip'],
  ['po-wip-waiting-', 'مسؤول الإنتاج', 'materials'],
  ['po-dispatch-', 'أمين المخزن', 'materials'],
  ['po-wip-', 'مسؤول الإنتاج', 'materials'],
  ['po-stages-', 'مسؤول الإنتاج', 'stages'],
  ['po-fg-', 'أمين المخزن', 'fg_receipt'],
  ['po-close-', 'مسؤول الإنتاج', 'wip'],
  ['inv-payreq-', 'المالية (الخزينة)'],
  ['inv-receive-', 'أمين المخزن'],
  ['inv-pay-', 'المالية'],
  ['st-count-', 'أمين المخزن'],
  ['st-review-', 'المدير العام'],
  ['st-post-', 'المدير العام'],
  ['mycash-', 'مسؤول مالي آخر (الخزينة)'],
  ['cash-', 'المالية (الخزينة)'],
  ['mycat-', 'المدير العام'],
  ['cat-', 'المدير العام'],
  ['rev-', 'المدير العام'],
];

/** يكمل كل مهمة بقسمها والدور المسؤول عن خطوتها التالية والقسم الذي تفتح عليه. */
function enrichTask(task: TaskItem): TaskItem {
  const match = NEXT_ROLE_BY_PREFIX.find(([prefix]) => task.id.startsWith(prefix));
  const section: TaskSection = task.section ?? (task.awaitingOther ? 'waiting' : 'action');
  const focus = task.focus && match?.[2] ? { ...task.focus, orderTab: match[2] } : task.focus;
  return {
    ...task,
    section,
    nextRole: task.nextRole ?? (section === 'action' ? 'أنت' : match?.[1]),
    focus,
  };
}

interface TaskSource {
  label: string;
  enabled: boolean;
  load: () => Promise<TaskItem[]>;
}

/**
 * جلب المهام المسموح بها للمستخدم الحالي استناداً إلى صلاحياته الخادمية.
 */
export async function fetchInboxTasks(permissions: string[], userId?: string): Promise<InboxResult> {
  const perms = new Set(permissions);

  const sources: TaskSource[] = [
    {
      label: 'أوامر التشغيل',
      enabled:
        perms.has('production:orders:view') &&
        (perms.has('warehouse:dispatch') ||
          perms.has('production:wip:receive') ||
          perms.has('warehouse:finished_goods:receive') ||
          perms.has('warehouse:returns:receive') ||
          perms.has('production:returns:resolve') ||
          perms.has('production:stages:manage') ||
          perms.has('production:orders:close')),
      load: async () =>
        ordersToTasks(await apiClient.request<ProductionOrderRaw[]>('/api/v1/production/orders'), perms, userId),
    },
    {
      label: 'فواتير الموردين',
      enabled:
        perms.has('suppliers:view') &&
        (perms.has('suppliers:receive') ||
          perms.has('suppliers:payments:request') ||
          perms.has('suppliers:payments:request_full_balance')),
      load: async () =>
        invoicesToTasks(await apiClient.request<SupplierInvoiceRaw[]>('/api/v1/finance/supplier-invoices'), perms, userId),
    },
    {
      label: 'جلسات الجرد',
      enabled: perms.has('inventory:stocktake:view'),
      load: async () =>
        stocktakesToTasks(await apiClient.request<StocktakeSessionRaw[]>('/api/v1/inventory/stocktakes'), perms),
    },
    {
      label: 'مستندات الخزينة المعلقة',
      enabled: perms.has('finance:cash:approve') && perms.has('finance:cash:view'),
      load: async () =>
        cashDocsToTasks(
          await apiClient.request<CashDocumentRaw[]>(
            '/api/v1/finance/cash-documents?status=pending&approvable_by_me=true'
          )
        ),
    },
    {
      label: 'اعتمادات دليل الأصناف',
      enabled: perms.has('catalog:item:approve') || perms.has('catalog:item:manage_revisions'),
      load: async () => {
        const [items, revisions] = await Promise.all([
          perms.has('catalog:item:approve')
            ? apiClient.request<PendingCatalogItemRaw[]>('/api/v1/catalog/pending-reviews')
            : Promise.resolve([] as PendingCatalogItemRaw[]),
          perms.has('catalog:item:manage_revisions')
            ? apiClient.request<PendingRevisionRaw[]>('/api/v1/catalog/pending-revisions')
            : Promise.resolve([] as PendingRevisionRaw[]),
        ]);
        return catalogToTasks(items, revisions);
      },
    },
    {
      label: 'مستنداتي المالية',
      enabled: Boolean(userId) && perms.has('finance:cash:view') && (perms.has('finance:cash:create') || perms.has('suppliers:payments:request') || perms.has('finance:payments:manage')),
      load: async () =>
        myCashDocsToTasks(await apiClient.request<CashDocumentRaw[]>('/api/v1/finance/cash-documents'), userId as string),
    },
    {
      label: 'أصناف قدّمتُها للدليل',
      enabled: Boolean(userId) && perms.has('catalog:item:submit'),
      load: async () => {
        const [pending, rejected] = await Promise.all([
          apiClient.request<CatalogItemRaw[]>('/api/v1/catalog/items?approval_status=pending_review&limit=250'),
          apiClient.request<CatalogItemRaw[]>('/api/v1/catalog/items?approval_status=rejected&limit=250'),
        ]);
        return myCatalogToTasks(pending, rejected, userId as string);
      },
    },
  ];

  const active = sources.filter((s) => s.enabled);
  const settled = await Promise.allSettled(active.map((s) => s.load()));

  const tasks: TaskItem[] = [];
  const errors: TaskSourceError[] = [];
  settled.forEach((res, idx) => {
    if (res.status === 'fulfilled') {
      tasks.push(...(Array.isArray(res.value) ? res.value.map(enrichTask) : []));
    } else {
      errors.push({ source: active[idx].label, message: errorMessage(res.reason) });
    }
  });

  // ترتيب المهام: العاجلة أولاً ثم الأحدث تاريخاً
  tasks.sort((a, b) => {
    if (a.priority === 'high' && b.priority !== 'high') return -1;
    if (a.priority !== 'high' && b.priority === 'high') return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return { tasks, errors };
}
