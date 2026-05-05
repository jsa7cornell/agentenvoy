/**
 * Event-intent modules — `create_link`, `modify_link`, `cancel_link`,
 * `schedule`. The four event-shaped intents that flow through the
 * scheduling precheck.
 *
 * Per the proposal §3 PR3 + PR3b handoff §"PR3b-iii": precheck stays at
 * the route layer (Rule 17 layer 2 — matcher); its output reaches the
 * module via `matchResult.resolved.args.precheckHint`, which the
 * `loadEventIntentContext` loader folds into `systemPromptSuffix`. The
 * runner inserts the suffix between playbook fragments and # Context,
 * matching the legacy schedule path's prompt-assembly order.
 *
 * Multi-match-disambiguate stays as an early-return at the route layer
 * (no `runModule` call) — that branch never invokes the LLM.
 *
 * `allowedActions` is narrowed per intent. The runner's enforcement
 * strips out-of-bounds emissions and logs them as
 * `allowed-actions-violation` guard fires for corpus segmentation.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadEventIntentContext } from "./context-loader";
import type { ScheduleContext } from "@/agent/modules/_shared/schedule-context";

const SHARED_PLAYBOOK = [
  "fragments/voice",
  "composers/calendar-event-composer",
] as const;

export const createLinkModule: IntentModule<ScheduleContext> = {
  intent: "create_link",
  surface: "dashboard-host",
  description:
    "Create a new bookable session — typically a 1:1 invite with a named " +
    "guest. Receives the matcher's deterministic-create hint when present.",
  composerPlaybook: SHARED_PLAYBOOK,
  contextLoader: loadEventIntentContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  allowedActions: [
    "create_link",
    // host may also save guest info or lock activity at creation time
    "save_guest_info",
    "lock_activity_location",
    "lock_session_duration",
  ],
  responseStyle: "human-prose",
  moduleGuardBucket: "create_link",
};

export const modifyLinkModule: IntentModule<ScheduleContext> = {
  intent: "modify_link",
  surface: "dashboard-host",
  description:
    "Modify an existing session — change format, time, location, or " +
    "extend the link parameters. Matcher resolves the target session id.",
  composerPlaybook: SHARED_PLAYBOOK,
  contextLoader: loadEventIntentContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  allowedActions: [
    "update_format",
    "update_time",
    "update_location",
    "update_link",
    "expand_link",
    "hold_slot",
    "release_hold",
    "save_guest_info",
    "lock_activity_location",
    "lock_session_duration",
  ],
  responseStyle: "human-prose",
  moduleGuardBucket: "modify_link",
};

export const cancelLinkModule: IntentModule<ScheduleContext> = {
  intent: "cancel_link",
  surface: "dashboard-host",
  description:
    "Cancel an existing session. Matcher resolves the target session id; " +
    "the composer confirms the cancellation in prose alongside the emit.",
  composerPlaybook: SHARED_PLAYBOOK,
  contextLoader: loadEventIntentContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  allowedActions: ["cancel", "archive", "archive_bulk", "unarchive"],
  responseStyle: "human-prose",
  moduleGuardBucket: "cancel_link",
};

/**
 * Legacy guest-emitted intent. The host classifier never returns `schedule`,
 * but the route still receives it via `userIntentHint` from clarifier
 * quick-reply clicks. Treat it like create_link (the most common shape) —
 * the precheck's deterministic-modify/cancel decisions still steer behavior
 * via the hint, but allowedActions covers the full event-write set so the
 * composer isn't artificially constrained.
 */
export const scheduleModule: IntentModule<ScheduleContext> = {
  intent: "schedule",
  surface: "dashboard-host",
  description:
    "Legacy guest-emitted intent reachable on the host endpoint via " +
    "userIntentHint. Composer treats it as a generic event turn; allowed " +
    "actions cover create / modify / cancel.",
  composerPlaybook: SHARED_PLAYBOOK,
  contextLoader: loadEventIntentContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  allowedActions: [
    "create_link",
    "update_format",
    "update_time",
    "update_location",
    "update_link",
    "expand_link",
    "cancel",
    "archive",
    "hold_slot",
    "release_hold",
    "save_guest_info",
    "lock_activity_location",
    "lock_session_duration",
  ],
  responseStyle: "human-prose",
  moduleGuardBucket: "schedule",
};
