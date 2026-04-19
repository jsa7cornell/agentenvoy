import { describe, it, expect } from "vitest";
import { canObject } from "@/lib/mcp/can-object";

const base = {
  status: "proposed",
  finalizesAt: null,
  supersededByRescheduleId: null,
};

describe("canObject", () => {
  it("true for an active, non-superseded session with no finalizesAt", () => {
    expect(canObject(base)).toBe(true);
  });

  it.each(["agreed", "rejected", "cancelled", "expired"])(
    "false when status is terminal (%s)",
    (status) => {
      expect(canObject({ ...base, status })).toBe(false);
    },
  );

  it("false when superseded by a reschedule", () => {
    expect(
      canObject({ ...base, supersededByRescheduleId: "sess_new" }),
    ).toBe(false);
  });

  it("false when now >= finalizesAt", () => {
    const finalizesAt = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:00Z");
    expect(canObject({ ...base, finalizesAt }, now)).toBe(false);
  });

  it("true when now < finalizesAt", () => {
    const finalizesAt = new Date("2026-01-01T00:00:01Z");
    const now = new Date("2026-01-01T00:00:00Z");
    expect(canObject({ ...base, finalizesAt }, now)).toBe(true);
  });
});
