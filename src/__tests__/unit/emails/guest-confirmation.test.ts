import { describe, expect, it } from "vitest";
import { buildGuestConfirmationEmail } from "@/lib/emails/guest-confirmation";

const baseDate = new Date("2026-04-18T21:00:00Z"); // 2pm PDT

describe("buildGuestConfirmationEmail", () => {
  const base = {
    hostName: "John Abramson",
    guestName: "Sarah Chen",
    topic: "Q2 Roadmap",
    dateTime: baseDate,
    duration: 30,
    format: "video",
    hostTimezone: "America/Los_Angeles",
    guestTimezone: "America/Los_Angeles",
    dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
  };

  it("returns subject and html without throwing", () => {
    const { subject, html } = buildGuestConfirmationEmail(base);
    expect(subject).toBeTruthy();
    expect(html).toContain("<div");
  });

  it("subject includes topic when present", () => {
    const { subject } = buildGuestConfirmationEmail(base);
    expect(subject).toContain("Q2 Roadmap");
  });

  it("subject falls back gracefully when topic is null", () => {
    const { subject } = buildGuestConfirmationEmail({ ...base, topic: null });
    expect(subject).toContain("confirmed");
  });

  it("addresses guest by name", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).toContain("Hi Sarah Chen");
  });

  it("falls back to generic greeting when guestName is null", () => {
    const { html } = buildGuestConfirmationEmail({ ...base, guestName: null });
    expect(html).toContain("Hi there");
  });

  it("includes host name", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).toContain("John Abramson");
  });

  it("shows timezone abbreviation", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).toMatch(/PDT|PST/);
  });

  it("includes duration and format", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).toContain("30 min");
    expect(html).toContain("Video");
  });

  it("includes topic in body when present", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).toContain("Q2 Roadmap");
  });

  it("omits topic block when topic is null", () => {
    const { html } = buildGuestConfirmationEmail({ ...base, topic: null });
    expect(html).not.toContain("Q2 Roadmap");
  });

  it("renders Join Meeting button when meetLink is present", () => {
    const { html } = buildGuestConfirmationEmail({
      ...base,
      meetLink: "https://meet.google.com/abc",
    });
    expect(html).toContain("Join Meeting");
    expect(html).toContain("https://meet.google.com/abc");
  });

  it("omits Join Meeting button when meetLink is null", () => {
    const { html } = buildGuestConfirmationEmail({ ...base, meetLink: undefined });
    expect(html).not.toContain("Join Meeting");
  });

  it("includes deal room link when provided", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).toContain("agentenvoy.ai/meet/johna/abc123");
  });

  it("shows guest's local time first when guestTimezone differs from host", () => {
    const { html } = buildGuestConfirmationEmail({
      ...base,
      hostTimezone: "America/Los_Angeles",
      guestTimezone: "America/New_York",
    });
    // Guest sees EDT time, host time shown as secondary
    expect(html).toMatch(/EDT|EST/);
    expect(html).toContain("Host's time");
  });

  it("does not show dual-timezone line when timezones match", () => {
    const { html } = buildGuestConfirmationEmail(base);
    expect(html).not.toContain("Host's time");
  });

  it("HTML-escapes guestName", () => {
    const { html } = buildGuestConfirmationEmail({
      ...base,
      guestName: '<script>alert("xss")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes hostName", () => {
    const { html } = buildGuestConfirmationEmail({
      ...base,
      hostName: '<b>Dr. Evil</b>',
    });
    expect(html).not.toContain("<b>Dr. Evil</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("HTML-escapes topic", () => {
    const { html } = buildGuestConfirmationEmail({
      ...base,
      topic: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("HTML-escapes meetLink", () => {
    const { html } = buildGuestConfirmationEmail({
      ...base,
      meetLink: 'https://evil.com/"><script>',
    });
    expect(html).not.toContain('"><script>');
  });
});
