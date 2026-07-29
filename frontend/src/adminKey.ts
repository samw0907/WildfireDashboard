// Shared admin-key gate for frontend-facing costly actions (mark-for-
// acquisition, confirm-and-proceed, etc.) - a single shared secret, not a
// login system. See DECISIONS.md for why: no multi-user need on a single-
// operator demo site, so a browser-local shared secret is proportionate.
//
// Uses an in-page modal (AdminKeyModal, mounted once in Layout) rather
// than window.prompt() - confirmed live that embedded browser views (e.g.
// VSCode's preview pane) silently no-op window.prompt() instead of
// showing a dialog, which made the whole flow fail with no visible
// feedback. A real DOM modal works in every context a page can render in.

const STORAGE_KEY = 'wildfiredashboard-admin-key'

type Resolver = (value: string | null) => void

let pendingResolvers: Resolver[] = []
let showModal: (() => void) | null = null

export function getStoredAdminKey(): string | null {
  return localStorage.getItem(STORAGE_KEY)
}

export function clearStoredAdminKey(): void {
  localStorage.removeItem(STORAGE_KEY)
}

/** Called once by AdminKeyModal on mount to register itself as the thing
 * that pops up when a key is needed. */
export function registerAdminKeyModal(trigger: () => void): void {
  showModal = trigger
}

/** Returns a key, prompting via the modal once if none is stored yet. */
export function getOrPromptAdminKey(): Promise<string | null> {
  const existing = getStoredAdminKey()
  if (existing) return Promise.resolve(existing)

  return new Promise((resolve) => {
    pendingResolvers.push(resolve)
    showModal?.()
  })
}

/** Called by AdminKeyModal when the user submits a value. */
export function submitAdminKey(value: string): void {
  localStorage.setItem(STORAGE_KEY, value)
  const resolvers = pendingResolvers
  pendingResolvers = []
  resolvers.forEach((resolve) => resolve(value))
}

/** Called by AdminKeyModal when the user cancels. */
export function cancelAdminKey(): void {
  const resolvers = pendingResolvers
  pendingResolvers = []
  resolvers.forEach((resolve) => resolve(null))
}
