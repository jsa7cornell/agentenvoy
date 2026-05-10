/**
 * Unit tests for authored-link-tip template.
 *
 * AP5b parity: guest vs host renders share the same templateId / sourceKind.
 * Per Phase 2 PR2 SEED pivot 2026-05-10.
 */
import { describe, it, expect } from "vitest";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";
import type { BuildTipInputArgs } from "@/lib/meeting-tip/build-input";

const BASE_ARGS: BuildTipInputArgs = {
  hostName: "John Anderson",
  inviteeName: "Sarah Chen",
  linkFormat: "video",
  linkActivity: "Coffee",
  linkLocation: null,
};

describe("authored-link-tip template", () => {
  it("wins when linkAuthoredTip is set — returns verbatim text", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "Bring your laptop and coffee.",
    });
    const result = renderTip(input, "guest");
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Bring your laptop and coffee.");
    expect(result!.templateId).toBe("authored-link-tip-v1");
    expect(result!.sourceKind).toBe("authored-day-of");
  });

  it("trims whitespace from linkAuthoredTip", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "  Great meeting!  ",
    });
    const result = renderTip(input, "guest");
    expect(result!.text).toBe("Great meeting!");
  });

  it("source label contains host first name", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "A tip",
    });
    const result = renderTip(input, "guest");
    expect(result!.source).toContain("John");
  });

  it("falls through when linkAuthoredTip is empty string", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "",
    });
    const result = renderTip(input, "guest");
    // Falls to next applicable template — not authored-link-tip-v1
    expect(result?.templateId ?? null).not.toBe("authored-link-tip-v1");
  });

  it("falls through when linkAuthoredTip is whitespace only", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "   ",
    });
    const result = renderTip(input, "guest");
    expect(result?.templateId ?? null).not.toBe("authored-link-tip-v1");
  });

  it("falls through when linkAuthoredTip is null", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: null,
    });
    const result = renderTip(input, "guest");
    expect(result?.templateId ?? null).not.toBe("authored-link-tip-v1");
  });

  it("falls through when linkAuthoredTip is undefined", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
    });
    const result = renderTip(input, "guest");
    expect(result?.templateId ?? null).not.toBe("authored-link-tip-v1");
  });

  // AP5b parity invariant: guest vs host get same templateId + sourceKind
  it("AP5b — guest and host viewer get same templateId", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "See you there!",
    });
    const guestResult = renderTip(input, "guest");
    const hostResult = renderTip(input, "host");
    expect(guestResult!.templateId).toBe(hostResult!.templateId);
    expect(guestResult!.sourceKind).toBe(hostResult!.sourceKind);
    expect(guestResult!.templateId).toBe("authored-link-tip-v1");
  });

  it("AP5b — templateId is authored-link-tip-v1 for both viewer roles", () => {
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "Don't be late!",
    });
    expect(renderTip(input, "guest")!.templateId).toBe("authored-link-tip-v1");
    expect(renderTip(input, "host")!.templateId).toBe("authored-link-tip-v1");
  });

  it("has priority 11 — beats all other templates", () => {
    // authored-link-tip has priority 11; next highest template is at most 10.
    // With tipDayOf also set, authored-link-tip still wins.
    const input = buildTipInput({
      ...BASE_ARGS,
      linkAuthoredTip: "My authored tip",
      tipDayOf: "Some other day-of tip",
    });
    const result = renderTip(input, "guest");
    expect(result!.templateId).toBe("authored-link-tip-v1");
    expect(result!.text).toBe("My authored tip");
  });
});
