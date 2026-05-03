# AgentEnvoy — Change Log

Running record of significant design decisions and feature additions. Most recent first. Bug fixes and refactors that don't change product behaviour are omitted; check git log for those.

---

## 2026-05-03 — Contextual help-bubble system + mobile preferences fix

**Branch:** `claude/help-bubble-system-nvVmP`

### What shipped

**Help bubble system** — foundation for contextually-triggered FYI nudges that teach users about AE features in the moment rather than via a tour.

- `src/components/bubbles/help-bubble.tsx` — reusable shell: bottom-right card, dismiss ×, optional "Open ___" action button
- `src/components/bubbles/targets.ts` — `BubbleTarget` type + `TARGET_MAP` (logical destination → route + optional mobile panel)
- `src/components/bubbles/use-open-target.ts` — hook that resolves a `BubbleTarget` to the correct surface: slide-in drawer on mobile (via `useMobilePanels`), full-page route push on desktop

**Mobile panels lifted to layout** — drawer state moved from `MobileDashboardHeader` (where only the avatar could open it) into a shared `MobilePanelsProvider` at the dashboard layout level.

- `src/components/mobile/mobile-panels-context.tsx` — new context; owns `prefsOpen / linksOpen / availabilityOpen` state, body-scroll-lock, and Escape handling. Mounts the three drawers once.
- `src/components/mobile/mobile-dashboard-header.tsx` — simplified: calls `openPanel(...)` instead of owning state; drawers removed from its render output.
- `src/app/dashboard/layout.tsx` — wrapped in `<MobilePanelsProvider>`.

**Dark-mode bubble migrated** — `src/components/theme-preference-sync.tsx` now uses `<HelpBubble>` + `useOpenTarget` instead of inline JSX with a hard-coded `href`. The "Open preferences →" action correctly opens the drawer on mobile instead of navigating to the full-page route.

**Mobile back affordance on `/dashboard/account`** — `src/app/dashboard/account/page.tsx` now has a `md:hidden` "← Back to dashboard" chip at the top so mobile users who arrive via direct URL, external link, or any CTA that bypasses the drawer are never stranded.

### Why

The dark-mode auto-flip bubble had a "Open preferences →" link that hard-coded `/dashboard/account`. On mobile that route renders as a full-page view inside the dashboard shell, but the mobile shell doesn't expose the same escape affordances as desktop (no sticky avatar-nav), so the user was stuck. The real mobile preferences UI is a slide-in drawer opened from the header avatar.

Root cause: the drawer state was locked inside `MobileDashboardHeader`, so nothing else could open it. Lifting state into `MobilePanelsProvider` makes the drawer accessible from anywhere, and the `useOpenTarget` hook makes sure every bubble CTA picks the right surface automatically.

### Persistence pattern (reference for future bubbles)

The dark-mode bubble already uses `User.preferences.explicit.seenThemeModeExplainer` (boolean, server-persisted via `PUT /api/me/ui-prefs`). New bubbles follow the same pattern: add a `seen<BubbleName>` field, read it in the UI-prefs GET, write it on dismiss. See `spec.md §Contextual Help Bubbles` for the full recipe.

---

## 2026-04-08 — Availability pipeline + FAQ page

See `.claude/handoffs/profile-ui-cleanup.md` for full context. Key additions:

- Scoring engine (`src/lib/scoring.ts`) — slots scored -2 (exclusive) to 5 (immovable)
- Calendar cache (`src/lib/calendar.ts`) — incremental Google Calendar sync
- Score-aware color mapping in `availability-calendar.tsx`
- FAQ page at `/faq` with shared `PublicHeader`

---

_Earlier entries to be back-filled from git log as needed._
