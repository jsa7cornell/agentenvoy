import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { prisma } from "@/lib/prisma";
import { getUserTimezone } from "@/lib/timezone";

export interface ParsedRule {
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "allow" | "buffer" | "prefer" | "limit" | "business_hours" | "location" | "office_hours";
  timeStart?: string;
  timeEnd?: string;
  allDay?: boolean;
  daysOfWeek?: number[];
  effectiveDate?: string;
  expiryDate?: string;
  bufferMinutesBefore?: number;
  bufferMinutesAfter?: number;
  bufferAppliesTo?: string;
  businessHoursStart?: number; // hour 0-23, set when action is "business_hours"
  businessHoursEnd?: number;   // hour 0-23, set when action is "business_hours"
  locationLabel?: string;      // set when action is "location" — e.g. "Baja", "NYC"
  // Office hours fields — only set when action is "office_hours"
  officeHoursTitle?: string;        // defaults to "Office Hours" if unspecified
  officeHoursFormat?: "video" | "phone" | "in-person";
  officeHoursDurationMinutes?: number;
  priority: number;
  ambiguous?: boolean;
  interpretations?: string[];
  summary: string; // human-readable summary for confirmation card
}

// POST /api/tuner/parse-rule — parse free text into a structured rule
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { text, businessHoursStart, businessHoursEnd } = await req.json();
  if (!text?.trim()) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  // Canonical timezone — stored preference, never from body
  const userRow = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { preferences: true },
  });
  const tz = getUserTimezone(userRow?.preferences as Record<string, unknown> | null);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });

  const { text: llmResponse } = await generateText({
    model: envoyModel("claude-haiku-4-5-20251001"),
    system: `You parse natural language scheduling preferences into structured rules.
Today is ${today}. User's timezone is ${tz}.
Business hours: ${businessHoursStart ?? 9}:00 to ${businessHoursEnd ?? 18}:00.

Return ONLY valid JSON matching this schema — no markdown, no explanation:
{
  "originalText": "the user's input verbatim",
  "type": "ongoing|recurring|temporary|one-time",
  "action": "block|allow|buffer|prefer|limit|business_hours|location|office_hours",
  "timeStart": "HH:MM or null",
  "timeEnd": "HH:MM or null",
  "allDay": false,
  "daysOfWeek": [0-6] or null,
  "effectiveDate": "YYYY-MM-DD or null",
  "expiryDate": "YYYY-MM-DD or null",
  "bufferMinutesBefore": number or null,
  "bufferMinutesAfter": number or null,
  "bufferAppliesTo": "string or null",
  "businessHoursStart": number or null,
  "businessHoursEnd": number or null,
  "locationLabel": "string or null",
  "officeHoursTitle": "string or null",
  "officeHoursFormat": "video|phone|in-person or null",
  "officeHoursDurationMinutes": number or null,
  "priority": 1-5,
  "ambiguous": false,
  "interpretations": null,
  "summary": "Human-readable one-line summary of the rule"
}

Type rules:
- "ongoing": permanent rules with no expiry ("no meetings before 10am", "buffer 45min after in-person")
- "recurring": weekly repeating ("block Friday afternoons", "yoga Wednesday 7-9am")
- "temporary": date range ("block 9-10am this week", "no meetings Apr 14-18")
- "one-time": single date ("block today after 4pm", "no meetings April 10")

Action rules:
- "block": prevent scheduling during specific hours ("block Friday afternoons", "no meetings before 10am")
- "allow": explicitly permit scheduling ("Saturday calls OK before 2pm")
- "buffer": add time around events ("buffer 45min after in-person meetings")
- "prefer": soft preference, not a hard block ("prefer mornings for calls")
- "limit": restrict availability to ONLY the specified hours — blocks everything outside the window. Use when the user wants to narrow their availability for specific days, NOT block specific hours. Examples:
  - "only available Monday 12-3" → action: "limit", daysOfWeek: [1], timeStart: "12:00", timeEnd: "15:00"
  - "reduce Monday to just 12-3" → action: "limit", daysOfWeek: [1], timeStart: "12:00", timeEnd: "15:00"
  - "limit Tuesday availability to 10am-2pm" → action: "limit", daysOfWeek: [2], timeStart: "10:00", timeEnd: "14:00"
  - "Wednesdays only 9-12" → action: "limit", daysOfWeek: [3], timeStart: "09:00", timeEnd: "12:00"
- "location": set where the host is physically located for a given period. Creates a location override that displays as "Currently in X" in the widget and tells the agent the host is away from home base. Set locationLabel to the place name. Use effectiveDate + expiryDate for traveling periods, or leave undated for an ongoing override. Examples:
  - "I'm in Baja until April 20" → action: "location", locationLabel: "Baja", type: "temporary", expiryDate: "2026-04-20"
  - "traveling to NYC next week" → action: "location", locationLabel: "NYC", type: "temporary", effectiveDate: <next Monday>, expiryDate: <next Sunday>
  - "based in Lisbon" → action: "location", locationLabel: "Lisbon", type: "ongoing"
  - "in Tokyo through Friday" → action: "location", locationLabel: "Tokyo", type: "temporary", expiryDate: <this Friday>
  Do NOT use "location" for the user's home base — that's a separate default location setting. Only use when the user signals they are somewhere other than their usual place, OR explicitly says "set my location to X".
- "business_hours": change when the user is available for meetings. Use this when the input is about setting/changing GENERAL availability window (all days), work hours, or business hours. Set businessHoursStart and businessHoursEnd (hour 0-23). Examples:
  - "business hours 10-4" → action: "business_hours", businessHoursStart: 10, businessHoursEnd: 16
  - "available 9am to 5pm" → action: "business_hours", businessHoursStart: 9, businessHoursEnd: 17
  - "standard hours 10 to 4" → action: "business_hours", businessHoursStart: 10, businessHoursEnd: 16
  - "only take meetings 11-6" → action: "business_hours", businessHoursStart: 11, businessHoursEnd: 18
- "office_hours": create a public, shareable booking window with a fixed meeting format and duration. This is different from "limit" — limit narrows general availability, office_hours creates a specific surface anyone can book against (like a drop-in window for students, mentees, or sales intros). Extract these fields when present:
  - timeStart / timeEnd: the window the host is making bookable
  - daysOfWeek: which days the window is available
  - officeHoursTitle: the name the host gives this (e.g. "Mentor calls", "Sales intros"). If unspecified, leave null — a default of "Office Hours" will be applied.
  - officeHoursFormat: "video", "phone", or "in-person". If unspecified, leave null — the UI will ask.
  - officeHoursDurationMinutes: slot length in minutes. If unspecified, leave null — the UI will ask.
  Trigger phrases: "office hours", "drop-in hours", "open hours", "mentor hours", "booking window", "make bookable", "let people book", "set up office hours".
  Examples:
  - "office hours Tuesdays 2-4pm, 20 min video calls, mentor calls" → action: "office_hours", daysOfWeek: [2], timeStart: "14:00", timeEnd: "16:00", officeHoursTitle: "Mentor calls", officeHoursFormat: "video", officeHoursDurationMinutes: 20
  - "set up office hours Fridays 10-12" → action: "office_hours", daysOfWeek: [5], timeStart: "10:00", timeEnd: "12:00" (title/format/duration omitted — UI will ask)
  - "drop-in hours for students Wed 3-5, 15 min video" → action: "office_hours", daysOfWeek: [3], timeStart: "15:00", timeEnd: "17:00", officeHoursTitle: "Student drop-ins", officeHoursFormat: "video", officeHoursDurationMinutes: 15
  - "sales intros, 15 minutes, Tue and Thu mornings 9-11, phone" → action: "office_hours", daysOfWeek: [2, 4], timeStart: "09:00", timeEnd: "11:00", officeHoursTitle: "Sales intros", officeHoursFormat: "phone", officeHoursDurationMinutes: 15

Date conversion:
- Convert ALL relative dates to absolute YYYY-MM-DD using today's date.
- "today" = today's date
- "tomorrow" = today + 1
- "this week" = effective today, expires end of this week (Sunday)
- "next week" = effective next Monday, expires next Sunday
- Day names without "every"/"always" = the next occurrence of that day, one-time

Days of week: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

Time edge cases:
- "after 4pm" = timeStart "16:00", timeEnd "23:59"
- "before 10am" = timeStart "00:00", timeEnd "10:00"
- "morning" = timeStart "00:00", timeEnd "12:00"
- "afternoon" = timeStart "12:00", timeEnd "17:00"
- "evening" = timeStart "17:00", timeEnd "21:00"
- Full day blocks = allDay: true (no timeStart/timeEnd needed)

Ambiguity detection:
- If the input could mean BLOCK or ALLOW (e.g. "Saturday morning calls OK"), set ambiguous: true
- Provide 2-3 interpretations array with human-readable descriptions
- Still fill in your best-guess fields

Buffer rules:
- "buffer X min before/after Y" → action: "buffer", bufferMinutesBefore/After set, bufferAppliesTo set
- "f2f", "face to face", "in-person" → bufferAppliesTo: "in-person"
- "all meetings" → bufferAppliesTo: "all"

Summary should be a clean, unambiguous description like:
- "Block every Friday 12:00 PM - 6:00 PM"
- "45-min buffer before & after in-person meetings"
- "Block Apr 14 (all day)"
- "Allow Saturday before 2:00 PM for calls"
- "Limit Monday to 12:00 PM - 3:00 PM only"
- "Set business hours to 10:00 AM - 4:00 PM"
- "Currently in Baja until Apr 20"
- "Based in Lisbon (ongoing)"
- "Office hours: Mentor calls · Tuesdays 2:00–4:00 PM · 20-min video"
- "Office hours: Tuesdays 2:00–4:00 PM (title, format, and duration needed)"`,
    prompt: text.trim(),
  });

  try {
    const cleaned = llmResponse.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as ParsedRule;

    // Validate and sanitize
    const validFormats = ["video", "phone", "in-person"];
    const rule: ParsedRule = {
      originalText: text.trim(),
      type: (["ongoing", "recurring", "temporary", "one-time"].includes(parsed.type) ? parsed.type : "ongoing") as ParsedRule["type"],
      action: (["block", "allow", "buffer", "prefer", "limit", "business_hours", "location", "office_hours"].includes(parsed.action) ? parsed.action : "block") as ParsedRule["action"],
      timeStart: parsed.timeStart || undefined,
      timeEnd: parsed.timeEnd || undefined,
      allDay: parsed.allDay || false,
      daysOfWeek: Array.isArray(parsed.daysOfWeek) ? parsed.daysOfWeek.filter(d => d >= 0 && d <= 6) : undefined,
      effectiveDate: parsed.effectiveDate || undefined,
      expiryDate: parsed.expiryDate || undefined,
      bufferMinutesBefore: typeof parsed.bufferMinutesBefore === "number" ? parsed.bufferMinutesBefore : undefined,
      bufferMinutesAfter: typeof parsed.bufferMinutesAfter === "number" ? parsed.bufferMinutesAfter : undefined,
      bufferAppliesTo: parsed.bufferAppliesTo || undefined,
      businessHoursStart: typeof parsed.businessHoursStart === "number" ? parsed.businessHoursStart : undefined,
      businessHoursEnd: typeof parsed.businessHoursEnd === "number" ? parsed.businessHoursEnd : undefined,
      locationLabel: typeof parsed.locationLabel === "string" && parsed.locationLabel.trim() ? parsed.locationLabel.trim() : undefined,
      officeHoursTitle: typeof parsed.officeHoursTitle === "string" && parsed.officeHoursTitle.trim() ? parsed.officeHoursTitle.trim() : undefined,
      officeHoursFormat: (typeof parsed.officeHoursFormat === "string" && validFormats.includes(parsed.officeHoursFormat)) ? parsed.officeHoursFormat as ParsedRule["officeHoursFormat"] : undefined,
      officeHoursDurationMinutes: typeof parsed.officeHoursDurationMinutes === "number" && parsed.officeHoursDurationMinutes > 0 ? Math.round(parsed.officeHoursDurationMinutes) : undefined,
      priority: typeof parsed.priority === "number" ? Math.max(1, Math.min(5, parsed.priority)) : 3,
      ambiguous: parsed.ambiguous || false,
      interpretations: Array.isArray(parsed.interpretations) ? parsed.interpretations : undefined,
      summary: parsed.summary || text.trim(),
    };

    return NextResponse.json(rule);
  } catch (e) {
    console.error("[parse-rule] LLM parse failed:", e, "Raw:", llmResponse);
    return NextResponse.json({ error: "Failed to parse rule" }, { status: 500 });
  }
}
