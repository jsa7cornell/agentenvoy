/**
 * Bare-slug vanity URL resolution — integration coverage for
 * `resolveLink` fallback path and `ensureDefaultLinkForUser` primitive.
 *
 * Proposal: proposals/2026-04-19_mcp-bare-slug-resolution_reviewed-2026-04-20_decided-2026-04-20.md
 *
 * The proposal explicitly frames the test as "convergence, not uniqueness":
 * parallel callers on a first-ever race might produce two `{userId, code: null}`
 * rows (cosmetic); post-convergence, all subsequent callers see one of them.
 * Our asserts are on this convergence, not strict uniqueness.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { ensureDefaultLinkForUser } from "@/lib/negotiation/default-link";
import { resolveLink } from "@/lib/mcp/auth";

describe("ensureDefaultLinkForUser", () => {
  beforeEach(resetDb);

  it("creates a default link on first call", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "johnanderson" },
    });

    const link = await ensureDefaultLinkForUser(user.id);
    expect(link.userId).toBe(user.id);
    expect(link.slug).toBe("johnanderson");
    expect(link.code).toBeNull();
    expect(link.parameters).toEqual({});
  });

  it("is idempotent — second call returns the same row", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "hostidem" },
    });

    const first = await ensureDefaultLinkForUser(user.id);
    const second = await ensureDefaultLinkForUser(user.id);
    expect(second.id).toBe(first.id);
  });

  it("ignores contextual (code-bearing) links when selecting the default", async () => {
    // Host has a contextual link with a code; ensure the primitive still
    // finds (and mints) the bare code-null default, distinct from the
    // contextual row.
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "hostctx" },
    });
    await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        slug: "hostctx",
        code: "ABCD1234",
        parameters: {},
      },
    });

    const link = await ensureDefaultLinkForUser(user.id);
    expect(link.code).toBeNull();
    expect(link.slug).toBe("hostctx");
  });

  it("throws for an unknown userId (programmer-error guard)", async () => {
    await expect(
      ensureDefaultLinkForUser("does-not-exist"),
    ).rejects.toThrow(/not found/);
  });
});

describe("resolveLink — vanity URL fallback", () => {
  beforeEach(resetDb);

  it("resolves /meet/<meetSlug> to a minted default link when no NegotiationLink exists", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "vanityhost" },
    });

    const result = await resolveLink({ slug: "vanityhost", code: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.userId).toBe(user.id);
      expect(result.link.slug).toBe("vanityhost");
      expect(result.link.code).toBeNull();
    }

    // Mint was persistent — a second resolveLink call finds the row rather
    // than minting again.
    const again = await resolveLink({ slug: "vanityhost", code: null });
    expect(again.ok).toBe(true);
    const rows = await prisma.negotiationLink.findMany({
      where: { userId: user.id, code: null },
    });
    expect(rows).toHaveLength(1);
  });

  it("does NOT fall back when a code is present (contextual links stay not-found on miss)", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "contexthost" },
    });

    const result = await resolveLink({
      slug: "contexthost",
      code: "NONEXISTENT",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("link_not_found");
    }

    // And no default link was minted as a side-effect.
    const rows = await prisma.negotiationLink.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("returns link_not_found when the slug matches no user and no link", async () => {
    const result = await resolveLink({ slug: "nobody-home", code: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("link_not_found");
    }
  });

  it("prefers an existing NegotiationLink over minting via meetSlug", async () => {
    // A bare-slug link already exists for this host with a custom rules blob.
    // resolveLink should return that row unchanged — not re-mint with empty rules.
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "existinghost" },
    });
    const existing = await prisma.negotiationLink.create({
      data: {
        userId: user.id,
        slug: "existinghost",
        code: null,
        parameters: { duration: 45 },
      },
    });

    const result = await resolveLink({ slug: "existinghost", code: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.id).toBe(existing.id);
      expect(result.link.parameters).toEqual({ duration: 45 });
    }
  });

  it("parallel calls on first-ever vanity hit converge (cosmetic transient duplicates tolerated)", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { meetSlug: "raceparty" },
    });

    // Fire N parallel resolves — the first-caller-wins path should create
    // one row; racing callers might create a second (proposal B2 explicit
    // tradeoff). The convergence claim is that ALL callers return an OK
    // result pointing at *some* default link for this user, and further
    // calls settle on a stable row.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveLink({ slug: "raceparty", code: null }),
      ),
    );
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.link.userId).toBe(user.id);
    }

    const rows = await prisma.negotiationLink.findMany({
      where: { userId: user.id, code: null },
    });
    // Proposal accepts 1 or more here. In practice Prisma's default isolation
    // and quick-pg make the race hard to hit; the assertion is "at least one"
    // rather than "exactly one" to match the proposal's documented tradeoff.
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Post-convergence: a fresh call returns one of the existing rows, no
    // new inserts.
    const beforeCount = rows.length;
    await resolveLink({ slug: "raceparty", code: null });
    const afterRows = await prisma.negotiationLink.findMany({
      where: { userId: user.id, code: null },
    });
    expect(afterRows.length).toBe(beforeCount);
  });
});
