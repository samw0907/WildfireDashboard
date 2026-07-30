// Shared loading state for full-page fetches (dashboard, fire detail) -
// a spinning ring instead of plain "Loading…" text, since some of these
// fetches can take up to ~10s.
export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-loading">
      <div className="spinner" />
      <p>{label}</p>
    </div>
  )
}
