// Small "?" hint badge with a native hover tooltip - used sparingly, only
// on fields whose meaning genuinely isn't obvious (priority score,
// incident complexity, population methodology), not on self-explanatory
// fields like acreage or dates.
export function InfoHint({ text }: { text: string }) {
  return (
    <span className="info-hint" title={text}>
      ?
    </span>
  )
}
