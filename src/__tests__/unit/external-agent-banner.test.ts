import { describe, it, expect } from "vitest";
import {
  computeExternalAgentSender,
  getRoleStyles,
} from "@/components/deal-room-role-dispatch";

// ─── computeExternalAgentSender — metadata fallbacks (banner spec §1) ──────

describe("computeExternalAgentSender", () => {
  it("happy path: 🤖 {clientName} · for {firstName(principal.name)}", () => {
    const { headline, tooltip } = computeExternalAgentSender({
      clientName: "Claude (via Claude Code)",
      clientType: "mcp",
      principal: { name: "Danny Lee" },
    });
    expect(headline).toBe("Claude (via Claude Code) · for Danny");
    expect(tooltip).toContain("Claude (via Claude Code)");
    expect(tooltip).toContain("(mcp)");
    expect(tooltip).toContain("for Danny Lee"); // full name in tooltip
  });

  it("missing principal → clientName only", () => {
    const { headline } = computeExternalAgentSender({
      clientName: "Acme Scheduler",
    });
    expect(headline).toBe("Acme Scheduler");
  });

  it("missing clientName → 'External agent'", () => {
    const { headline, tooltip } = computeExternalAgentSender({
      clientType: "mcp",
    });
    expect(headline).toBe("External agent");
    expect(tooltip).toContain("(mcp)");
  });

  it("null metadata → 'External agent'", () => {
    const { headline } = computeExternalAgentSender(null);
    expect(headline).toBe("External agent");
  });

  it("whitespace-only clientName treated as missing", () => {
    const { headline } = computeExternalAgentSender({ clientName: "   " });
    expect(headline).toBe("External agent");
  });

  it("empty/whitespace principal.name falls back to clientName only", () => {
    const { headline } = computeExternalAgentSender({
      clientName: "Acme",
      principal: { name: "  " },
    });
    expect(headline).toBe("Acme");
  });
});

// ─── getRoleStyles — dispatch (banner spec §"Component changes") ───────────

describe("getRoleStyles", () => {
  const opts = { isGuest: false, isHost: true };

  it("external_agent returns violet left-aligned bubble", () => {
    const s = getRoleStyles("external_agent", undefined, opts);
    expect(s).not.toBeNull();
    expect(s!.rightAligned).toBe(false);
    expect(s!.bubble).toContain("violet-50");
    expect(s!.bubble).toContain("dark:bg-violet-900/30");
    expect(s!.labelColor).toContain("violet");
  });

  it("host_update metadata kind opts out of bubble (returns null)", () => {
    expect(getRoleStyles("system", "host_update", opts)).toBeNull();
  });

  it("system without host_update renders emerald bubble", () => {
    const s = getRoleStyles("system", undefined, opts);
    expect(s).not.toBeNull();
    expect(s!.bubble).toContain("emerald");
  });

  it("host / guest are right-aligned", () => {
    expect(getRoleStyles("host", undefined, opts)!.rightAligned).toBe(true);
    expect(getRoleStyles("guest", undefined, opts)!.rightAligned).toBe(true);
  });

  it("guest_envoy tints viewer-relative: guest → blue, host → purple", () => {
    const asGuest = getRoleStyles("guest_envoy", undefined, {
      isGuest: true,
      isHost: false,
    });
    const asHost = getRoleStyles("guest_envoy", undefined, {
      isGuest: false,
      isHost: true,
    });
    expect(asGuest!.bubble).toContain("blue");
    expect(asHost!.bubble).toContain("purple");
  });

  it("unknown role falls back to neutral left bubble", () => {
    const s = getRoleStyles("something_new", undefined, opts);
    expect(s).not.toBeNull();
    expect(s!.rightAligned).toBe(false);
    expect(s!.bubble).toContain("surface-secondary");
  });

  it("violet ≠ amber — banner B1 visual-collision guard", () => {
    const ext = getRoleStyles("external_agent", undefined, opts)!;
    expect(ext.bubble).not.toMatch(/amber/);
  });
});
