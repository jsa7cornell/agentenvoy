import { describe, it, expect } from "vitest";
import {
  validateRationaleProse,
  renderRationaleTemplate,
  RATIONALE_MAX_LEN,
} from "@/lib/mcp/rationale";
import { redactForCallLog } from "@/lib/mcp/call-log";

describe("validateRationaleProse", () => {
  it("accepts plain short prose", () => {
    expect(validateRationaleProse("Align with duration and format.")).toEqual({
      ok: true,
    });
  });

  it("rejects URLs", () => {
    expect(validateRationaleProse("See https://evil.com for details")).toEqual({
      ok: false,
      reason: "url",
    });
    expect(validateRationaleProse("visit www.foo.org now")).toEqual({
      ok: false,
      reason: "url",
    });
    expect(validateRationaleProse("go to evil.io")).toEqual({
      ok: false,
      reason: "url",
    });
  });

  it("rejects emails", () => {
    expect(
      validateRationaleProse("ping alex@example.com"),
    ).toEqual({ ok: false, reason: "email" });
  });

  it("rejects phone numbers", () => {
    expect(validateRationaleProse("call 415-555-1212 now")).toEqual({
      ok: false,
      reason: "phone",
    });
    expect(validateRationaleProse("call +1 415 555 1212")).toEqual({
      ok: false,
      reason: "phone",
    });
  });

  it("rejects length > MAX", () => {
    const s = "a".repeat(RATIONALE_MAX_LEN + 1);
    expect(validateRationaleProse(s)).toEqual({ ok: false, reason: "length" });
  });
});

describe("renderRationaleTemplate", () => {
  it("fills allow-listed placeholders", () => {
    const { output, unknownPlaceholders } = renderRationaleTemplate(
      "Switch to {{format}} for {{duration}}.",
      { format: "video", duration: "30min" },
    );
    expect(output).toBe("Switch to video for 30min.");
    expect(unknownPlaceholders).toEqual([]);
  });

  it("leaves unknown placeholders unrendered and reports them", () => {
    const { output, unknownPlaceholders } = renderRationaleTemplate(
      "Because {{injection}}.",
      {},
    );
    expect(output).toBe("Because {{injection}}.");
    expect(unknownPlaceholders).toEqual(["injection"]);
  });

  it("renders missing context as bracketed name", () => {
    const { output } = renderRationaleTemplate("Switch to {{format}}.", {});
    expect(output).toBe("Switch to [format].");
  });
});

describe("redactForCallLog drops rationaleProse", () => {
  it("propose_lock.rationaleProse → drop", () => {
    expect(redactForCallLog("propose_lock", "rationaleProse", "any text")).toEqual({
      kind: "drop",
    });
  });

  it("propose_lock.rationaleTemplate → kept (verbatim)", () => {
    expect(
      redactForCallLog("propose_lock", "rationaleTemplate", "Switch to {{format}}"),
    ).toEqual({ kind: "keep", value: "Switch to {{format}}" });
  });
});
