/**
 * Module registration entry point.
 *
 * Each module registers itself with the registry at import time. Surface
 * adapters (route handlers) import this file once at the top of their
 * module, then call `lookupModule(surface, intent)` per turn.
 *
 * PR1a registers the smoke `chat` module. Subsequent PRs add:
 *   PR1c: rule, create_bookable_link
 *   PR2:  profile, edit_preference (split into profile/rule routes)
 *   PR3:  create_link, modify_link, cancel_link, schedule, inquire, query_calendar, query_event
 *   PR4:  bookings (book_with_person) ← shipped
 *   PR-B: event_action cluster (collapses create_link/modify_link/cancel_link/schedule)
 *   PR-C: manage_setup cluster (collapses profile/rule/create_bookable_link/edit_preference)
 *   PR-D: inquire cluster (collapses query_calendar/query_event under inquire)
 *   PR5:  dealroom-host/*, dealroom-guest/*
 *   PR6:  no new modules; PR6 is MCP exposure layer
 */
import { registerModule } from "./registry";
import { chatModule } from "./chat/module";
// PR-B: event_action cluster — replaces create_link/modify_link/cancel_link/schedule.
import { eventActionModule } from "./event-action/module";
// PR-C: manage_setup cluster — replaces profile/rule/create_bookable_link/edit_preference.
// The individual module files are kept for their context-loaders + preEmitChecks,
// which the cluster module imports directly.
import { manageSetupModule } from "./manage-setup/module";
import {
  inquireModule,
  queryCalendarModule,
  queryEventModule,
} from "./inquire/module";
import { bookingsModule } from "./bookings/module";

let _registered = false;

/**
 * Idempotent module registration. Safe to call from multiple route imports.
 * Tests should call `_resetRegistryForTests()` from registry.ts before
 * re-invoking.
 */
export function ensureModulesRegistered(): void {
  if (_registered) return;
  _registered = true;
  registerModule(chatModule);
  // PR-B: event_action cluster (single module for all event-shaped intents).
  // create_link/modify_link/cancel_link/schedule route to event_action via INTENT_TO_CLUSTER.
  registerModule(eventActionModule);
  // PR-C: manage_setup cluster (single module for profile/rule/bookable-link/edit_preference).
  // edit_preference/profile/rule/create_bookable_link route to manage_setup via INTENT_TO_CLUSTER.
  registerModule(manageSetupModule);
  registerModule(inquireModule);
  registerModule(queryCalendarModule);
  registerModule(queryEventModule);
  registerModule(bookingsModule);      // PR4 — bookings module
}

// Auto-register on first import. Production code paths that import any
// module-related symbol get registration as a side effect, ensuring the
// registry is populated before any `lookupModule` call.
ensureModulesRegistered();

// Re-exports for convenience.
export { lookupModule, getRegistry, registerModule, _resetRegistryForTests } from "./registry";
export { runModule, defaultComposerInvoker, composeSystemPrompt, loadFragment } from "./runner";
export type {
  IntentModule,
  IntentSurface,
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
  RunnerInput,
  RunnerOutput,
  ModuleGuardRecord,
  ComposerTool,
  AnyComposerTool,
  PreEmitCheck,
  PreEmitCheckResult,
  PreEmitCheckArgs,
  PostStreamGuard,
  PostStreamGuardResult,
  PostStreamGuardArgs,
  ComposerInvoker,
  ResponseStyle,
} from "./types";
export { MAX_RETRIES_PER_TURN } from "./types";
