/**
 * `chat` module — free-form host turn on the dashboard channel.
 *
 * Per proposal §3 PR3 + the PR3b handoff §"PR3b-ii": this is the real
 * production module replacing PR1a's smoke-stub. The chat intent is the
 * fall-through bucket — turns the host classifier returns `chat` for either
 * (a) genuinely free-form ("change to light mode"), (b) ambiguous-but-
 * conversational utterances the precheck path doesn't fit. The module
 * loads the full schedule context and runs through the channel composer
 * playbook with the default Layer 2a/2b/F6 post-stream guards.
 *
 * Skipping precheck is intentional: chat-shaped turns shouldn't drag the
 * matcher into resolving phantom guests. The legacy chat path at
 * chat/route.ts:579 ("chat → skip precheck entirely") is the same posture.
 *
 * allowedActions covers the union the channel composer might emit. Per-
 * action narrowing happens in PR3b-iii's per-event-intent modules
 * (create_link gets just `create_link`; modify_link gets the update_*
 * family; etc.). Chat's permissive set matches the legacy schedule path.
 */
import type { IntentModule } from "@/agent/modules/types";
import {
  loadScheduleContext,
  type ScheduleContext,
} from "@/agent/modules/_shared/schedule-context";

export const chatModule: IntentModule<ScheduleContext> = {
  intent: "chat",
  surface: "dashboard-host",
  description:
    "Free-form host turn — fall-through composer. Loads full schedule context " +
    "(calendar, sessions, preferences, reusable links) and runs through the " +
    "channel composer playbook. Skips precheck; the matcher fires only for " +
    "explicitly event-shaped intents.",

  composerPlaybook: [
    "fragments/voice",
    "composers/calendar-event-composer",
  ],

  contextLoader: loadScheduleContext,

  composerTools: [],

  preEmitChecks: [],

  postStreamGuards: [],                          // defaults Layer 2a/2b/F6 auto-injected

  allowedActions: [
    // Calendar/event operations
    "create_link",
    "update_link",
    "expand_link",
    "update_format",
    "update_time",
    "update_location",
    "cancel",
    "archive",
    "archive_bulk",
    "unarchive",
    "hold_slot",
    "release_hold",
    // Profile / settings (chat may mint these mid-conversation)
    "update_knowledge",
    "update_meeting_settings",
    "update_business_hours",
    // Rule operations (rare from chat, but possible)
    "update_availability_rule",
    "rename_primary",
    // Session-scoped specifics
    "save_guest_info",
    "lock_activity_location",
    "lock_session_duration",
  ],

  responseStyle: "human-prose",

  moduleGuardBucket: "chat",
};
