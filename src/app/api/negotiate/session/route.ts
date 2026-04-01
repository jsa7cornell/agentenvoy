import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAvailableSlots } from "@/lib/calendar";
import { generateAgentResponse, AgentContext } from "@/agent/administrator";

// POST /api/negotiate/session
// Start a new negotiation session from a link click
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { slug, code } = body;

  if (!slug) {
    return NextResponse.json({ error: "Missing slug" }, { status: 400 });
  }

  // Find the user by meetSlug
  const user = await prisma.user.findUnique({
    where: { meetSlug: slug },
    select: { id: true, name: true, preferences: true, meetSlug: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Find the link — contextual (with code) or generic
  let link;
  if (code) {
    link = await prisma.negotiationLink.findFirst({
      where: { slug, code },
    });
    if (!link) {
      return NextResponse.json({ error: "Link not found" }, { status: 404 });
    }
  } else {
    // Find or create the generic link for this user
    link = await prisma.negotiationLink.findFirst({
      where: { userId: user.id, type: "generic" },
    });
    if (!link) {
      link = await prisma.negotiationLink.create({
        data: {
          userId: user.id,
          type: "generic",
          slug: user.meetSlug!,
        },
      });
    }
  }

  // Create the session
  const session = await prisma.negotiationSession.create({
    data: {
      linkId: link.id,
      initiatorId: user.id,
      type: "calendar",
      status: "active",
    },
  });

  // Get available slots for the next 2 weeks
  let availableSlots: Array<{ start: string; end: string }> = [];
  try {
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const slots = await getAvailableSlots(user.id, now, twoWeeks);
    availableSlots = slots.slice(0, 20).map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
    }));
  } catch (e) {
    // Calendar might not be connected — that's ok
    console.log("Could not fetch calendar slots:", e);
  }

  // Generate the initial greeting
  const context: AgentContext = {
    role: "coordinator",
    initiatorName: user.name || "the organizer",
    initiatorPreferences: (user.preferences as Record<string, unknown>) || {},
    responderName: link.inviteeName || undefined,
    responderEmail: link.inviteeEmail || undefined,
    topic: link.topic || undefined,
    rules: (link.rules as Record<string, unknown>) || {},
    availableSlots,
    conversationHistory: [],
  };

  // Generate greeting
  const greeting = await generateAgentResponse({
    ...context,
    conversationHistory: [
      {
        role: "user",
        content:
          "A new visitor just opened the deal room. Generate your initial greeting. Introduce yourself, mention the topic if known, ask about format preference (phone/video/in-person), and offer to help find a time. If you know the responder's name, use it. Mention they can connect their calendar or their agent for faster scheduling.",
      },
    ],
  });

  // Save the greeting message
  await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "administrator",
      content: greeting,
    },
  });

  return NextResponse.json({
    sessionId: session.id,
    greeting,
    initiator: {
      name: user.name,
    },
    link: {
      type: link.type,
      topic: link.topic,
      inviteeName: link.inviteeName,
    },
  });
}

// GET /api/negotiate/session?id=xxx
// Get session details and messages
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("id");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session id" }, { status: 400 });
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      link: true,
      initiator: { select: { name: true, image: true } },
      messages: { orderBy: { createdAt: "asc" } },
      proposals: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ session });
}
