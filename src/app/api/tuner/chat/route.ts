import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule } from "@/agent/composer";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import { sanitizeHistory, roleSummary } from "@/lib/conversation";
import { getUserTimezone } from "@/lib/timezone";

const TUNER_SYSTEM = `You are Envoy, operating inside the Availability Tuner. The user is viewing a weekly calendar overlay that shows their Google Calendar events alongside your scored availability slots. Your job is to help them understand and adjust their availability.

CORE BEHAVIOR:
1. Explain why specific slots have certain scores — reference calendar events, blocked windows, and preferences
2. Accept preference changes and save them using update_knowledge
3. Distinguish between general preference changes (persistent) and schedule-specific changes (situational/blockedWindows)
4. Be specific about what you changed and why it will affect their availability

EXPLAINING SCORES:
When the user asks about a time slot, reference:
- The protection score (-2 to 5) and what it means
- Which calendar events overlap with that slot
- Which blocked windows or preferences affect it
- Whether it's a hard block (score 4-5) or soft hold (score 2-3)

Protection scores:
- -2: Exclusive — only these slots offered
- -1: Preferred — offer these first
- 0: Explicitly free (declined invite)
- 1: Open business hours
- 2: Soft hold (Focus Time, tentative) — available with light friction
- 3: Moderate friction (tentative meeting, recurring 1:1) — not ideal
- 4: Protected (confirmed meeting, blocked window, weekend) — off limits
- 5: Immovable (flights, sacred items) — never offer

SAVING CHANGES:
Use the update_knowledge action when the user wants to change their availability:
- Durable patterns (how they work, what they prefer) → persistent
- Near-term schedule context (this week, next week) → situational
- RULE: Any time commitment → blockedWindows, NEVER just situational text
  Examples:
  - "Keep Friday afternoons free" → blockedWindows: [{ start: "12:00", end: "18:00", days: ["Fri"], label: "Friday afternoons free" }]
  - "I'm surfing 8-10 every morning" → blockedWindows: [{ start: "08:00", end: "10:00", days: ["Mon","Tue","Wed","Thu","Fri"], label: "surfing" }]
  - "Open up Saturday mornings" → persistent: mention Saturday morning availability
- Current location (traveling or away from home base) → currentLocation: { label: "Baja", until: "2026-04-14" } — this creates a location rule on the Availability page with automatic expiry.

After saving, tell the user to check the calendar view — it will refresh automatically with the updated scores.

FEEDBACK ROUTING:
If the user gives feedback about how AgentEnvoy itself should work (not their personal availability), note it clearly:
"That's a great suggestion for how AgentEnvoy could work differently. I've noted it — the team will review it."
Do NOT try to implement platform-level changes through preferences.

TONE:
- Conversational, efficient, no filler. Reference the calendar naturally.
- No emoji unless the user uses them first.
- No markdown bold, italics, or headers. Plain text only.
- Use concise time formatting: "9-11 AM PT" not "9:00 AM - 11:00 AM PT".

ACTIONS:
[ACTION]{"action":"update_knowledge","params":{"persistent":"...","situational":"...","blockedWindows":[...],"currentLocation":{...}}}[/ACTION]

Only include the fields you're updating — partial updates are fine.`;

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
        preferences: true,
        persistentKnowledge: true,
        upcomingSchedulePreferences: true,
        hostDirectives: true,
      },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const body = await req.json();
    const { message, weekStart } = body;

    // Get or create channel (shared with dashboard feed)
    let channel = await prisma.channel.findUnique({ where: { userId: user.id } });
    if (!channel) {
      channel = await prisma.channel.create({ data: { userId: user.id } });
    }

    // Save user message
    await prisma.channelMessage.create({
      data: { channelId: channel.id, role: "user", content: message },
    });

    // Build context
    const contextParts: string[] = [];
    contextParts.push(`User: ${user.name || "User"}`);

    // Schedule context
    const hostPrefs = user.preferences as Record<string, unknown> | null;
    const tz = getUserTimezone(hostPrefs);

    try {
      const schedule = await getOrComputeSchedule(user.id);
      if (schedule.connected) {
        contextParts.push(formatComputedSchedule(schedule.slots, tz, schedule.canWrite));

        // Add raw events for the viewed week so Envoy can reference specific meetings
        if (weekStart) {
          const ws = new Date(weekStart + "T00:00:00");
          const we = new Date(ws);
          we.setDate(ws.getDate() + 7);
          const weekEvents = schedule.events
            .filter((e) => {
              const eStart = new Date(e.start).getTime();
              const eEnd = new Date(e.end).getTime();
              return eEnd > ws.getTime() && eStart < we.getTime();
            })
            .slice(0, 40);

          if (weekEvents.length > 0) {
            const eventLines = weekEvents.map((e) => {
              const start = new Date(e.start).toLocaleString("en-US", {
                weekday: "short", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit", timeZone: tz,
              });
              const end = new Date(e.end).toLocaleString("en-US", {
                hour: "numeric", minute: "2-digit", timeZone: tz,
              });
              let line = `- ${e.summary} (${start} - ${end})`;
              if (e.responseStatus === "declined") line += " [DECLINED]";
              if (e.responseStatus === "tentative") line += " [TENTATIVE]";
              if (e.isRecurring) line += " [recurring]";
              if (e.attendeeCount && e.attendeeCount > 2) line += ` [${e.attendeeCount} attendees]`;
              return line;
            });
            contextParts.push(`Calendar events for viewed week:\n${eventLines.join("\n")}`);
          }
        }
      }
    } catch (e) {
      console.log("Tuner schedule context error:", e);
    }

    // Knowledge base
    if (user.persistentKnowledge) {
      contextParts.push(`Host's persistent preferences:\n${user.persistentKnowledge}`);
    }
    if (user.upcomingSchedulePreferences) {
      contextParts.push(`Host's situational context:\n${user.upcomingSchedulePreferences}`);
    }
    if (user.hostDirectives && (user.hostDirectives as string[]).length > 0) {
      contextParts.push(`Host directives:\n${(user.hostDirectives as string[]).map((d) => `- ${d}`).join("\n")}`);
    }

    // Week context
    if (weekStart) {
      const ws = new Date(weekStart + "T12:00:00");
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      contextParts.push(`User is viewing the week of ${fmt(ws)} - ${fmt(we)}, ${ws.getFullYear()}`);
    }

    // Current time
    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: tz,
    });
    contextParts.push(`Current time: ${timeStr}`);

    // Blocked windows context
    const explicit = (hostPrefs?.explicit as Record<string, unknown>) || {};
    const blockedWindows = explicit.blockedWindows as Array<Record<string, unknown>> | undefined;
    if (blockedWindows && blockedWindows.length > 0) {
      const bwLines = blockedWindows.map((bw) => {
        let line = `- ${bw.label || "Unnamed"}: ${bw.start}-${bw.end}`;
        if (bw.days) line += ` (${(bw.days as string[]).join(", ")})`;
        if (bw.expires) line += ` [expires ${bw.expires}]`;
        return line;
      });
      contextParts.push(`Active blocked windows:\n${bwLines.join("\n")}`);
    }

    // Get conversation history (3-day window)
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const threeDaysAgo = new Date(Date.now() - THREE_DAYS_MS);
    const history = await prisma.channelMessage.findMany({
      where: {
        channelId: channel.id,
        createdAt: { gte: threeDaysAgo },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    history.reverse();

    const { messages, warnings } = sanitizeHistory(
      history.map((m) => ({ role: m.role, content: m.content })),
      ["envoy", "assistant"]
    );
    if (warnings.length > 0) {
      console.warn(`[tuner/chat] History sanitized | userId=${user.id} | ${warnings.join("; ")}`);
    }

    // Generate response
    let text: string;
    try {
      const result = await generateText({
        model: envoyModel("claude-sonnet-4-6"),
        system: TUNER_SYSTEM + "\n\nCONTEXT:\n" + contextParts.join("\n"),
        messages,
      });
      text = result.text;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(
        `[tuner/chat] AI call failed | userId=${user.id} | messageCount=${messages.length} | roles=${roleSummary(messages)} | error=${err.message}`
      );
      return NextResponse.json(
        { error: "AI service temporarily unavailable", detail: err.message, retryable: true },
        { status: 502 }
      );
    }

    // Parse and execute actions
    const actions = parseActions(text);
    let actionExecuted = false;
    if (actions.length > 0) {
      const results = await executeActions(actions, user.id);
      actionExecuted = results.some((r) => r.success);
    }

    // Strip action blocks from displayed text
    let displayText = stripActionBlocks(text);

    // Also strip legacy action blocks if any
    displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

    const finalText = displayText || "Done.";

    // Save envoy response
    await prisma.channelMessage.create({
      data: { channelId: channel.id, role: "envoy", content: finalText },
    });

    return NextResponse.json({ message: finalText, actionExecuted });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`[tuner/chat] Unhandled error: ${err.message}`, err.stack);
    return NextResponse.json(
      { error: "Something went wrong", detail: err.message, retryable: true },
      { status: 500 }
    );
  }
}
