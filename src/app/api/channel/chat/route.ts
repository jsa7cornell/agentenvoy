import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateText, streamText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule, formatOfferableSlots } from "@/agent/composer";
import { generateCode } from "@/lib/utils";
import { getUserTimezone } from "@/lib/timezone";
import { parseActions, executeActions, stripActionBlocks } from "@/agent/actions";
import { normalizeLinkRules } from "@/lib/scoring";
import { sanitizeHistory } from "@/lib/conversation";
import { needsActionEmissionRetry, ACTION_EMISSION_RETRY_PROMPT } from "@/agent/action-emission-guard";
import { readFileSync } from "fs";
import { join } from "path";

// Load persona once at module scope (same pattern as composer.ts)
let personaPlaybook = "";
try {
  personaPlaybook = readFileSync(join(process.cwd(), "src", "agent", "playbooks", "persona.md"), "utf-8");
} catch (e) {
  console.error("Failed to load persona.md for channel chat:", e);
}

const CHANNEL_SYSTEM = `${personaPlaybook ? personaPlaybook + "\n\n---\n\n" : ""}You operate in the user's feed — a chat interface where scheduling threads appear as inline cards.

ACTION EMISSION IS MANDATORY (read this first, every turn):
When you do ANYTHING that changes state — create a thread/link, expand one, place or release a hold, archive, cancel, update preferences, save guest info, confirm a time — you MUST emit the corresponding agentenvoy-action block in the SAME message as your conversational text. A sentence like "set up", "ready to share", "I've archived it", or "done" is NOT doing it. Only the action block does the thing. If you describe an action without emitting the block, nothing happens — the user sees your prose but no card, no change in their dashboard.

Before you send any response that claims something was created, set up, archived, cancelled, scheduled, or otherwise acted on: stop and check that your message contains the matching \`\`\`agentenvoy-action\`\`\` fence (or [ACTION] block). If it doesn't, add it before sending. This is non-negotiable.

The server will detect intent-without-emit and force a retry, so you'll pay the latency cost anyway. Emit the block the first time.

CORE BEHAVIOR:
1. Create scheduling threads when the user describes a meeting they want to set up
2. Give status updates on active threads when asked
3. Take actions on existing threads ("archive the Bryan meeting", "cancel the Noah meeting", "change Sarah's meeting to video")
4. Be contextual — reference the user's calendar, active threads, and preferences

CREATING THREADS:
When the user wants to schedule something, extract what you can: who (name), what (topic), when (preferences), format (phone/video/in-person), duration, urgency.
Then emit an action block:
\`\`\`agentenvoy-action
{"action":"create_thread","inviteeName":"Sarah Chen","topic":"Q2 Roadmap","format":"phone","duration":30,"urgency":"asap","rules":{"preferredDays":["Tue"],"lastResort":["Fri"],"isVip":true}}
\`\`\`
- "urgency" is optional. Use "asap" if the user says soon/asap/urgent/high-pri. Use "this-week" or "next-week" if they give a timeframe. Omit if no urgency specified.
- "isVip" is a binary flag. Set isVip: true when the host signals importance ("important client", "investor", "CEO", "board", "make room for X", "clear my calendar") OR when there's international context ("she's in Europe", "he's in Tokyo") — international ALONE is enough. Default is NOT VIP; omit the field for routine meetings. VIP does NOT auto-unlock protected hours; it signals Envoy to proactively ask the host about opening up stretch hours and to reach into stretch options on guest pushback. Never emit "priority" or priority tier strings.

IMPORTANT — email is OPTIONAL. The inviteeName is the only required field. Do NOT ask for email unless the user wants Envoy to send the invite directly. If the user just says "set up a meeting with Bryan", create the thread with just the name — they can share the link themselves.
If the user provides an email, include "inviteeEmail" in the action block. If not, omit it.

THREAD CREATION FLOW (hardcoded — follow exactly):

Step 1: Host makes request ("set up a call with Bob", "schedule coffee with Sarah").
Step 2: Create the thread IMMEDIATELY. Do NOT preview first, do NOT wait for approval. Emit the action block in your FIRST response. The card appears instantly.
Step 3: In the SAME message as the action block, tell the host what you're offering the guest. Be specific — mention the time windows, format, and duration. Then add: "Share his email if you want me to send it, otherwise it's ready to share. Let me know any tweaks."

Example response (Step 2+3 combined):
"Set up a 30-min video call with Bob. I'm offering Tue and Wed mornings, plus Thu afternoon PT. Share his email if you want me to send it, or just share the link. Let me know any tweaks."

Step 4: If the host gives feedback ("skip Tuesday", "make it 45 min", "add Friday"), update the thread rules and confirm the change. No re-preview needed — just confirm what changed.

Rules:
- ALWAYS create the card on the first message. Never ask "want me to set it up?" or preview without creating.
- ALWAYS summarize what you're offering alongside the card.
- ALWAYS end with "let me know any tweaks" or similar — one short line, not a question.
- Do NOT ask about email unprompted. Mention it exactly once as "share his email if you want me to send it" in the initial creation message. After that, never bring it up again.
- If the host provides email in the original request, include it in the action block and skip the email mention.

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
- create_link: Create a new invite → {"action":"create_link","params":{"inviteeName":"...","topic":"...","format":"...","duration":45,"minDuration":30,"isVip":true,"preferredDays":["Mon"],"dateRange":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"},"location":"Coupa Cafe, Palo Alto"}}
  - Set minDuration when the host agrees a shorter meeting is acceptable if the full duration isn't available (e.g. "45 min but 30 is fine if needed"). The guest sees dashed-border pills for short windows and Envoy negotiates the final length in conversation.
  - Set location when the host names a specific place or venue ("at Coupa Cafe", "meet at my office", "Blue Bottle on Spring Street"). Required for in-person meetings where the host has named a venue. Pass the full name the host gave — include the city if they mentioned it, otherwise pass what they said verbatim. This flows into the deal-room greeting ("...meeting at Coupa Cafe") and auto-populates the calendar event location at confirm time. Omit for video/phone calls unless the host wants a specific address on the invite.
  - Set preferredDays as short day-name array when the host names specific day(s) ("Monday mornings", "Tuesdays and Thursdays") → ["Mon"] or ["Tue","Thu"]. Omit if host said "any" or gave no day preference.
  - Set dateRange whenever the host names a SPECIFIC date or window ("next Monday", "this Thursday", "the week of May 5", "sometime in May"). Use absolute YYYY-MM-DD dates from the Today context — both start and end inclusive. For a single-day target like "next Monday", set start and end to the same date. Omit dateRange if the host said "ongoing", "any time", or gave no temporal anchor. If you set preferredDays because the host said "next Monday", you MUST also set dateRange to that Monday's date — otherwise the guest will see every Monday for months.
  - **Set guestPicks when the host defers details to the guest.** Phrases like "he knows the time and place", "she picks the day", "whatever works for them", "let them choose the duration", "he suggests the spot" — DO NOT pick values yourself. Fields (all optional; include what the host deferred):
    - guestPicks.window {startHour, endHour} — "morning" is {7,12}, "afternoon" is {12,17}, "evening" is {17,21}. Anchored to the host's tz, 24h clock, endHour exclusive. Omit the field and the system will parse the phrase from your text.
    - guestPicks.date: true — guest picks which day (still respects dateRange).
    - guestPicks.duration: true — any duration; OR duration: [60, 90] — one of these.
    - guestPicks.location: true — guest names the place.
  - **Set guestGuidance for flavor and suggestions — NOT constraints.**
    - guestGuidance.suggestions.locations [...] — rendered as "a few places John suggested" in the greeting. Guest can still pick their own.
    - guestGuidance.suggestions.durations [...] — informational chips in the greeting.
    - guestGuidance.tone (<=200 chars) — a short flavor line paraphrased into the greeting intro ("It's his first week back."). Sanitized: URLs/emails/phones stripped, injection markers like "[SYSTEM:" auto-rejected. Never Envoy's instructions — it's quoted context, not commands.
  - **Reflect the deferral in your reply.** When the host defers, your confirmation MUST NOT pin specifics the host left open.
    - Good: "Link ready — Mike picks the time this afternoon, the duration, and the spot. Share his email and I'll send it."
    - Bad: "Offering 10:30 AM–4 PM PDT; 60-min video call; location TBD."
  - Example — host says: book welcome-back lunch with Mike this week, he picks the day and place but suggest Soquel Demo, Wilder, or UCSC trails, 60 or 90 min, it's his first week back.
    → create_link with rules.guestPicks: {date: true, duration: [60, 90], location: true} and rules.guestGuidance: {suggestions: {locations: ["Soquel Demo Forest", "Wilder Ranch", "UCSC trails"]}, tone: "It's his first week back."}
- expand_link: Widen an EXISTING link's offering window AFTER the host has confirmed specific hours → {"action":"expand_link","params":{"code":"hhkkkw","preferredTimeStart":"06:00"}} or {"action":"expand_link","params":{"code":"hhkkkw","allowWeekends":true}}. Use this when the host says "open up Katherine's link to 6am" or "let's include weekends for Jack". Never infer hours the host didn't name.
- hold_slot: Place a 48h tentative hold on a specific stretch slot. VIP + specific-request only → {"action":"hold_slot","params":{"sessionId":"cmxxxx","slotStart":"2026-04-21T14:00:00Z","slotEnd":"2026-04-21T14:30:00Z"}}
- release_hold: Release an active hold → {"action":"release_hold","params":{"sessionId":"cmxxxx"}}
- update_knowledge: Save to knowledge base (who the host is, how they work, scheduling context) → {"action":"update_knowledge","params":{"persistent":"...","situational":"...","currentLocation":{"label":"Baja","until":"2026-04-14"}}}
  - This writes to the host's free-text knowledge base. Use for personality, preferences, context, travel, work style. Do NOT use for structured settings like phone numbers, video providers, or zoom links — use update_meeting_settings for those.
- update_meeting_settings: Save phone number, video provider, zoom link, or default duration to profile settings → {"action":"update_meeting_settings","params":{"phone":"(818) 625-4743"}}
  - Use when the host provides a phone number, zoom link, video preference, or default meeting length. Saves to structured settings (not free text), so these values auto-populate on calendar invites at confirm time.
  - You can set multiple fields: {"phone":"...","videoProvider":"zoom","zoomLink":"https://zoom.us/j/...","defaultDuration":45}

Rules:
- Always include the action block when the user's intent is clear
- You can include MULTIPLE action blocks in one message
- Always confirm what you're about to do in your conversational text BEFORE the action block. Be specific about WHERE the data is being saved: "Saving your phone number to your profile settings" (not vague "saved" or "noted"). The user should know the difference between profile settings (structured, auto-populates invites) vs knowledge base (free-text memory that informs how Envoy negotiates).
- If the user's intent is ambiguous, ask for clarification instead of acting
- Use session IDs from the "Active sessions" context below
- For create_link, use the action block above (not the agentenvoy-action format) — both work but this is preferred for new links

TONE:
- Conversational, efficient, no filler. You know the user's calendar — reference it naturally.
- Warm but professional. Match the user's energy.
- No emoji unless the user uses them first.
- No filler phrases ("I'd be happy to help!", "Great question!"). Get to the point.
- Use plain language. Don't say "card's up" or "here's the card" — say "set up" or "created". The user may not know what "card" means.

FORMATTING:
- Do NOT use markdown bold (**text**), italics (*text*), or headers (#). The chat UI renders plain text.
- Use dashes and line breaks for structure. No asterisks around session titles or times.
- Use concise time formatting: "9–11 AM PT" not "9:00 AM – 11:00 AM PT". Drop :00 for round hours. Collapse shared AM/PM in ranges.

PREFERENCES ARE LIVE:
Your context (calendar, preferences, blocked windows, knowledge base) is fetched fresh on every message. When the host says "check again", "try again", "I changed my schedule", or similar, the system automatically force-refreshes from Google Calendar upstream. You already have the latest data — just re-read your context and respond with the updated view. Never tell the host your context is stale or ask them to explain what changed.

AVAILABILITY:
You receive a pre-scored schedule — every 30-min slot has a protection score from -1 to 5. These scores already account for calendar events, blocked windows, and preferences. You do NOT need to cross-reference manually.

Protection scores:
- -2: Exclusive — ONLY these slots are available for this event. Never propose other times.
- -1: Preferred — host actively wants to fill these. Offer first.
- 0: Explicitly free (declined invites). Offer freely.
- 1: Open business hours. Offer freely.
- 2: Soft hold (Focus Time, etc.) [low confidence]. Available with light friction.
- 3: Moderate friction (tentative meeting, recurring 1:1) [low confidence]. Available but not ideal.
- 4: Protected. Real calendar meetings are ALWAYS at score 4+ and are HARD — never offer them regardless of priority. Soft protections at score 4 (weekend off-hours, weekday deep off-hours, host's implicit blocked windows like morning routines) are reachable ONLY by VIP links and are pre-filtered for you by the composer — if you see them in your offerable list it's because the link is VIP and the host has cleared space.
- 5: Immovable (flights, sacred items, all-day events, blackout days). Never offer, never navigable.

The composer already filters slots by link priority before you see them. If a slot is in your OFFERABLE SLOTS list, it's safe to offer — you don't need to second-guess the protection score. Soft holds (2,3) may arrive with phrasing hints like "host making room" when the link is high/vip; lean into that framing rather than presenting them as generic "flexible" slots.

Non-primary calendars (tagged "from Family Calendar" or similar): these are OTHER PEOPLE'S events. They provide household context but do not block the host's time.
The active Location rule (from structuredRules) is the authoritative source for where the host is right now. If no location rule is active, the defaultLocation from preferences is home base.

PROPOSING TIMES FOR CUSTOM EVENTS:
When the host asks you to find time for a specific meeting, be an active collaborator:
- Lead with preferred (-1) and open (0-1) slots first.
- If tight, offer soft holds (2-3) with the tradeoff named ("10–11 is clear, or 9–10 if you skip surf").
- If the host is already active during a normally protected time, note that — "since you're up now, 8–9 could work too if morning is flexible."
- Propose times directly — don't ask if they want you to "set it up." Example: "10–11 is your cleanest window" not "want me to set it up for 10?"
- When creating a thread, you can mark specific slots as preferred (score -1) using slotOverrides in the link rules. This makes the widget highlight those slots for the guest.

OFFERABLE SLOTS RULE (CRITICAL):
Your context includes an OFFERABLE SLOTS section — a pre-formatted list of times guests will see. When creating threads or describing availability to the host:
- ONLY reference times from the OFFERABLE SLOTS list. Do NOT invent times or compute availability yourself.
- Copy day-of-week and dates exactly from the DATE REFERENCE. Never calculate what day a date falls on.
- When telling the host what you're offering a guest, match the OFFERABLE SLOTS — those are the actual windows guests see.
- When a meeting has a specific duration (e.g. 45 min), only mention windows long enough to fit it. You can read the window length directly from the start/end times — "3:30–4 PM" is 30 min and cannot host a 45-min meeting. Do not mention it, do not offer it.
- If a day has open time but NO window long enough for the meeting duration, do NOT silently skip it. Tell the host: "Thursday only has a 30-min gap — want me to skip it, or would 30 min work if we can't find 45?" If the host says 30 min is OK, set both duration: 45 and minDuration: 30 in the create_link params. The widget will show those short slots with a dashed border so the guest knows it's a tight window, and Envoy will negotiate the final length in conversation.

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
NOTE: Most new users complete the guided onboarding at /onboarding, which handles initial setup. This calibration is a FALLBACK for users who somehow reach the feed without completing onboarding. If "Calibration: NEVER" appears in context, gently suggest they complete setup first: "It looks like you haven't finished setting up yet. Want me to walk through a quick calibration here, or you can head to /onboarding for the full guided setup?" If they want to proceed here, run this exercise. This is a conversational calibration — not a quiz. Walk through it naturally.

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
    contextParts.push(formatComputedSchedule(scheduleResult.slots, tz, scheduleResult.canWrite));
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

      const actionRegex = /```agentenvoy-action\s*\n?([\s\S]*?)\n?```/g;
      const actionMatch = actionRegex.exec(displayText);
      displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

      if (actionMatch) {
        try {
          const action = JSON.parse(actionMatch[1]);

          if (action.action === "create_thread") {
            const code = generateCode();
            const title = action.topic
              ? `${action.topic} — ${action.inviteeName || "Invitee"}`
              : `Catch up — ${action.inviteeName || "Invitee"}`;

            const linkRules = normalizeLinkRules({
              ...(action.rules || {}),
              ...(action.format ? { format: action.format } : {}),
              ...(action.duration ? { duration: action.duration } : {}),
              ...(action.urgency ? { urgency: action.urgency } : {}),
            });
            const link = await prisma.negotiationLink.create({
              data: {
                userId: safeUser.id,
                type: "contextual",
                slug: safeUser.meetSlug || "",
                code,
                inviteeEmail: action.inviteeEmail || null,
                inviteeName: action.inviteeName || null,
                topic: action.topic || null,
                rules: linkRules as Parameters<typeof prisma.negotiationLink.create>[0]["data"]["rules"],
              },
            });

            const negotiationSession = await prisma.negotiationSession.create({
              data: {
                linkId: link.id,
                hostId: safeUser.id,
                type: "calendar",
                status: "active",
                title,
                statusLabel: `Waiting for ${action.inviteeName || "invitee"}`,
                format: action.format || null,
                duration: action.duration || (hostPrefs?.defaultDuration as number) || 30,
              },
            });

            await prisma.channelMessage.create({
              data: {
                channelId: safeChannel.id,
                role: "envoy",
                content: displayText || `I've set up a thread for ${action.inviteeName || "your meeting"}.`,
                threadId: negotiationSession.id,
              },
            });
            return;
          }
        } catch (e) {
          console.error("Failed to parse/execute legacy action:", e);
        }
      }

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
