import { describe, it, expect } from "vitest";
import { formatDuration, formatDurationCompact } from "@/lib/format-duration";

describe("formatDuration", () => {
  it("under an hour: plain minutes", () => {
    expect(formatDuration(15)).toBe("15 min");
    expect(formatDuration(30)).toBe("30 min");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(59)).toBe("59 min");
  });

  it("exact hour multiples", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(480)).toBe("8h");
  });

  it("mixed hours and minutes", () => {
    expect(formatDuration(75)).toBe("1h 15m");
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(150)).toBe("2h 30m");
  });

  it("handles null/undefined/bad input", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(-5)).toBe("");
    expect(formatDuration(NaN)).toBe("");
  });
});

describe("formatDurationCompact", () => {
  it("under an hour: N-min suffix", () => {
    expect(formatDurationCompact(30)).toBe("30-min");
    expect(formatDurationCompact(45)).toBe("45-min");
  });

  it("hour multiples and mixed", () => {
    expect(formatDurationCompact(60)).toBe("1h");
    expect(formatDurationCompact(90)).toBe("1h-30m");
    expect(formatDurationCompact(480)).toBe("8h");
  });
});
