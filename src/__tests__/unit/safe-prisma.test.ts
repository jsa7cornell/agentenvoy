import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isDestructive } from "../../../scripts/safe-prisma";

/**
 * Tests for the destructive-Prisma-command wrapper at
 * `scripts/safe-prisma.ts`. Two layers:
 *
 * 1. **Predicate test** — `isDestructive` classifies arg arrays. Cheap;
 *    locks the precise three-command list.
 * 2. **Subprocess test** — spawns the wrapper with a controlled env and
 *    asserts the refusal behavior. Slower but is what actually protects
 *    against the 2026-05-10 incident shape.
 *
 * Background: 2026-05-10 near-miss — `prisma migrate dev` from a dev shell
 * triggered a destructive-reset prompt against prod Supabase. The wrapper
 * exists so the prompt never appears: it refuses to invoke prisma if either
 * `POSTGRES_PRISMA_URL` or `POSTGRES_URL_NON_POOLING` points at a non-local
 * host. No bypass flag — the right command for prod is `prisma migrate
 * deploy`, which is forward-only and not wrapped.
 */

const WRAPPER = resolve(__dirname, "../../../scripts/safe-prisma.ts");
const PROD_LIKE = "postgresql://postgres:pwd@aws-1-us-east-2.pooler.supabase.com:5432/postgres";
const LOCAL_POOL = "postgresql://postgres:postgres@localhost:5432/agentenvoy_dev";
const LOCAL_DIRECT = "postgresql://postgres:postgres@localhost:5432/agentenvoy_dev";

function runWrapper(args: string[], env: Record<string, string | undefined>) {
  return spawnSync("npx", ["tsx", WRAPPER, ...args], {
    env: { ...process.env, ...env, PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
}

describe("isDestructive", () => {
  describe("destructive shapes — wrapper must refuse on non-local URL", () => {
    const cases: string[][] = [
      ["migrate", "dev"],
      ["migrate", "dev", "--name", "add_archivedat"],
      ["migrate", "reset"],
      ["migrate", "reset", "--skip-seed"],
      ["db", "push", "--force-reset"],
      ["db", "push", "--accept-data-loss", "--force-reset"],
    ];
    for (const args of cases) {
      it(`classifies as destructive: ${args.join(" ")}`, () => {
        expect(isDestructive(args)).toBe(true);
      });
    }
  });

  describe("non-destructive shapes — wrapper must not gate these", () => {
    const cases: string[][] = [
      ["migrate", "deploy"],
      ["migrate", "status"],
      ["migrate", "resolve", "--applied", "20260510_foo"],
      ["db", "push"],
      ["db", "pull"],
      ["db", "seed"],
      ["generate"],
      ["studio"],
      ["validate"],
      ["format"],
    ];
    for (const args of cases) {
      it(`classifies as non-destructive: ${args.join(" ")}`, () => {
        expect(isDestructive(args)).toBe(false);
      });
    }
  });
});

describe("safe-prisma wrapper — subprocess integration", () => {
  it("refuses migrate dev when POSTGRES_PRISMA_URL is remote (2026-05-10 incident shape)", () => {
    const result = runWrapper(["migrate", "dev"], {
      POSTGRES_PRISMA_URL: PROD_LIKE,
      POSTGRES_URL_NON_POOLING: PROD_LIKE,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REFUSED");
    expect(result.stderr).toContain("aws-1-us-east-2.pooler.supabase.com");
    // Critical: the destructive prompt must not appear.
    expect(result.stdout).not.toContain("All data will be lost");
  });

  it("refuses when direct URL is remote even if pool URL is local", () => {
    const result = runWrapper(["migrate", "dev"], {
      POSTGRES_PRISMA_URL: LOCAL_POOL,
      POSTGRES_URL_NON_POOLING: PROD_LIKE,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REFUSED");
  });

  it("refuses when either URL is missing", () => {
    const result = runWrapper(["migrate", "dev"], {
      POSTGRES_PRISMA_URL: LOCAL_POOL,
      POSTGRES_URL_NON_POOLING: undefined,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REFUSED");
  });

  it("rejects non-destructive subcommands with exit 2 (clear misuse signal)", () => {
    const result = runWrapper(["migrate", "deploy"], {
      POSTGRES_PRISMA_URL: LOCAL_POOL,
      POSTGRES_URL_NON_POOLING: LOCAL_DIRECT,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not on the destructive-command list");
  });

  it("rejects empty args with exit 2", () => {
    const result = runWrapper([], {
      POSTGRES_PRISMA_URL: LOCAL_POOL,
      POSTGRES_URL_NON_POOLING: LOCAL_DIRECT,
    });
    expect(result.status).toBe(2);
  });
});
