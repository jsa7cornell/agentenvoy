import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getAvailableSlots } from "@/lib/calendar";
import { generateCode } from "@/lib/utils";

const CHANNEL_SYSTEM = `You are Envoy, the user's scheduling agent. You operate in their feed — a chat interface where scheduling threads appear as inline cards.

CORE BEHAVIOR:
1. Create scheduling threads when the user describes a meeting they want to set up
2. Give status updates on active threads when asked
3. Take actions on existing threads ("push Sarah to Wednesday", "cancel the Noah meeting")
4. Be contextual — reference the user's calendar, active threads, and preferences

CREATING THREADS:
When the user wants to schedule something, extract what you can: who (name), what (topic), when (preferences), format (phone/video/in-person), duration.
Then emit an action block:
\`\`\`agentenvoy-action
{"action":"create_thread","inviteeName":"Sarah Chen","topic":"Q2 Roadmap","format":"phone","duration":30,"rules":{"preferredDays":["Tuesday"],"lastResort":["Friday"]}}
\`\`\`

IMPORTANT — email is OPTIONAL. The inviteeName is the only required field. Do NOT ask for email unless the user wants Envoy to send the invite directly. If the user just says "set up a meeting with Bryan", create the thread with just the name — they can share the link themselves.
If the user provides an email, include "inviteeEmail" in the action block. If not, omit it.

TONE: Conversational, efficient, no filler. You know the user's calendar — reference it naturally.`;

export async function POST(req: NextRequest) {
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

  // Get or create channel
  let channel = await prisma.channel.findUnique({ where: { userId: user.id } });
  if (!channel) {
    channel = await prisma.channel.create({ data: { userId: user.id } });
  }

  const body = await req.json();
  const { message } = body;

  // Save user message
  await prisma.channelMessage.create({
    data: { channelId: channel.id, role: "user", content: message },
  });

  // Build context
  const contextParts: string[] = [];
  contextParts.push(`User: ${user.name || "User"}`);

  // Calendar context
  let calendarConnected = false;
  try {
    const account = await prisma.account.findFirst({
      where: { userId: user.id, provider: "google" },
    });
    if (account?.refresh_token && account.scope?.includes("calendar")) {
      calendarConnected = true;
      const now = new Date();
      const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const slots = await getAvailableSlots(user.id, now, twoWeeks);
      const slotSummary = slots.slice(0, 10).map(s =>
        `${s.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} ${s.start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} - ${s.end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      ).join('\n  ');
      contextParts.push(`Calendar: Connected. Open slots:\n  ${slotSummary}`);
    }
  } catch (e) {
    console.log("Calendar context error:", e);
  }
  if (!calendarConnected) {
    contextParts.push("Calendar: Not connected");
  }

  // Active threads context
  const activeThreads = await prisma.negotiationSession.findMany({
    where: { hostId: user.id, status: { in: ["active", "agreed"] } },
    include: { link: true, _count: { select: { messages: true } } },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });
  if (activeThreads.length > 0) {
    const threadList = activeThreads.map(t =>
      `- "${t.title || 'Untitled'}" (${t.statusLabel || t.status}, ${t._count.messages} messages)`
    ).join('\n');
    contextParts.push(`Active threads:\n${threadList}`);
  } else {
    contextParts.push("Active threads: None");
  }

  // Get conversation history
  const history = await prisma.channelMessage.findMany({
    where: { channelId: channel.id },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  const messages = history.map(m => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));

  // Generate response
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: CHANNEL_SYSTEM + "\n\nCONTEXT:\n" + contextParts.join("\n"),
    messages,
  });

  // Parse for agentenvoy-action blocks
  const actionRegex = /```agentenvoy-action\s*\n?([\s\S]*?)\n?```/g;
  const actionMatch = actionRegex.exec(text);

  // Strip action blocks from the visible message
  const displayText = text.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

  // Process action if found
  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);

      if (action.action === "create_thread") {
        const code = generateCode();
        const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
        const threadUrl = `${baseUrl}/meet/${user.meetSlug}/${code}`;
        const title = action.topic
          ? `${action.topic} — ${action.inviteeName || "Invitee"}`
          : `Catch up — ${action.inviteeName || "Invitee"}`;

        // Create contextual link
        const link = await prisma.negotiationLink.create({
          data: {
            userId: user.id,
            type: "contextual",
            slug: user.meetSlug || "",
            code,
            inviteeEmail: action.inviteeEmail || null,
            inviteeName: action.inviteeName || null,
            topic: action.topic || null,
            rules: action.rules || {},
          },
        });

        // Create negotiation session
        const negotiationSession = await prisma.negotiationSession.create({
          data: {
            linkId: link.id,
            hostId: user.id,
            type: "calendar",
            status: "active",
            title,
            statusLabel: `Waiting for ${action.inviteeName || "invitee"}`,
            format: action.format || null,
            duration: action.duration || 30,
          },
        });

        // Save envoy response (stripped of action block) with threadId
        await prisma.channelMessage.create({
          data: {
            channelId: channel.id,
            role: "envoy",
            content: displayText || `I've set up a thread for ${action.inviteeName || "your meeting"}.`,
            threadId: negotiationSession.id,
          },
        });

        // Build a response that includes the thread data
        const shareNote = action.inviteeEmail
          ? `I'll send the invite to ${action.inviteeEmail}.`
          : `Here's the link to share: ${threadUrl}`;

        const responsePayload = {
          message: displayText || `I've set up a thread for ${action.inviteeName || "your meeting"}.`,
          shareNote,
          thread: {
            id: negotiationSession.id,
            title,
            status: "active",
            statusLabel: `Waiting for ${action.inviteeName || "invitee"}`,
            format: action.format || null,
            duration: action.duration || 30,
            url: threadUrl,
            code,
            link: {
              inviteeName: action.inviteeName || null,
              inviteeEmail: action.inviteeEmail || null,
              topic: action.topic || null,
              code,
              slug: user.meetSlug || "",
            },
          },
        };

        return NextResponse.json(responsePayload);
      }
    } catch (e) {
      console.error("Failed to parse/execute action:", e);
    }
  }

  // No action — save envoy response as-is
  await prisma.channelMessage.create({
    data: { channelId: channel.id, role: "envoy", content: displayText || text },
  });

  // Return as stream-compatible format (matching existing pattern)
  const encoded = JSON.stringify(displayText || text);
  return new Response(`0:${encoded}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
