import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule } from "@/agent/composer";
import { generateCode } from "@/lib/utils";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import { sanitizeHistory, roleSummary } from "@/lib/conversation";

const CHANNEL_SYSTEM = `You are Envoy, the user's scheduling assistant. You look at their calendar and other context to smartly infer and offer up time slots when people want to schedule with them. You operate in their feed — a chat interface where scheduling threads appear as inline cards.

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

AFTER CREATING A THREAD:
Default assumption: the host will share the link themselves. Just confirm it's done and offer email as an option.
Good: "Done — drop Nathan's email if you'd like me to send it directly."
Good: "Card's ready. Share the link when you want, or give me Nathan's email and I'll send it."
NEVER say: "You sharing the link with him directly?" or "Sharing the link with Nathan yourself?" — never ask, never phrase it as a question. The host always shares it themselves unless they say otherwise.

WHEN TO CREATE — PREVIEW FIRST:
Before creating a thread, show the host a quick preview of what you'll offer the guest. The host should sanity-check the windows before the link goes live.

Flow:
1. Parse the request (who, format, duration, timing).
2. Look at the scored schedule and pick the windows you'd propose to the guest.
3. Show a concise preview: "Here's what I'd offer Danny — 30-min video call: Wed 9 AM–noon, Thu 9 AM–5 PM, Fri morning PT. Look good?"
4. Wait for the host to approve or adjust.
5. On approval ("yes", "looks good", "go", thumbs up, or similar), create the thread immediately.
6. If the host adjusts ("skip Wednesday", "add Monday morning", "make it 45 min"), update and either re-preview or create if the adjustment is clear.

Keep the preview to 2-3 sentences — the host wants a quick gut check, not a detailed analysis. Show the time windows, format, and duration. Reference the scored schedule but present it as broad windows, not per-slot scores.

SKIP THE PREVIEW only when the host explicitly says to ("just set it up", "create it", "don't ask"). In that case, create immediately and confirm what you assumed.

Never block creation on email — that can always come after.

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
- update_knowledge: Save to knowledge base → {"action":"update_knowledge","params":{"persistent":"...","situational":"...","currentLocation":{"label":"Baja","until":"2026-04-14"}}}

Rules:
- Always include the action block when the user's intent is clear
- You can include MULTIPLE action blocks in one message
- Always confirm what you're about to do in your conversational text BEFORE the action block
- If the user's intent is ambiguous, ask for clarification instead of acting
- Use session IDs from the "Active sessions" context below
- For create_link, use the action block above (not the agentenvoy-action format) — both work but this is preferred for new links

TONE:
- Conversational, efficient, no filler. You know the user's calendar — reference it naturally.
- Warm but professional. Match the user's energy.
- No emoji unless the user uses them first.
- No filler phrases ("I'd be happy to help!", "Great question!"). Get to the point.

FORMATTING:
- Do NOT use markdown bold (**text**), italics (*text*), or headers (#). The chat UI renders plain text.
- Use dashes and line breaks for structure. No asterisks around session titles or times.
- Use concise time formatting: "9–11 AM PT" not "9:00 AM – 11:00 AM PT". Drop :00 for round hours. Collapse shared AM/PM in ranges.

AVAILABILITY:
You receive a pre-scored schedule — every 30-min slot has a protection score from -1 to 5. These scores already account for calendar events, blocked windows, and preferences. You do NOT need to cross-reference manually.

Protection scores:
- -2: Exclusive — ONLY these slots are available for this event. Never propose other times.
- -1: Preferred — host actively wants to fill these. Offer first.
- 0: Explicitly free (declined invites). Offer freely.
- 1: Open business hours. Offer freely.
- 2: Soft hold (Focus Time, etc.) [low confidence]. Available with light friction.
- 3: Moderate friction (tentative meeting, recurring 1:1) [low confidence]. Available but not ideal.
- 4: Protected (confirmed meeting, blocked window, weekend). Do NOT offer to guests. Only the host can override.
- 5: Immovable (flights, sacred items). Never offer.

Low-confidence scores (2, 3) are starting points — adjust based on context:
- Phone format reduces friction by 1 point (can take calls during soft holds).
- VIP guest or high-priority meeting reduces friction by 1 point.
- But never present a protected (4+) slot as available without the host explicitly overriding it.

Non-primary calendars (tagged "from Family Calendar" or similar): these are OTHER PEOPLE'S events. They provide household context but do not block the host's time.
currentLocation in preferences is the authoritative source for where the host is.

PROPOSING TIMES FOR CUSTOM EVENTS:
When the host asks you to find time for a specific meeting, be an active collaborator:
- Lead with preferred (-1) and open (0-1) slots first.
- If tight, offer soft holds (2-3) with the tradeoff named ("10–11 is clear, or 9–10 if you skip surf").
- If the host is already active during a normally protected time, note that — "since you're up now, 8–9 could work too if morning is flexible."
- Propose times directly — don't ask if they want you to "set it up." Example: "10–11 is your cleanest window" not "want me to set it up for 10?"
- When creating a thread, you can mark specific slots as preferred (score -1) using slotOverrides in the link rules. This makes the widget highlight those slots for the guest.

UPDATING KNOWLEDGE:
When the host tells you something about their schedule, preferences, or context, save it using the update_knowledge action:
- Durable patterns (how they work, what they prefer) → persistent
- Non-time situational context (mood, goals, relationships, temporary non-schedule rules) → situational
- Current location (when host is away from home base) → currentLocation: { label: "Baja", until: "2026-04-14" }
  - Always save this when the host mentions they're traveling or away. It prevents in-person meeting proposals.
  - Set until to the date they return (ISO format). Pass null to clear it when they're home.
- RULE: Any time commitment → blockedWindows, NEVER just situational text.
  If the host says they're doing something at specific times, that MUST become a blockedWindow so the slots engine and your availability reasoning both respect it. Situational text is for non-time context only.
  - "I'm surfing 8-10 every morning this week" → blockedWindows: [{ start: "08:00", end: "10:00", days: ["Mon","Tue","Wed","Thu","Fri"], label: "surfing", expires: "2026-04-14" }]
  - "I'm in Baja through the 14th" → currentLocation + situational (no time block needed)
  - "I never take calls before 9 AM" → persistent + blockedWindows: [{ start: "00:00", end: "09:00", days: ["Mon","Tue","Wed","Thu","Fri"], label: "no calls before 9" }]
  - "Katie is evaluating AgentEnvoy" → situational (no time component)
- Only include the field(s) you're updating — partial updates are fine

ONBOARDING CALIBRATION:
If the context says "Calibration: NEVER", run this exercise before handling scheduling requests. This is a conversational calibration — not a quiz. Walk through it naturally.

1. Welcome and explain how Envoy works:
   - "Hey! I'm Envoy. I build your availability from two sources: your Google Calendar and your preferences here. Every 30-minute slot gets a protection score — from -2 (exclusive) to 5 (immovable). Guests only see the open slots; everything else is hidden."
   - "The more context I have, the smarter I am. Calendar events are automatic. But things not on your calendar — workouts, commutes, personal time — I need you to tell me about. I'll save those as blocked windows so they're protected just like calendar events."
   - "Let me look at your week and ask a few questions to get calibrated."

2. Confirm timezone: "What timezone are you usually in? I'll use that as your default for all scheduling." Save to persistent knowledge. If their calendar already has a timezone set, confirm it: "It looks like your calendar is set to Pacific time — is that right?"

3. Look at the host's calendar for the next 7 days. Pick 3-4 events that represent real judgment calls and ask about them:
   - A soft block: "You have [Focus Time / Hold / Block] on [day]. Should I treat that as available for meetings, or protect it?" (This determines whether it stays score 2 or goes to 4.)
   - An evening/weekend slot: "Your [day] evening is open. Should I offer evening slots, or keep those off-limits?"
   - A movable meeting: "You have a [1:1 / recurring meeting] on [day]. If someone important needed that slot, could I suggest rescheduling it?"

4. Ask about shadow calendar items: "Anything this week I should protect that isn't on your calendar? Workouts, family time, personal stuff? I'll save these as blocked windows so they show up as protected in both the calendar widget and my scheduling."
   - IMPORTANT: When the host mentions ANY recurring time commitment (surfing, gym, commute), immediately save it as a blockedWindow using update_knowledge. This is critical — if it's not a blockedWindow, it won't show on the calendar widget or affect scoring.

4b. If non-primary calendars are visible (e.g., Family Calendar), ask: "I can see your Family Calendar — should I treat those as your commitments, or just as context for other people's schedules?" Save the answer to persistent knowledge.

5. Ask about format: "When you're driving or commuting, are you open to phone calls?" and "For in-person meetings, how much travel buffer do you usually need?"

6. Ask about overall posture: "Overall — should I be generous with your availability and offer whatever's open, or more conservative and check with you before offering times?"

7. Save everything you learn using the update_knowledge action. Durable patterns (general context) go in persistent, this-week items (upcoming schedule context) go in situational. Any time commitment MUST also be a blockedWindow — never just text.

Keep it conversational — you can combine questions, skip obvious ones, and adapt based on what the calendar shows. The goal is 3-5 exchanges, not a 20-question survey.

CHECK-IN CALIBRATION:
If the context says calibration was 10+ days ago, or if you notice the host has been overriding your proposals frequently, offer a light check-in:

1. "Hey — it's been a while since we synced on your schedule. Mind if I do a quick check-in?"
   Or, if context-triggered: "I noticed your calendar looks different this week. Want to walk through how I should handle it?"
2. Focus on 2-3 things: new recurring events, upcoming travel/context shifts, and whether your current approach is working.
3. "Anything coming up in the next couple weeks I should know about? Travel, deadlines, things not on the calendar?"
4. Save updates using the update_knowledge action.

Don't force the check-in if the host wants to do something else — it's a suggestion, not a gate.`;


export async function POST(req: NextRequest) {
  try {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
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

  // Scored schedule — pre-computed slots with protection scores
  let calendarConnected = false;
  const hostPrefs = user.preferences as Record<string, unknown> | null;
  const tz =
    (hostPrefs?.timezone as string) ??
    ((hostPrefs?.explicit as Record<string, unknown> | undefined)?.timezone as string) ??
    "America/Los_Angeles";
  try {
    const schedule = await getOrComputeSchedule(user.id);
    if (schedule.connected) {
      calendarConnected = true;
      contextParts.push(formatComputedSchedule(schedule.slots, tz, schedule.canWrite));
    }
  } catch (e) {
    console.log("Schedule context error:", e);
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

  // --- Channel session lifecycle (3-day rolling window) ---
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  let activeSession = await prisma.channelSession.findFirst({
    where: { channelId: channel.id, closed: false },
    orderBy: { startedAt: "desc" },
  });

  let previousSummary: string | null = null;

  if (activeSession && activeSession.expiresAt < now) {
    // Session expired — close it with a summary and start fresh
    // Generate summary from recent messages
    const recentMsgs = await prisma.channelMessage.findMany({
      where: {
        channelId: channel.id,
        createdAt: { gte: activeSession.startedAt },
      },
      orderBy: { createdAt: "asc" },
      take: 30,
    });
    const summaryText = recentMsgs
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
      .join("\n");

    // Quick LLM summary
    try {
      const summaryResult = await generateText({
        model: envoyModel("claude-sonnet-4-6"),
        system: "Summarize this scheduling conversation in 2-3 sentences. Focus on what was decided, what's pending, and any preferences learned.",
        messages: [{ role: "user", content: summaryText }],
      });
      previousSummary = summaryResult.text;
      await prisma.channelSession.update({
        where: { id: activeSession.id },
        data: { closed: true, summary: previousSummary },
      });
    } catch {
      await prisma.channelSession.update({
        where: { id: activeSession.id },
        data: { closed: true },
      });
    }
    activeSession = null;
  }

  if (!activeSession) {
    // Start new session
    activeSession = await prisma.channelSession.create({
      data: {
        channelId: channel.id,
        expiresAt: new Date(Date.now() + THREE_DAYS_MS),
      },
    });
  } else {
    // Extend rolling window
    await prisma.channelSession.update({
      where: { id: activeSession.id },
      data: { expiresAt: new Date(Date.now() + THREE_DAYS_MS) },
    });
  }

  // Add previous session summary to context if starting fresh
  if (previousSummary) {
    contextParts.push(`Previous session summary: ${previousSummary}`);
  }

  // Get conversation history — hard cap at 3 days to keep thread context lean
  const threeDaysAgo = new Date(Date.now() - THREE_DAYS_MS);
  const historyStart = activeSession.startedAt > threeDaysAgo ? activeSession.startedAt : threeDaysAgo;
  const history = await prisma.channelMessage.findMany({
    where: {
      channelId: channel.id,
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
    console.warn(`[channel/chat] History sanitized | userId=${user.id} | ${warnings.join("; ")}`);
  }

  // Generate response
  let text: string;
  try {
    const result = await generateText({
      model: envoyModel("claude-sonnet-4-6"),
      system: CHANNEL_SYSTEM + "\n\nCONTEXT:\n" + contextParts.join("\n"),
      messages,
    });
    text = result.text;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(
      `[channel/chat] AI call failed | userId=${user.id} | messageCount=${messages.length} | roles=${roleSummary(messages)} | error=${err.message}`
    );
    return NextResponse.json(
      { error: "AI service temporarily unavailable", detail: err.message, retryable: true },
      { status: 502 }
    );
  }

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

  // If actions executed and AI didn't provide conversational text, build a summary
  if (actionResults.length > 0) {
    const summary = actionResults
      .map((r) => `${r.success ? "\u2713" : "\u2717"} ${r.message}`)
      .join("\n");
    if (!displayText) {
      displayText = summary;
    } else {
      // Save action results as a separate system message
      await prisma.channelMessage.create({
        data: { channelId: channel.id, role: "system", content: summary },
      });
    }
  }

  // Final fallback — never save or return empty content
  const finalText = displayText || text || "Done.";

  // Save envoy response
  await prisma.channelMessage.create({
    data: { channelId: channel.id, role: "envoy", content: finalText },
  });

  // Return as stream-compatible format (matching existing pattern)
  const encoded = JSON.stringify(finalText);
  return new Response(`0:${encoded}\n`, {
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
