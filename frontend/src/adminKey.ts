// Shared admin-key gate for frontend-facing costly actions (mark-for-
// acquisition, confirm-and-proceed, etc.) - a single shared secret, not a
// login system. See DECISIONS.md for why: no multi-user need on a single-
// operator demo site, so a browser-local shared secret is proportionate.

const STORAGE_KEY = 'wildfiredashboard-admin-key'

export function getStoredAdminKey(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}

export function clearStoredAdminKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** Returns a key, prompting the user once if none is stored yet. */
export function getOrPromptAdminKey(): string | null {
  const existing = getStoredAdminKey()
  if (existing) return existing

  const entered = window.prompt('Enter admin key to continue:')
  if (entered) localStorage.setItem(STORAGE_KEY, entered)
  return entered
}
