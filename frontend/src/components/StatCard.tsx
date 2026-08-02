import type { ComponentType } from 'react'
import { InfoHint } from './InfoHint'

interface StatCardProps {
  label: string
  value: string | number
  unit?: string
  accent?: 'green' | 'orange' | 'red' | 'yellow'
  icon?: ComponentType
  hint?: string
}

export function StatCard({ label, value, unit, accent = 'green', icon: Icon, hint }: StatCardProps) {
  return (
    <div className="stat-card">
      {Icon && (
        <div className={`stat-icon stat-icon--${accent}`}>
          <Icon />
        </div>
      )}
      <div>
        <div className={`stat-value stat-value--${accent}`}>
          {value}
          {unit && <span className="stat-unit">{unit}</span>}
        </div>
        <div className="stat-label">
          {label}
          {hint && <InfoHint text={hint} />}
        </div>
      </div>
    </div>
  )
}
