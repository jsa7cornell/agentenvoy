/**
 * `group_coordination` module — Track 2 group scheduling on `dashboard-host`.
 *
 * Chat-first, open-question coordination (vs Track 1 picker). Two phases:
 *
 *   Phase 1 — Pre-flight: host describes the event; composer gathers title,
 *   participants, candidate windows, and what to ask. When host confirms,
 *   composer emits `create_link` (type: "group"). The create_link handler
 *   mints a GroupCoordination row as a side effect (Model A — decided 2026-05-06).
 *
 *   Phase 2 — Synthesis: as responses come in, host returns to the dashboard
 *   and asks for overlap analysis. Composer calls `propose_convergence` which
 *   loads all raw responses and increments synthesisVersion; LLM renders a
 *   generative table + prose summary (intentional boundary test — decided
 *   2026-05-06).
 *
 *   Ongoing: host can record participant windows manually (`record_availability`)
 *   and collect activity suggestions (`collect_suggestion`).
 *
 * Free-form `responses` JSON: { person, windows, preferences, unavailable }[]
 * (no promptId linkage — decided 2026-05-06).
 *
 * Proposal: 2026-05-06_group-coordination-composer-module_reviewed-2026-05-06_decided-2026-05-06.md
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadGroupCoordinationContext, type GroupCoordinationContext } from "./context-loader";
import { recordAvailabilityTool, proposeConvergenceTool, collectSuggestionTool } from "./tools";
import { DEFAULT_POST_STREAM_GUARDS } from "@/agent/modules/_shared/post-stream-guards";

export const groupCoordinationModule: IntentModule<GroupCoordinationContext> = {
  intent: "group_coordination",
  surface: "dashboard-host",
  description:
    "Track 2 group scheduling: chat-first open-question coordination for group events. " +
    "Phase 1 gathers event details + participant windows via conversation and emits create_link. " +
    "Phase 2 synthesizes collected responses into a generative overlap table when host asks.",

  composerPlaybook: [
    "fragments/voice",
    "composers/group-coordination/base",
  ],

  contextLoader: loadGroupCoordinationContext,

  composerTools: [
    recordAvailabilityTool,
    proposeConvergenceTool,
    collectSuggestionTool,
  ],

  // create_link is the only emitted action type (pre-flight confirmation).
  // Phase 2 synthesis is tool-call + generative rendering — no action emission.
  allowedActions: ["create_link"],

  postStreamGuards: [...DEFAULT_POST_STREAM_GUARDS],

  responseStyle: "human-prose",

  moduleGuardBucket: "group_coordination",
};
