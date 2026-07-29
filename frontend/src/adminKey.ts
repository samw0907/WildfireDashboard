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
//
// Deliberately sessionStorage, not localStorage: the key should be
// forgotten when the tab/window closes, not cached indefinitely - a
// shared/public machine shouldn't stay "logged in" across browser
// sessions just because someone entered the key once, weeks ago.

const STORAGE_KEY = 'wildfiredashboard-admin-key'

type Resolver = (value: string | null) => void

let pendingResolvers: Resolver[] = []
let showModal: (() => void) | null = null

export function getStoredAdminKey(): string | null {
  return sessionStorage.getItem(STORAGE_KEY)
}

export function clearStoredAdminKey(): void {
  sessionStorage.removeItem(STORAGE_KEY)
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
  sessionStorage.setItem(STORAGE_KEY, value)
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
