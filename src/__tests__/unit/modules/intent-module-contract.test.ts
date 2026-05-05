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
  // "rule" — migrated in PR1c
  // "profile", "create_bookable_link" — migrated in PR2
  // "inquire", "query_calendar", "query_event" — migrated in PR3b-i
  // "edit_preference" — left unregistered by design in PR2 (Open Question 1
  //   of the composer-modules proposal remains open). The route layer
  //   delegates to either the profile or rule module via a keyword regex.
  "edit_preference",
  "create_link",                                // PR3b-iii
  "modify_link",                                // PR3b-iii
  "cancel_link",                                // PR3b-iii
]);

describe("intent module contract", () => {
  it("every host intent has a registered module on dashboard-host (or is allowlisted as still-migrating)", () => {
    for (const intent of HOST_CHAT_INTENT_VALUES) {
      const intentModule = lookupModule("dashboard-host", intent);
      if (!intentModule) {
        if (STILL_MIGRATING_HOST_INTENTS.has(intent)) continue;
        throw new Error(
          `Missing module for dashboard-host/${intent}. Either register one, or add to STILL_MIGRATING_HOST_INTENTS.`,
        );
      }
      // Module exists — allowedActions subset check lands in PR1c when the rule
      // module declares actual actions; PR1a's smoke module has empty allowedActions.
      expect(intentModule.allowedActions, `${intent}: allowedActions must be defined (use [] to opt out)`).toBeDefined();
    }
  });

  it("chat module is registered and well-formed (real module post-PR3b-ii)", () => {
    const chat = lookupModule("dashboard-host", "chat");
    expect(chat, "chat module must be registered").toBeDefined();
    expect(chat!.intent).toBe("chat");
    expect(chat!.surface).toBe("dashboard-host");
    expect(chat!.composerPlaybook).toBeDefined();
    expect(chat!.responseStyle).toBe("human-prose");
    // PR3b-ii: chat is now the real fall-through module with the full
    // channel-composer action union; the PR1a empty-allowedActions stub
    // is gone. A non-trivial allowedActions list is the new invariant.
    expect(Array.isArray(chat!.allowedActions)).toBe(true);
    expect(chat!.allowedActions.length).toBeGreaterThan(0);
    expect(chat!.allowedActions).toContain("create_link");
    expect(chat!.moduleGuardBucket).toBe("chat");
  });

  it("every registered module declares all required fields (TS exhaustiveness as runtime check)", () => {
    const registry = getRegistry();
    for (const surface of Object.keys(registry) as Array<keyof typeof registry>) {
      const surfaceMap = registry[surface] ?? {};
      for (const intent of Object.keys(surfaceMap)) {
        const intentModule = surfaceMap[intent];
        expect(intentModule.intent, `${surface}/${intent}: missing intent field`).toBe(intent);
        expect(intentModule.surface, `${surface}/${intent}: missing surface field`).toBe(surface);
        expect(intentModule.description, `${surface}/${intent}: missing description`).toBeTruthy();
        expect(intentModule.composerPlaybook, `${surface}/${intent}: missing composerPlaybook`).toBeDefined();
        expect(intentModule.contextLoader, `${surface}/${intent}: missing contextLoader`).toBeDefined();
        expect(intentModule.postStreamGuards, `${surface}/${intent}: missing postStreamGuards (use [] to opt out)`).toBeDefined();
        expect(intentModule.allowedActions, `${surface}/${intent}: missing allowedActions`).toBeDefined();
        expect(intentModule.responseStyle, `${surface}/${intent}: missing responseStyle`).toBeDefined();
        expect(intentModule.moduleGuardBucket, `${surface}/${intent}: missing moduleGuardBucket`).toBeTruthy();
      }
    }
  });
});
