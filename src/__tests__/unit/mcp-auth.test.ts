import { describe, it, expect } from "vitest";
import { parseMeetingUrl, MCP_RATE_LIMITS } from "@/lib/mcp/auth";

describe("parseMeetingUrl", () => {
  it("parses generic /meet/<slug>", () => {
    const r = parseMeetingUrl("/meet/johnny");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slug).toBe("johnny");
      expect(r.code).toBeNull();
    }
  });

  it("parses /meet/<slug>?c=<code>", () => {
    const r = parseMeetingUrl("/meet/johnny?c=abc123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.slug).toBe("johnny");
      expect(r.code).toBe("abc123");
    }
  });

  it("accepts absolute URL", () => {
    const r = parseMeetingUrl("https://agentenvoy.ai/meet/johnny?c=xyz");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toBe("xyz");
  });

  it("rejects non-meet paths", () => {
    const r = parseMeetingUrl("/dashboard");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not_meeting_path");
  });

  it("rejects empty / null input", () => {
    expect(parseMeetingUrl("").ok).toBe(false);
    // @ts-expect-error — testing defensive branch
    expect(parseMeetingUrl(null).ok).toBe(false);
  });

  it("rejects malformed URL", () => {
    const r = parseMeetingUrl("http://[::1");
    expect(r.ok).toBe(false);
  });
});

describe("MCP_RATE_LIMITS coverage (SPEC §1.3)", () => {
  const eightTools = [
    "get_meeting_parameters",
    "get_availability",
    "get_session_status",
    "post_message",
    "propose_parameters",
    "propose_lock",
    "cancel_meeting",
    "reschedule_meeting",
  ];

  it("defines every tool in the 8-tool set", () => {
    for (const t of eightTools) {
      expect(MCP_RATE_LIMITS[t], `missing rate limit for ${t}`).toBeDefined();
    }
  });

  it("read-only tools are fail-open", () => {
    expect(MCP_RATE_LIMITS.get_meeting_parameters.failMode).toBe("open");
    expect(MCP_RATE_LIMITS.get_availability.failMode).toBe("open");
    expect(MCP_RATE_LIMITS.get_session_status.failMode).toBe("open");
  });

  it("side-effecting writes are fail-closed", () => {
    expect(MCP_RATE_LIMITS.propose_parameters.failMode).toBe("closed");
    expect(MCP_RATE_LIMITS.propose_lock.failMode).toBe("closed");
    expect(MCP_RATE_LIMITS.cancel_meeting.failMode).toBe("closed");
    expect(MCP_RATE_LIMITS.reschedule_meeting.failMode).toBe("closed");
  });

  it("all limits are positive and windows are 60s", () => {
    for (const t of eightTools) {
      expect(MCP_RATE_LIMITS[t].limit).toBeGreaterThan(0);
      expect(MCP_RATE_LIMITS[t].windowSec).toBe(60);
    }
  });
});
