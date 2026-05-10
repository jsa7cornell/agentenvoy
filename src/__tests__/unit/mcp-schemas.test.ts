/**
 * MCP schema smoke tests. Not exhaustive — the schemas are the contract, and
 * the downstream handler tests will exercise shapes in earnest. This file
 * locks the two invariants that don't belong anywhere else:
 *
 *   1. All 8 tools listed in parent proposal §2.7 exist in MCP_TOOLS.
 *   2. Each input schema accepts its documented happy case and rejects an
 *      unknown key (strict() is load-bearing — it's how we catch agents
 *      typo'ing field names instead of silently dropping them).
 */
import { describe, it, expect } from "vitest";
import { MCP_TOOLS, MCP_TOOL_NAMES } from "@/lib/mcp/schemas";
import { MCP_RATE_LIMITS } from "@/lib/mcp/auth";
import { HOST_MCP_TOOLS } from "@/lib/mcp/host-schemas";

describe("MCP tool registry", () => {
  it("lists all 11 tools (parent proposal §2.7's 8 + lock_activity_location + PR2 get_tip + get_event_summary)", () => {
    expect(new Set(MCP_TOOL_NAMES)).toEqual(
      new Set([
        "get_meeting_parameters",
        "get_availability",
        "get_session_status",
        "post_message",
        "propose_parameters",
        "propose_lock",
        "cancel_meeting",
        "reschedule_meeting",
        "lock_activity_location",
        "get_tip",
        "get_event_summary",
      ])
    );
  });

  it("every tool has non-empty description + paired input/output schemas", () => {
    for (const name of MCP_TOOL_NAMES) {
      const tool = MCP_TOOLS[name];
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input).toBeDefined();
      expect(tool.output).toBeDefined();
    }
  });
});

describe("input schemas — happy case + strict() rejection", () => {
  const happyCases: Record<(typeof MCP_TOOL_NAMES)[number], unknown> = {
    get_meeting_parameters: { meetingUrl: "/meet/abc?c=xyz" },
    get_availability: {
      meetingUrl: "/meet/abc",
      dateRange: { start: "2026-05-01", end: "2026-05-07" },
    },
    get_session_status: { meetingUrl: "/meet/abc" },
    post_message: { meetingUrl: "/meet/abc", text: "hello from Claude" },
    propose_parameters: {
      meetingUrl: "/meet/abc",
      proposal: { format: "video" },
    },
    propose_lock: {
      meetingUrl: "/meet/abc",
      slot: { start: "2026-05-01T15:00:00Z" },
      guest: { email: "alice@example.com", name: "Alice Example" },
    },
    cancel_meeting: { meetingUrl: "/meet/abc" },
    reschedule_meeting: {
      meetingUrl: "/meet/abc",
      newSlot: { start: "2026-05-02T15:00:00Z" },
    },
    lock_activity_location: {
      meetingUrl: "/meet/abc",
      activity: "coffee",
    },
    get_tip: { meetingUrl: "/meet/abc" },
    get_event_summary: { meetingUrl: "/meet/abc" },
  };

  it.each(MCP_TOOL_NAMES)("%s accepts its happy case", (name) => {
    const result = MCP_TOOLS[name].input.safeParse(happyCases[name]);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it.each(MCP_TOOL_NAMES)("%s rejects unknown keys (strict)", (name) => {
    const payload = { ...(happyCases[name] as object), rogueField: "nope" };
    const result = MCP_TOOLS[name].input.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe("propose_parameters — batch semantics", () => {
  it("rejects empty proposal object (must set at least one field)", () => {
    const r = MCP_TOOLS.propose_parameters.input.safeParse({
      meetingUrl: "/meet/abc",
      proposal: {},
    });
    expect(r.success).toBe(false);
  });

  it("accepts multi-field proposal", () => {
    const r = MCP_TOOLS.propose_parameters.input.safeParse({
      meetingUrl: "/meet/abc",
      proposal: { format: "video", duration: 45, location: "Zoom" },
    });
    expect(r.success).toBe(true);
  });
});

// Structural lints — every tool registered in MCP_TOOLS must have a
// rate-limit policy and (for host tools) a requiredScope. These exist to
// catch the kind of drift that bit us with `lock_activity_location`, where
// the tool was registered without an MCP_RATE_LIMITS entry and every call
// fell into the unknown-tool fail-closed branch returning a fixed
// retryAfterSeconds: 30. The lint is structural, not procedural — adding a
// new tool without these entries fails CI.
//
// 2026-04-30 stabilization-package §3 Group B (B1's CI lint suggestion).
describe("structural lints — registry coverage", () => {
  it("every MCP_TOOLS entry has a corresponding MCP_RATE_LIMITS entry", () => {
    const missing = MCP_TOOL_NAMES.filter((name) => !MCP_RATE_LIMITS[name]);
    expect(missing, `Missing MCP_RATE_LIMITS for: ${missing.join(", ")}`).toEqual([]);
  });

  it("every HOST_MCP_TOOLS entry declares a requiredScope in {read, schedule, admin}", () => {
    for (const [name, def] of Object.entries(HOST_MCP_TOOLS)) {
      expect(
        def.requiredScope,
        `HOST_MCP_TOOLS.${name}.requiredScope missing or invalid`
      ).toMatch(/^(read|schedule|admin)$/);
    }
  });
});

describe("output refusal shapes", () => {
  it("get_meeting_parameters rate-limit refusal parses", () => {
    const r = MCP_TOOLS.get_meeting_parameters.output.safeParse({
      ok: false,
      reason: "rate_limited",
      message: "Too many requests",
      retryAfterSeconds: 60,
    });
    expect(r.success).toBe(true);
  });

  it("propose_lock slot-taken refusal carries counterProposal[]", () => {
    const r = MCP_TOOLS.propose_lock.output.safeParse({
      ok: false,
      reason: "slot_taken_during_handshake",
      message: "Race lost",
      counterProposal: [
        {
          start: "2026-05-01T16:00:00Z",
          end: "2026-05-01T16:30:00Z",
          score: 4,
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});
