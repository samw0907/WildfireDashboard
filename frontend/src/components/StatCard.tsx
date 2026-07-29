import type { ComponentType } from 'react'

interface StatCardProps {
  label: string
  value: string | number
  unit?: string
  accent?: 'green' | 'orange' | 'red' | 'yellow'
  icon?: ComponentType
}

export function StatCard({ label, value, unit, accent = 'green', icon: Icon }: StatCardProps) {
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
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
