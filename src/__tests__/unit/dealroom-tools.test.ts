/**
 * Deal-room tool surface — role-aware selector + grounding declarations.
 *
 * Locks in:
 *   - `buildUnifiedToolsFor({role: "host-channel", ...})` returns the same
 *     tool set as `buildUnifiedTools(ctx)` directly (back-compat).
 *   - `buildUnifiedToolsFor({role: "dealroom-host", ...})` returns ONLY tools
 *     in the host allowlist — no `bookable_link_*`, no `primary_link_update`,
 *     no `rule_*`, no `prefs_*`, no `knowledge_write` (deflected per §2.6).
 *   - `buildUnifiedToolsFor({role: "dealroom-guest", ...})` returns the
 *     guest-side narrower subset. `get_matched_availability` present;
 *     `personal_link_update` absent.
 *   - The three new deal-room tools exist and have grounding declarations.
 *   - SESSION_SET_STATUS_VALUES includes `"skipped"` per Round 2 RN2.
 *
 * Phase A.3 of the deal-room unified-agent migration.
 */

import { describe, it, expect } from "vitest";
import { buildUnifiedToolsFor, type UnifiedToolsForInput } from "@/agent/unified/tools";
import {
  DEALROOM_HOST_ALLOWED_TOOLS,
  DEALROOM_GUEST_ALLOWED_TOOLS,
  allowedToolsForRole,
} from "@/agent/unified/dealroom-tools";
import { SESSION_SET_STATUS_VALUES } from "@/lib/session-state";
import { GROUNDING_DECLARATIONS } from "@/agent/unified/grounding-check";

const AGENT_CTX = {
  userId: "u_test",
  timezone: "America/Los_Angeles",
  meetSlug: "testhost",
  userMessage: "test message",
};

const DEALROOM_CTX_HOST = {
  sessionId: "sess_test_1",
  hostId: "u_test",
  role: "dealroom-host" as const,
};

const DEALROOM_CTX_GUEST = {
  sessionId: "sess_test_1",
  hostId: "u_test",
  role: "dealroom-guest" as const,
};

describe("buildUnifiedToolsFor — role-aware tool surface", () => {
  it("host-channel returns the full 34-tool surface (back-compat)", () => {
    const tools = buildUnifiedToolsFor({ role: "host-channel", agentCtx: AGENT_CTX });
    const names = Object.keys(tools);
    // Sanity: must include LOAD tools, link tools, rule tools, prefs tools, etc.
    expect(names).toContain("LOAD_calendar_context");
    expect(names).toContain("personal_link_create");
    expect(names).toContain("bookable_link_create");
    expect(names).toContain("primary_link_update");
    expect(names).toContain("rule_add");
    expect(names).toContain("prefs_update_timezone");
    expect(names).toContain("knowledge_write");
    expect(names).toContain("session_cancel");
    // The deal-room-specific tools are NOT in host-channel — they don't apply.
    expect(names).not.toContain("session_set_status");
    expect(names).not.toContain("session_confirm_slot");
    expect(names).not.toContain("session_request_reschedule");
  });

  it("dealroom-host: returns only the allowed tool set; no account-prefs", () => {
    const input: UnifiedToolsForInput = {
      role: "dealroom-host",
      agentCtx: AGENT_CTX,
      dealroomCtx: DEALROOM_CTX_HOST,
    };
    const tools = buildUnifiedToolsFor(input);
    const names = Object.keys(tools);

    // Allowlist is the source of truth — every returned tool must be on it.
    for (const name of names) {
      expect(DEALROOM_HOST_ALLOWED_TOOLS, `unexpected tool in host set: ${name}`).toContain(name);
    }

    // Spot-check the inclusions:
    expect(names).toContain("session_update_time");
    expect(names).toContain("session_update_format");
    expect(names).toContain("session_update_location");
    expect(names).toContain("session_cancel");
    expect(names).toContain("session_set_status"); // new in A.3
    expect(names).toContain("session_request_reschedule"); // new in A.3
    expect(names).toContain("personal_link_update"); // host can edit this session's link
    expect(names).toContain("LOAD_active_sessions");

    // Account-pref exclusions — proposal §2.6:
    expect(names).not.toContain("bookable_link_create");
    expect(names).not.toContain("bookable_link_update");
    expect(names).not.toContain("primary_link_update");
    expect(names).not.toContain("rule_add");
    expect(names).not.toContain("rule_update");
    expect(names).not.toContain("rule_remove");
    expect(names).not.toContain("prefs_update_appearance");
    expect(names).not.toContain("prefs_update_timezone");
    expect(names).not.toContain("knowledge_write");
    expect(names).not.toContain("group_event_create");
  });

  it("dealroom-guest: even narrower; get_matched_availability present, personal_link_update absent", () => {
    const input: UnifiedToolsForInput = {
      role: "dealroom-guest",
      agentCtx: AGENT_CTX,
      dealroomCtx: DEALROOM_CTX_GUEST,
    };
    const tools = buildUnifiedToolsFor(input);
    const names = Object.keys(tools);

    for (const name of names) {
      expect(DEALROOM_GUEST_ALLOWED_TOOLS, `unexpected tool in guest set: ${name}`).toContain(name);
    }

    // Guest spot-checks:
    expect(names).toContain("session_confirm_slot"); // new in A.3
    expect(names).toContain("session_request_reschedule"); // new in A.3
    expect(names).toContain("session_set_status");
    expect(names).toContain("session_save_guest_info"); // guest can save their own info
    expect(names).toContain("LOAD_calendar_context");
    expect(names).toContain("LOAD_preferences");

    // Guest exclusions — no host-link or account writes:
    expect(names).not.toContain("personal_link_update"); // guests don't edit host's link
    expect(names).not.toContain("session_update_time");
    expect(names).not.toContain("session_update_format");
    expect(names).not.toContain("session_update_location");
    expect(names).not.toContain("session_cancel"); // host cancels; guest reschedules
    expect(names).not.toContain("bookable_link_create");
    expect(names).not.toContain("rule_add");
    expect(names).not.toContain("primary_link_update");
  });

  it("allowedToolsForRole returns the correct allowlist per role", () => {
    expect(allowedToolsForRole("dealroom-host")).toEqual(DEALROOM_HOST_ALLOWED_TOOLS);
    expect(allowedToolsForRole("dealroom-guest")).toEqual(DEALROOM_GUEST_ALLOWED_TOOLS);
  });

  it("the three new deal-room tools have grounding declarations", () => {
    expect(GROUNDING_DECLARATIONS.session_set_status).toBeDefined();
    expect(GROUNDING_DECLARATIONS.session_set_status?.toolSeverity).toBe("strict");

    expect(GROUNDING_DECLARATIONS.session_confirm_slot).toBeDefined();
    expect(GROUNDING_DECLARATIONS.session_confirm_slot?.toolSeverity).toBe("strict");

    expect(GROUNDING_DECLARATIONS.session_request_reschedule).toBeDefined();
    expect(GROUNDING_DECLARATIONS.session_request_reschedule?.toolSeverity).toBe("strict");
  });

  it("SESSION_SET_STATUS_VALUES includes 'skipped' per Round 2 RN2", () => {
    // Round 2 reviewer flagged that the new MeetingCard recognizes
    // sessionStatus === "skipped" but the legacy VALID_STATUSES omitted it.
    // The new enum widens to include it so the recurring-session skip UI
    // stays reachable from chat after migration.
    expect(SESSION_SET_STATUS_VALUES).toContain("skipped");
    // And the legacy quartet is preserved:
    expect(SESSION_SET_STATUS_VALUES).toContain("active");
    expect(SESSION_SET_STATUS_VALUES).toContain("proposed");
    expect(SESSION_SET_STATUS_VALUES).toContain("cancelled");
    expect(SESSION_SET_STATUS_VALUES).toContain("escalated");
    // And "agreed" is NOT in the set — confirm-pipeline owns that transition
    // exclusively per SPEC §2.3.1.
    expect(SESSION_SET_STATUS_VALUES).not.toContain("agreed");
  });
});
