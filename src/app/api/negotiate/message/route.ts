import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AgentContext } from "@/agent/administrator";
import { computeThreadStatus } from "@/lib/thread-status";

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

  // Save the guest's message
  await prisma.message.create({
    data: { sessionId, role: "guest", content },
  });

  // Update guest email if provided
  if (guestEmail && !session.guestEmail) {
    await prisma.negotiationSession.update({
      where: { id: sessionId },
      data: { guestEmail },
    });
  }

  // Build conversation history
  const history = session.messages.map((m) => ({
    role: m.role === "administrator" ? "assistant" : "user",
    content: m.content,
  }));
  history.push({ role: "user", content });

  // Build agent context
  const context: AgentContext = {
    role: session.type === "calendar" ? "coordinator" : "administrator",
    hostName: session.host.name || "the host",
    hostPreferences:
      (session.host.preferences as Record<string, unknown>) || {},
    guestName: session.link.inviteeName || undefined,
    guestEmail:
      session.guestEmail || session.link.inviteeEmail || undefined,
    topic: session.link.topic || undefined,
    rules: (session.link.rules as Record<string, unknown>) || {},
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
