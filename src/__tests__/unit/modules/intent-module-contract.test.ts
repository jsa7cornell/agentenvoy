/**
 * Intent-module contract test.
 *
 * Per proposal §2.10 + bug fix item #9 (intent-chat.test.ts drift): every
 * host intent in `HOST_CHAT_INTENT_VALUES` must have a registered module
 * on the `dashboard-host` surface. Asserting against the canonical enum
 * (not a frozen literal array) makes drift between enum + modules
 * structurally impossible — the test fails the moment they diverge.
 *
 * PR-B+: The registry is keyed on cluster names (e.g., `event_action`), not
 * individual intent names. The contract test translates each intent via
 * `INTENT_TO_CLUSTER` before looking up in the registry, mirroring the
 * runtime dispatch path in `dispatchModuleAndStream`. This means:
 * - `create_link` → looks up `event_action` → registered ✓
 * - `modify_link` → looks up `event_action` → registered ✓
 * - `cancel_link` → looks up `event_action` → registered ✓
 * - `edit_preference` → looks up `manage_setup` (PR-C)
 * - etc.
 *
 * The "still-migrating" allowlist covers intents whose cluster module has
 * not yet been registered (PRs not yet landed). It shrinks with each PR.
 */
import { describe, it, expect } from "vitest";
import { HOST_CHAT_INTENT_VALUES, INTENT_TO_CLUSTER } from "@/lib/intent";
import { lookupModule, getRegistry } from "@/agent/modules";

/**
 * Intents whose cluster module is still pending registration. Every entry is
 * a "ticket" for a future PR. The list shrinks per PR; when empty, every host
 * intent resolves to a registered cluster module.
 *
 * PR-B: removed create_link/modify_link/cancel_link (now route to event_action).
 * PR-C: will remove edit_preference/create_bookable_link (route to manage_setup).
 * PR-D: will remove query_calendar/query_event (route to inquire).
 */
const STILL_MIGRATING_HOST_INTENTS: ReadonlySet<string> = new Set([
  // "rule" — migrated in PR1c
  // "profile", "create_bookable_link" — migrated in PR2
  // "inquire", "query_calendar", "query_event" — migrated in PR3b-i
  // "create_link", "modify_link", "cancel_link" — collapsed to event_action in PR-B
  // "edit_preference", "create_bookable_link" — route to manage_setup cluster (PR-C)
  "edit_preference",
  "create_bookable_link",  // routes to manage_setup (PR-C)
]);

describe("intent module contract", () => {
  it("every host intent has a registered module on dashboard-host (or is allowlisted as still-migrating)", () => {
    for (const intent of HOST_CHAT_INTENT_VALUES) {
      // PR-B+: Translate via INTENT_TO_CLUSTER before registry lookup.
      // This mirrors the runtime dispatch path in dispatchModuleAndStream.
      const clusterIntent = INTENT_TO_CLUSTER[intent] ?? intent;
      const intentModule = lookupModule("dashboard-host", clusterIntent);
      if (!intentModule) {
        if (STILL_MIGRATING_HOST_INTENTS.has(intent)) continue;
        throw new Error(
          `Missing module for dashboard-host/${clusterIntent} (intent: ${intent}). ` +
          `Either register one, or add to STILL_MIGRATING_HOST_INTENTS.`,
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
