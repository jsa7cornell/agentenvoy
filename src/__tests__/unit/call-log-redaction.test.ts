import { describe, it, expect } from "vitest";
import {
  redactForCallLog,
  redactResponseForCallLog,
} from "@/lib/mcp/call-log";
import { createHash } from "node:crypto";

describe("redactForCallLog", () => {
  it("verbatim class keeps value as-is", () => {
    expect(redactForCallLog("propose_lock", "field", "format")).toEqual({
      kind: "keep",
      value: "format",
    });
  });

  it("drop class omits", () => {
    expect(redactForCallLog("propose_lock", "rationaleProse", "x")).toEqual({
      kind: "drop",
    });
  });

  it("hashed class sha256-hexes", () => {
    const input = "alex@example.com";
    const expected = createHash("sha256").update(input).digest("hex");
    expect(
      redactForCallLog("post_message", "guestEmail", input),
    ).toEqual({ kind: "keep", value: expected });
  });

  it("cap:0 drops long strings", () => {
    // post_message.body has { cap: 0 } → always drop
    expect(redactForCallLog("post_message", "body", "hello")).toEqual({
      kind: "drop",
    });
  });

  it("shape-summary replaces objects with keys/types", () => {
    const out = redactForCallLog("read_state", "rules", {
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

  it("throws on unknown tool", () => {
    expect(() =>
      redactForCallLog("unknown_tool", "field", 1),
    ).toThrow(/unknown tool/);
  });

  it("throws on unknown field (forces table to stay exhaustive)", () => {
    expect(() =>
      redactForCallLog("propose_lock", "newField", 1),
    ).toThrow(/no redaction class/);
  });
});

describe("redactResponseForCallLog", () => {
  it("drops fields with drop class; keeps the rest", () => {
    const out = redactResponseForCallLog("propose_lock", {
      accepted: true,
      field: "format",
      rationaleProse: "anything with secrets https://x.com",
      rationaleTemplate: "Switch to {{format}}",
    });
    expect(out).toEqual({
      accepted: true,
      field: "format",
      rationaleTemplate: "Switch to {{format}}",
    });
    expect(out).not.toHaveProperty("rationaleProse");
  });
});
