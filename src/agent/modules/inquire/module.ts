/**
 * Inquire cluster module — `inquire`.
 *
 * PR-D: Collapses `inquire`, `query_calendar`, and `query_event` into a single
 * cluster module. All three intents already shared the same composerPlaybook,
 * contextLoader, and allowedActions ([]); the collapse makes that explicit.
 *
 * Cluster name: `inquire` (cluster name reuses the intent name — already
 * cluster-shaped from PR3b-i).
 * Absorbed intents: `inquire`, `query_calendar`, `query_event`
 * (query_calendar and query_event map to `inquire` via INTENT_TO_CLUSTER).
 *
 * `moduleGuardBucket` is `"inquire"`. During the dual-write window,
 * the runner writes `legacyBucket` with the originating intent name
 * (e.g., `"query_calendar"`) for corpus-continuity.
 *
 * Per-intent segmentation is preserved post-collapse via `emittedActions`
 * and via the `legacyBucket` dual-write during the window.
 */
import type { IntentModule } from "@/agent/modules/types";
import {
  loadScheduleContext,
  type ScheduleContext,
} from "@/agent/modules/_shared/schedule-context";

export const inquireClusterModule: IntentModule<ScheduleContext> = {
  intent: "inquire",
  surface: "dashboard-host",
  description:
    "Inquire cluster — read-only host queries about the schedule, sessions, " +
    "links, preferences, or specific calendar events. Absorbs inquire / " +
    "query_calendar / query_event intents. No [ACTION] blocks emitted.",
  composerPlaybook: [
    "fragments/voice",
    "composers/inquire-composer",
  ],
  contextLoader: loadScheduleContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  useDefaultPostStreamGuards: false,
  allowedActions: [],
  responseStyle: "human-prose",
  moduleGuardBucket: "inquire",
};

// Keep legacy named exports so any direct imports in bench fixtures or tests
// don't break during the transition period. They all point to the cluster module.
/** @deprecated Use inquireClusterModule — individual intent modules removed in PR-D */
export const inquireModule = inquireClusterModule;
/** @deprecated Use inquireClusterModule — individual intent modules removed in PR-D */
export const queryCalendarModule = inquireClusterModule;
/** @deprecated Use inquireClusterModule — individual intent modules removed in PR-D */
export const queryEventModule = inquireClusterModule;
