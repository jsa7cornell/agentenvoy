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

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const messages = await prisma.channelMessage.findMany({
    where: { channelId: channel.id, createdAt: { gte: oneWeekAgo } },
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
          linkId: true,
          link: {
            select: {
              inviteeName: true,
              inviteeEmail: true,
              topic: true,
              code: true,
              slug: true,
              mode: true,
            },
          },
          _count: {
            select: { messages: true },
          },
        },
      },
    },
  });

  // For group links, attach participant data
  const groupLinkIds = new Set<string>();
  for (const msg of messages) {
    if (msg.thread?.link?.mode === "group" && msg.thread.linkId) {
      groupLinkIds.add(msg.thread.linkId);
    }
  }

  const participantsByLink: Record<string, Array<{ name: string | null; status: string; role: string }>> = {};
  if (groupLinkIds.size > 0) {
    const participants = await prisma.sessionParticipant.findMany({
      where: { linkId: { in: Array.from(groupLinkIds) } },
    });
    for (const p of participants) {
      if (!participantsByLink[p.linkId]) participantsByLink[p.linkId] = [];
      participantsByLink[p.linkId].push({
        name: p.name || p.email || null,
        status: p.status,
        role: p.role,
      });
    }
  }

  // Enrich thread data with group info
  const enrichedMessages = messages.map((msg) => {
    if (msg.thread?.link?.mode === "group" && msg.thread.linkId) {
      return {
        ...msg,
        thread: {
          ...msg.thread,
          isGroupEvent: true,
          participants: participantsByLink[msg.thread.linkId] || [],
        },
      };
    }
    return msg;
  });

  return NextResponse.json({ messages: enrichedMessages });
}
