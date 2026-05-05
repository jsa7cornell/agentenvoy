/**
 * Inquire-tier modules — read-only schedule-path intents.
 *
 * Per proposal §3 PR3 + the PR3b handoff §"Recommended sub-PR split":
 * `inquire`, `query_calendar`, `query_event` are the lowest-risk slice of
 * the schedule path migration — no actions emitted, no precheck dependency,
 * no state mutation. Three modules share:
 *   - composerPlaybook: voice + inquire-composer
 *   - contextLoader: loadScheduleContext (the shared schedule-path loader)
 *   - allowedActions: [] (composer playbook forbids [ACTION] blocks; runner
 *     strips any emitted)
 *   - useDefaultPostStreamGuards: false (no action emission to guard)
 *
 * Three separate modules (vs one with a function-variant playbook) keep the
 * moduleGuard buckets distinct — the corpus can segment retry/guard rates by
 * intent shape ("did query_event drift more than inquire?" is the kind of
 * question this enables).
 */
import type { IntentModule } from "@/agent/modules/types";
import {
  loadScheduleContext,
  type ScheduleContext,
} from "@/agent/modules/_shared/schedule-context";

const SHARED_INQUIRE_PLAYBOOK = [
  "fragments/voice",
  "composers/inquire-composer",
] as const;

export const inquireModule: IntentModule<ScheduleContext> = {
  intent: "inquire",
  surface: "dashboard-host",
  description:
    "Read-only host turn — answer questions about the schedule, sessions, " +
    "links, or preferences without emitting any [ACTION] block.",
  composerPlaybook: SHARED_INQUIRE_PLAYBOOK,
  contextLoader: loadScheduleContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  useDefaultPostStreamGuards: false,
  allowedActions: [],
  responseStyle: "human-prose",
  moduleGuardBucket: "inquire",
};

export const queryCalendarModule: IntentModule<ScheduleContext> = {
  intent: "query_calendar",
  surface: "dashboard-host",
  description:
    "Read-only calendar query — answer questions about open/protected/soft " +
    "windows or scoring without emitting actions.",
  composerPlaybook: SHARED_INQUIRE_PLAYBOOK,
  contextLoader: loadScheduleContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  useDefaultPostStreamGuards: false,
  allowedActions: [],
  responseStyle: "human-prose",
  moduleGuardBucket: "query_calendar",
};

export const queryEventModule: IntentModule<ScheduleContext> = {
  intent: "query_event",
  surface: "dashboard-host",
  description:
    "Read-only event query — answer questions about specific calendar " +
    "events or upcoming meetings without emitting actions.",
  composerPlaybook: SHARED_INQUIRE_PLAYBOOK,
  contextLoader: loadScheduleContext,
  composerTools: [],
  preEmitChecks: [],
  postStreamGuards: [],
  useDefaultPostStreamGuards: false,
  allowedActions: [],
  responseStyle: "human-prose",
  moduleGuardBucket: "query_event",
};
