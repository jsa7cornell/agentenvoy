import { describe, it, expect } from "vitest";
import {
  needsActionEmissionRetry,
  needsActionShapeRetry,
  needsActionRedundancyRetry,
} from "@/agent/modules/_shared/post-stream-guards";
import type { ActionRequest } from "@/agent/actions";

describe("needsActionEmissionRetry", () => {
  it("returns false when an agentenvoy-action block is present", () => {
    const text = 'Set up the meeting.\n\n```agentenvoy-action\n{"action":"create_link"}\n```';
    expect(needsActionEmissionRetry(text)).toBe(false);
  });

  it("returns false for [ACTION] format", () => {
    const text = 'Archiving.\n[ACTION]{"action":"archive"}[/ACTION]';
    expect(needsActionEmissionRetry(text)).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(needsActionEmissionRetry("")).toBe(false);
    expect(needsActionEmissionRetry(null as unknown as string)).toBe(false);
  });

  it("catches 'link is ready' without an action block (Dannyo case)", () => {
    const text =
      'Set up a 30-min phone call with Dannyo about "Testmania" — offering Mon Apr 20 through Fri Apr 24. Share his email if you want me to send it, otherwise the link is ready. Let me know any tweaks.';
    expect(needsActionEmissionRetry(text)).toBe(true);
  });

  it("catches 'I've set up a meeting' without an action block", () => {
    expect(needsActionEmissionRetry("I've set up a meeting with Bryan for Tuesday.")).toBe(true);
  });

  it("catches 'I've created a link'", () => {
    expect(needsActionEmissionRetry("I've created a link for you to share.")).toBe(true);
  });

  it("catches 'I've archived'", () => {
    expect(needsActionEmissionRetry("I've archived that session.")).toBe(true);
  });

  it("catches 'Invite sent'", () => {
    expect(needsActionEmissionRetry("Invite sent to sarah@example.com.")).toBe(true);
  });

  it("catches 'Set up a 30-min phone call' pattern", () => {
    expect(needsActionEmissionRetry("Set up a 30-min phone call with Mike about hiking.")).toBe(true);
  });

  it("does NOT flag an exploratory question", () => {
    expect(
      needsActionEmissionRetry("Want me to set up a meeting with Bryan, or just send the link?")
    ).toBe(false);
  });

  it("does NOT flag 'I can set up...' offers", () => {
    expect(
      needsActionEmissionRetry("I can set up a call with Bryan if you give me a date.")
    ).toBe(false);
  });

  it("does NOT flag 'the link will be ready'", () => {
    expect(needsActionEmissionRetry("Once you share his email, the link will be ready to send.")).toBe(false);
  });

  it("does NOT double-retry when claim + action block coexist", () => {
    // This is the success path — claim prose AND action block present.
    const text =
      'I\'ve set up a meeting with Bryan.\n\n```agentenvoy-action\n{"action":"create_link","inviteeName":"Bryan"}\n```';
    expect(needsActionEmissionRetry(text)).toBe(false);
  });

  it("catches curly-apostrophe variants of 'I've'", () => {
    expect(needsActionEmissionRetry("I\u2019ve created the thread.")).toBe(true);
  });

  // Reviewer B2 regression: the canonical channel.md example opens with "Set up a 30-min
  // video call with Bob..." which matches the line-49 opener regex. It's saved from
  // retry only by the [ACTION]-present short-circuit (line 35). If anyone moves the
  // [ACTION] block below the prose — or deletes the short-circuit — this test catches it.
  it("B2 regression: canonical channel.md example (block FIRST, then 'Set up a' prose) returns false", () => {
    const canonical =
      '[ACTION]{"action":"create_link","params":{"inviteeName":"Bob","format":"video","duration":30,"rules":{"preferredDays":["Tue","Wed","Thu"]}}}[/ACTION]\n\n' +
      "Set up a 30-min video call with Bob. I'm offering Tue and Wed mornings, plus Thu afternoon PT. Share his email if you want me to send it — or copy the link below and send it yourself. Let me know any tweaks.";
    expect(needsActionEmissionRetry(canonical)).toBe(false);
  });

  // Layer 2a (proposal `2026-04-30_composer-action-fidelity` Gap B):
  // "Set up X" pattern must accept activity-vocab nouns, not just
  // meeting/call/chat/etc. The composer's "Set up a coffee with Suzie..."
  // failure (failure #3) slipped past the original pattern because "coffee"
  // wasn't on the trailing-noun whitelist.
  it("2a: catches 'Set up a coffee with Suzie' (activity-vocab noun)", () => {
    expect(
      needsActionEmissionRetry("Set up a coffee with Suzie next Tuesday."),
    ).toBe(true);
  });

  it("2a: catches 'Set up a run with Jason' (activity-vocab noun)", () => {
    expect(
      needsActionEmissionRetry("Set up a run with Jason for next week."),
    ).toBe(true);
  });

  it("2a: catches 'Set up a hike with Larry' (activity-vocab noun)", () => {
    expect(
      needsActionEmissionRetry("Set up a hike with Larry on Saturday."),
    ).toBe(true);
  });

  it("2a: catches 'Set up a bike ride with Sarah' (multi-word activity-vocab noun)", () => {
    expect(
      needsActionEmissionRetry("Set up a bike ride with Sarah this weekend."),
    ).toBe(true);
  });

  it("2a: still catches the original 'Set up a 30-min phone call' pattern", () => {
    // Belt-and-suspenders: the activity-vocab union must NOT regress the
    // original noun-list coverage.
    expect(
      needsActionEmissionRetry("Set up a 30-min phone call with Mike."),
    ).toBe(true);
  });
});

describe("needsActionShapeRetry", () => {
  // Helper: build an ActionRequest tersely.
  const action = (params: Record<string, unknown>): ActionRequest => ({
    action: "create_link",
    params,
  });

  it("returns null when no delegation prose detected", () => {
    expect(
      needsActionShapeRetry("Set up a 30-min call with Bob.", [
        action({ inviteeName: "Bob" }),
      ]),
    ).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(needsActionShapeRetry("", [])).toBeNull();
  });

  // Layer 2b (Gap A1): the prose-action coherence check is the new shape
  // of validation that runs alongside the existing emission guard.
  it("flags 'she picks the spot' without guestPicks.location", () => {
    const result = needsActionShapeRetry(
      "Set up a coffee with Suzie — she picks the spot.",
      [action({ inviteeName: "Suzie", activity: "coffee" })],
    );
    expect(result).not.toBeNull();
    expect(result?.flaggedReason).toBe("delegation:location");
    expect(result?.hint).toMatch(/guestPicks\.location/);
  });

  it("does NOT flag when guestPicks.location IS set", () => {
    expect(
      needsActionShapeRetry(
        "Set up a coffee with Suzie — she picks the spot.",
        [
          action({
            inviteeName: "Suzie",
            activity: "coffee",
            guestPicks: { location: true },
          }),
        ],
      ),
    ).toBeNull();
  });

  it("flags 'he picks the location' without guestPicks.location", () => {
    const result = needsActionShapeRetry(
      "Set up a meeting with Larry — he picks the location.",
      [action({ inviteeName: "Larry" })],
    );
    expect(result?.flaggedReason).toBe("delegation:location");
  });

  it("flags 'they pick the day' without guestPicks.date", () => {
    const result = needsActionShapeRetry(
      "Set up a sync with the team — they pick the day.",
      [action({ inviteeNames: ["Alex", "Sam"] })],
    );
    expect(result?.flaggedReason).toBe("delegation:date");
  });

  it("flags 'let her choose where' without guestPicks.location", () => {
    const result = needsActionShapeRetry(
      "Set up a coffee with Suzie — let her choose where.",
      [action({ inviteeName: "Suzie", activity: "coffee" })],
    );
    expect(result?.flaggedReason).toBe("let-them-pick:location");
  });

  it("flags 'wherever works for her' without guestPicks.location", () => {
    const result = needsActionShapeRetry(
      "Set up a meeting with Suzie — wherever works for her.",
      [action({ inviteeName: "Suzie" })],
    );
    expect(result?.flaggedReason).toBe("wherever-works");
  });

  it("does NOT flag 'she picks' without a field anchor (too generic)", () => {
    // The patterns require a field noun (spot/location/day/length/format etc).
    // Bare "she picks" is too ambiguous — composer might be narrating
    // post-confirmation that the guest already picked something.
    expect(
      needsActionShapeRetry("She picks one of the times.", [
        action({ inviteeName: "Suzie" }),
      ]),
    ).toBeNull();
  });

  it("flags location delegation when actions array is empty", () => {
    // If composer narrates delegation but emitted no actions at all, the
    // shape check still fires (parsedActions=[] means there's no action
    // with a matching guestPicks key). The emission guard catches "no
    // action" cases; this is a defense-in-depth assertion that shape doesn't
    // silently pass.
    const result = needsActionShapeRetry(
      "Set up a coffee with Suzie — she picks the spot.",
      [],
    );
    expect(result?.flaggedReason).toBe("delegation:location");
  });

  it("returns null when delegation matches an array-form guestPicks", () => {
    // guestPicks.format can be an array (allowed values list); coherence
    // check should treat that as 'present'.
    expect(
      needsActionShapeRetry(
        "Set up a meeting with Bob — he picks the format.",
        [
          action({
            inviteeName: "Bob",
            guestPicks: { format: ["video", "phone"] },
          }),
        ],
      ),
    ).toBeNull();
  });
});

describe("needsActionRedundancyRetry (F6 — false-apology / duplicate-emit)", () => {
  const action = (params: Record<string, unknown>): ActionRequest => ({
    action: "create_link",
    params,
  });

  it("returns null when no apology-retry prose is present", () => {
    expect(
      needsActionRedundancyRetry("Set up a 30-min call with Bob.", [
        action({ inviteeName: "Bob" }),
      ]),
    ).toBeNull();
  });

  it("returns null when prose has apology language but no actions emitted", () => {
    // The existing emission guard handles the no-action case; this guard
    // is specifically for redundant duplicate emits.
    expect(
      needsActionRedundancyRetry(
        "Apologies — I hadn't emitted that yet, let me try again.",
        [],
      ),
    ).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(needsActionRedundancyRetry("", [])).toBeNull();
    expect(needsActionRedundancyRetry("anything", [])).toBeNull();
  });

  // Bundle cmon1vhs6... — the verbatim prose that triggered F6.
  it("flags 'I got ahead of myself' (F6 bundle prose)", () => {
    const result = needsActionRedundancyRetry(
      "Apologies — I got ahead of myself and hadn't emitted the piano lesson link yet. That's now created: 10-week weekly series.",
      [action({ topic: "piano lessons", inviteeName: "MainJohn" })],
    );
    expect(result).not.toBeNull();
    // First-matching pattern wins; in this prose both apology-retry
    // patterns match, but the regex order in the implementation determines
    // which `flaggedReason` surfaces. Just assert one of the family.
    expect(result?.flaggedReason).toMatch(/^apology-retry:/);
  });

  it("flags 'Apologies — I hadn't emitted X yet' generic", () => {
    const result = needsActionRedundancyRetry(
      "Apologies — I hadn't emitted the meeting link yet.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.flaggedReason).toBe("apology-retry:hadnt-emitted");
  });

  it("flags 'Apologies, I forgot to create the link'", () => {
    const result = needsActionRedundancyRetry(
      "Apologies, I forgot to create the link earlier.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.flaggedReason).toBe("apology-retry:hadnt-emitted");
  });

  it("flags 'Let me re-emit'", () => {
    const result = needsActionRedundancyRetry(
      "Let me re-emit that piano lesson link.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.flaggedReason).toBe("apology-retry:let-me-retry");
  });

  it("flags 'Let me try that again'", () => {
    const result = needsActionRedundancyRetry(
      "Let me try that again — should be set up now.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.flaggedReason).toBe("apology-retry:let-me-retry");
  });

  it("flags \"That's now created\"", () => {
    const result = needsActionRedundancyRetry(
      "That's now created: 10-week weekly series, 30 min in-person.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.flaggedReason).toBe("apology-retry:thats-now-x");
  });

  it("flags 'I should have emitted that'", () => {
    const result = needsActionRedundancyRetry(
      "I should have emitted that on the prior turn.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.flaggedReason).toBe("apology-retry:should-have");
  });

  it("does NOT flag a legitimate apology without retry framing", () => {
    // "Apologies for the delay" with no claim about prior emission ≠ F6.
    expect(
      needsActionRedundancyRetry(
        "Apologies for the delay — here's the meeting link.",
        [action({ inviteeName: "Bob" })],
      ),
    ).toBeNull();
  });

  it("does NOT flag a forward-looking 'I'll create' phrase", () => {
    expect(
      needsActionRedundancyRetry(
        "I'll create the link now — give me a moment.",
        [action({ inviteeName: "Bob" })],
      ),
    ).toBeNull();
  });

  it("returns the F6 retry hint that grounds the LLM on actionResults", () => {
    const result = needsActionRedundancyRetry(
      "I got ahead of myself and forgot to emit. That's now created.",
      [action({ inviteeName: "Bob" })],
    );
    expect(result?.hint).toMatch(/actionResults/);
    expect(result?.hint).toMatch(/already in the host's dashboard/i);
  });
});
