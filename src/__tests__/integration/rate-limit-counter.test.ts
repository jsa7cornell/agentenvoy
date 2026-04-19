import { beforeEach, describe, expect, test } from "vitest";
import { prisma, resetDb } from "./helpers/db";
import { hashToken, incrementRateCounter } from "@/lib/mcp/rate-limit";

/**
 * SPEC §1. N concurrent UPSERT increments within a fresh window must
 * produce `finalCount === N` exactly. This is the correctness kernel of
 * the rate-limit counter — if this test passes, READ COMMITTED + the CASE
 * clause in rate-limit.ts holds up under concurrent load.
 *
 * Mutation-test: change the UPSERT's `"count" + 1` to `1` and this test
 * must fail. That proves it's load-bearing.
 */

beforeEach(async () => {
  await resetDb();
});

describe("MCPRateCounter UPSERT", () => {
  test("N=10 concurrent increments produce finalCount === 10 exactly", async () => {
    const N = 10;
    const token = "concurrency-token-1";
    const tool = "propose_lock";

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        incrementRateCounter({ token, tool, limit: 100, windowSec: 60 }),
      ),
    );

    // Every result reports a count in [1..N] and each count is unique.
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // The stored row shows the terminal count.
    const row = await prisma.mCPRateCounter.findFirstOrThrow({
      where: { tokenHash: hashToken(token), tool },
    });
    expect(row.count).toBe(N);
  });

  test("exceeded flips when count > limit", async () => {
    const token = "tok-2";
    const r1 = await incrementRateCounter({ token, tool: "x", limit: 1, windowSec: 60 });
    expect(r1.count).toBe(1);
    expect(r1.exceeded).toBe(false);

    const r2 = await incrementRateCounter({ token, tool: "x", limit: 1, windowSec: 60 });
    expect(r2.count).toBe(2);
    expect(r2.exceeded).toBe(true);
  });

  test("separate tokens have separate counters", async () => {
    const a = await incrementRateCounter({
      token: "alpha",
      tool: "t",
      limit: 10,
      windowSec: 60,
    });
    const b = await incrementRateCounter({
      token: "beta",
      tool: "t",
      limit: 10,
      windowSec: 60,
    });
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  test("separate tools on the same token have separate counters", async () => {
    const token = "tok-3";
    const a = await incrementRateCounter({
      token,
      tool: "propose_lock",
      limit: 10,
      windowSec: 60,
    });
    const b = await incrementRateCounter({
      token,
      tool: "post_message",
      limit: 10,
      windowSec: 60,
    });
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });
});
