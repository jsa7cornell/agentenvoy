import { describe, expect, it } from "vitest";
import { buildHostBookingConfirmedEmail } from "@/lib/emails/host-booking-confirmed";

const baseDate = new Date("2026-04-18T21:00:00Z"); // 2pm PDT

const baseUpcoming = [
  {
    agreedTime: new Date(Date.now() + 2 * 86400000), // 2 days from now
    guestDisplay: "Alex Kim",
    duration: 45,
    format: "phone",
  },
];

const basePending = [
  { guestDisplay: "Jordan Lee", topic: "Q4 Budget", updatedAt: new Date(Date.now() - 3600000) },
];

describe("buildHostBookingConfirmedEmail", () => {
  const base = {
    hostFirstName: "John",
    guestName: "Sarah Chen",
    guestEmail: "sarah@example.com",
    topic: "Q2 Roadmap",
    dateTime: baseDate,
    duration: 30,
    format: "video",
    hostTimezone: "America/Los_Angeles",
    guestTimezone: "America/Los_Angeles",
    dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
    upcoming: [],
    pending: [],
  };

  it("returns subject and html without throwing", () => {
    const { subject, html } = buildHostBookingConfirmedEmail(base);
    expect(subject).toBeTruthy();
    expect(html).toContain("<div");
  });

  it("subject includes guest name", () => {
    const { subject } = buildHostBookingConfirmedEmail(base);
    expect(subject).toContain("Sarah Chen");
    expect(subject).toContain("confirmed");
  });

  it("subject falls back gracefully when guestName is null", () => {
    const { subject } = buildHostBookingConfirmedEmail({ ...base, guestName: null });
    expect(subject).toContain("confirmed");
  });

  it("greets host by first name", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).toContain("Hey John");
  });

  it("falls back to generic greeting when hostFirstName is null", () => {
    const { html } = buildHostBookingConfirmedEmail({ ...base, hostFirstName: null });
    expect(html).toContain("Hey there");
  });

  it("displays guest name prominently", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).toContain("Sarah Chen");
  });

  it("shows guest email as mailto link", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).toContain("mailto:sarah@example.com");
    expect(html).toContain("sarah@example.com");
  });

  it("includes topic when present", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).toContain("Q2 Roadmap");
  });

  it("omits topic when null", () => {
    const { html } = buildHostBookingConfirmedEmail({ ...base, topic: null });
    expect(html).not.toContain("Q2 Roadmap");
  });

  it("shows host timezone", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).toMatch(/PDT|PST/);
  });

  it("shows guest's time as secondary when timezones differ", () => {
    const { html } = buildHostBookingConfirmedEmail({
      ...base,
      hostTimezone: "America/Los_Angeles",
      guestTimezone: "America/New_York",
    });
    expect(html).toContain("Guest's time");
    expect(html).toMatch(/EDT|EST/);
  });

  it("does not show guest's time line when timezones match", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).not.toContain("Guest's time");
  });

  it("includes deal room button", () => {
    const { html } = buildHostBookingConfirmedEmail(base);
    expect(html).toContain("View Deal Room");
    expect(html).toContain("agentenvoy.ai/meet/johna/abc123");
  });

  it("includes meetLink when present", () => {
    const { html } = buildHostBookingConfirmedEmail({
      ...base,
      meetLink: "https://meet.google.com/xyz",
    });
    expect(html).toContain("meet.google.com/xyz");
  });

  it("shows upcoming meetings section when upcoming is non-empty", () => {
    const { html } = buildHostBookingConfirmedEmail({ ...base, upcoming: baseUpcoming, pending: [] });
    expect(html).toContain("Also on your schedule");
    expect(html).toContain("Alex Kim");
    expect(html).toContain("45 min");
  });

  it("shows pending section when pending is non-empty", () => {
    const { html } = buildHostBookingConfirmedEmail({ ...base, upcoming: [], pending: basePending });
    expect(html).toContain("Also on your schedule");
    expect(html).toContain("Jordan Lee");
    expect(html).toContain("Q4 Budget");
  });

  it("omits schedule section when both upcoming and pending are empty", () => {
    const { html } = buildHostBookingConfirmedEmail({ ...base, upcoming: [], pending: [] });
    expect(html).not.toContain("Also on your schedule");
  });

  it("HTML-escapes guestName", () => {
    const { html } = buildHostBookingConfirmedEmail({
      ...base,
      guestName: '<script>alert("xss")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes hostFirstName", () => {
    const { html } = buildHostBookingConfirmedEmail({
      ...base,
      hostFirstName: '<b>Bold</b>',
    });
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("HTML-escapes guestEmail", () => {
    const { html } = buildHostBookingConfirmedEmail({
      ...base,
      guestEmail: 'bad"@example.com',
    });
    expect(html).not.toContain('"@example.com');
    expect(html).toContain("&quot;");
  });

  it("HTML-escapes topic", () => {
    const { html } = buildHostBookingConfirmedEmail({
      ...base,
      topic: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
