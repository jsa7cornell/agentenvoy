import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/channel/messages
// Returns channel messages with thread snapshots for ThreadCard rendering
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const channel = await prisma.channel.findUnique({
    where: { userId: user.id },
  });
  if (!channel) {
    return NextResponse.json({ messages: [] });
  }

  const messages = await prisma.channelMessage.findMany({
    where: { channelId: channel.id },
    orderBy: { createdAt: "asc" },
    include: {
      thread: {
        select: {
          id: true,
          title: true,
          status: true,
          statusLabel: true,
          type: true,
          meetingType: true,
          duration: true,
          format: true,
          archived: true,
          agreedTime: true,
          meetLink: true,
          createdAt: true,
          updatedAt: true,
          link: {
            select: {
              inviteeName: true,
              inviteeEmail: true,
              topic: true,
              code: true,
              slug: true,
            },
          },
          _count: {
            select: { messages: true },
          },
        },
      },
    },
  });

  return NextResponse.json({ messages });
}
