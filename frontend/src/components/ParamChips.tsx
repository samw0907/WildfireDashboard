interface ParamChip {
  label: string
  value: string
}

export function ParamChips({ params }: { params: ParamChip[] }) {
  return (
    <div className="param-chip-row">
      {params.map((p) => (
        <div key={p.label} className="param-chip">
          <div className="param-chip-label">{p.label}</div>
          <div className="param-chip-value">{p.value}</div>
        </div>
      ))}
    </div>
  )
}
