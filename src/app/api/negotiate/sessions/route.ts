import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/negotiate/sessions
// List all negotiation sessions for the current user
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = req.nextUrl.searchParams.get("status"); // active | agreed | all

  const where: Record<string, unknown> = {
    initiatorId: session.user.id,
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
