/**
 * Default link-per-user primitive.
 *
 * Background: the MCP bearer-URL auth layer parses `/meet/<slug>` into a
 * `NegotiationLink` row. Before this primitive, a bare-slug URL like
 * `/meet/johnanderson` (vanity URL matching `User.meetSlug`) returned
 * `link_not_found` from `resolveLink` because no `NegotiationLink` row was
 * ever minted for the bare vanity path — links were only created when a host
 * called `create_link` with a specific code.
 *
 * `ensureDefaultLinkForUser` is the idempotent fixer: find-or-create the
 * one bare-slug `NegotiationLink` row for a given user (i.e. the row with
 * `code: null` whose `slug === user.meetSlug`). Safe to call concurrently —
 * the first caller creates, subsequent callers read. A true millisecond-
 * concurrent first-ever race could produce two `{userId, code: null}` rows;
 * that's cosmetic (both satisfy the lookup) and dedupable offline. The
 * deliberate choice not to add a partial unique index is documented in
 * `proposals/2026-04-19_mcp-bare-slug-resolution_*`.
 *
 * See also: `src/lib/mcp/auth.ts` resolveLink fallback — the only caller
 * today.
 */
import type { NegotiationLink } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function ensureDefaultLinkForUser(
  userId: string,
): Promise<NegotiationLink> {
  const existing = await prisma.negotiationLink.findFirst({
    where: { userId, code: null },
  });
  if (existing) return existing;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { meetSlug: true },
  });
  if (!user) {
    // Caller should have verified the user exists before calling. Treat as
    // programmer error rather than returning null — the MCP fallback path
    // passes only verified `user.id` values.
    throw new Error(`ensureDefaultLinkForUser: user ${userId} not found`);
  }
  if (!user.meetSlug) {
    // User exists but has no vanity slug (`meetSlug` is nullable on the User
    // model). No vanity-URL capability, no default link to mint. Caller
    // should have verified this before calling; the MCP fallback only hits
    // this path after a `User.meetSlug` lookup succeeded, so a null here is
    // a race (slug cleared between lookup and mint) — same programmer-error
    // class as above.
    throw new Error(
      `ensureDefaultLinkForUser: user ${userId} has no meetSlug`,
    );
  }

  return prisma.negotiationLink.create({
    data: {
      userId,
      slug: user.meetSlug,
      code: null,
      rules: {},
      topic: null,
    },
  });
}
