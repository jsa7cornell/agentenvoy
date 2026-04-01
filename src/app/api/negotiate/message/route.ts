import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AgentContext } from "@/agent/administrator";

// POST /api/negotiate/message
// Send a message in a negotiation session and get agent response (streaming)
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, content, responderEmail } = body;

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
      initiator: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Save the responder's message
  await prisma.message.create({
    data: { sessionId, role: "responder", content },
  });

  // Update responder email if provided
  if (responderEmail && !session.responderEmail) {
    await prisma.negotiationSession.update({
      where: { id: sessionId },
      data: { responderEmail },
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
    initiatorName: session.initiator.name || "the initiator",
    initiatorPreferences:
      (session.initiator.preferences as Record<string, unknown>) || {},
    responderName: session.link.inviteeName || undefined,
    responderEmail:
      session.responderEmail || session.link.inviteeEmail || undefined,
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
