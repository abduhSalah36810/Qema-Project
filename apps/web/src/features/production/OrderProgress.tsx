import type { ProductionOrder } from './productionApi';
import { workflowSteps, type nextStep } from './orderWorkflow';

/**
 * شريط تقدم أمر التشغيل: ما تم، ما يجري الآن، ومن صاحب الخطوة التالية.
 * يُعرض أعلى شاشة الأمر حتى يفهم أي موظف موقع الأمر دون فتح التبويبات.
 */
interface Props {
  order: ProductionOrder;
  hasPermission?: (permission: string) => boolean;
  userId?: string | null;
  onGoToStep?: (tab: NonNullable<ReturnType<typeof nextStep>>['tab']) => void;
}

export function OrderProgress({ order }: Props) {
  const steps = workflowSteps(order);
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
    </section>
  );
}
