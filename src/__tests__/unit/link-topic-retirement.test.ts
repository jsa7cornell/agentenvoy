/**
 * PR3 — Link.topic retirement tests.
 *
 * 1. host-MCP write-mirror: modify_link with topic:"X" writes both
 *    link.topic AND link.customTitle to the same value.
 * 2. topic=null clears link.topic but does NOT write customTitle (null
 *    customTitle must not clobber an existing value).
 * 3. lint-no-link-topic-read.ts: the lint script exits 0 when the only
 *    .topic hits are in allowlisted files (smoke — runs the actual script).
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md
 * §PR3 (write-mirror invariant).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import path from "path";

// ---------------------------------------------------------------------------
// Prisma mock — use vi.hoisted so refs are available inside the factory
// ---------------------------------------------------------------------------

const { mockLinkFindUnique, mockLinkUpdate } = vi.hoisted(() => ({
  mockLinkFindUnique: vi.fn(),
  mockLinkUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    negotiationLink: {
      findUnique: mockLinkFindUnique,
      update: mockLinkUpdate,
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// applyPostureToScope does its own DB work — mock to no-op since we're
// only testing the topic branch here.
vi.mock("@/lib/links/scope", () => ({
  applyPostureToScope: vi.fn().mockResolvedValue({ varianceWrites: 0, primaryWritten: false }),
}));

// ---------------------------------------------------------------------------
// Unit under test
// ---------------------------------------------------------------------------

import { _testHandleModifyLinkTool } from "@/lib/mcp/host-tools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LINK_ID = "lnk_test_001";
const USER_ID = "usr_test_001";

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    userId: USER_ID,
    topic: null as string | null,
    customTitle: null as string | null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Write-mirror tests
// ---------------------------------------------------------------------------

describe("modify_link — topic write-mirror (PR3)", () => {
  it("topic:'Board prep' writes both topic and customTitle to 'Board prep'", async () => {
    mockLinkFindUnique.mockResolvedValueOnce(makeLink());
    mockLinkUpdate.mockResolvedValueOnce({});

    const result = await _testHandleModifyLinkTool(
      { linkId: LINK_ID, topic: "Board prep" },
      USER_ID,
    );

    expect(result.isError).toBeFalsy();

    expect(mockLinkUpdate).toHaveBeenCalledOnce();
    const data = mockLinkUpdate.mock.calls[0][0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({
      topic: "Board prep",
      customTitle: "Board prep",
    });
  });

  it("topic:null clears link.topic and does NOT write customTitle key", async () => {
    mockLinkFindUnique.mockResolvedValueOnce(makeLink({ customTitle: "Existing title" }));
    mockLinkUpdate.mockResolvedValueOnce({});

    const result = await _testHandleModifyLinkTool(
      { linkId: LINK_ID, topic: null as unknown as string },
      USER_ID,
    );

    expect(result.isError).toBeFalsy();

    expect(mockLinkUpdate).toHaveBeenCalledOnce();
    const data = mockLinkUpdate.mock.calls[0][0]?.data as Record<string, unknown>;
    expect(data.topic).toBeNull();
    // customTitle must NOT be in the update data — a null topic must not
    // clobber an existing customTitle value.
    expect(Object.keys(data)).not.toContain("customTitle");
  });

  it("topic:undefined skips the negotiationLink.update call entirely", async () => {
    mockLinkFindUnique.mockResolvedValueOnce(makeLink());

    await _testHandleModifyLinkTool(
      { linkId: LINK_ID }, // no topic field
      USER_ID,
    );

    expect(mockLinkUpdate).not.toHaveBeenCalled();
  });

  it("returns link_not_found error when link does not exist", async () => {
    mockLinkFindUnique.mockResolvedValueOnce(null);

    const result = await _testHandleModifyLinkTool(
      { linkId: "nonexistent", topic: "X" },
      USER_ID,
    );

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("link_not_found");
  });

  it("returns not_authorized when link belongs to a different user", async () => {
    mockLinkFindUnique.mockResolvedValueOnce(makeLink({ userId: "usr_other" }));

    const result = await _testHandleModifyLinkTool(
      { linkId: LINK_ID, topic: "X" },
      USER_ID,
    );

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("not_authorized");
  });
});

// ---------------------------------------------------------------------------
// Lint smoke test
// ---------------------------------------------------------------------------

describe("lint-no-link-topic-read — script smoke test", () => {
  it("exits 0 against the current source tree (all .topic hits are allowlisted)", () => {
    // Resolve to the `app/` directory where scripts/ and src/ live.
    // __dirname = app/src/__tests__/unit → ../../.. = app/
    const appDir = path.resolve(__dirname, "../../..");
    let exitCode = 0;
    try {
      execSync("npx tsx scripts/lint-no-link-topic-read.ts", {
        cwd: appDir,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: Buffer };
      exitCode = e.status ?? 1;
      console.error("lint-no-link-topic-read failed:\n" + (e.stderr?.toString() ?? ""));
    }
    expect(exitCode).toBe(0);
  });
});
