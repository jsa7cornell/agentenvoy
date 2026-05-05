/**
 * `chat` smoke module — the construct's no-op fall-through proof-point.
 *
 * Per the proposal §3 PR1a + per the spike-and-bench plan: PR1a registers a
 * single trivial module (`chat`) so the contract test has at least one
 * (surface, intent) entry to validate. This module is intentionally minimal:
 *  - composerPlaybook: just voice + ground-truth fragments
 *  - contextLoader: no state load
 *  - composerTools: none
 *  - preEmitChecks: none
 *  - postStreamGuards: defaults only (Layer 2a/2b/F6)
 *  - allowedActions: empty (chat is the fall-through; doesn't emit actions)
 *
 * It does NOT replace the existing chat handling in chat/route.ts. PR1a is
 * purely additive; this module exists to prove the runner construct works
 * end-to-end on a no-side-effect surface. Production wiring of `chat` (or
 * its replacement) lands in PR3.
 */
import type { IntentModule, ModuleContextOutput } from "@/agent/modules/types";

interface ChatContext extends ModuleContextOutput {}

export const chatModule: IntentModule<ChatContext> = {
  intent: "chat",
  surface: "dashboard-host",
  description:
    "Smoke module — no-op chat fall-through. Proves the runner construct loads + dispatches end-to-end. " +
    "PR1a only; PR3 replaces with the real chat module that wires into chat/route.ts schedule path.",

  composerPlaybook: ["fragments/voice", "fragments/ground-truth"],

  contextLoader: async () => ({
    contextLines: [],
  }),

  composerTools: [],

  preEmitChecks: [],

  postStreamGuards: [],                          // defaults (Layer 2a/2b/F6) auto-injected by runner

  allowedActions: [],                            // chat doesn't emit actions; runner strips any emitted

  responseStyle: "human-prose",

  moduleGuardBucket: "chat:smoke",
};
