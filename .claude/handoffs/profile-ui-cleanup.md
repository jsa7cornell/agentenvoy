# Handoff: Profile Page UI Cleanup

**From session:** AgentEnvoy — Availability pipeline + FAQ + deploy — 2026-04-08
**Next session name:** `AgentEnvoy — Profile page UI cleanup — 2026-04-08`

---

## What Just Shipped

The availability pipeline is fully deployed and live. Key pieces:

1. **Scoring engine** (`src/lib/scoring.ts`) — scores every 30-min slot from -2 (exclusive) to 5 (immovable)
2. **Calendar cache** (`src/lib/calendar.ts`) — incremental Google Calendar sync with inputHash-based invalidation
3. **Profile → schedule invalidation** — editing knowledge fields on the profile page triggers `invalidateSchedule()` via `PUT /api/agent/knowledge`
4. **`extractTemporalOverrides()`** — parses free-text preferences ("I surf 8-10 AM") into scored blocked windows
5. **Score -2 exclusive mode** — replaces the old `exclusiveSlots` boolean
6. **Widget colors** — full score-aware color mapping in `availability-calendar.tsx`
7. **FAQ page** (`/faq`) with `PublicHeader` component shared across public pages
8. **LLM prompt sync** — `formatComputedSchedule()` in `composer.ts` includes exclusive tier

All committed and force-deployed. Working tree is clean.

---

## Profile Page: Current State

**File:** `src/app/dashboard/profile/page.tsx` (484 lines)

### Current sections (top to bottom):
1. **Profile header** — avatar, name, email, sign out button
2. **Connections** — Google Calendar tile (functional) + "Other" calendar placeholder + 3x AI Agent placeholders ("Soon")
3. **Upcoming Schedule Context** — textarea for `upcomingSchedulePreferences` (with InfoBubble + Save button)
4. **General Preferences** — textarea for `persistentKnowledge` (with InfoBubble, shares the same Save button)
5. **Active Meetings** — list of active negotiation sessions with status badges
6. **Archived Meetings** — link to `/dashboard/archive`
7. **Google Calendar modal** — disconnect flow

### Data flow:
- Reads from: `GET /api/connections/status`, `GET /api/agent/knowledge`, `GET /api/negotiate/sessions?archived=false`
- Writes to: `PUT /api/agent/knowledge` (both textareas share one Save button)
- Profile save triggers `invalidateSchedule()` server-side

### Components used:
- `DashboardHeader` (not `PublicHeader` — this is the authenticated dashboard header)
- `InfoBubble` (defined inline in the same file)

### Known rough edges:
- The two textareas share a single Save button that lives in the "Upcoming Schedule Context" section header — easy to miss that it also saves General Preferences
- AI Agents placeholder grid (3 identical "Soon" tiles) takes up visual space for no current value
- InfoBubble component is defined inline rather than extracted
- No visual feedback connecting the two text fields to the scoring pipeline (user doesn't know their text is being parsed into blocked windows)
- The page is one long scroll — no visual hierarchy distinguishing "things you edit" from "things you view"

---

## Key Files to Reference

| File | Why |
|------|-----|
| `src/app/dashboard/profile/page.tsx` | The page itself |
| `src/components/dashboard-header.tsx` | Authenticated header used on dashboard pages |
| `src/app/api/agent/knowledge/route.ts` | GET/PUT for knowledge fields + invalidateSchedule |
| `src/lib/scoring.ts` | `extractTemporalOverrides()` — parses the text fields |
| `src/components/public-header.tsx` | Reference for consistent header pattern |
| `src/app/layout.tsx` | Global layout with footer |

---

## Launch Config

```json
{
  "name": "agentenvoy-dev",
  "runtimeExecutable": "/bin/sh",
  "runtimeArgs": ["-c", "cd /Users/ja/AI\\ Brain/agentenvoy/app && PATH=/opt/homebrew/bin:$PATH op run --env-file=.env.tpl -- npx next dev"],
  "port": 3000
}
```

---

## Deploy

```bash
cd "/Users/ja/AI Brain/agentenvoy/app" && npx vercel --prod --force
```

Git-triggered deploys have been flaky (0ms build failures). Force deploy via CLI works reliably.
