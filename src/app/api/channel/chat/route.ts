import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { getAvailableSlots } from "@/lib/calendar";
import { generateCode } from "@/lib/utils";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";

const CHANNEL_SYSTEM = `You are Envoy, the user's scheduling agent. You operate in their feed — a chat interface where scheduling threads appear as inline cards.

CORE BEHAVIOR:
1. Create scheduling threads when the user describes a meeting they want to set up
2. Give status updates on active threads when asked
3. Take actions on existing threads ("archive the Bryan meeting", "cancel the Noah meeting", "change Sarah's meeting to video")
4. Be contextual — reference the user's calendar, active threads, and preferences

CREATING THREADS:
When the user wants to schedule something, extract what you can: who (name), what (topic), when (preferences), format (phone/video/in-person), duration.
Then emit an action block:
\`\`\`agentenvoy-action
{"action":"create_thread","inviteeName":"Sarah Chen","topic":"Q2 Roadmap","format":"phone","duration":30,"rules":{"preferredDays":["Tuesday"],"lastResort":["Friday"]}}
\`\`\`

IMPORTANT — email is OPTIONAL. The inviteeName is the only required field. Do NOT ask for email unless the user wants Envoy to send the invite directly. If the user just says "set up a meeting with Bryan", create the thread with just the name — they can share the link themselves.
If the user provides an email, include "inviteeEmail" in the action block. If not, omit it.

ACTIONS ON EXISTING THREADS:
When the user asks you to DO something to an existing thread (archive, cancel, change format, etc.), include an action block at the END of your message:

[ACTION]{"action":"archive","params":{"sessionId":"SESSION_ID"}}[/ACTION]

Available actions:
- archive: Archive a session → {"action":"archive","params":{"sessionId":"..."}}
- archive_bulk: Archive multiple → {"action":"archive_bulk","params":{"filter":"unconfirmed"}} (filters: "unconfirmed", "expired", "cancelled", "all")
- unarchive: Restore archived → {"action":"unarchive","params":{"sessionId":"..."}}
- cancel: Cancel a meeting → {"action":"cancel","params":{"sessionId":"...","reason":"..."}}
- update_format: Change format → {"action":"update_format","params":{"sessionId":"...","format":"video"}}
- update_time: Propose new time → {"action":"update_time","params":{"sessionId":"...","dateTime":"...","timezone":"..."}}
- update_location: Change location → {"action":"update_location","params":{"sessionId":"...","location":"..."}}
- create_link: Create a new invite → {"action":"create_link","params":{"inviteeName":"...","topic":"...","format":"...","duration":30}}

Rules:
- Always include the action block when the user's intent is clear
- You can include MULTIPLE action blocks in one message
- Always confirm what you're about to do in your conversational text BEFORE the action block
- If the user's intent is ambiguous, ask for clarification instead of acting
- Use session IDs from the "Active sessions" context below
- For create_link, use the action block above (not the agentenvoy-action format) — both work but this is preferred for new links

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

  // Active sessions context — with IDs so the AI can reference them in actions
  const activeSessions = await prisma.negotiationSession.findMany({
    where: { hostId: user.id, archived: false },
    include: { link: { select: { inviteeName: true, inviteeEmail: true, topic: true } } },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  if (activeSessions.length > 0) {
    const sessionList = activeSessions.map(s =>
      `- "${s.title || 'Untitled'}" (ID: ${s.id}) — status: ${s.status}, guest: ${s.link.inviteeName || s.guestEmail || "unknown"}${s.statusLabel ? `, note: ${s.statusLabel}` : ""}`
    ).join('\n');
    contextParts.push(`Active sessions:\n${sessionList}\n\nYou can execute actions on these sessions using [ACTION] blocks.`);
  } else {
    contextParts.push("Active sessions: None");
  }

  // Timezone reference
  const hostPrefs = user.preferences as Record<string, unknown> | null;
  const tz =
    (hostPrefs?.timezone as string) ??
    ((hostPrefs?.explicit as Record<string, unknown> | undefined)?.timezone as string) ??
    "America/Los_Angeles";
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: tz,
  });
  contextParts.push(`Current time: ${timeStr}`);

  // Get conversation history
  const history = await prisma.channelMessage.findMany({
    where: { channelId: channel.id },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  // Build conversation history for the AI. Filter out system messages (action results)
  // and merge consecutive same-role messages to satisfy the alternating-turns requirement.
  const filtered = history
    .filter(m => m.role === "user" || m.role === "envoy")
    .map(m => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    }));
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of filtered) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge consecutive same-role messages
      prev.content += "\n" + msg.content;
    } else {
      messages.push({ ...msg });
    }
  }

  // Generate response
  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-5"),
    system: CHANNEL_SYSTEM + "\n\nCONTEXT:\n" + contextParts.join("\n"),
    messages,
  });

  // --- Parse and execute [ACTION] blocks ---
  const actions = parseActions(text);
  let actionResults: Awaited<ReturnType<typeof executeActions>> = [];
  if (actions.length > 0) {
    actionResults = await executeActions(actions, user.id, { meetSlug: user.meetSlug || undefined });
  }

  // Strip [ACTION] blocks from displayed text
  let displayText = stripActionBlocks(text);

  // --- Legacy: parse agentenvoy-action blocks (create_thread) ---
  const actionRegex = /```agentenvoy-action\s*\n?([\s\S]*?)\n?```/g;
  const actionMatch = actionRegex.exec(displayText);

  // Strip legacy action blocks from the visible message
  displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

  // Process legacy create_thread action if found
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
      console.error("Failed to parse/execute legacy action:", e);
    }
  }

  // Check if create_link action was among the new-style actions
  const createLinkResult = actionResults.find(
    (r) => r.success && r.data?.url
  );
  if (createLinkResult?.data) {
    const d = createLinkResult.data;
    // Save envoy response with threadId for thread card rendering
    await prisma.channelMessage.create({
      data: {
        channelId: channel.id,
        role: "envoy",
        content: displayText || createLinkResult.message,
        threadId: d.sessionId as string,
      },
    });

    return NextResponse.json({
      message: displayText || createLinkResult.message,
      shareNote: `Here's the link to share: ${d.url}`,
      thread: {
        id: d.sessionId,
        title: d.title,
        status: "active",
        statusLabel: `Waiting for invitee`,
        url: d.url,
        code: d.code,
        link: {
          slug: user.meetSlug || "",
          code: d.code,
        },
      },
    });
  }

  // Append action results summary if any non-create_link actions executed
  if (actionResults.length > 0) {
    const summary = actionResults
      .map((r) => `${r.success ? "\u2713" : "\u2717"} ${r.message}`)
      .join("\n");
    // Save the action results as a system message
    await prisma.channelMessage.create({
      data: { channelId: channel.id, role: "system", content: summary },
    });
  }

  // Save envoy response
  await prisma.channelMessage.create({
    data: { channelId: channel.id, role: "envoy", content: displayText || text },
  });

  // Return as stream-compatible format (matching existing pattern)
  const encoded = JSON.stringify(displayText || text);
  return new Response(`0:${encoded}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
