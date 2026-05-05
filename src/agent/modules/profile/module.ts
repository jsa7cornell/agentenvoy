/**
 * Profile module — composer-modules architecture migration of the legacy
 * `runDispatchHandler({ tier: "profile" })` path (chat/route.ts:423-453 pre-PR2).
 *
 * Per proposal §3 PR2. The module:
 *   - composerPlaybook: voice + ground-truth + profile-composer
 *   - contextLoader: profile gap hints
 *   - allowedActions: update_knowledge, update_meeting_settings, update_business_hours
 *   - postStreamGuards: defaults (Layer 2a/2b/F6)
 *
 * Behavior is intended to match pre-PR2 observable output; the migration is
 * a re-platform onto `runModule`, not a feature change.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadProfileContext, type ProfileContext } from "./context-loader";

export const profileModule: IntentModule<ProfileContext> = {
  intent: "profile",
  surface: "dashboard-host",
  description:
    "Update host profile fields (knowledge, meeting settings, business hours). " +
    "Surfaces profile gaps as natural-conversation opportunities; never silent-writes.",

  composerPlaybook: [
    "fragments/voice",
    "fragments/ground-truth",
    "composers/profile-composer",
  ],

  contextLoader: loadProfileContext,

  composerTools: [],

  preEmitChecks: [],

  postStreamGuards: [],

  allowedActions: [
    "update_knowledge",
    "update_meeting_settings",
    "update_business_hours",
  ],

  responseStyle: "human-prose",

  moduleGuardBucket: "profile",
};
