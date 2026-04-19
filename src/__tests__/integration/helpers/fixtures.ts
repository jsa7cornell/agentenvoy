import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import type { NegotiationLink, NegotiationSession, User } from "@prisma/client";

/**
 * Test fixture factories. These return real DB rows and MUST NOT import
 * from `prisma/seed.ts` — that seed is for dev-time UX. Fixtures here
 * create exactly what a given test needs and nothing more.
 *
 * `createUser()` is upsert-on-email (idempotent) so tests that run in a
 * database where `resetDb()` was partially skipped can still work — though
 * the default path is a full wipe before each test (see resetDb in db.ts).
 */

let emailCounter = 0;

function nextEmail(prefix = "fixture"): string {
  emailCounter += 1;
  return `${prefix}+${emailCounter}@agentenvoy.test`;
}

export async function createUser(
  overrides: Partial<{ email: string; name: string }> = {}
): Promise<User> {
  const email = overrides.email ?? nextEmail("user");
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: overrides.name ?? "Fixture User",
    },
  });
}

export async function createLink(
  overrides: Partial<{
    userId: string;
    slug: string;
    rules: Prisma.InputJsonValue;
  }> = {}
): Promise<NegotiationLink> {
  const userId = overrides.userId ?? (await createUser()).id;
  const slug = overrides.slug ?? `fixture-${Math.random().toString(36).slice(2, 10)}`;
  return prisma.negotiationLink.create({
    data: {
      userId,
      slug,
      type: "generic",
      mode: "single",
      rules: overrides.rules ?? ({} as Prisma.InputJsonValue),
    },
  });
}

/**
 * Create a NegotiationSession with `status = "active"` — the state the
 * confirm-pipeline CAS fires from. Returns the row.
 */
export async function createActiveSession(
  overrides: Partial<{
    linkId: string;
    hostId: string;
    duration: number;
    meetingType: string;
  }> = {}
): Promise<NegotiationSession> {
  let hostId = overrides.hostId;
  let linkId = overrides.linkId;
  if (!hostId || !linkId) {
    const link = linkId
      ? await prisma.negotiationLink.findUniqueOrThrow({ where: { id: linkId } })
      : await createLink({ userId: hostId });
    linkId = link.id;
    hostId = link.userId;
  }
  return prisma.negotiationSession.create({
    data: {
      linkId,
      hostId,
      status: "active",
      type: "calendar",
      duration: overrides.duration ?? 30,
      meetingType: overrides.meetingType ?? "video",
    },
  });
}
