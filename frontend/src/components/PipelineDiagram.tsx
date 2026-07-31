export interface PipelineStep {
  number: string
  eyebrow: string
  title: string
  bullets: string[]
  accent: 'red' | 'orange' | 'yellow' | 'green'
}

interface PipelineDiagramProps {
  steps: PipelineStep[]
}

export function PipelineDiagram({ steps }: PipelineDiagramProps) {
  return (
    <div className="pipeline-diagram">
      {steps.map((step, i) => (
        <div key={step.number} className="pipeline-step-wrap">
          <div className={`pipeline-step pipeline-step--${step.accent}`}>
            <div className="pipeline-step-eyebrow">
              {step.number} · {step.eyebrow}
            </div>
            <div className="pipeline-step-title">{step.title}</div>
            <ul className="pipeline-step-bullets">
              {step.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
          {i < steps.length - 1 && <div className="pipeline-arrow">→</div>}
        </div>
      ))}
    </div>
  )
}
