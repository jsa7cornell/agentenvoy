/**
 * Command-to-state regression test #2: idempotent rule writes.
 *
 * Sending the same "Protect next Tuesday" message twice MUST NOT create
 * a duplicate rule. The structuredRules array still has exactly one
 * matching entry after the second turn.
 *
 * Why this matters: in production, users casually re-send equivalent
 * commands ("oh, also protect next Tuesday" / "yeah do that"). Without
 * write-time dedupe, structuredRules silently grows linearly with retries,
 * which (a) leaks into the composer's CURRENT RULES ground-truth block
 * (token bloat + fabricated-id confusion), (b) leaves the host with N
 * identical UI rows in tuner, and (c) produces N identical compiled
 * blackoutDays / windows — annoying but harmless until something downstream
 * starts deduplicating naively and one of the duplicates is the "real" id.
 *
 * Expected to FAIL against current main — there is no write-time dedupe
 * in `handleUpdateAvailabilityRule` today (rg "dedupe" finds only an
 * unrelated date-window dedupe in another handler). The parallel
 * rule-system-fixes driver is implementing the fix; this test is its
 * regression harness.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { resetDb } from "../helpers/db";
import { runTurn, seedTestUser, nextTuesdayISO } from "./_harness";

beforeEach(async () => {
  await resetDb();
});

describe("command-to-state — Protect next Tuesday (dedupe)", () => {
  test("sending the same protect-Tuesday command twice → still exactly one matching rule", async () => {
    const user = await seedTestUser();
    const tuesday = nextTuesdayISO();

    const composerOutput = [
      "I'll block out next Tuesday for you.",
      `[ACTION]${JSON.stringify({
        action: "update_availability_rule",
        params: {
          operation: "add",
          rule: {
            originalText: "Protect next Tuesday all day",
            type: "one-time",
            action: "block",
            effectiveDate: tuesday,
            expiryDate: tuesday,
          },
        },
      })}[/ACTION]`,
    ].join("\n");

    // First turn — establishes the rule.
    const first = await runTurn({
      userId: user.id,
      userMessage: "Protect next Tuesday all day",
      composerOutput,
    });
    expect(first.actionResults[0].success).toBe(true);
    expect(first.structuredRules).toHaveLength(1);

    // Second turn — same user message, same composer emit. Production
    // protective behavior is: do not create a second identical rule.
    const second = await runTurn({
      userId: user.id,
      userMessage: "Protect next Tuesday all day",
      composerOutput,
    });

    // The matching-rule predicate: same action + type + effectiveDate +
    // expiryDate. We don't compare on `id`/`createdAt` — those are
    // legitimately new each call.
    const matching = second.structuredRules.filter(
      (r) =>
        r.action === "block" &&
        r.type === "one-time" &&
        r.effectiveDate === tuesday &&
        r.expiryDate === tuesday &&
        r.status === "active",
    );

    expect(
      matching,
      `Expected exactly one matching rule after the second turn (write-time dedupe). ` +
        `Got ${matching.length}. structuredRules: ${JSON.stringify(second.structuredRules, null, 2)}`,
    ).toHaveLength(1);
  });
});
