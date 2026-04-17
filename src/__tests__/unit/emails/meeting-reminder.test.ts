import { describe, expect, it } from "vitest";
import { buildMeetingReminderEmail } from "@/lib/emails/meeting-reminder";

describe("buildMeetingReminderEmail", () => {
  const baseParams = {
    guestName: "Sarah Chen",
    hostName: "John Abramson",
    whenLabel: "Saturday, April 19, 2026 at 10:00 AM",
    timezoneLabel: "PDT",
    durationLabel: "45 min",
    format: "video",
    location: null,
    meetLink: "https://meet.google.com/abc-defg-hij",
    dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
  };

  it("returns a subject and html body without throwing", () => {
    const { subject, html } = buildMeetingReminderEmail(baseParams);
    expect(subject).toBeTruthy();
    expect(typeof subject).toBe("string");
    expect(html).toContain("<div");
  });

  it("subject mentions the host name and tomorrow", () => {
    const { subject } = buildMeetingReminderEmail(baseParams);
    expect(subject).toContain("John Abramson");
    expect(subject.toLowerCase()).toContain("tomorrow");
  });

  it("greets the guest by name when provided", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("Hi Sarah Chen");
  });

  it("falls back to generic opening when guestName is null", () => {
    const { html } = buildMeetingReminderEmail({ ...baseParams, guestName: null });
    expect(html).toContain("Just a heads-up");
  });

  it("includes the host name", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("John Abramson");
  });

  it("includes when and timezone labels", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("Saturday, April 19, 2026 at 10:00 AM");
    expect(html).toContain("PDT");
  });

  it("includes duration and format", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("45 min");
    expect(html).toContain("Video");
  });

  it("includes meet link when present", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("https://meet.google.com/abc-defg-hij");
  });

  it("renders a Join Meeting button when meetLink is present", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("Join Meeting");
  });

  it("omits join button when meetLink is null", () => {
    const { html } = buildMeetingReminderEmail({ ...baseParams, meetLink: null });
    expect(html).not.toContain("Join Meeting");
  });

  it("shows location when present and no meetLink", () => {
    const { html } = buildMeetingReminderEmail({
      ...baseParams,
      meetLink: null,
      location: "123 Main St, San Francisco",
    });
    expect(html).toContain("123 Main St, San Francisco");
  });

  it("includes the deal room link", () => {
    const { html } = buildMeetingReminderEmail(baseParams);
    expect(html).toContain("https://agentenvoy.ai/meet/johna/abc123");
  });

  it("HTML-escapes user-controlled fields — guestName", () => {
    const { html } = buildMeetingReminderEmail({
      ...baseParams,
      guestName: '<script>alert("xss")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes user-controlled fields — hostName", () => {
    const { html } = buildMeetingReminderEmail({
      ...baseParams,
      hostName: '<b>Dr. Evil</b>',
    });
    expect(html).not.toContain("<b>Dr. Evil</b>");
    expect(html).toContain("&lt;b&gt;Dr. Evil&lt;/b&gt;");
  });

  it("HTML-escapes user-controlled fields — location", () => {
    const { html } = buildMeetingReminderEmail({
      ...baseParams,
      meetLink: null,
      location: '<a href="evil.com">click</a>',
    });
    expect(html).not.toContain('<a href="evil.com">');
    expect(html).toContain("&lt;a");
  });

  it("HTML-escapes the dealRoomUrl", () => {
    const { html } = buildMeetingReminderEmail({
      ...baseParams,
      dealRoomUrl: 'https://agentenvoy.ai/meet/j"ohna/x',
    });
    expect(html).not.toContain('"ohna');
    expect(html).toContain("&quot;");
  });
});
