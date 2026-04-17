import { describe, expect, it } from "vitest";
import { buildHostNewBookingEmail } from "@/lib/emails/host-new-booking";

describe("buildHostNewBookingEmail", () => {
  const baseParams = {
    hostFirstName: "John",
    guestName: "Sarah Chen",
    guestEmail: "sarah@example.com",
    topic: "Q2 Roadmap",
    whenLabel: "Friday, April 18, 2026 at 2:00 PM",
    timezoneLabel: "PDT",
    durationLabel: "30 min",
    format: "video",
    dealRoomUrl: "https://agentenvoy.ai/meet/johna/abc123",
  };

  it("returns a subject and html body without throwing", () => {
    const { subject, html } = buildHostNewBookingEmail(baseParams);
    expect(subject).toBeTruthy();
    expect(typeof subject).toBe("string");
    expect(html).toContain("<div");
  });

  it("addresses the host by first name", () => {
    const { html } = buildHostNewBookingEmail(baseParams);
    expect(html).toContain("Hey John");
  });

  it("falls back to generic greeting when hostFirstName is null", () => {
    const { html } = buildHostNewBookingEmail({ ...baseParams, hostFirstName: null });
    expect(html).toContain("Hey there");
  });

  it("includes the guest name prominently", () => {
    const { html } = buildHostNewBookingEmail(baseParams);
    expect(html).toContain("Sarah Chen");
  });

  it("falls back to guest email when guestName is null", () => {
    const { html } = buildHostNewBookingEmail({
      ...baseParams,
      guestName: null,
      guestEmail: "sarah@example.com",
    });
    expect(html).toContain("sarah@example.com");
  });

  it("falls back to 'Someone' when both name and email are null", () => {
    const { html } = buildHostNewBookingEmail({
      ...baseParams,
      guestName: null,
      guestEmail: null,
    });
    expect(html).toContain("Someone");
  });

  it("includes the when and timezone labels", () => {
    const { html } = buildHostNewBookingEmail(baseParams);
    expect(html).toContain("Friday, April 18, 2026 at 2:00 PM");
    expect(html).toContain("PDT");
  });

  it("includes duration and format", () => {
    const { html } = buildHostNewBookingEmail(baseParams);
    expect(html).toContain("30 min");
    expect(html).toContain("Video");
  });

  it("includes the topic when present", () => {
    const { html } = buildHostNewBookingEmail(baseParams);
    expect(html).toContain("Q2 Roadmap");
  });

  it("omits topic section when topic is null", () => {
    const { html } = buildHostNewBookingEmail({ ...baseParams, topic: null });
    expect(html).not.toContain("Topic:");
  });

  it("includes a deal room link", () => {
    const { html } = buildHostNewBookingEmail(baseParams);
    expect(html).toContain("https://agentenvoy.ai/meet/johna/abc123");
  });

  it("subject includes guest name when present", () => {
    const { subject } = buildHostNewBookingEmail(baseParams);
    expect(subject).toContain("Sarah Chen");
  });

  it("subject falls back gracefully when guest name is null", () => {
    const { subject } = buildHostNewBookingEmail({ ...baseParams, guestName: null });
    expect(subject).toBeTruthy();
    expect(subject).toContain("New booking");
  });

  it("HTML-escapes user-controlled fields — guestName", () => {
    const { html } = buildHostNewBookingEmail({
      ...baseParams,
      guestName: '<script>alert("xss")</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes user-controlled fields — topic", () => {
    const { html } = buildHostNewBookingEmail({
      ...baseParams,
      topic: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("HTML-escapes user-controlled fields — hostFirstName", () => {
    const { html } = buildHostNewBookingEmail({
      ...baseParams,
      hostFirstName: '<b>bold</b>',
    });
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("HTML-escapes user-controlled fields — guestEmail in subject area", () => {
    const { html } = buildHostNewBookingEmail({
      ...baseParams,
      guestName: null,
      guestEmail: 'bad"@example.com',
    });
    expect(html).not.toContain('"@example.com');
  });
});
