"""Shared admin-key gate for frontend-facing costly actions (mark-for-
acquisition, confirm-and-proceed, etc.) - a single shared secret prompted
once in the browser, not a full login/session system. See DECISIONS.md
for why: no multi-user need exists on a single-operator demo site, so
password hashing/sessions would be real complexity for no benefit over a
shared secret gating a handful of actions."""

from fastapi import Header, HTTPException

from .config import get_settings


def require_admin_key(x_admin_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    # Fail closed: if no key is configured server-side, every request is
    # refused rather than silently allowing unauthenticated access.
    if not settings.admin_access_key or x_admin_key != settings.admin_access_key:
        raise HTTPException(status_code=403, detail="Invalid or missing admin key")
