import { describe, it, expect } from "vitest";
import { buildIcs } from "@/lib/ics";

describe("buildIcs", () => {
  const base = {
    uid: "session_abc123",
    startUtc: new Date("2026-05-01T15:30:00.000Z"),
    endUtc: new Date("2026-05-01T16:00:00.000Z"),
    summary: "AgentEnvoy meeting",
  };

  it("emits a valid VCALENDAR/VEVENT skeleton with CRLF and trailing newline", () => {
    const ics = buildIcs(base);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("UID:session_abc123@agentenvoy.ai");
  });

  it("formats DTSTART/DTEND as UTC YYYYMMDDTHHMMSSZ", () => {
    const ics = buildIcs(base);
    expect(ics).toContain("DTSTART:20260501T153000Z");
    expect(ics).toContain("DTEND:20260501T160000Z");
  });

  it("escapes commas, semicolons, and newlines in SUMMARY/DESCRIPTION", () => {
    const ics = buildIcs({
      ...base,
      summary: "Sync; with Bryan, re: Q2",
      description: "Line one\nLine two; more, stuff",
    });
    expect(ics).toContain("SUMMARY:Sync\\; with Bryan\\, re: Q2");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two\\; more\\, stuff");
  });

  it("appends Join: <meetLink> to description when meetLink present", () => {
    const ics = buildIcs({
      ...base,
      description: "Quarterly sync",
      meetLink: "https://meet.google.com/abc-defg-hij",
    });
    expect(ics).toContain("Join: https://meet.google.com/abc-defg-hij");
  });

  it("emits ORGANIZER and ATTENDEE lines with mailto:", () => {
    const ics = buildIcs({
      ...base,
      organizer: { name: "Mike", email: "mike@example.com" },
      attendees: [{ name: "Bryan", email: "bryan@example.com" }],
    });
    expect(ics).toContain("ORGANIZER;CN=Mike:mailto:mike@example.com");
    expect(ics).toContain(
      "ATTENDEE;CN=Bryan;RSVP=FALSE;PARTSTAT=ACCEPTED:mailto:bryan@example.com",
    );
  });

  it("folds lines longer than 75 octets per RFC 5545", () => {
    const longDesc = "x".repeat(200);
    const ics = buildIcs({ ...base, description: longDesc });
    const descLineMatch = ics.match(/DESCRIPTION:[^\r]*(\r\n [^\r]*)+/);
    expect(descLineMatch).toBeTruthy();
  });
});
