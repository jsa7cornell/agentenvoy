/**
 * DST correctness on `computeUtcOffset`. Author-self-awareness hedge flagged
 * in the confirm-pipeline-extraction proposal §"What could go wrong":
 * the offset flow is rough-offset → rough-date → DST-correct-offset. A
 * block-copy reordering could pass tests on a non-DST day and silently
 * break a DST-adjacent booking. This test pins the observed behavior.
 */
import { describe, it, expect } from "vitest";
import { computeUtcOffset } from "@/lib/confirm-pipeline";

describe("computeUtcOffset — DST correctness", () => {
  // America/Denver spring-forward: 2026-03-08 02:00 → 03:00
  // Before: MST = -07:00. After: MDT = -06:00.
  it("America/Denver before spring-forward → -07:00", () => {
    const d = new Date("2026-03-07T12:00:00Z");
    expect(computeUtcOffset("America/Denver", d)).toBe("-07:00");
  });

  it("America/Denver after spring-forward → -06:00", () => {
    const d = new Date("2026-03-09T12:00:00Z");
    expect(computeUtcOffset("America/Denver", d)).toBe("-06:00");
  });

  // America/Denver fall-back: 2026-11-01 02:00 → 01:00
  // Before: MDT = -06:00. After: MST = -07:00.
  it("America/Denver before fall-back → -06:00", () => {
    const d = new Date("2026-10-31T12:00:00Z");
    expect(computeUtcOffset("America/Denver", d)).toBe("-06:00");
  });

  it("America/Denver after fall-back → -07:00", () => {
    const d = new Date("2026-11-03T12:00:00Z");
    expect(computeUtcOffset("America/Denver", d)).toBe("-07:00");
  });

  it("UTC always returns +00:00", () => {
    expect(computeUtcOffset("UTC", new Date("2026-06-01T00:00:00Z"))).toBe("+00:00");
    expect(computeUtcOffset("UTC", new Date("2026-01-01T00:00:00Z"))).toBe("+00:00");
  });

  it("Asia/Tokyo (no DST) always returns +09:00", () => {
    expect(computeUtcOffset("Asia/Tokyo", new Date("2026-06-01T00:00:00Z"))).toBe(
      "+09:00"
    );
    expect(computeUtcOffset("Asia/Tokyo", new Date("2026-01-01T00:00:00Z"))).toBe(
      "+09:00"
    );
  });
});
