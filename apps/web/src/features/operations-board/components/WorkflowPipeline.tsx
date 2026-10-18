import type { FlowStep } from '../mockData';

interface WorkflowPipelineProps {
  steps: FlowStep[];
}

export function WorkflowPipeline({ steps }: WorkflowPipelineProps) {
  return (
    <section className="flow" aria-label="مراحل التشغيل">
      {steps.map((step, idx) => (
        <div
          key={step.id}
          className={[
            'flow-step',
            step.state === 'done' ? 'flow-step--done' : '',
            step.state === 'current' ? 'flow-step--current' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className="flow-step__top">
            <span className="flow-step__no">{step.number}</span>
            {step.label}
          </div>
          <div className="flow-step__title">{step.title}</div>
          <div className="flow-step__desc">{step.description}</div>
          {idx < steps.length - 1 && (
            <span className="flow-step__chevron" aria-hidden>‹</span>
          )}
        </div>
      ))}
    </section>
  );
}
