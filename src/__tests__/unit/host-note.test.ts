import { describe, it, expect } from "vitest";
import { formatHostNoteLine } from "@/lib/greeting-template";

describe("formatHostNoteLine", () => {
  it("returns null when hostNote is null/undefined/empty/whitespace", () => {
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: null })).toBeNull();
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: undefined })).toBeNull();
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: "" })).toBeNull();
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: "   " })).toBeNull();
  });

  it("renders 💬 prefix + colon attribution + verbatim note", () => {
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: "I suggested Monday morning" })).toBe(
      "💬 John: I suggested Monday morning",
    );
  });

  it("preserves embedded straight quotes verbatim (no wrapping quotes to escape against)", () => {
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: 'She said "yes" and "maybe"' })).toBe(
      '💬 John: She said "yes" and "maybe"',
    );
  });

  it("preserves curly quotes verbatim", () => {
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: "He said \u201cyes\u201d" })).toBe(
      "\uD83D\uDCAC John: He said \u201cyes\u201d",
    );
  });

  it("trims surrounding whitespace on the note", () => {
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: "  framing  " })).toBe(
      "💬 John: framing",
    );
  });

  it("falls back to 'Host' when hostFirstName is missing", () => {
    expect(formatHostNoteLine({ hostFirstName: "", hostNote: "context" })).toBe(
      "💬 Host: context",
    );
  });

  it("renders markdown chars literally (not interpreted at this layer)", () => {
    expect(formatHostNoteLine({ hostFirstName: "John", hostNote: "**bold** and # heading" })).toBe(
      "💬 John: **bold** and # heading",
    );
  });
});
