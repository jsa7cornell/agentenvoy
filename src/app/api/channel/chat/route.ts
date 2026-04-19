import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule, formatOfferableSlots } from "@/agent/composer";
import { getUserTimezone } from "@/lib/timezone";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import type { ActionResult } from "@/agent/actions";
import { narrateFailures, narrateTimeout, narrateFinalizeError } from "@/agent/action-narration";
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


  // Action-parsing + DB-write logic. Runs server-side BEFORE any bytes go to
  // the client (always-buffer mode, narration-hygiene-v2 proposal decided
  // 2026-04-20). Returns the display text to enqueue; the caller writes it
  // to the stream in one shot.
  //
  // On any action failure, the LLM's drafted narration is replaced by a
  // deterministic template (see action-narration.ts) — the original LLM
  // draft is preserved in ChannelMessage.metadata.overriddenNarration for
  // debug/forensics but never shown to the user.
  //
  // 15-second cap on action execution. If executeActions exceeds that, we
  // emit a "still working" template and let the action finish in background;
  // we prefer a predictable user-visible message over a hung request.
  const ACTION_TIMEOUT_MS = 15_000;
  const finalizeResponse = async (text: string): Promise<string> => {
    try {
      const actions = parseActions(text);
      let actionResults: ActionResult[] = [];
      let timedOut = false;
      if (actions.length > 0) {
        const execPromise = executeActions(actions, safeUser.id, { meetSlug: safeUser.meetSlug || undefined });
        const timeoutPromise = new Promise<"__TIMEOUT__">((resolve) =>
          setTimeout(() => resolve("__TIMEOUT__"), ACTION_TIMEOUT_MS),
        );
        const raced = await Promise.race([execPromise, timeoutPromise]);
        if (raced === "__TIMEOUT__") {
          timedOut = true;
          // Don't await — let it finish in background. Log when it settles.
          execPromise
            .then((r) => console.warn(`[channel/chat] late action completion user=${safeUser.id} results=${r.map(x => x.success ? "ok" : "fail").join(",")}`))
            .catch((e) => console.error(`[channel/chat] late action error user=${safeUser.id}:`, e));
        } else {
          actionResults = raced;
        }
      }

      let displayText = stripActionBlocks(text);

      // Strip any ```agentenvoy-action``` fences that slipped through (legacy
      // format retired 2026-04-18; kept as a display-only strip so old DB
      // messages or rare model regressions don't leak raw JSON into the UI).
      displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

      // Narration hygiene v2: if any action failed, REPLACE the LLM's draft
      // with a deterministic template (not prepend — the prepend-only approach
      // in bcf2ec1 left the LLM's misleading success text visible below the
      // warning). Preserve the original draft in metadata.overriddenNarration
      // for forensics.
      let overriddenNarration: string | null = null;
      if (timedOut) {
        overriddenNarration = displayText || null;
        displayText = narrateTimeout();
      } else {
        const failedResults = actionResults.filter((r) => !r.success);
        if (failedResults.length > 0) {
          overriddenNarration = displayText || null;
          displayText = narrateFailures(actions, actionResults, displayText);
        }
      }

      const metadata = overriddenNarration
        ? { overriddenNarration }
        : undefined;

      const createLinkResult = actionResults.find((r) => r.success && r.data?.url);
      if (createLinkResult?.data) {
        const d = createLinkResult.data;
        const envoyText = displayText || createLinkResult.message;
        await prisma.channelMessage.create({
          data: {
            channelId: safeChannel.id,
            role: "envoy",
            content: envoyText,
            threadId: d.sessionId as string,
            ...(metadata ? { metadata } : {}),
          },
        });
        return envoyText;
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
            ...(metadata ? { metadata } : {}),
          },
        });
        if (summary && displayText) {
          await prisma.channelMessage.create({
            data: { channelId: safeChannel.id, role: "system", content: summary },
          });
        }
        return envoyText;
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
        data: {
          channelId: safeChannel.id,
          role: "envoy",
          content: finalText,
          ...(metadata ? { metadata } : {}),
        },
      });
      return finalText;
    } catch (e) {
      console.error("[channel/chat] finalizeResponse error:", e);
      // Last-resort: deterministic line; persist so the feed has *something*.
      const fallback = narrateFinalizeError();
      try {
        await prisma.channelMessage.create({
          data: { channelId: safeChannel.id, role: "envoy", content: fallback },
        });
      } catch {
        // swallow — already in an error path
      }
      return fallback;
    }
  }

  // Always-buffer mode (narration-hygiene-v2, decided 2026-04-20). Previously
  // we streamed the LLM's text token-by-token to the client, then ran actions
  // in onFinish — which meant the LLM's drafted narration (potentially
  // claiming success before the tool ran) was on screen before we could
  // correct it. Now: generate the full text server-side, run actions, compute
  // the final display text (with deterministic failure rewrite when needed),
  // and enqueue it in one shot. Costs ~200–800ms of perceived latency on
  // action turns; justified by removing the narration/outcome mismatch.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const first = await generateText({
          model: envoyModel(modelId),
          maxOutputTokens: 1024,
          system,
          messages,
        });
        let fullText = first.text;

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
            fullText += "\n\n" + retry.text;
          }
        }

        const clientText = await finalizeResponse(fullText);
        controller.enqueue(encoder.encode(clientText));
        controller.close();
      } catch (e) {
        console.error("[channel/chat] stream start error:", e);
        // Deterministic fallback to client; never propagate raw error.
        try {
          controller.enqueue(encoder.encode(narrateFinalizeError()));
          controller.close();
        } catch {
          try { controller.error(e); } catch { /* already closed */ }
        }
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
