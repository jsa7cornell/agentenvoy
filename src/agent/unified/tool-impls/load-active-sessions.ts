import { prisma } from "@/lib/prisma";

type LoadActiveSessionsResult = {
  sessions: Array<{
    id: string;
    status: string;
    title: string | null;
    guestName: string | null;
    guestEmail: string | null;
    archived: boolean;
    linkCode: string | null;
    activity: string | null;
    createdAt: string;
  }>;
  note: string;
};

/**
 * Returns the host's active (non-archived) negotiation sessions.
 * Used by the unified agent to ground session-specific actions.
 */
export async function loadActiveSessions(
  userId: string,
): Promise<LoadActiveSessionsResult> {
  const rows = await prisma.negotiationSession.findMany({
    where: {
      hostId: userId,
      archived: false,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      status: true,
      title: true,
      guestName: true,
      guestEmail: true,
      archived: true,
      createdAt: true,
      link: {
        select: {
          code: true,
          parameters: true,
        },
      },
    },
  });

  const sessions = rows.map((r) => {
    const params = (r.link?.parameters as Record<string, unknown> | null) ?? {};
    const activity = typeof params.activity === "string" ? params.activity : null;
    return {
      id: r.id,
      status: r.status,
      title: r.title,
      guestName: r.guestName,
      guestEmail: r.guestEmail,
      archived: r.archived,
      linkCode: r.link?.code ?? null,
      activity,
      createdAt: r.createdAt.toISOString(),
    };
  });

  return {
    sessions,
    note: `${sessions.length} active session(s) returned.`,
  };
}
