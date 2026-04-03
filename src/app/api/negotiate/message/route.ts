import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AgentContext } from "@/agent/administrator";
import { getAvailableSlots } from "@/lib/calendar";
import { computeThreadStatus } from "@/lib/thread-status";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// POST /api/negotiate/message
// Send a message in a negotiation session and get agent response (streaming)
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, content, guestEmail } = body;

  if (!sessionId || !content) {
    return new Response(
      JSON.stringify({ error: "Missing sessionId or content" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const session = await prisma.negotiationSession.findUnique({
    where: { id: sessionId },
    include: {
      link: true,
      host: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Detect if sender is the host
  const authSession = await getServerSession(authOptions);
  const isHost = authSession?.user?.id === session.hostId;
  const messageRole = isHost ? "host" : "guest";

  // Save the message
  await prisma.message.create({
    data: { sessionId, role: messageRole, content },
  });

  // Update guest email if provided (guest only)
  if (!isHost && guestEmail && !session.guestEmail) {
    await prisma.negotiationSession.update({
      where: { id: sessionId },
      data: { guestEmail },
    });
  }

  // If host sends a regular message, don't trigger agent response — it's direct to guest
  if (isHost) {
    return new Response(
      JSON.stringify({ ok: true, role: "host" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Build conversation history
  const history = session.messages.map((m) => ({
    role: m.role === "administrator" ? "assistant" : "user",
    content: m.content,
  }));
  history.push({ role: "user", content });

  // Fetch calendar slots for context
  let availableSlots: Array<{ start: string; end: string }> = [];
  try {
    const now = new Date();
    const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const slots = await getAvailableSlots(session.hostId, now, twoWeeks);
    availableSlots = slots.slice(0, 20).map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
    }));
  } catch (e) {
    console.log("Calendar context error in negotiate/message:", e);
  }

  // Build agent context
  const context: AgentContext = {
    role: session.type === "calendar" ? "coordinator" : "administrator",
    hostName: session.host.name || "the host",
    hostPreferences:
      (session.host.preferences as Record<string, unknown>) || {},
    hostDirectives: (session.host.hostDirectives as string[]) || [],
    guestName: session.link.inviteeName || undefined,
    guestEmail:
      session.guestEmail || session.link.inviteeEmail || undefined,
    topic: session.link.topic || undefined,
    rules: (session.link.rules as Record<string, unknown>) || {},
    availableSlots,
    conversationHistory: history,
  };

  const { generateAgentResponse } = await import("@/agent/administrator");
  const responseText = await generateAgentResponse(context);

  // Save the response
  await prisma.message.create({
    data: { sessionId, role: "administrator", content: responseText },
  });

  // Update thread status label
  const lastMessage = await prisma.message.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
  });
  const statusResult = computeThreadStatus({
    status: session.status,
    inviteeName: session.link.inviteeName,
    lastMessageRole: lastMessage?.role,
    guestEmail: session.guestEmail || session.link.inviteeEmail,
  });
  await prisma.negotiationSession.update({
    where: { id: sessionId },
    data: { statusLabel: statusResult.label },
  });

  // Return as a streaming-compatible format
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Send in AI SDK text stream format
      controller.enqueue(encoder.encode(`0:${JSON.stringify(responseText)}\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
