import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { AgentContext, extractAvailabilitySummary } from "@/agent/administrator";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import type { ScoredSlot, LinkRules } from "@/lib/scoring";
import { applyEventOverrides } from "@/lib/scoring";
import { computeThreadStatus } from "@/lib/thread-status";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import { sanitizeHistory } from "@/lib/conversation";

const VALID_STATUSES = ["active", "proposed", "cancelled", "escalated"];

function parseStatusUpdate(content: string): { status: string; label: string } | null {
  const match = content.match(/\[STATUS_UPDATE\](.*?)\[\/STATUS_UPDATE\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function stripStatusUpdate(content: string): string {
  return content.replace(/\s*\[STATUS_UPDATE\].*?\[\/STATUS_UPDATE\]\s*/g, "").trim();
}

// Slice 9 — Proxy attribution (Layer 2 of the proxy framework). When Envoy
// detects a proxy via Layer 1's conversational signals, it emits one of
// these blocks inline:
//
//   [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER]
//   [DELEGATE_SPEAKER]{"kind":"human_assistant","name":"Sarah's EA"}[/DELEGATE_SPEAKER]
//   [DELEGATE_SPEAKER]{"kind":"unknown"}[/DELEGATE_SPEAKER]
//
// The block attaches to the most recent GUEST-role message (the one that
// triggered detection) via message.metadata.delegateSpeaker. The UI reads
// that metadata and renders a small "via {name}" badge. Envoy emits once
// per distinct speaker — subsequent messages from the same proxy don't
// need to repeat the block.
const VALID_DELEGATE_KINDS = new Set(["human_assistant", "ai_agent", "unknown"]);

function parseDelegateSpeaker(content: string): { kind: string; name?: string } | null {
  const match = content.match(/\[DELEGATE_SPEAKER\](.*?)\[\/DELEGATE_SPEAKER\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed?.kind !== "string" || !VALID_DELEGATE_KINDS.has(parsed.kind)) return null;
    const name = typeof parsed.name === "string" && parsed.name.length > 0 && parsed.name.length <= 80
      ? parsed.name
      : undefined;
    return { kind: parsed.kind, name };
  } catch {
    return null;
  }
}

function stripDelegateSpeaker(content: string): string {
  return content.replace(/\s*\[DELEGATE_SPEAKER\].*?\[\/DELEGATE_SPEAKER\]\s*/g, "").trim();
}

// POST /api/negotiate/message
// Send a message in a negotiation session and get agent response (streaming)
export async function POST(req: NextRequest) {
  try {
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

  // Host messages in the deal room are instructions TO Envoy (e.g., "book it for friday at 9").
  // Envoy should always respond — the host is directing the negotiation.

  // Build and sanitize conversation history
  // Prefix host messages so Envoy knows who is speaking (host vs guest)
  const rawHistory = session.messages.map((m) => ({
    role: m.role,
    content: m.role === "host" ? `[HOST]: ${m.content}` : m.content,
  }));
  rawHistory.push({
    role: messageRole,
    content: isHost ? `[HOST]: ${content}` : content,
  });
  const { messages: history, warnings } = sanitizeHistory(rawHistory, [
    "administrator",
    "assistant",
  ]);
  if (warnings.length > 0) {
    console.warn(
      `[negotiate/message] History sanitized | sessionId=${sessionId} | ${warnings.join("; ")}`
    );
  }

  // Fetch scored schedule (uses cached calendar + computed scores)
  let calendarContext: CalendarContext | undefined;
  let scoredSlots: ScoredSlot[] = [];
  try {
    const schedule = await getOrComputeSchedule(session.hostId);
    if (schedule.connected) {
      calendarContext = {
        connected: true,
        events: schedule.events,
        calendars: schedule.calendars,
        timezone: schedule.timezone,
        canWrite: schedule.canWrite,
      };
      scoredSlots = schedule.slots;

      // Apply link-level overrides (preferredDays, dateRange, slot overrides)
      // so the LLM sees the same filtered set as the widget and greeting.
      const lr = (session.link.rules as LinkRules) || {};
      if (Object.keys(lr).length > 0) {
        const hostPrefs = (session.host.preferences as Record<string, unknown>) || {};
        const hostTz = (hostPrefs.explicit as Record<string, unknown>)?.timezone as string || schedule.timezone;
        scoredSlots = applyEventOverrides(scoredSlots, lr, hostTz);
      }
    }
  } catch (e) {
    console.log("Schedule context error in negotiate/message:", e);
  }

  // Build group context if applicable
  const isGroupEvent = (session.link as { mode?: string }).mode === "group";
  let eventParticipants: Array<{ name: string; status: string; statedAvailability?: string }> | undefined;

  if (isGroupEvent) {
    const allParticipants = await prisma.sessionParticipant.findMany({
      where: { linkId: session.linkId },
      include: {
        session: {
          include: { messages: { orderBy: { createdAt: "asc" } } },
        },
      },
    });

    // Update this participant's status to "active" on first guest message
    const thisParticipant = allParticipants.find((p) => p.sessionId === sessionId);
    if (thisParticipant && thisParticipant.status === "pending") {
      await prisma.sessionParticipant.update({
        where: { id: thisParticipant.id },
        data: { status: "active" },
      });
    }

    // Extract availability from other participants' sessions
    const participantContexts = await Promise.all(
      allParticipants
        .filter((p) => p.sessionId !== sessionId)
        .map(async (p) => {
          const msgs = p.session.messages.map((m) => ({
            role: m.role === "administrator" ? "assistant" : m.role,
            content: m.content,
          }));
          const availability = msgs.length > 1 ? await extractAvailabilitySummary(msgs) : null;
          return {
            name: p.name || p.email || "Unknown",
            status: p.status,
            statedAvailability: availability || undefined,
          };
        })
    );
    eventParticipants = participantContexts;
  }

  // Build agent context
  const context: AgentContext = {
    role: session.type === "calendar" ? "coordinator" : "administrator",
    sessionId,
    hostName: session.host.name || "the host",
    hostPreferences:
      (session.host.preferences as Record<string, unknown>) || {},
    hostDirectives: (session.host.hostDirectives as string[]) || [],
    guestName: session.link.inviteeName || undefined,
    guestEmail:
      session.guestEmail || session.link.inviteeEmail || undefined,
    topic: session.link.topic || undefined,
    rules: (session.link.rules as Record<string, unknown>) || {},
    calendarContext,
    scoredSlots,
    hostPersistentKnowledge: (session.host as { persistentKnowledge?: string }).persistentKnowledge,
    hostUpcomingSchedulePreferences: (session.host as { upcomingSchedulePreferences?: string }).upcomingSchedulePreferences,
    isGroupEvent: isGroupEvent || undefined,
    eventParticipants,
    conversationHistory: history,
  };

  console.log(`[negotiate/message] start | session=${sessionId} | role=${messageRole} | slots=${scoredSlots.length} | history=${history.length}`);

  const { streamAgentResponse } = await import("@/agent/administrator");
  const streamResult = await streamAgentResponse(context, {
    async onFinish({ text: responseText }) {
      try {
        const responseLen = responseText?.length || 0;
        if (responseLen === 0) {
          console.warn(`[negotiate/message] empty response | session=${sessionId}`);
        }

        // Parse and execute [ACTION] blocks
        const actions = parseActions(responseText);
        if (actions.length > 0) {
          console.log(`[negotiate/message] actions | session=${sessionId} | ${actions.map(a => a.action).join(",")}`);
          await executeActions(actions, session.hostId, { sessionId });
        }

        // Strip all structured blocks from the display text
        let displayText = stripActionBlocks(responseText);

        // Parse and apply status update if present
        const statusUpdate = parseStatusUpdate(displayText);
        displayText = stripStatusUpdate(displayText);

        // Parse delegate-speaker attribution if present (Slice 9). Writes
        // to the most recent guest message's metadata so the UI can render
        // a "via {name}" badge next to it. Stripped from displayText like
        // STATUS_UPDATE so the block never shows in the UI.
        const delegateSpeaker = parseDelegateSpeaker(displayText);
        displayText = stripDelegateSpeaker(displayText);

        // Save the response (stripped of all blocks)
        await prisma.message.create({
          data: { sessionId, role: "administrator", content: displayText },
        });

        if (delegateSpeaker) {
          try {
            const targetGuestMsg = await prisma.message.findFirst({
              where: { sessionId, role: "guest" },
              orderBy: { createdAt: "desc" },
              select: { id: true, metadata: true },
            });
            if (targetGuestMsg) {
              const prev = (targetGuestMsg.metadata as Record<string, unknown> | null) ?? {};
              await prisma.message.update({
                where: { id: targetGuestMsg.id },
                data: {
                  metadata: {
                    ...prev,
                    delegateSpeaker,
                  } as unknown as Prisma.InputJsonValue,
                },
              });
              console.log(
                `[negotiate/message] delegate-speaker attached | session=${sessionId} | kind=${delegateSpeaker.kind}${delegateSpeaker.name ? ` name=${delegateSpeaker.name}` : ""}`,
              );
            }
          } catch (e) {
            console.error("[negotiate/message] delegate-speaker write failed:", e);
          }
        }

        // Update session status from AI block, or fall back to thread status heuristic
        if (statusUpdate && VALID_STATUSES.includes(statusUpdate.status)) {
          await prisma.negotiationSession.update({
            where: { id: sessionId },
            data: {
              status: statusUpdate.status,
              statusLabel: statusUpdate.label,
            },
          });
        } else {
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
        }
      } catch (e) {
        console.error("[negotiate/message] onFinish error:", e);
      }
    },
  });

  return streamResult.toTextStreamResponse();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[negotiate/message] Unhandled error: ${err.message}`, err.stack);
    return new Response(
      JSON.stringify({ error: "Something went wrong", detail: err.message, retryable: true }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
