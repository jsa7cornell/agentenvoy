import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateRequest } from "@/lib/api-auth";

// GET /api/negotiate/sessions
// List all negotiation sessions for the current user
// Auth: Bearer token OR NextAuth session
export async function GET(req: NextRequest) {
  const userId = await authenticateRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = req.nextUrl.searchParams.get("status"); // active | agreed | all

  const where: Record<string, unknown> = {
    hostId: userId,
  };
  if (status && status !== "all") {
    where.status = status;
  }

  const sessions = await prisma.negotiationSession.findMany({
    where,
    include: {
      link: {
        select: {
          type: true,
          inviteeName: true,
          inviteeEmail: true,
          topic: true,
        },
      },
      _count: { select: { messages: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({ sessions });
}
