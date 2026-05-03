# AgentEnvoy — Design Spec

Living reference for cross-cutting design systems. Append a new section when a new system is established. Each section should be short enough to read in 2 minutes and answer: _what is it, how does it work, how do I add more_.

---

## Contextual Help Bubbles

**Added:** 2026-05-03  
**Files:** `src/components/bubbles/`, `src/components/mobile/mobile-panels-context.tsx`, `src/components/theme-preference-sync.tsx`

### What it is

Small, dismissible FYI cards that appear in context to teach users about AE as they use it — the right feature at the right moment, not a tour. The first one appears at night when AE silently switches to dark mode and explains why. More are expected as new features ship.

Design goals:
- **Contextually triggered** — each bubble knows _when_ to appear (time of day, user state, feature usage), not just _that_ it should appear
- **One-shot** — dismissed state is server-persisted so the bubble doesn't come back after the user acts on it
- **No dead ends** — every CTA opens the correct surface for the device (drawer on mobile, route on desktop)
- **Same family** — all bubbles share the same shell so they read as a consistent system

### Components

| File | Role |
|------|------|
| `src/components/bubbles/help-bubble.tsx` | Presentational shell — bottom-right card, dismiss ×, optional action button |
| `src/components/bubbles/targets.ts` | `BubbleTarget` union type + `TARGET_MAP` (logical destination → route + optional mobile panel) |
| `src/components/bubbles/use-open-target.ts` | Hook: given a `BubbleTarget`, opens the drawer on mobile or pushes the route on desktop |

### Adding a new bubble

Each bubble owns three things:

1. **Trigger logic** — a condition checked at runtime. Can be time-of-day, user preference state, onboarding phase, feature usage flag, anything. Mount the bubble only when the condition is true.
2. **Persistence** — whether the user has dismissed. Server-persisted via a `seen<X>` boolean in `User.preferences.explicit.*`, written through `PUT /api/me/ui-prefs` (see existing `seenThemeModeExplainer` as the reference). For ephemeral state (session-only), localStorage is acceptable.
3. **Copy + target** — the message and where "Open ___" takes the user.

The shell (`HelpBubble`) takes those as props:

```tsx
import { HelpBubble } from "@/components/bubbles/help-bubble";

// In a client component, when the trigger fires:
if (shouldShow) {
  return (
    <HelpBubble
      id="my-feature-tip"          // stable — used for data-testid
      message="Try setting office hours — guests will see your real availability instead of a blank form."
      target="availability"        // logical destination from targets.ts
      targetLabel="Open availability"
      onDismiss={dismissAndPersist}
    />
  );
}
```

`onDismiss` should both hide the bubble locally and persist the dismissal so it doesn't reappear:

```ts
const dismissAndPersist = async () => {
  setShow(false);
  seenRef.current = true;
  await fetch("/api/me/ui-prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seenMyFeatureTip: true }),
  });
};
```

Don't forget to extend the `/api/me/ui-prefs` GET response to include the new flag, and add it to the Prisma `preferences` JSON shape.

### Targets

Add new targets to `src/components/bubbles/targets.ts`. If the destination has a mobile drawer counterpart, set `mobilePanel`. If not (e.g. connectors), omit it and the resolver will navigate on both surfaces:

```ts
export const TARGET_MAP: Record<BubbleTarget, TargetMapping> = {
  preferences:  { route: "/dashboard/account",          mobilePanel: "preferences" },
  availability: { route: "/dashboard/availability",     mobilePanel: "availability" },
  eventLinks:   { route: "/dashboard/event-links",      mobilePanel: "eventLinks" },
  connectors:   { route: "/dashboard/account/connectors" },   // no drawer — full-page both ways
  // add new targets here
};
```

Also extend the `BubbleTarget` union type in the same file.

### Mobile drawer plumbing

`MobilePanelsProvider` (in `src/components/mobile/mobile-panels-context.tsx`) owns the slide-in drawer state at the dashboard layout level. Any descendant can call `useMobilePanels().openPanel("preferences")`. The provider mounts `<PreferencesDrawer>`, `<EventLinksSheet>`, and `<AvailabilityDrawer>` once; `MobileDashboardHeader` reads state from it rather than owning it.

If you add a new mobile drawer, add it to the provider and extend `MobilePanelName`.

### Where bubbles mount

Currently, each bubble mounts itself as a `position: fixed` element from wherever it's rendered in the tree (e.g. `ThemePreferenceSync` in `Providers`). This is fine while there's at most one bubble visible at a time. When we have multiple bubbles that could co-exist, we'll need a small scheduler that stacks them or queues display — that's a future problem once we have 3+ bubbles.

---

## Mobile Panels

**Added:** 2026-05-03  
**Files:** `src/components/mobile/mobile-panels-context.tsx`

`MobilePanelsProvider` wraps the dashboard layout and owns the open/close state for all mobile slide-in panels. It also centralises body-scroll-lock and Escape key handling so any opener (header button, help bubble, deep-link CTA) gets the same chrome for free.

Add a new panel:
1. Create the drawer/sheet component with `open: boolean` and `onClose: () => void` props
2. Add its name to `MobilePanelName` in `mobile-panels-context.tsx`
3. Mount it inside the provider alongside the existing three
4. Add its entry to `TARGET_MAP` in `targets.ts` if a bubble or CTA should be able to open it
