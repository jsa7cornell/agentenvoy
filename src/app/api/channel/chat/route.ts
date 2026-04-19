import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText, streamText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule, formatOfferableSlots } from "@/agent/composer";
import { getUserTimezone } from "@/lib/timezone";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import { sanitizeHistory } from "@/lib/conversation";
import { needsActionEmissionRetry, ACTION_EMISSION_RETRY_PROMPT } from "@/agent/action-emission-guard";
import { readFileSync } from "fs";
import { join } from "path";

// Load playbooks once at module scope (same pattern as composer.ts)
let personaPlaybook = "";
let channelPlaybook = "";
try {
  personaPlaybook = readFileSync(join(process.cwd(), "src", "agent", "playbooks", "persona.md"), "utf-8");
} catch (e) {
  console.error("Failed to load persona.md for channel chat:", e);
}
try {
  channelPlaybook = readFileSync(join(process.cwd(), "src", "agent", "playbooks", "channel.md"), "utf-8");
} catch (e) {
  console.error("Failed to load channel.md for channel chat:", e);
  throw e;
}

const CHANNEL_SYSTEM = `${personaPlaybook ? personaPlaybook + "\n\n---\n\n" : ""}${channelPlaybook}`;

export async function POST(req: NextRequest) {
  try {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parallel group 1: user lookup + body parse
  const [user, body] = await Promise.all([
    prisma.user.findUnique({
      where: { email: session.user.email },
      select: {
        id: true,
        name: true,
        email: true,
        meetSlug: true,
        preferences: true,
        persistentKnowledge: true,
        upcomingSchedulePreferences: true,
        hostDirectives: true,
        lastCalibratedAt: true,
      },
    }),
    req.json(),
  ]);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  // Pin narrowed user for closures later in this handler. TypeScript drops
  // null-check narrowing across nested function boundaries on let-bound locals.
  const safeUser = user;
  const { message } = body;

  // Get or create channel
  let channel = await prisma.channel.findUnique({ where: { userId: safeUser.id } });
  if (!channel) {
    channel = await prisma.channel.create({ data: { userId: safeUser.id } });
  }
  const safeChannel = channel;

  // Detect if the host is asking us to re-check / refresh calendar
  const lowerMsg = message.toLowerCase();
  const isRefreshRequest = /\b(check again|re-?check|refresh|re-?pull|changed my (schedule|calendar)|updated my (schedule|calendar)|look again|try again|one more time)\b/i.test(lowerMsg);

  // Parallel group 2: save message + session lookup + schedule + active sessions
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const now = new Date();

  const [, sessionResult, scheduleResult, activeSessions] = await Promise.all([
    // Save user message
    prisma.channelMessage.create({
      data: { channelId: safeChannel.id, role: "user", content: message },
    }),
    // Find active session
    prisma.channelSession.findFirst({
      where: { channelId: safeChannel.id, closed: false },
      orderBy: { startedAt: "desc" },
    }),
    // Fetch scored schedule
    getOrComputeSchedule(safeUser.id, { forceRefresh: isRefreshRequest }).catch((e) => {
      console.log("Schedule context error:", e);
      return null;
    }),
    // Fetch active negotiation sessions
    prisma.negotiationSession.findMany({
      where: { hostId: safeUser.id, archived: false },
      include: { link: { select: { inviteeName: true, inviteeEmail: true, topic: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  // --- Channel session lifecycle (3-day rolling window) ---
  let activeSession = sessionResult;

  if (activeSession && activeSession.expiresAt < now) {
    // Session expired — close it immediately and summarize in the background.
    // The summarization runs fire-and-forget so the user's message proceeds without waiting.
    const expiredSessionId = activeSession.id;
    const expiredSessionStart = activeSession.startedAt;
    await prisma.channelSession.update({
      where: { id: expiredSessionId },
      data: { closed: true },
    });

    void (async () => {
      try {
        const recentMsgs = await prisma.channelMessage.findMany({
          where: {
            channelId: safeChannel.id,
            createdAt: { gte: expiredSessionStart },
          },
          orderBy: { createdAt: "asc" },
          take: 30,
        });
        const summaryText = recentMsgs
          .filter((m) => m.role !== "system")
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
          .join("\n");

        const summaryResult = await generateText({
          model: envoyModel("claude-sonnet-4-6"),
          maxOutputTokens: 512,
          system: "Summarize this scheduling conversation in 2-3 sentences. Focus on what was decided, what's pending, and any preferences learned.",
          messages: [{ role: "user", content: summaryText }],
        });
        await prisma.channelSession.update({
          where: { id: expiredSessionId },
          data: { summary: summaryResult.text },
        });
      } catch (e) {
        console.error("[channel/chat] Background summarization failed:", e);
      }
    })();

    activeSession = null;
  }

  if (!activeSession) {
    activeSession = await prisma.channelSession.create({
      data: {
        channelId: safeChannel.id,
        expiresAt: new Date(Date.now() + THREE_DAYS_MS),
      },
    });
  } else {
    await prisma.channelSession.update({
      where: { id: activeSession.id },
      data: { expiresAt: new Date(Date.now() + THREE_DAYS_MS) },
    });
  }

  // Build context
  const contextParts: string[] = [];
  contextParts.push(`User: ${user.name || "User"}`);

  // Scored schedule — use pre-fetched result
  let calendarConnected = false;
  const hostPrefs = user.preferences as Record<string, unknown> | null;
  const tz = getUserTimezone(hostPrefs);
  if (scheduleResult?.connected) {
    calendarConnected = true;
    // Dashboard channel: use Sunday-start week convention (host-side US
     // convention) — "this week" on Sunday = today→next Saturday, which is
     // what John means when he says it mid-conversation. Deal-room paths
     // keep the default ISO/Monday-start so guests from ISO-8601 cultures
     // aren't surprised. See proposals/2026-04-20 Bug 2.
    contextParts.push(
      formatComputedSchedule(scheduleResult.slots, tz, scheduleResult.canWrite, undefined, {
        weekConvention: "sun_start",
      }),
    );
    contextParts.push(formatOfferableSlots(scheduleResult.slots, tz, scheduleResult.canWrite));
  }
  if (!calendarConnected) {
    contextParts.push("Calendar: Not connected");
  }

  // Host knowledge base — same context the deal room agent gets
  if (user.persistentKnowledge) {
    contextParts.push(`Host's persistent preferences:\n${user.persistentKnowledge}`);
  }
  if (user.upcomingSchedulePreferences) {
    contextParts.push(`Host's situational context (near-term):\n${user.upcomingSchedulePreferences}`);
  }
  if (user.hostDirectives && (user.hostDirectives as string[]).length > 0) {
    contextParts.push(`Host directives (highest priority):\n${(user.hostDirectives as string[]).map(d => `- ${d}`).join("\n")}`);
  }

  // Active sessions context — use pre-fetched result
  if (activeSessions.length > 0) {
    const sessionList = activeSessions.map(s =>
      `- "${s.title || 'Untitled'}" (ID: ${s.id}) — status: ${s.status}, guest: ${s.link.inviteeName || s.guestEmail || "unknown"}${s.statusLabel ? `, note: ${s.statusLabel}` : ""}`
    ).join('\n');
    contextParts.push(`Active sessions:\n${sessionList}\n\nYou can execute actions on these sessions using [ACTION] blocks.`);
  } else {
    contextParts.push("Active sessions: None");
  }

  // Timezone reference
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

  // Calibration state
  if (!user.lastCalibratedAt) {
    contextParts.push("Calibration: NEVER — this host has not been calibrated. Run onboarding calibration (see ONBOARDING CALIBRATION below).");
  } else {
    const daysSince = Math.floor((Date.now() - new Date(user.lastCalibratedAt).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince >= 10) {
      contextParts.push(`Calibration: Last calibrated ${daysSince} days ago. Consider running a check-in (see CHECK-IN CALIBRATION below).`);
    } else {
      contextParts.push(`Calibration: Last calibrated ${daysSince} day${daysSince !== 1 ? "s" : ""} ago.`);
    }
  }

  // Get conversation history — hard cap at 3 days
  const threeDaysAgo = new Date(Date.now() - THREE_DAYS_MS);
  const sessionStart = new Date(activeSession.startedAt.getTime() - 5000);
  const historyStart = sessionStart > threeDaysAgo ? sessionStart : threeDaysAgo;
  const history = await prisma.channelMessage.findMany({
    where: {
      channelId: safeChannel.id,
      createdAt: { gte: historyStart },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  history.reverse();

  // Sanitize history for the Anthropic API (filter system messages, merge consecutive turns)
  const { messages, warnings } = sanitizeHistory(
    history.map(m => ({ role: m.role, content: m.content })),
    ["envoy", "assistant"]
  );
  if (warnings.length > 0) {
    console.warn(`[channel/chat] History sanitized | userId=${safeUser.id} | ${warnings.join("; ")}`);
  }

  const system = CHANNEL_SYSTEM + "\n\nCONTEXT:\n" + contextParts.join("\n");
  const modelId = "claude-sonnet-4-6";


  // Action-parsing + DB-write logic, hoisted out of onFinish so the
  // emission-retry path (below) can run it on the COMBINED text (original
  // stream + retry's appended action block). If we left it in onFinish it
  // would fire on the first text alone, and a retry-emitted action would
  // never hit the DB.
  const finalizeResponse = async (text: string) => {
    try {
      const actions = parseActions(text);
      let actionResults: Awaited<ReturnType<typeof executeActions>> = [];
      if (actions.length > 0) {
        actionResults = await executeActions(actions, safeUser.id, { meetSlug: safeUser.meetSlug || undefined });
      }

      let displayText = stripActionBlocks(text);

      // Strip any ```agentenvoy-action``` fences that slipped through (legacy
      // format retired 2026-04-18; kept as a display-only strip so old DB
      // messages or rare model regressions don't leak raw JSON into the UI).
      displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

      const createLinkResult = actionResults.find((r) => r.success && r.data?.url);
      if (createLinkResult?.data) {
        const d = createLinkResult.data;
        await prisma.channelMessage.create({
          data: {
            channelId: safeChannel.id,
            role: "envoy",
            content: displayText || createLinkResult.message,
            threadId: d.sessionId as string,
          },
        });
        return;
      }

      // For non-create actions that mutated a specific session (update_*, expand_link,
      // cancel, archive, hold, save_guest_info), thread the envoy reply to that
      // session so the feed renders a ThreadCard with a "View it here" link. Pick
      // the most recent session-bearing action result as the thread anchor.
      const threadedResult = actionResults.find(
        (r) => r.success && typeof r.data?.sessionId === "string",
      );
      if (threadedResult?.data) {
        const sid = threadedResult.data.sessionId as string;
        const summary =
          actionResults.length > 0
            ? actionResults
                .map((r) => `${r.success ? "\u2713" : "\u2717"} ${r.message}`)
                .join("\n")
            : "";
        const envoyText = displayText || threadedResult.message;
        await prisma.channelMessage.create({
          data: {
            channelId: safeChannel.id,
            role: "envoy",
            content: envoyText,
            threadId: sid,
          },
        });
        if (summary && displayText) {
          await prisma.channelMessage.create({
            data: { channelId: safeChannel.id, role: "system", content: summary },
          });
        }
        return;
      }

      if (actionResults.length > 0) {
        const summary = actionResults
          .map((r) => `${r.success ? "\u2713" : "\u2717"} ${r.message}`)
          .join("\n");
        if (!displayText) {
          displayText = summary;
        } else {
          await prisma.channelMessage.create({
            data: { channelId: safeChannel.id, role: "system", content: summary },
          });
        }
      }

      const finalText = displayText || text || "Done.";
      await prisma.channelMessage.create({
        data: { channelId: safeChannel.id, role: "envoy", content: finalText },
      });
    } catch (e) {
      console.error("[channel/chat] finalizeResponse error:", e);
    }
  }

  // Stream to the client while buffering. If the LLM described a
  // state-change without emitting an action block, fire one retry and
  // append its output. finalizeResponse then runs on the combined text.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const first = streamText({
          model: envoyModel(modelId),
          maxOutputTokens: 1024,
          system,
          messages,
        });
        let fullText = "";
        for await (const chunk of first.textStream) {
          controller.enqueue(encoder.encode(chunk));
          fullText += chunk;
        }

        if (needsActionEmissionRetry(fullText)) {
          console.warn(
            `[channel/chat] intent-without-emit detected for user ${safeUser.id}, forcing retry`
          );
          const retry = await generateText({
            model: envoyModel(modelId),
            maxOutputTokens: 512,
            system,
            messages: [
              ...messages,
              { role: "assistant", content: fullText },
              { role: "user", content: ACTION_EMISSION_RETRY_PROMPT },
            ],
          });
          if (retry.text.trim()) {
            controller.enqueue(encoder.encode("\n\n" + retry.text));
            fullText += "\n\n" + retry.text;
          }
        }
        controller.close();
        await finalizeResponse(fullText);
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[channel/chat] Unhandled error: ${err.message}`, err.stack);
    return NextResponse.json(
      { error: "Something went wrong", detail: err.message, retryable: true },
      { status: 500 }
    );
  }
}
