/**
 * Unit tests for `computeOnboardingState`, `selectChatVariant`, and the
 * supporting helpers in `lib/onboarding/dormant-eligibility.ts`.
 *
 * Per `2026-05-05_conversational-onboarding-vision_decided-2026-05-05` PR-C
 * test plan: covers fresh-signup (no terminals), post-tuning (terminal
 * `primary-link-tuning`), post-calibration (terminal `recalibrate`), 10d
 * sub-dormant, 14d dormant, and mixed history shapes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    channelMessage: { count: vi.fn() },
    negotiationSession: { count: vi.fn() },
    sessionParticipant: { count: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  computeOnboardingState,
  findLatestTerminalMarkerAt,
  resolveWelcomeVariant,
  RETURNING_DORMANT_THRESHOLD_DAYS,
  type DatedMessageMetaSlice,
} from "@/lib/onboarding/dormant-eligibility";
import {
  selectChatVariant,
  POST_CALIBRATION_WINDOW_MS,
} from "@/agent/modules/chat/playbook-variants";

const USER_ID = "u_test";
const NOW = new Date("2026-05-05T12:00:00Z");

function mockUser(lastCalibratedAt: Date | null) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    lastCalibratedAt,
  } as never);
}

function mockCounts(args: {
  messageCount: number;
  hostedSessionCount: number;
  guestSessionCount: number;
  participantCount: number;
}) {
  vi.mocked(prisma.channelMessage.count).mockResolvedValue(args.messageCount as never);
  // Two negotiationSession.count calls: hosted then guest. Use mockImplementation
  // so we can serve them in order.
  let nsCallIdx = 0;
  vi.mocked(prisma.negotiationSession.count).mockImplementation(() => {
    const idx = nsCallIdx++;
    return Promise.resolve(
      idx === 0 ? args.hostedSessionCount : args.guestSessionCount,
    ) as never;
  });
  vi.mocked(prisma.sessionParticipant.count).mockResolvedValue(
    args.participantCount as never,
  );
}

function makeMessage(
  createdAt: Date,
  meta: Record<string, unknown> | null,
): DatedMessageMetaSlice {
  return { createdAt, metadata: meta };
}

describe("findLatestTerminalMarkerAt", () => {
  it("returns null when no matching messages exist", () => {
    expect(
      findLatestTerminalMarkerAt(
        [makeMessage(NOW, { kind: "host", text: "hi" })],
        "primary-link-tuning",
      ),
    ).toBeNull();
  });

  it("returns null when matching kind+subkind exists but terminal is false", () => {
    const at = new Date(NOW.getTime() - 1000);
    expect(
      findLatestTerminalMarkerAt(
        [
          makeMessage(at, {
            kind: "onboarding",
            subkind: "primary-link-tuning",
            terminal: false,
          }),
        ],
        "primary-link-tuning",
      ),
    ).toBeNull();
  });

  it("returns the most-recent terminal timestamp when multiple exist", () => {
    const older = new Date(NOW.getTime() - 60_000);
    const newer = new Date(NOW.getTime() - 30_000);
    const result = findLatestTerminalMarkerAt(
      [
        makeMessage(older, {
          kind: "onboarding",
          subkind: "recalibrate",
          terminal: true,
        }),
        makeMessage(newer, {
          kind: "onboarding",
          subkind: "recalibrate",
          terminal: true,
        }),
      ],
      "recalibrate",
    );
    expect(result?.getTime()).toBe(newer.getTime());
  });

  it("ignores other subkinds", () => {
    const at = new Date(NOW.getTime() - 1000);
    expect(
      findLatestTerminalMarkerAt(
        [
          makeMessage(at, {
            kind: "onboarding",
            subkind: "preferences-extended",
            terminal: true,
          }),
        ],
        "primary-link-tuning",
      ),
    ).toBeNull();
  });
});

describe("resolveWelcomeVariant", () => {
  it("first-run when no messages, no sessions, no participation", () => {
    expect(
      resolveWelcomeVariant({
        messageCount: 0,
        lastChannelMessageAt: null,
        hostedSessionCount: 0,
        guestSessionCount: 0,
        participantCount: 0,
        now: NOW,
      }),
    ).toBe("first-run");
  });

  it("guest-first when guest activity exists but no host activity", () => {
    expect(
      resolveWelcomeVariant({
        messageCount: 0,
        lastChannelMessageAt: null,
        hostedSessionCount: 0,
        guestSessionCount: 1,
        participantCount: 0,
        now: NOW,
      }),
    ).toBe("guest-first");
  });

  it("active when messages exist within threshold window", () => {
    const recent = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    expect(
      resolveWelcomeVariant({
        messageCount: 5,
        lastChannelMessageAt: recent,
        hostedSessionCount: 1,
        guestSessionCount: 0,
        participantCount: 0,
        now: NOW,
      }),
    ).toBe("active");
  });

  it("returning-dormant at exactly 14d", () => {
    const at14d = new Date(
      NOW.getTime() - RETURNING_DORMANT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(
      resolveWelcomeVariant({
        messageCount: 5,
        lastChannelMessageAt: at14d,
        hostedSessionCount: 1,
        guestSessionCount: 0,
        participantCount: 0,
        now: NOW,
      }),
    ).toBe("returning-dormant");
  });
});

describe("computeOnboardingState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fresh signup: no terminals, no calibration history", async () => {
    mockUser(null);
    mockCounts({
      messageCount: 0,
      hostedSessionCount: 0,
      guestSessionCount: 0,
      participantCount: 0,
    });

    const state = await computeOnboardingState(USER_ID, [], 2, NOW);

    expect(state.welcomeVariant).toBe("first-run");
    expect(state.daysSinceCalibration).toBeNull();
    expect(state.daysSinceLastChannelMessage).toBeNull();
    expect(state.primaryLinkTuningCompleted).toBe(false);
    expect(state.preferencesExtendedCompleted).toBe(false);
    expect(state.lastTuningCompletionAt).toBeNull();
    expect(state.lastCalibrationCompletionAt).toBeNull();
    expect(state.profileGapsCount).toBe(2);
  });

  it("post-tuning: primary-link-tuning terminal marker present", async () => {
    const lastCal = new Date(NOW.getTime() - 60_000); // 1m ago
    mockUser(lastCal);
    mockCounts({
      messageCount: 3,
      hostedSessionCount: 0,
      guestSessionCount: 0,
      participantCount: 0,
    });

    const tuningAt = new Date(NOW.getTime() - 90_000);
    const state = await computeOnboardingState(
      USER_ID,
      [
        makeMessage(tuningAt, {
          kind: "onboarding",
          subkind: "primary-link-tuning",
          terminal: true,
        }),
      ],
      0,
      NOW,
    );

    expect(state.welcomeVariant).toBe("active");
    expect(state.primaryLinkTuningCompleted).toBe(true);
    expect(state.lastTuningCompletionAt?.getTime()).toBe(tuningAt.getTime());
    expect(state.lastCalibrationCompletionAt).toBeNull();
    expect(state.daysSinceCalibration).toBe(0);
  });

  it("post-calibration: recalibrate terminal marker present", async () => {
    const lastCal = new Date(NOW.getTime() - 60_000);
    mockUser(lastCal);
    mockCounts({
      messageCount: 5,
      hostedSessionCount: 1,
      guestSessionCount: 0,
      participantCount: 0,
    });

    const recalAt = new Date(NOW.getTime() - 120_000);
    const state = await computeOnboardingState(
      USER_ID,
      [
        makeMessage(recalAt, {
          kind: "onboarding",
          subkind: "recalibrate",
          terminal: true,
        }),
      ],
      0,
      NOW,
    );

    expect(state.lastCalibrationCompletionAt?.getTime()).toBe(recalAt.getTime());
    expect(state.lastTuningCompletionAt).toBeNull();
    expect(state.primaryLinkTuningCompleted).toBe(false);
  });

  it("10d sub-dormant gap: still active (<14d)", async () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    mockUser(tenDaysAgo);
    mockCounts({
      messageCount: 8,
      hostedSessionCount: 2,
      guestSessionCount: 0,
      participantCount: 0,
    });

    const state = await computeOnboardingState(
      USER_ID,
      [makeMessage(tenDaysAgo, { kind: "host", text: "previous turn" })],
      0,
      NOW,
    );

    expect(state.welcomeVariant).toBe("active");
    expect(state.daysSinceLastChannelMessage).toBe(10);
    expect(state.daysSinceCalibration).toBe(10);
  });

  it("14d dormant gap: returning-dormant", async () => {
    const fourteenDaysAgo = new Date(
      NOW.getTime() - 14 * 24 * 60 * 60 * 1000,
    );
    mockUser(fourteenDaysAgo);
    mockCounts({
      messageCount: 10,
      hostedSessionCount: 3,
      guestSessionCount: 0,
      participantCount: 0,
    });

    const state = await computeOnboardingState(
      USER_ID,
      [makeMessage(fourteenDaysAgo, { kind: "host", text: "previous turn" })],
      0,
      NOW,
    );

    expect(state.welcomeVariant).toBe("returning-dormant");
    expect(state.daysSinceLastChannelMessage).toBe(14);
  });

  it("mixed history: most-recent terminal of each subkind wins", async () => {
    mockUser(NOW);
    mockCounts({
      messageCount: 12,
      hostedSessionCount: 1,
      guestSessionCount: 0,
      participantCount: 0,
    });

    const olderTuning = new Date(NOW.getTime() - 10 * 60 * 1000);
    const newerTuning = new Date(NOW.getTime() - 5 * 60 * 1000);
    const recal = new Date(NOW.getTime() - 60_000);

    const state = await computeOnboardingState(
      USER_ID,
      [
        makeMessage(olderTuning, {
          kind: "onboarding",
          subkind: "primary-link-tuning",
          terminal: true,
        }),
        makeMessage(newerTuning, {
          kind: "onboarding",
          subkind: "primary-link-tuning",
          terminal: true,
        }),
        makeMessage(recal, {
          kind: "onboarding",
          subkind: "recalibrate",
          terminal: true,
        }),
      ],
      1,
      NOW,
    );

    expect(state.lastTuningCompletionAt?.getTime()).toBe(newerTuning.getTime());
    expect(state.lastCalibrationCompletionAt?.getTime()).toBe(recal.getTime());
    expect(state.primaryLinkTuningCompleted).toBe(true);
    expect(state.profileGapsCount).toBe(1);
  });
});

describe("selectChatVariant", () => {
  const matchResult = { kind: "deterministic" as const, resolved: {} };

  function ctx(state: ReturnType<typeof makeState> | undefined) {
    return { contextLines: [], onboardingState: state };
  }

  function makeState(overrides: {
    lastCalibrationCompletionAt?: Date | null;
    lastTuningCompletionAt?: Date | null;
  }) {
    return {
      welcomeVariant: "active" as const,
      daysSinceCalibration: 0,
      daysSinceLastChannelMessage: 0,
      primaryLinkTuningCompleted: false,
      preferencesExtendedCompleted: false,
      lastTuningCompletionAt: overrides.lastTuningCompletionAt ?? null,
      lastCalibrationCompletionAt:
        overrides.lastCalibrationCompletionAt ?? null,
      profileGapsCount: 0,
    };
  }

  it("returns 'base' when onboardingState absent", () => {
    expect(selectChatVariant(matchResult, ctx(undefined), NOW)).toBe("base");
  });

  it("returns 'base' when no terminal timestamps", () => {
    expect(
      selectChatVariant(matchResult, ctx(makeState({})), NOW),
    ).toBe("base");
  });

  it("fires 'post-calibration' on recalibrate completion within window", () => {
    const recalAt = new Date(NOW.getTime() - 60_000); // 1m ago
    expect(
      selectChatVariant(
        matchResult,
        ctx(makeState({ lastCalibrationCompletionAt: recalAt })),
        NOW,
      ),
    ).toBe("post-calibration");
  });

  it("fires 'post-calibration' on tuning completion within window (legacy auto-resume)", () => {
    const tuneAt = new Date(NOW.getTime() - 60_000);
    expect(
      selectChatVariant(
        matchResult,
        ctx(makeState({ lastTuningCompletionAt: tuneAt })),
        NOW,
      ),
    ).toBe("post-calibration");
  });

  it("does NOT fire when completion is older than the 5-minute window", () => {
    const tooOld = new Date(NOW.getTime() - POST_CALIBRATION_WINDOW_MS - 1000);
    expect(
      selectChatVariant(
        matchResult,
        ctx(makeState({ lastCalibrationCompletionAt: tooOld })),
        NOW,
      ),
    ).toBe("base");
  });

  it("does NOT fire when completion is in the future (clock skew defense)", () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(
      selectChatVariant(
        matchResult,
        ctx(makeState({ lastCalibrationCompletionAt: future })),
        NOW,
      ),
    ).toBe("base");
  });

  it("fires at exactly the 5-minute boundary", () => {
    const exact = new Date(NOW.getTime() - POST_CALIBRATION_WINDOW_MS);
    expect(
      selectChatVariant(
        matchResult,
        ctx(makeState({ lastCalibrationCompletionAt: exact })),
        NOW,
      ),
    ).toBe("post-calibration");
  });
});
