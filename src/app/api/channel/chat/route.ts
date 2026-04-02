import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getAvailableSlots } from "@/lib/calendar";

const CHANNEL_SYSTEM = `You are Envoy, the user's scheduling agent. You operate in their feed — a chat interface where scheduling threads appear as inline cards.

CORE BEHAVIOR:
1. Create scheduling threads when the user describes a meeting they want to set up
2. Give status updates on active threads when asked
3. Take actions on existing threads ("push Sarah to Wednesday", "cancel the Noah meeting")
4. Be contextual — reference the user's calendar, active threads, and preferences

CREATING THREADS:
When the user wants to schedule something, extract: who (name, email), what (topic), when (preferences), format (phone/video/in-person), duration.
Then emit an action block:
\`\`\`agentenvoy-action
{"action":"create_thread","inviteeName":"Sarah Chen","inviteeEmail":"sarah@acme.com","topic":"Q2 Roadmap","format":"phone","duration":30,"rules":{"preferredDays":["Tuesday"],"lastResort":["Friday"]}}
\`\`\`

If you're missing critical info (who or email), ask for it conversationally — don't make the user fill out a form.

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
    where: { initiatorId: user.id, status: { in: ["active", "agreed"] } },
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

  // Save envoy response
  await prisma.channelMessage.create({
    data: { channelId: channel.id, role: "envoy", content: text },
  });

  // Return as stream-compatible format (matching existing pattern)
  const encoded = JSON.stringify(text);
  return new Response(`0:${encoded}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
