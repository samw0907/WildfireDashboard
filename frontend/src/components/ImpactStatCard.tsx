import type { ComponentType } from 'react'

interface ImpactStatCardProps {
  label: string
  icon: ComponentType
  accent: 'red' | 'orange'
  impacted: string | number
  underThreat: string | number
}

// Two related numbers in one card - within-perimeter ("impacted") and
// within-2.4km ("under threat") - rather than four separate full-size
// stat cards competing for the same header row.
export function ImpactStatCard({ label, icon: Icon, accent, impacted, underThreat }: ImpactStatCardProps) {
  return (
    <div className="stat-card impact-card">
      <div className={`stat-icon stat-icon--${accent}`}>
        <Icon />
      </div>
      <div>
        <div className="stat-label">{label}</div>
        <div className="impact-numbers">
          <div className="impact-number">
            <span className={`stat-value stat-value--${accent} impact-value`}>{impacted}</span>
            <span className="impact-number-label">impacted</span>
          </div>
          <div className="impact-number">
            <span className="stat-value stat-value--yellow impact-value">{underThreat}</span>
            <span className="impact-number-label">under threat (2.4km)</span>
          </div>
        </div>
      </div>
    </div>
  )
}
