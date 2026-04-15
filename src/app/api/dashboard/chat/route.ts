import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { streamText } from "ai";
import { envoyModel } from "@/lib/model";
import { getOrComputeSchedule } from "@/lib/calendar";
import { formatComputedSchedule, formatOfferableSlots } from "@/agent/composer";
import { getUserTimezone } from "@/lib/timezone";

const DASHBOARD_SYSTEM = `You are Envoy, the user's scheduling agent. You help them:
1. Create meeting links from natural language
2. Configure their scheduling preferences
3. View and manage their negotiations

CALENDAR AWARENESS:
You have access to the user's Google Calendar connection status and their upcoming availability.
- If the calendar IS connected, you can see their real availability and should reference it when creating links.
- If the calendar is NOT connected, let the user know — but DO NOT say you "can't access" it. Instead, explain that connecting Google Calendar helps Envoy propose real open times to invitees.
- Never claim you can see something you can't. Check the CONTEXT block for calendar status.

LINK TYPES:
- **Generic link**: /meet/[slug] — always-on, uses default preferences. Like a Calendly link. Already shown in the dashboard.
- **Contextual link**: /meet/[slug]/[code] — created per-invitee with specific topic, rules, format, timing constraints. Much more powerful.

WHEN TO CREATE A CONTEXTUAL LINK:
Any time the user mentions a specific person, topic, format preference, timing constraint, or any meeting-specific detail, you MUST create a contextual link. Only the generic link is appropriate for "give me a link anyone can use."

When the user describes a meeting, extract ALL of:
- Who: inviteeName, inviteeEmail
- What: topic/purpose
- When: preferred days, time windows, deadlines, flexibility level
- How: format (phone/video/in-person), duration
- Rules: constraints, things to avoid, conditional preferences (e.g. "Tuesday = phone only", "evening = suggest drinks at X")

Be thorough in extracting rules. If the user says "phone only since I'll be driving", capture BOTH the format constraint AND the reason (driving → no video). If they say "Friday is last resort", capture the priority level. These details shape the invitee experience.

IMPORTANT: When you create a link, include the structured data in a JSON block at the end of your message. Do NOT include a URL in your text — the UI will display the contextual URL automatically.

\`\`\`agentenvoy-action
{"action": "create_link", "inviteeEmail": "...", "inviteeName": "...", "topic": "...", "rules": {"preferredDays": ["Mon","Tue"], "lastResort": ["Fri"], "format": "...", "duration": 30, "dateRange": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}, "notes": "..."}}
\`\`\`

If the user just wants to update their default preferences:
\`\`\`agentenvoy-action
{"action": "update_preferences", "preferences": {...}}
\`\`\`

After creating a link, confirm what you captured and tell the user the link will appear above. Suggest they share the contextual link (not their generic link) since it carries all the meeting context.
`;

// POST /api/dashboard/chat
// Stream chat response for the dashboard agent
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { messages } = await req.json();

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      meetSlug: true,
      preferences: true,
      persistentKnowledge: true,
      upcomingSchedulePreferences: true,
      hostDirectives: true,
    },
  });

  // Check Google Calendar connection
  const account = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: "google" },
    select: { refresh_token: true, scope: true },
  });
  const hasCalendar = !!account?.refresh_token;

  // Fetch calendar context — same raw-event pipeline as deal room
  const userPrefs = user?.preferences as Record<string, unknown> | null;
  const tz = getUserTimezone(userPrefs);
  let availabilityContext = "";
  if (hasCalendar) {
    try {
      const schedule = await getOrComputeSchedule(session.user.id);
      if (schedule.connected) {
        availabilityContext = `\n${formatComputedSchedule(schedule.slots, tz, schedule.canWrite)}\n${formatOfferableSlots(schedule.slots, tz, schedule.canWrite)}`;
      } else {
        availabilityContext = "\nGoogle Calendar: CONNECTED but no events returned.";
      }
    } catch (e) {
      availabilityContext = `\nGoogle Calendar: CONNECTED but could not fetch events (${e instanceof Error ? e.message : "unknown error"}). The calendar connection exists but may need re-authorization.`;
    }
  } else {
    availabilityContext = "\nGoogle Calendar: NOT CONNECTED — the user has not granted calendar access. Suggest they connect it via the Connections menu in the header for smarter scheduling.";
  }

  // Knowledge base context
  let knowledgeContext = "";
  if (user?.persistentKnowledge) {
    knowledgeContext += `\nHost's persistent preferences:\n${user.persistentKnowledge}`;
  }
  if (user?.upcomingSchedulePreferences) {
    knowledgeContext += `\nHost's situational context:\n${user.upcomingSchedulePreferences}`;
  }

  const contextMessage = `User: ${user?.name || "User"}\nMeet slug: ${user?.meetSlug || "not set"}\nCurrent preferences: ${JSON.stringify(user?.preferences || {})}\nBase URL: ${process.env.NEXTAUTH_URL || "https://agentenvoy.ai"}${availabilityContext}${knowledgeContext}`;

  const result = streamText({
    model: envoyModel("claude-sonnet-4-6"),
    system: DASHBOARD_SYSTEM + "\n\nCONTEXT:\n" + contextMessage,
    messages,
  });

  return result.toTextStreamResponse();
}
