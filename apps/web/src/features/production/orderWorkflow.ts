/**
 * دورة أمر التشغيل كما يراها الموظف: الخطوات، الحالة الحالية، الخطوة التالية ومن المسؤول عنها،
 * وهل هي من مهام المستخدم الحالي. مصدر واحد تستخدمه قائمة الأوامر وشاشة تفاصيل الأمر.
 * لا يقرر شيئاً بدل الخادم: الصلاحيات هنا لعرض الإجراء المناسب فقط، والخادم يفرضها.
 */
import type { OrderDetailTab } from '@/lib/navigation';
import type { ProductionOrder } from './productionApi';

export const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: 'بانتظار صرف الخامات',
  materials_dispatched: 'خامات في الطريق للورشة',
  in_production: 'قيد التصنيع',
  manufacturing_completed: 'اكتمل التصنيع',
  receipt_completed: 'استُلم المنتج التام',
  completed: 'مكتمل',
  closed: 'مغلق',
};

export type StepState = 'done' | 'current' | 'upcoming';

export interface WorkflowStep {
  id: 'dispatch' | 'wip' | 'stages' | 'fg' | 'settle' | 'close';
  label: string;
  role: string;
  state: StepState;
  detail?: string;
}

export interface NextStep {
  label: string;
  role: string;
  tab: OrderDetailTab;
  /** يستطيع المستخدم الحالي تنفيذها بصلاحياته (ولا يمنعه فصل المسؤوليات) */
  isMine: boolean;
  /** سبب عدم قدرته عليها رغم الصلاحية (مثل: هو من صرف الخامات) */
  blockedReason?: string;
}

const STATUS_ORDER = ['draft', 'materials_dispatched', 'in_production', 'manufacturing_completed', 'receipt_completed', 'closed'];

function statusIndex(status: string): number {
  const normalized = status === 'completed' ? 'receipt_completed' : status;
  const idx = STATUS_ORDER.indexOf(normalized);
  return idx < 0 ? 0 : idx;
}

export function completedStages(order: ProductionOrder): number {
  return order.stage_events.filter((s) => s.status === 'completed').length;
}

export function workflowSteps(order: ProductionOrder): WorkflowStep[] {
  const idx = statusIndex(order.status);
  const stagesDone = completedStages(order);
  const state = (doneFrom: number, currentAt: number): StepState =>
    idx >= doneFrom ? 'done' : idx === currentAt ? 'current' : 'upcoming';
  const returnsPending = (order.returns_awaiting_receipt ?? 0) + (order.returns_awaiting_resolution ?? 0);
  return [
    { id: 'dispatch', label: 'صرف الخامات', role: 'أمين المخزن', state: state(1, 0) },
    { id: 'wip', label: 'استلام الورشة', role: 'مسؤول الإنتاج', state: state(2, 1) },
    {
      id: 'stages',
      label: 'مراحل التصنيع',
      role: 'مسؤول الإنتاج',
      state: state(3, 2),
      detail: idx >= 2 ? `${stagesDone} من 5` : undefined,
    },
    { id: 'fg', label: 'استلام المنتج التام', role: 'أمين المخزن', state: state(4, 3) },
    {
      id: 'settle',
      label: 'تسوية الخامات والمرتجعات',
      role: 'الإنتاج والمخزن',
      state: idx >= 5 ? 'done' : idx === 4 ? 'current' : 'upcoming',
      detail: returnsPending > 0 ? `${returnsPending} مرتجع معلق` : undefined,
    },
    { id: 'close', label: 'إغلاق الأمر', role: 'مسؤول الإنتاج', state: idx >= 5 ? 'done' : 'upcoming' },
  ];
}

export function nextStep(order: ProductionOrder, hasPermission: (p: string) => boolean, userId?: string | null): NextStep | null {
  const me = userId ?? '';
  const awaitingReceipt = order.returns_awaiting_receipt ?? 0;
  const awaitingResolution = order.returns_awaiting_resolution ?? 0;

  // المرتجعات المعلقة تسبق الإغلاق (وهي الخطوة التالية بعد استلام التام)، ولا تحجب خطوات التصنيع قبلها
  const returnsFirst = order.status === 'receipt_completed' || order.status === 'completed';
  if (returnsFirst && awaitingReceipt > 0) {
    const declaredByMe = (order.returns_pending_declared_by ?? []).includes(me);
    return {
      label: 'فحص واستلام مرتجع الورشة',
      role: 'أمين المخزن',
      tab: 'wip',
      isMine: hasPermission('warehouse:returns:receive') && !declaredByMe,
      blockedReason: declaredByMe ? 'أنت من سجّل المرتجع؛ يستلمه غيرك.' : undefined,
    };
  }
  if (returnsFirst && awaitingResolution > 0) {
    const receivedByMe = (order.returns_pending_received_by ?? []).includes(me);
    return {
      label: 'قرار في عجز أو مرفوض المرتجع',
      role: 'مسؤول الإنتاج أو المدير العام',
      tab: 'wip',
      isMine: hasPermission('production:returns:resolve') && !receivedByMe,
      blockedReason: receivedByMe ? 'أنت من أثبت العجز أو الرفض؛ يسوّيه غيرك.' : undefined,
    };
  }

  switch (order.status) {
    case 'draft':
      return { label: 'صرف الخامات من مخزن الخامات', role: 'أمين المخزن', tab: 'materials', isMine: hasPermission('warehouse:dispatch') };
    case 'materials_dispatched': {
      const dispatchedByMe = Boolean(me && order.pending_transfer_dispatched_by === me);
      return {
        label: 'عدّ الخامات بالورشة وتأكيد استلامها',
        role: 'مسؤول الإنتاج',
        tab: 'materials',
        isMine: hasPermission('production:wip:receive') && !dispatchedByMe,
        blockedReason: dispatchedByMe ? 'أنت من صرف الخامات؛ يؤكد استلامها غيرك.' : undefined,
      };
    }
    case 'in_production':
      return {
        label: `تسجيل مراحل التصنيع (${completedStages(order)} من 5)`,
        role: 'مسؤول الإنتاج',
        tab: 'stages',
        isMine: hasPermission('production:stages:manage'),
      };
    case 'manufacturing_completed':
      return {
        label: 'فحص واستلام المنتج التام لكل مقاس',
        role: 'أمين المخزن',
        tab: 'fg_receipt',
        isMine: hasPermission('warehouse:finished_goods:receive'),
      };
    case 'receipt_completed':
    case 'completed':
      return {
        label: 'تسوية خامات الورشة ثم إغلاق الأمر',
        role: 'مسؤول الإنتاج',
        tab: 'wip',
        isMine: hasPermission('production:orders:manage') || hasPermission('production:orders:close'),
      };
    default:
      return null;
  }
}
