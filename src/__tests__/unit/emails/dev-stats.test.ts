import { describe, expect, it } from "vitest";
import { buildDevStatsEmail, type DevStatsParams } from "@/lib/emails/dev-stats";

function baseParams(overrides: Partial<DevStatsParams> = {}): DevStatsParams {
  const windowEnd = new Date("2026-04-17T16:00:00Z");
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  return {
    windowStart,
    windowEnd,
    newUsers: 0,
    sessionsCreated: 0,
    sessionsConfirmed: 0,
    sessionsCancelled: 0,
    sessionsExpired: 0,
    sessionsEscalated: 0,
    formatBreakdown: [],
    failures: [],
    totalFailures: 0,
    ...overrides,
  };
}

describe("buildDevStatsEmail", () => {
  it("renders a subject containing the day label", () => {
    const { subject } = buildDevStatsEmail(baseParams());
    expect(subject).toContain("AgentEnvoy daily");
    expect(subject).toMatch(/[A-Z][a-z]{2} [A-Z][a-z]{2} \d+/);
  });

  it("renders without errors when everything is zero", () => {
    const { html } = buildDevStatsEmail(baseParams());
    expect(html).toContain("New users");
    expect(html).toContain("Sessions created");
    expect(html).toContain("No failed side effects");
  });

  it("prints all six activity rows with their numeric values", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        newUsers: 3,
        sessionsCreated: 12,
        sessionsConfirmed: 5,
        sessionsCancelled: 1,
        sessionsExpired: 2,
        sessionsEscalated: 0,
      }),
    );
    expect(html).toMatch(/New users[^0-9]*>3</);
    expect(html).toMatch(/Sessions created[^0-9]*>12</);
    expect(html).toMatch(/Sessions confirmed[^0-9]*>5</);
    expect(html).toMatch(/Sessions cancelled[^0-9]*>1</);
    expect(html).toMatch(/Sessions expired[^0-9]*>2</);
    expect(html).toMatch(/Sessions escalated[^0-9]*>0</);
  });

  it("renders the format breakdown rows sorted by caller", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        sessionsConfirmed: 7,
        formatBreakdown: [
          { format: "video", count: 5 },
          { format: "phone", count: 2 },
        ],
      }),
    );
    expect(html).toContain("video");
    expect(html).toContain("phone");
    expect(html.indexOf("video")).toBeLessThan(html.indexOf("phone"));
  });

  it("renders '(none)' when the format breakdown is empty", () => {
    const { html } = buildDevStatsEmail(baseParams());
    expect(html).toContain("(none)");
  });

  it("shows per-kind failure rows with a warning banner when failures exist", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        failures: [
          { kind: "email.send", count: 2 },
          { kind: "calendar.create_event", count: 1 },
        ],
        totalFailures: 3,
      }),
    );
    expect(html).toContain("3 failed side effect");
    expect(html).toContain("email.send");
    expect(html).toContain("calendar.create_event");
    expect(html).not.toContain("No failed side effects");
  });

  it("pluralizes the failure banner correctly for a single failure", () => {
    const { html } = buildDevStatsEmail(
      baseParams({
        failures: [{ kind: "email.send", count: 1 }],
        totalFailures: 1,
      }),
    );
    expect(html).toContain("1 failed side effect");
    expect(html).not.toContain("1 failed side effects");
  });

  it("renders the window range in the body", () => {
    const { html } = buildDevStatsEmail(baseParams());
    expect(html).toContain("PT");
    expect(html).toContain("→");
  });
});
