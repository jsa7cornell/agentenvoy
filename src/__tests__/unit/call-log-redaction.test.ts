import { describe, it, expect } from "vitest";
import {
  redactForCallLog,
  redactResponseForCallLog,
} from "@/lib/mcp/call-log";

describe("redactForCallLog", () => {
  it("verbatim class keeps value as-is", () => {
    expect(redactForCallLog("propose_lock", "status", "agreed")).toEqual({
      kind: "keep",
      value: "agreed",
    });
  });

  it("shape-summary replaces objects with keys/types", () => {
    const out = redactForCallLog("get_meeting_parameters", "rules", {
      duration: 30,
      format: "video",
    });
    expect(out.kind).toBe("keep");
    if (out.kind !== "keep") return;
    expect(out.value).toEqual({
      keys: ["duration", "format"],
      valueTypes: { duration: "number", format: "string" },
    });
  });

  it("shape-summary on arrays returns type/length/elementShape", () => {
    const out = redactForCallLog("get_availability", "slots", [
      { start: "2026-05-01T10:00:00Z", tier: "first_offer" },
    ]);
    expect(out.kind).toBe("keep");
    if (out.kind !== "keep") return;
    expect(out.value).toMatchObject({ type: "array", length: 1 });
  });

  it("refusal common fields are verbatim across tools", () => {
    expect(redactForCallLog("propose_lock", "reason", "slot_mismatch")).toEqual({
      kind: "keep",
      value: "slot_mismatch",
    });
    expect(
      redactForCallLog("get_availability", "retryAfterSeconds", 30),
    ).toEqual({ kind: "keep", value: 30 });
  });

  it("throws on unknown tool", () => {
    expect(() => redactForCallLog("unknown_tool", "field", 1)).toThrow(
      /unknown tool/,
    );
  });

  it("throws on unknown field (forces table to stay exhaustive)", () => {
    expect(() =>
      redactForCallLog("propose_lock", "newField", 1),
    ).toThrow(/no redaction class/);
  });
});

describe("redactResponseForCallLog", () => {
  it("keeps verbatim fields and shape-summarizes nested objects", () => {
    const out = redactResponseForCallLog("propose_lock", {
      ok: true,
      sessionId: "sess_123",
      status: "agreed",
      dateTime: "2026-05-01T10:00:00Z",
      duration: 30,
      format: "video",
      location: null,
      meetLink: "https://meet.example/abc",
      eventLink: "https://cal.example/evt",
      idempotent: false,
      warnings: [],
      counterProposal: { dateTime: "2026-05-02T10:00:00Z", reason: "soft" },
    });
    expect(out.sessionId).toBe("sess_123");
    expect(out.status).toBe("agreed");
    expect(out.meetLink).toBe("https://meet.example/abc");
    // counterProposal → shape-summary
    expect(out.counterProposal).toMatchObject({
      keys: ["dateTime", "reason"],
    });
  });

  it("handles refusal envelopes", () => {
    const out = redactResponseForCallLog("propose_lock", {
      ok: false,
      reason: "slot_mismatch",
      message: "slot no longer available",
    });
    expect(out).toEqual({
      ok: false,
      reason: "slot_mismatch",
      message: "slot no longer available",
    });
  });
});
