import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";

export interface ParsedRule {
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "allow" | "buffer" | "prefer" | "limit" | "business_hours";
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

  const { text, timezone, businessHoursStart, businessHoursEnd } = await req.json();
  if (!text?.trim()) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const tz = timezone ?? "America/Los_Angeles";
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
  "action": "block|allow|buffer|prefer|limit|business_hours",
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
- "business_hours": change when the user is available for meetings. Use this when the input is about setting/changing GENERAL availability window (all days), work hours, or business hours. Set businessHoursStart and businessHoursEnd (hour 0-23). Examples:
  - "business hours 10-4" → action: "business_hours", businessHoursStart: 10, businessHoursEnd: 16
  - "available 9am to 5pm" → action: "business_hours", businessHoursStart: 9, businessHoursEnd: 17
  - "standard hours 10 to 4" → action: "business_hours", businessHoursStart: 10, businessHoursEnd: 16
  - "only take meetings 11-6" → action: "business_hours", businessHoursStart: 11, businessHoursEnd: 18

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
- "Set business hours to 10:00 AM - 4:00 PM"`,
    prompt: text.trim(),
  });

  try {
    const cleaned = llmResponse.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as ParsedRule;

    // Validate and sanitize
    const rule: ParsedRule = {
      originalText: text.trim(),
      type: (["ongoing", "recurring", "temporary", "one-time"].includes(parsed.type) ? parsed.type : "ongoing") as ParsedRule["type"],
      action: (["block", "allow", "buffer", "prefer", "limit", "business_hours"].includes(parsed.action) ? parsed.action : "block") as ParsedRule["action"],
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
