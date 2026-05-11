import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { AgentContext, extractAvailabilitySummary } from "@/agent/agent-runner";
import { getOrComputeSchedule } from "@/lib/calendar";
import type { CalendarContext } from "@/lib/calendar";
import type { ScoredSlot } from "@/lib/scoring";
import { applyEventOverrides } from "@/lib/scoring";
import { computeThreadStatus } from "@/lib/thread-status";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import { sanitizeHistory } from "@/lib/conversation";
import { mergeChannelMetadata } from "@/lib/channel/metadata-schema";
import type { ChannelMessageMetadata } from "@/lib/channel/metadata-schema";
import { parseLinkParameters } from "@/lib/link-parameters";
import { z } from "zod";
import { tool } from "ai";
import {
  recordAvailabilityTool,
  proposeConvergenceTool,
  collectSuggestionTool,
  recordAvailabilityInput,
  proposeConvergenceInput,
  collectSuggestionInput,
} from "@/agent/modules/group-coordination/tools";
import type { ModuleContext } from "@/agent/modules/types";

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

  // Build and sanitize conversation history.
  //
  // PR3 of the 2026-04-27 chat-decisioning-layer-redesign: dropped the
  // legacy `[HOST]:` prefix injection. Audience is now selected by the
  // `isHost` flag threading down to composer.ts, which loads the
  // role-aware composer (`dealroom-host-composer.md` vs. `dealroom-guest-
  // composer.md`). The composer no longer sniffs a textual prefix from
  // history — role is passed explicitly per proposal §2.6.
  const rawHistory = session.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  rawHistory.push({
    role: messageRole,
    content,
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
    const schedule = await getOrComputeSchedule(session.hostId, { link: session.link ?? null });
    if (schedule.connected) {
      calendarContext = {
        connected: true,
        events: schedule.events,
        calendars: schedule.calendars,
        timezone: schedule.timezone,
        canWrite: schedule.canWrite,
      };
      scoredSlots = schedule.slots;

      // Apply link-level filters (availability, dateRange, blockedRanges,
      // lastResort) so the LLM sees the same filtered set as the widget and
      // greeting.
      const lr = parseLinkParameters(session.link.parameters);
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
  let groupCoordinationSessionId: string | undefined;

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

    // Resolve the GroupCoordination row for this link (keyed to the host's
    // NegotiationSession, not the participant's). Used to pass the right
    // sessionId to record_availability / propose_convergence tool calls.
    // Lazy-create: links created before this feature shipped won't have a row.
    let gc = await prisma.groupCoordination.findFirst({
      where: { session: { linkId: session.linkId } },
      select: { sessionId: true },
    });
    if (!gc) {
      // Find the host's original session for this link (earliest, host-owned).
      const hostSession = await prisma.negotiationSession.findFirst({
        where: { linkId: session.linkId, hostId: session.hostId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (hostSession) {
        gc = await prisma.groupCoordination.upsert({
          where: { sessionId: hostSession.id },
          create: { sessionId: hostSession.id },
          update: {},
          select: { sessionId: true },
        });
      }
    }
    groupCoordinationSessionId = gc?.sessionId;
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
    guestTimezone: session.guestTimezone || undefined,
    // Viewer-authoritative tz — drives dual-tz follow-up rendering + the
    // deterministic parser when guest messages reference bare times.
    // Decisions #8 and #9 of the 2026-04-21 guest-tz-ux-three-primitives.
    viewerTimezone: session.viewerTimezone,
    // Current turn's guest message — fed to the parser only when dual-tz is
    // active. Host turns (messageRole === "host") skip the parser because
    // the host is presumed to speak in host tz, not viewer tz.
    guestMessage: messageRole === "guest" ? content : undefined,
    topic: session.link.topic || undefined,
    rules: parseLinkParameters(session.link.parameters),
    calendarContext,
    scoredSlots,
    hostPersistentKnowledge: (session.host as { persistentKnowledge?: string }).persistentKnowledge,
    hostUpcomingSchedulePreferences: (session.host as { upcomingSchedulePreferences?: string }).upcomingSchedulePreferences,
    isGroupEvent: isGroupEvent || undefined,
    eventParticipants,
    conversationHistory: history,
    // Guest-negotiated values — inject as [LOCKED] GROUND TRUTH so Envoy
    // doesn't re-open already-agreed activity/location.
    negotiatedActivity: (session as Record<string, unknown>).negotiatedActivity as string | null ?? null,
    negotiatedLocation: (session as Record<string, unknown>).negotiatedLocation as string | null ?? null,
    negotiatedFormat: (session as Record<string, unknown>).negotiatedFormat as string | null ?? null,
    // Host-offered activity menu from link rules.
    activityOptions: parseLinkParameters(session.link.parameters).activityOptions ?? null,
    // PR3: select the deal-room host vs. guest composer in composer.ts.
    isHost,
    groupCoordinationSessionId,
    // F2 of proposal 2026-05-04_update-time-action-state-drift. When the
    // session has a live calendar event (calendarEventId set), surface that
    // to the composer so it doesn't treat a re-time-in-flight session as a
    // fresh-from-scratch negotiation. priorAgreedTime is the value cleared
    // by the most recent update_time; today the row doesn't preserve it
    // explicitly, so we pass session.agreedTime which is non-null only on
    // status="agreed" — for "retime_proposed" sessions priorAgreedTime is
    // null today (a future schema change could persist the prior time, but
    // F15 ships without it; the calendarEventId alone is sufficient signal).
    sessionLiveEvent: session.calendarEventId
      ? {
          status: session.status,
          calendarEventId: session.calendarEventId,
          priorAgreedTime: session.agreedTime
            ? session.agreedTime.toISOString()
            : null,
        }
      : null,
  };

  console.log(`[negotiate/message] start | session=${sessionId} | role=${messageRole} | slots=${scoredSlots.length} | history=${history.length}`);

  const { streamAgentResponse } = await import("@/agent/agent-runner");
  // Captured via onInvocation; used to snapshot the prompt that produced
  // this turn's response for feedback-pipeline debug reads.
  const promptSnapshotEnabled = process.env.PROMPT_SNAPSHOT_ENABLED !== "false";
  let invocationInfo: { systemPrompt: string; modelId: string } | null = null;

  // Tool registry — guest-side composer gets `get_matched_availability` plus,
  // for group events, the three group-coordination tools (record_availability,
  // propose_convergence, collect_suggestion). These persist participant windows
  // and synthesize overlap. ComposerTool.execute takes (input, ctx) but ctx is
  // voided in all three — wrap each in tool() to match the AI SDK ToolSet shape.
  // Host composer + greeting path stay tool-less per the B2 scoping decision
  // (proposals/2026-04-29_bilateral-and-picker-unified-execution-plan_decided-2026-04-29.md §7).
  let tools: import("@/agent/tools/registry").ToolRegistry | undefined;
  if (!isHost) {
    const { buildGetMatchedAvailabilityTool } = await import(
      "@/agent/tools/get-matched-availability"
    );
    tools = {
      get_matched_availability: buildGetMatchedAvailabilityTool(sessionId),
    };

    if (isGroupEvent && groupCoordinationSessionId) {
      const gcCtx = {} as ModuleContext;
      tools = {
        ...tools,
        record_availability: tool({
          description: recordAvailabilityTool.description,
          inputSchema: recordAvailabilityInput,
          execute: async (input: z.infer<typeof recordAvailabilityInput>) =>
            recordAvailabilityTool.execute(input, gcCtx),
        }),
        propose_convergence: tool({
          description: proposeConvergenceTool.description,
          inputSchema: proposeConvergenceInput,
          execute: async (input: z.infer<typeof proposeConvergenceInput>) =>
            proposeConvergenceTool.execute(input, gcCtx),
        }),
        collect_suggestion: tool({
          description: collectSuggestionTool.description,
          inputSchema: collectSuggestionInput,
          execute: async (input: z.infer<typeof collectSuggestionInput>) =>
            collectSuggestionTool.execute(input, gcCtx),
        }),
      };
    }
  }

  const streamResult = await streamAgentResponse(context, {
    tools,
    onInvocation(info) {
      invocationInfo = info;
    },
    async onFinish({ text: responseText, toolInvocations }) {
      try {
        const responseLen = responseText?.length || 0;
        if (responseLen === 0) {
          console.warn(`[negotiate/message] empty response | session=${sessionId}`);
        }
        if (toolInvocations.length > 0) {
          console.log(
            `[negotiate/message] tool calls | session=${sessionId} | ${toolInvocations
              .map((t) => `${t.name}${t.error ? "(err)" : ""}`)
              .join(",")}`,
          );
        }

        // Parse and execute [ACTION] blocks
        const actions = parseActions(responseText);
        let actionResults: Awaited<ReturnType<typeof executeActions>> = [];
        // Always log action count for diagnostics — the deal-room route has
        // no post-stream guards (unlike the module-runner path), so when the
        // LLM narrates a write effect without emitting an [ACTION] block, the
        // only signal is in logs. 2026-05-11 — added to investigate report
        // "Envoy says 'Got it — updated to X' but nothing changes".
        if (actions.length > 0) {
          console.log(`[negotiate/message] actions | session=${sessionId} | ${actions.map(a => a.action).join(",")}`);
          actionResults = await executeActions(actions, session.hostId, { sessionId });
          const failed = actionResults
            .map((r, i) => ({ name: actions[i]?.action ?? "?", r }))
            .filter((x) => !x.r.success);
          if (failed.length > 0) {
            console.warn(
              `[negotiate/message] action failures | session=${sessionId} | ${failed
                .map((f) => `${f.name}:${f.r.message}`)
                .join(" | ")}`,
            );
          }
        } else {
          // No actions parsed. Check whether prose narrated a write effect
          // anyway — the canned dealroom-guest acknowledgment phrases
          // ("Got it — updated to X") are the production-observed shape.
          const NARRATION_WITHOUT_EMIT = /\bgot\s+it\s*[—\-,:]\s*(?:updated|changed|locked|set|switched|moved|rescheduled|cancell?ed)\b/i;
          if (NARRATION_WITHOUT_EMIT.test(responseText)) {
            console.warn(
              `[negotiate/message] narration-without-emit | session=${sessionId} | role=${messageRole} | text="${responseText.slice(0, 200).replace(/\s+/g, " ")}"`,
            );
          }
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

        // Compose the administrator-turn metadata: parsed actions + their
        // results, plus a prompt snapshot so feedback bundles can show the
        // instructions that produced this turn. Host-only — deal-room guest
        // render already filters these via GUEST_METADATA_ALLOWLIST.
        const additions: Partial<ChannelMessageMetadata> = {};
        if (actions.length > 0) {
          additions.actions = actions.map((a) => ({
            action: a.action,
            params: (a.params ?? {}) as Record<string, unknown>,
          }));
          additions.actionResults = actions.map((a, i) => {
            const r = actionResults[i];
            if (!r) {
              return { action: a.action, success: false, message: "no_result" };
            }
            return {
              action: a.action,
              success: r.success,
              message: r.message,
              ...(r.data ? { data: r.data } : {}),
            };
          });
        }
        if (promptSnapshotEnabled && invocationInfo) {
          additions.promptContext = {
            systemPrompt: invocationInfo.systemPrompt,
            modelId: invocationInfo.modelId,
          };
        }
        // Persist tool invocations alongside the assistant turn so feedback
        // bundles can replay what the model called mid-turn. Empty when no
        // tools were registered (PR-0a is plumbing only — first consumer
        // is PR-A2's `get_matched_availability`).
        if (toolInvocations.length > 0) {
          additions.toolInvocations = toolInvocations.map((t) => ({
            name: t.name,
            input: t.input as Prisma.InputJsonValue,
            ...(t.output !== undefined ? { output: t.output as Prisma.InputJsonValue } : {}),
            ...(t.error ? { error: t.error } : {}),
            ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
          }));
        }
        const adminMetadata = mergeChannelMetadata(null, additions);
        const hasMetadata = Object.keys(adminMetadata).length > 0;

        // Save the response (stripped of all blocks)
        await prisma.message.create({
          data: {
            sessionId,
            role: "administrator",
            content: displayText,
            ...(hasMetadata
              ? { metadata: adminMetadata as Prisma.InputJsonValue }
              : {}),
          },
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

        // Update session status from AI block, or fall back to thread status heuristic.
        //
        // Invariant (2026-04-29): `agreedTime` / `agreedFormat` are valid only
        // when status === "agreed". VALID_STATUSES intentionally excludes
        // "agreed" — only confirm-pipeline writes that. Any STATUS_UPDATE
        // landing here is therefore a transition AWAY from agreed (or never
        // entered agreed). Clear the agreed-state fields so the deal-room
        // doesn't enter "pending confirm" mode against a stale slot. Surfaced
        // by feedback cmokr58r2 — guest re-opened a confirmed negotiation,
        // LLM flipped status back to "proposed", agreedTime stayed stale,
        // picker became non-clickable.
        if (statusUpdate && VALID_STATUSES.includes(statusUpdate.status)) {
          await prisma.negotiationSession.update({
            where: { id: sessionId },
            data: {
              status: statusUpdate.status,
              statusLabel: statusUpdate.label,
              agreedTime: null,
              agreedFormat: null,
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
