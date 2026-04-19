import { describe, it, expect } from "vitest";
import { needsActionEmissionRetry } from "@/agent/action-emission-guard";

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
});
