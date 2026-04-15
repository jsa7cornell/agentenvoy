# Handoff: Onboarding — How New Features Tie In

> For any agent adding a feature that introduces a user preference. **Read this before you ship a feature that needs to be configured.** The question isn't "should I add it to onboarding" — it's "what's the right way to get it in front of a new user without bloating the flow?"

## The Live Design — Read This First

AgentEnvoy's onboarding is a **conversational flow inside the dashboard feed**, not a dedicated page. When a new user first lands on `/dashboard`, `feed.tsx` detects `!user.lastCalibratedAt`, flips into `isOnboarding` mode, and starts calling `/api/onboarding/chat`. The user sees the normal Envoy chat UI with numbered quick replies; they don't know they're on a special screen.

**There is no `/onboarding` route in active use.** `src/app/onboarding/page.tsx` is a redirect shim left over from an earlier design. Don't build new UI there — build it in the feed's onboarding mode.

### Files that matter

| File | Role |
|------|------|
| `src/lib/onboarding-machine.ts` | State machine: phases, message templates, transition map. Pure functions, no I/O. |
| `src/app/api/onboarding/chat/route.ts` | GET returns current phase + messages; POST processes a user response, writes preferences, returns the next phase. Resume-safe via `User.onboardingPhase`. |
| `src/components/feed.tsx` | Client — detects uncalibrated users, renders the chat, POSTs responses, switches to normal mode when `onboardingComplete` comes back. |
| `src/components/onboarding/quick-replies.tsx` | The numbered-button row. The only onboarding-specific component the feed imports. |
| `src/app/api/debug/onboarding-reset/route.ts` | Dev-only `POST` — `mode: "reset"` wipes calibration/prefs/cache; `mode: "create"` spawns a throwaway test user. Used by the Dev Tools section on `/dashboard/account`. |

**Dead code to ignore (will be deleted):** `src/components/onboarding/onboarding-chat.tsx`, `inline-calendar.tsx`, `simulated-deal-room.tsx`. These belonged to an abandoned dedicated-page design.

### The current phase list (as of 2026-04-14)

```
intro              — welcome + timezone confirm (inline picker + freetext fallback)
defaults_format    — phone / Google Meet / Zoom / in-person / none
phone_number       — conditional, only if format = phone
zoom_link          — conditional, only if format = zoom
defaults_duration  — 15 / 30 / 45 / 60
defaults_buffer    — 0 / 10 / 15 / 30 (creates a structured AvailabilityRule)
calendar_rules     — business hours window
calendar_evenings  — evening posture → persistentKnowledge
complete           — sets lastCalibratedAt, shows welcome, invalidates schedule
```

Conditional phases (`phone_number`, `zoom_link`) are skipped via flags in the POST handler based on the previous answer. See `route.ts` for the skip logic.

### What gets saved where

| Phase | Writes to | Via |
|---|---|---|
| `intro` | `preferences.explicit.timezone` | direct Prisma update (validated with `safeTimezone`) |
| `defaults_format` | `preferences.explicit.defaultFormat`, `.videoProvider` | direct |
| `phone_number` | `preferences.explicit.phone` | direct |
| `zoom_link` | `preferences.explicit.zoomLink` | direct |
| `defaults_duration` | `preferences.explicit.defaultDuration` | direct |
| `defaults_buffer` | `preferences.explicit.structuredRules[]` (append) | AvailabilityRule with `action: "buffer"` |
| `calendar_rules` | `preferences.explicit.businessHoursStart/End` | direct |
| `calendar_evenings` | `persistentKnowledge` (appended line) | direct |
| `complete` | `lastCalibratedAt`, `onboardingPhase`, calls `invalidateSchedule()` | direct |

**Canonical keys:** everything structured goes to `preferences.explicit.*`. The top-level `preferences.timezone` and `preferences.*` legacy fields are deprecated — never write there. Persistent free text goes to `persistentKnowledge`. Near-term context goes to `upcomingSchedulePreferences`. Availability-engine rules go to `preferences.explicit.structuredRules[]` — see `onboarding-availability-rules.md` for the rule shape.

### Timezone handling — already correct, don't regress it

- Onboarding reads the detected tz via `getUserTimezone(prefs)` from `@/lib/timezone` — the canonical module
- The picker is sourced from `TIMEZONE_TABLE`, not hardcoded
- Labels use `longTimezoneLabel(iana)` for prose and `shortTimezoneLabel(iana)` for chrome
- Writes go to `preferences.explicit.timezone` after `safeTimezone()` validation
- **LLMs never emit IANA strings.** The state machine is deterministic; no free-text → LLM → timezone path exists. Keep it that way.

## The Integration Rules — Read This Before You Ship Anything

When you add a feature that needs a user preference, ask in order:

### 1. Does it actually need to be set before first use?

Most preferences **don't**. Good defaults get the user to first value fast. Examples of things that ship with sane defaults and surface later:
- Rule priorities (default 3)
- Posture modes (default "balanced")
- Notification preferences
- Dark/light theme (detects from system)
- Which Google calendars to sync (defaults to all)

If a sensible default exists and the feature works for 80% of users without asking, **don't touch onboarding**. Ship with the default, surface the setting on `/dashboard/account` or the feature's own page, and let users discover it when they need it.

### 2. If they do need to set it, can they set it the first time they use the feature?

Some preferences are better captured at point of use. Example: the `per-invite format override` — you could ask in onboarding "what's your default override behavior?" but it's clearer to ask the first time they create a custom invite, when the context is visible. That's not onboarding; that's first-use configuration.

### 3. Only if neither of the above, add a phase.

A new phase is justified when **all** of these are true:
- The preference materially affects how Envoy behaves for every user, not just users of one feature
- A wrong default would produce visibly bad results (not just suboptimal — actually bad)
- It can be answered in ≤10 seconds with a small number of quick replies
- Skipping it would require a bigger explanation later

If any of those fail, the feature doesn't belong in onboarding. Put it on the account page.

### Examples

| Feature | Belongs in onboarding? | Why |
|---|---|---|
| Default meeting format (phone/video/in-person) | ✅ Yes — already there | Affects every invite; wrong default is wrong for every meeting |
| Business hours | ✅ Yes — already there | Core scheduling constraint; no sane universal default |
| Buffer between meetings | ✅ Yes — already there | Baseline availability; needed for the scoring engine to produce useful output |
| "Preferred video provider" within video | ✅ Yes — already there, inside `defaults_format` | Conditional, only asked if user picks video |
| Timezone | ✅ Yes — already there, with auto-detect | Everything else is meaningless without it |
| Per-invite format override rules | ❌ No — first-use | Only matters when they create a custom invite |
| RFP negotiation defaults | ❌ No — first-use | Phase 1b feature, most users won't use it |
| Rule priority weights | ❌ No — good default | Default of 3 is fine; surface in the rule editor |
| Light/dark mode | ❌ No — system default | `next-themes` handles it |
| Which Google calendars to sync | ❌ No — good default | Default "all" works; surface on availability page |
| Default meeting location | ❓ Maybe — depends | If most users have one, a quick reply is cheap. If it varies, let them set it per-invite. |

**Bias toward "no."** The onboarding flow takes ~60 seconds today. Every phase you add taxes every new user forever. A new phase must earn its place.

## How to Add a Phase

If you've decided a phase is justified, here's the checklist. Don't skip steps — the state machine is resume-safe and skipping steps will break that.

### 1. Add the phase name to the union type

In `src/lib/onboarding-machine.ts`:

```typescript
export type OnboardingPhase =
  | "intro"
  | "defaults_format"
  // ...
  | "your_new_phase"  // ← add here
  | "complete";
```

### 2. Write the phase handler

Pure function — takes `OnboardingContext` (and maybe options), returns `PhaseResult`. No I/O, no DB calls, no `fetch`. Follow the existing pattern:

```typescript
export function getYourNewPhaseMessages(): PhaseResult {
  return {
    phase: "your_new_phase",
    messages: [
      {
        content: `Short explanation of what this sets and why. Reassure they can change it later.`,
        options: [
          { number: 1, label: "Option A", value: "a" },
          { number: 2, label: "Option B", value: "b" },
        ],
      },
    ],
  };
}
```

**Copy guidelines:**
- Every click should set something. No "Let's go" / "Sounds good" filler phases.
- Give context: what is this, why are we asking, what happens if they pick wrong
- Reassure: "you can change this later" or "I'll use this as a default, you can override per-invite"
- ≤5 options in a quick reply. If you need more, use regional grouping (see timezone picker) or freetext with an `"other"` escape hatch
- Never auto-advance a phase with no user input unless you have a really good reason (breaks the user's sense of control)

### 3. Add it to `PHASE_ORDER`

In the same file:

```typescript
const PHASE_ORDER: OnboardingPhase[] = [
  "intro",
  "defaults_format",
  // ...
  "your_new_phase",   // ← in the right position
  "complete",
];
```

`nextPhase()` walks this array, so position determines flow order.

### 4. Wire the handler into the API route

In `src/app/api/onboarding/chat/route.ts`:

**4a.** Import the new handler at the top.

**4b.** Add a case to the big `switch (currentPhase)` block that processes the response and writes to the DB. Use `getFreshPrefs(user.id)` before writing if prior phases may have updated prefs in the same session. Always write via the `updatePrefs` helper so the `preferences.explicit` nesting stays correct.

**4c.** Add a case to `getMessagesForPhase()` that calls your new handler.

**4d.** If the phase is conditional (only asked when a prior answer has a certain value), follow the `skipPhoneNumber` / `skipZoomLink` pattern — set a flag in the prior case, then skip-ahead logic after the switch.

### 5. Consider the reset endpoint

`src/app/api/debug/onboarding-reset/route.ts` wipes prefs on reset. If your phase writes to a field that reset should clear, verify `mode: "reset"` does the right thing. It currently replaces `preferences` with `{ explicit: { timezone } }`, which wipes everything except timezone — so new `.explicit.*` fields are automatically cleared. But if you write outside `.explicit` (you shouldn't), reset won't know.

### 6. Verify resume

Open the app, start onboarding, complete your new phase and the next one, then hit the reset endpoint with a tweak (or clear `lastCalibratedAt` manually). Reload and make sure the flow resumes at the right phase, showing the right state.

### 7. Update this doc

Add your phase to the table above. Note what it saves and via what mechanism. Future agents thank you.

### 8. Mention it in the LOG

`agentenvoy/LOG.md` gets an entry for material onboarding changes. Short — one line: "Added `your_new_phase` — captures X at step N."

## What NOT to Do

- **Don't build a parallel onboarding UI.** The dashboard-feed flow is the only one. If you think a dedicated page would be better, talk to John first — this was explicitly decided against in commit `9eb2252`.
- **Don't let the LLM drive the flow.** The state machine is deterministic. LLMs are used only for (a) parsing freetext into structured rules via `/api/tuner/parse-rule`, (b) contextual reactions after a phase lands. Never for branching logic, never for timezone inference, never for "which phase next."
- **Don't add a phase that duplicates a feature-level setting.** If the availability page already has a UI for it, don't rebuild that UI in onboarding. Deep-link or use the same API (see `onboarding-availability-rules.md` for the pattern).
- **Don't write to top-level `preferences.*`.** Everything structured goes to `preferences.explicit.*`. The legacy top-level keys (`preferences.timezone`, etc.) are deprecated. `getUserTimezone()` logs a warning if it reads them.
- **Don't add a phase with ≥8 quick-reply options.** Break it into regions (see timezone picker) or use a freetext input with a help hint.
- **Don't forget conditional skip logic.** If your phase is conditional, make sure the skip flag is set in the prior phase's case block AND the skip-ahead logic runs after the switch. Missing either one produces dead phases that fire for users who shouldn't see them.
- **Don't touch `lastCalibratedAt` outside the `complete` handler.** That's the field that means "done with onboarding." Setting it early breaks the resume flow.

## Testing Your Changes

There's no formal onboarding test suite yet. Manual flow:

1. Go to `/dashboard/account` → Dev Tools → **Reset & Test Onboarding** (wipes your calibration state and redirects to `/dashboard`)
2. Walk through the flow. Hit every path, including conditional branches.
3. Verify saved preferences: `/dashboard/account` shows most; for the rest, query Prisma directly or look at the `/api/tuner/preferences` GET response.
4. Resume test: complete phases 1-3, reload the page, confirm you land at phase 4 not phase 1.
5. Mobile check: 375px width. Quick replies should stack, not overflow.

When adding a phase that writes to `structuredRules` or business hours, **also verify** that `/dashboard/availability` shows the new rule correctly after onboarding completes. `invalidateSchedule()` runs on `complete`, so the scoring engine should pick it up immediately.

## Related Docs

- `agentenvoy/PLAYBOOK.md` → "Onboarding (dashboard-feed chat)" section — the short version of this doc
- `agentenvoy/app/.claude/handoffs/onboarding-availability-rules.md` — how to write availability rules from onboarding (business hours, buffers, blocks)
- `agentenvoy/SPEC.md` → preferences schema — what fields exist and what they mean
- `src/lib/timezone.ts` — canonical timezone module (read the top comment)
