interface StatCardProps {
  label: string
  value: string | number
  unit?: string
  accent?: 'green' | 'orange'
}

export function StatCard({ label, value, unit, accent = 'green' }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className={`stat-value stat-value--${accent}`}>
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  )
}
