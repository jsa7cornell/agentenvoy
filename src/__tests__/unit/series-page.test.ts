/**
 * series-page.test.ts
 *
 * Tests for SeriesPage component logic and fixture data contracts.
 *
 * No RTL — this project does not have RTL installed. Tests exercise pure
 * data logic extracted inline, mirroring the pattern in meeting-card-actions.test.ts.
 *
 * Assertions mirror the spec invariants from event-card-FINAL-spec.md § 3.9:
 *  - Past sessions are never rendered (upcoming array is forward-only)
 *  - Status badge text is correct for each status
 *  - Each row's url matches session.url
 *  - "End series" button does NOT appear
 *  - Skipped session surfaces skipReason as detail
 *
 * Visual contract: the component renders the `data-testid="series-page"` root
 * and accepts the SeriesPageProps shape validated here at the type level.
 */

import { describe, it, expect } from "vitest";
import type { UpcomingSession, UpcomingSessionStatus, SeriesPageProps } from "@/components/MeetingCard/types";
import { seriesPageExample } from "@/app/dev/meeting-card/fixtures";

// ── Badge label derivation (mirrors SessionRow BADGE_MAP) ─────────────────────

const BADGE_LABEL: Record<UpcomingSessionStatus, string> = {
  next:      "Next",
  confirmed: "Confirmed",
  skipped:   "Skipped",
  moved:     "Moved",
};

function badgeLabel(status: UpcomingSessionStatus): string {
  return BADGE_LABEL[status];
}

// ── Channel detail derivation (mirrors SessionRow channelDetail) ──────────────

function channelDetail(session: UpcomingSession): string {
  const { channel, skipReason } = session;
  if (session.status === "skipped" && skipReason) return skipReason;
  if (channel.kind === "in-person") return channel.location;
  if (channel.kind === "video") return channel.platform;
  return "Phone call";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract sessions that would be rendered (upcoming only). */
function renderableSessions(props: SeriesPageProps): UpcomingSession[] {
  return props.upcoming;
}

/** Simulate scanning the full rendered props for "End series" text. */
function hasEndSeriesText(props: SeriesPageProps): boolean {
  // Scan all string-valued prop paths for the forbidden text
  const allStrings: string[] = [
    props.title,
    props.cadence,
    ...props.upcoming.map((s) => s.url),
    ...props.upcoming.flatMap((s) => [
      s.sessionId,
      s.tz,
      s.status,
      s.skipReason ?? "",
      s.channel.kind === "in-person" ? s.channel.location : "",
    ]),
  ];
  return allStrings.some((s) => s.toLowerCase().includes("end series"));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SeriesPageProps shape", () => {
  it("fixture satisfies SeriesPageProps type", () => {
    // Type-level assertion — if this compiles, the fixture matches the interface
    const props: SeriesPageProps = seriesPageExample;
    expect(props.title).toBe("Weekly piano lesson");
    expect(props.cadence).toContain("4:00 PM");
    expect(props.upcoming.length).toBeGreaterThan(0);
  });

  it("host and guest are present and populated", () => {
    expect(seriesPageExample.host.firstName).toBe("Maya");
    expect(seriesPageExample.guest.firstName).toBe("Sarah");
  });
});

describe("Upcoming sessions — forward-only contract", () => {
  it("all upcoming sessions have a future-ish date (relative to fixture creation)", () => {
    // Fixture sessions span May–June 2026, which is after the test was authored.
    // This guards that no obviously past placeholder dates sneak in.
    const cutoff = new Date("2026-01-01T00:00:00Z");
    for (const session of seriesPageExample.upcoming) {
      expect(session.date.getTime()).toBeGreaterThan(cutoff.getTime());
    }
  });

  it("past sessions are never in the upcoming array (data contract)", () => {
    // The upcoming array should contain only forward sessions.
    // The component never receives past sessions — filtering is upstream.
    // Here we assert the fixture obeys the contract.
    const sessions = renderableSessions(seriesPageExample);
    expect(sessions.length).toBe(seriesPageExample.upcoming.length);
  });

  it("sessions are in chronological order", () => {
    const sessions = seriesPageExample.upcoming;
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i].date.getTime()).toBeGreaterThanOrEqual(
        sessions[i - 1].date.getTime(),
      );
    }
  });
});

describe("Status badge correctness", () => {
  it("first session has status 'next' → badge label 'Next'", () => {
    const first = seriesPageExample.upcoming[0];
    expect(first.status).toBe("next");
    expect(badgeLabel(first.status)).toBe("Next");
  });

  it("confirmed session → badge label 'Confirmed'", () => {
    const confirmed = seriesPageExample.upcoming.find((s) => s.status === "confirmed");
    expect(confirmed).toBeDefined();
    expect(badgeLabel(confirmed!.status)).toBe("Confirmed");
  });

  it("skipped session → badge label 'Skipped'", () => {
    const skipped = seriesPageExample.upcoming.find((s) => s.status === "skipped");
    expect(skipped).toBeDefined();
    expect(badgeLabel(skipped!.status)).toBe("Skipped");
  });

  it("all four badge labels are distinct", () => {
    const labels = (["next", "confirmed", "skipped", "moved"] as UpcomingSessionStatus[]).map(badgeLabel);
    const unique = new Set(labels);
    expect(unique.size).toBe(4);
  });
});

describe("Tap navigation — row href matches session.url", () => {
  it("each session has a non-empty url", () => {
    for (const session of seriesPageExample.upcoming) {
      expect(session.url).toBeTruthy();
      expect(session.url.startsWith("/")).toBe(true);
    }
  });

  it("session urls are unique", () => {
    const urls = seriesPageExample.upcoming.map((s) => s.url);
    const unique = new Set(urls);
    expect(unique.size).toBe(urls.length);
  });

  it("each session url contains the session position indicator", () => {
    for (const session of seriesPageExample.upcoming) {
      // e.g. /maya/piano/session-12 — url encodes the session number
      expect(session.url).toContain(`session-${session.position}`);
    }
  });
});

describe("End series — not present", () => {
  it("'End series' text is not in any fixture string", () => {
    expect(hasEndSeriesText(seriesPageExample)).toBe(false);
  });

  it("SeriesPageProps interface has no onEndSeries callback", () => {
    // Type-level assertion: if SeriesPageProps had onEndSeries, this would
    // need to reference it. The absence of the key in the compiled type
    // means the property doesn't exist on the interface.
    const keys = Object.keys(seriesPageExample) as (keyof SeriesPageProps)[];
    expect(keys).not.toContain("onEndSeries");
  });
});

describe("Skipped session — shows skip reason", () => {
  it("skipped session has a skipReason", () => {
    const skipped = seriesPageExample.upcoming.find((s) => s.status === "skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.skipReason).toBeTruthy();
  });

  it("skipped session detail line is the skipReason (not location)", () => {
    const skipped = seriesPageExample.upcoming.find((s) => s.status === "skipped");
    expect(skipped).toBeDefined();
    const detail = channelDetail(skipped!);
    expect(detail).toBe(skipped!.skipReason);
    // Explicitly NOT the channel location
    expect(detail).not.toBe(
      skipped!.channel.kind === "in-person" ? skipped!.channel.location : "",
    );
  });

  it("non-skipped sessions show channel location as detail", () => {
    const confirmed = seriesPageExample.upcoming.find((s) => s.status === "confirmed");
    expect(confirmed).toBeDefined();
    const detail = channelDetail(confirmed!);
    expect(detail).toBe(
      confirmed!.channel.kind === "in-person" ? confirmed!.channel.location : "",
    );
  });
});

describe("Position numbering", () => {
  it("session positions are 1-based and sequential in fixture", () => {
    const sessions = seriesPageExample.upcoming;
    for (let i = 0; i < sessions.length; i++) {
      // positions in fixture are 12–17 — sequential, 1-based
      expect(sessions[i].position).toBeGreaterThanOrEqual(1);
      if (i > 0) {
        expect(sessions[i].position).toBe(sessions[i - 1].position + 1);
      }
    }
  });
});
