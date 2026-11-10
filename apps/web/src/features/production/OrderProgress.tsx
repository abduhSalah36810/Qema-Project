import type { ProductionOrder } from './productionApi';
import { nextStep, workflowSteps } from './orderWorkflow';

/**
 * شريط تقدم أمر التشغيل: ما تم، ما يجري الآن، ومن صاحب الخطوة التالية.
 * يُعرض أعلى شاشة الأمر حتى يفهم أي موظف موقع الأمر دون فتح التبويبات.
 */
interface Props {
  order: ProductionOrder;
  hasPermission: (permission: string) => boolean;
  userId?: string | null;
  onGoToStep?: (tab: NonNullable<ReturnType<typeof nextStep>>['tab']) => void;
}

export function OrderProgress({ order, hasPermission, userId, onGoToStep }: Props) {
  const steps = workflowSteps(order);
  const next = nextStep(order, hasPermission, userId);
  return (
    <section className="order-progress" aria-label="تقدم أمر التشغيل">
      <ol className="order-progress__steps">
        {steps.map((step, i) => (
          <li key={step.id} className={`order-progress__step order-progress__step--${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
            <span className="order-progress__dot" aria-hidden>{step.state === 'done' ? '✓' : i + 1}</span>
            <span className="order-progress__label">{step.label}</span>
            <small className="order-progress__role">{step.detail ?? step.role}</small>
          </li>
        ))}
      </ol>
      {order.status === 'closed' ? (
        <p className="order-progress__next order-progress__next--done">✓ الأمر مغلق؛ لا توجد خطوات متبقية.</p>
      ) : next ? (
        <div className={`order-progress__next ${next.isMine ? 'order-progress__next--mine' : ''}`}>
          <div>
            <strong>{next.isMine ? 'الخطوة التالية عندك: ' : 'الخطوة التالية: '}</strong>
            {next.label}
            {!next.isMine && <span> — يقوم بها {next.role}</span>}
            {next.blockedReason && <small className="order-progress__blocked">{next.blockedReason}</small>}
          </div>
          {next.isMine && onGoToStep && (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => onGoToStep(next.tab)}>
              انتقل للخطوة
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}
