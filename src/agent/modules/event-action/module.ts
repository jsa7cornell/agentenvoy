/**
 * Event-action cluster module — `event_action`.
 *
 * PR-B: Collapses the four event-intent modules (`create_link`, `modify_link`,
 * `cancel_link`, `schedule`) into a single cluster module. This is a nominal
 * collapse — the four modules already shared `loadEventIntentContext` and
 * `composers/calendar-event-composer.md`; the cluster makes that structural
 * reality explicit in the registry.
 *
 * Cluster name: `event_action`
 * Absorbed intents: `create_link`, `modify_link`, `cancel_link`, `schedule`
 * (all map to `event_action` via `INTENT_TO_CLUSTER` in intent.ts)
 *
 * `moduleGuardBucket` is `"event_action"`. During the dual-write window
 * (PR-B through ~14 days post-PR-E), the runner writes `legacyBucket` with
 * the originating intent name (e.g., `"create_link"`) via `originatingIntent`
 * passed from `dispatchModuleAndStream`.
 *
 * `allowedActions` is the union of all four absorbed modules' allowed sets,
 * deduplicated. This lets the composer emit any event-action-appropriate
 * action without triggering silent-strip (proposal §2.9: Report 5 fix —
 * within-thread intent drift from create→modify no longer strips `update_time`).
 *
 * The precheck-hint mechanism is preserved: `matchResult.resolved.args.precheckHint`
 * flows into `loadEventIntentContext` → `systemPromptSuffix`, steering the
 * composer toward the correct sub-shape (create vs modify vs cancel) per the
 * existing `event-intents/context-loader.ts` logic.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadEventIntentContext } from "@/agent/modules/event-intents/context-loader";
import type { ScheduleContext } from "@/agent/modules/_shared/schedule-context";
import { forwardProjectionConsistencyGuard } from "@/agent/modules/_shared/post-stream-guards";

export const eventActionModule: IntentModule<ScheduleContext> = {
  intent: "event_action",
  surface: "dashboard-host",
  description:
    "Event-action cluster — create, modify, cancel, or schedule a session. " +
    "Absorbs create_link / modify_link / cancel_link / schedule intents. " +
    "The precheckHint arg steers the composer toward the correct sub-shape.",
  composerPlaybook: [
    "fragments/voice",
    "composers/calendar-event-composer",
  ],
  contextLoader: loadEventIntentContext,
  composerTools: [],
  preEmitChecks: [],
  // forward-projection-consistency: cluster-allowlisted opt-in (Mode D, 2026-05-05).
  // Catches unsolicited "Want me to open up earlier mornings?" projection bleed
  // (FeedbackReport `cmot63s7x0001k2js8f96655r`). Structural backstop after
  // prose tunes (7f0b6ca / 3a12911 / 4248a08) proved insufficient.
  postStreamGuards: [forwardProjectionConsistencyGuard],
  // Union of all four absorbed modules' allowedActions (deduplicated).
  // Includes update_time / update_format / update_location from modify_link
  // so within-thread drift (create→modify) no longer triggers silent-strip
  // (proposal §2.9, Report 5 fix).
  allowedActions: [
    // create_link originals
    "create_link",
    "save_guest_info",
    "lock_activity_location",
    "lock_session_duration",
    // modify_link additions
    "update_time",
    "update_format",
    "update_location",
    "update_link",
    "expand_link",
    "hold_slot",
    "release_hold",
    // cancel_link additions
    "cancel",
    "archive",
    "archive_bulk",
    "unarchive",
  ],
  responseStyle: "human-prose",
  moduleGuardBucket: "event_action",
};
