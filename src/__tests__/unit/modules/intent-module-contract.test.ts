/**
 * Intent-module contract test.
 *
 * Per proposal §2.10 + bug fix item #9 (intent-chat.test.ts drift): every
 * host intent in `HOST_CHAT_INTENT_VALUES` must have a registered module
 * on the `dashboard-host` surface. Asserting against the canonical enum
 * (not a frozen literal array) makes drift between enum + modules
 * structurally impossible — the test fails the moment they diverge.
 *
 * PR1a ships this test with an explicit "still-migrating" allowlist (per
 * the author's response to N4): intents that haven't migrated to a real
 * module yet pass through `runDispatchHandler` (or the schedule path) as
 * before. The allowlist shrinks with every subsequent PR (PR1c removes
 * `rule`, PR2 removes `profile` + `edit_preference`, etc.). When the
 * allowlist is empty, every host intent is module-backed.
 */
import { describe, it, expect } from "vitest";
import { HOST_CHAT_INTENT_VALUES } from "@/lib/intent";
import { lookupModule, getRegistry } from "@/agent/modules";

/**
 * Intents whose module-migration is still pending. Every entry is a "ticket"
 * for a future PR. The list shrinks per PR; when empty, every host intent
 * runs through a module + the runner.
 *
 * Order matches the migration roadmap in the proposal's §3 PR plan.
 */
const STILL_MIGRATING_HOST_INTENTS: ReadonlySet<string> = new Set([
  // "rule" — migrated in PR1c (composer-modules-pr1c)
  "create_bookable_link",                       // PR1c follow-on (or PR2)
  "profile",                                    // PR2
  "edit_preference",                            // PR2
  "create_link",                                // PR3
  "modify_link",                                // PR3
  "cancel_link",                                // PR3
  "query_calendar",                             // PR3
  "query_event",                                // PR3
]);

describe("intent module contract", () => {
  it("every host intent has a registered module on dashboard-host (or is allowlisted as still-migrating)", () => {
    for (const intent of HOST_CHAT_INTENT_VALUES) {
      const module = lookupModule("dashboard-host", intent);
      if (!module) {
        if (STILL_MIGRATING_HOST_INTENTS.has(intent)) continue;
        throw new Error(
          `Missing module for dashboard-host/${intent}. Either register one, or add to STILL_MIGRATING_HOST_INTENTS.`,
        );
      }
      // Module exists — allowedActions subset check lands in PR1c when the rule
      // module declares actual actions; PR1a's smoke module has empty allowedActions.
      expect(module.allowedActions, `${intent}: allowedActions must be defined (use [] to opt out)`).toBeDefined();
    }
  });

  it("PR1a smoke module is registered and well-formed", () => {
    const chat = lookupModule("dashboard-host", "chat");
    expect(chat, "chat smoke module must be registered (PR1a's only module)").toBeDefined();
    expect(chat!.intent).toBe("chat");
    expect(chat!.surface).toBe("dashboard-host");
    expect(chat!.composerPlaybook).toBeDefined();
    expect(chat!.allowedActions).toEqual([]);   // smoke module emits no actions
    expect(chat!.responseStyle).toBe("human-prose");
  });

  it("every registered module declares all required fields (TS exhaustiveness as runtime check)", () => {
    const registry = getRegistry();
    for (const surface of Object.keys(registry) as Array<keyof typeof registry>) {
      const surfaceMap = registry[surface] ?? {};
      for (const intent of Object.keys(surfaceMap)) {
        const module = surfaceMap[intent];
        expect(module.intent, `${surface}/${intent}: missing intent field`).toBe(intent);
        expect(module.surface, `${surface}/${intent}: missing surface field`).toBe(surface);
        expect(module.description, `${surface}/${intent}: missing description`).toBeTruthy();
        expect(module.composerPlaybook, `${surface}/${intent}: missing composerPlaybook`).toBeDefined();
        expect(module.contextLoader, `${surface}/${intent}: missing contextLoader`).toBeDefined();
        expect(module.postStreamGuards, `${surface}/${intent}: missing postStreamGuards (use [] to opt out)`).toBeDefined();
        expect(module.allowedActions, `${surface}/${intent}: missing allowedActions`).toBeDefined();
        expect(module.responseStyle, `${surface}/${intent}: missing responseStyle`).toBeDefined();
        expect(module.moduleGuardBucket, `${surface}/${intent}: missing moduleGuardBucket`).toBeTruthy();
      }
    }
  });
});
