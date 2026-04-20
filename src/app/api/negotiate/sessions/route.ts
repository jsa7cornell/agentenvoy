import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateRequest } from "@/lib/api-auth";
import { displayStatusLabel } from "@/lib/status-label";

// GET /api/negotiate/sessions
// List all negotiation sessions for the current user
// Auth: Bearer token OR NextAuth session
export async function GET(req: NextRequest) {
  const userId = await authenticateRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = req.nextUrl.searchParams.get("status"); // active | agreed | all
  const archived = req.nextUrl.searchParams.get("archived"); // true | false

  const where: Record<string, unknown> = {
    hostId: userId,
  };
  if (status && status !== "all") {
    where.status = status;
  }
  if (archived === "true") {
    where.archived = true;
  } else if (archived === "false") {
    where.archived = false;
  }

  const sessions = await prisma.negotiationSession.findMany({
    where,
    include: {
      link: {
        select: {
          type: true,
          slug: true,
          code: true,
          inviteeName: true,
          inviteeEmail: true,
          topic: true,
        },
      },
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  // Suppress statusLabel on pre-engagement sessions (no guest interaction yet)
  // so the meetings/archive lists don't show misleading "Waiting for X" or
  // "Time change proposed by host" chips on never-shared links.
  const shaped = sessions.map((s) => ({
    ...s,
    statusLabel: displayStatusLabel({
      status: s.status,
      statusLabel: s.statusLabel,
      guestEmail: s.guestEmail,
      guestName: s.guestName,
      linkType: s.link?.type ?? null,
    }),
  }));

  return NextResponse.json({ sessions: shaped });
}
