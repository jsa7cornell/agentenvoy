/**
 * `buildCalibrateSeedInfoText` — generates the first-person seed-info
 * Envoy ChannelMessage written by /api/onboarding/calibrate-opener.
 *
 * Hotfix-2 (2026-05-05): the four Google-seed bullets that used to render in
 * `<PostureBubble>` are now persisted as a chat message so they survive the
 * `<FirstRunWelcome>` unmount on `hasRealChat`. The four fields, format,
 * copy, and emoji set must match the React component John explicitly loves.
 */
import { describe, it, expect } from "vitest";
import { buildCalibrateSeedInfoText } from "@/lib/onboarding/calibrate-seed-info-text";

describe("buildCalibrateSeedInfoText", () => {
  it("renders all four Google-seed bullets with bold field labels", () => {
    const text = buildCalibrateSeedInfoText({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1020,
      defaultDuration: 30,
      videoProvider: "google_meet",
      timezone: "America/Los_Angeles",
    });
    expect(text).toContain("⏰ **Business hours:** 9am–5pm");
    expect(text).toContain("🌍 **Timezone:**");
    expect(text).toContain("⏱️ **Default meetings:** 30-minute Google Meet");
    expect(text).toContain("📅 **Reading from:** your primary calendar");
    expect(text).toContain("All customizable any time.");
    expect(text.startsWith("I've pulled in your calendar")).toBe(true);
  });

  it("renders Zoom when videoProvider is zoom", () => {
    const text = buildCalibrateSeedInfoText({
      businessHoursStartMinutes: 480,
      businessHoursEndMinutes: 960,
      defaultDuration: 25,
      videoProvider: "zoom",
      timezone: "America/New_York",
    });
    expect(text).toContain("25-minute Zoom");
    expect(text).toContain("8am–4pm");
  });

  it("omits the timezone bullet when timezone is null", () => {
    const text = buildCalibrateSeedInfoText({
      businessHoursStartMinutes: 540,
      businessHoursEndMinutes: 1020,
      defaultDuration: 30,
      videoProvider: "google_meet",
      timezone: null,
    });
    expect(text).not.toContain("🌍");
    // Other bullets still render.
    expect(text).toContain("Business hours:");
    expect(text).toContain("Default meetings:");
    expect(text).toContain("Reading from:");
  });

  it("formats half-hour business-hour boundaries", () => {
    const text = buildCalibrateSeedInfoText({
      businessHoursStartMinutes: 510, // 8:30am
      businessHoursEndMinutes: 1050, // 5:30pm
      defaultDuration: 30,
      videoProvider: "google_meet",
      timezone: "America/Los_Angeles",
    });
    expect(text).toContain("8:30am–5:30pm");
  });
});
