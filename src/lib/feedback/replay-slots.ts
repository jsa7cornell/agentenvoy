/**
 * Slot-computation replay for widget-display debugging.
 *
 * Widget-display bugs ("wrong slots offered", "today disappeared") need the
 * computed availability the guest saw at view time — NOT just the rule.
 * recentLinks[].rulesJson is the input; this is the output.
 *
 * Design: invoke `/api/negotiate/slots?sessionId=<id>` server-side with the
 * same code path the widget hits. No logic duplication — any change to the
 * scoring stack automatically shows up in replays.
 *
 * Called at bundle-build time (submit), not at mint time, so the replay
 * reflects state AS OF the filer's submit. Mint-time replay could drift (a
 * calendar event shifting between submit and mint would change the slots).
 *
 * Non-fatal on any failure — returns null and the bundle ships without a
 * replay slice. Agent still has rulesJson and filingContext to work with.
 */

export interface SlotsReplay {
  /** When this replay was computed (bundle-build time, not view time). */
  computedAt: string;
  /** `/api/negotiate/slots` sessionId that was probed. */
  sessionId: string;
  /** Grouped by YYYY-MM-DD in display-timezone. Empty object = no slots. */
  slotsByDay: Record<
    string,
    Array<{ start: string; end: string; score: number; isShortSlot?: boolean; isStretch?: boolean }>
  >;
  bilateralByDay?: Record<
    string,
    Array<{ start: string; end: string; color: "green" | "orange" }>
  >;
  timezone: string;
  hostTimezone?: string;
  duration?: number;
  minDuration?: number;
  isVip?: boolean;
  /** Best-effort note for the agent ("empty → no slots computed" vs. "fetch
   *  failed"). Lets the prompt/agent distinguish "widget showed nothing" from
   *  "we couldn't replay". */
  note?: string;
}

function resolveOrigin(explicit?: string | null): string | null {
  if (explicit) return explicit;
  const env = process.env.NEXTAUTH_URL;
  if (env) return env.replace(/\/+$/, "");
  return null;
}

export async function fetchSlotsReplay(params: {
  sessionId: string;
  origin?: string | null;
}): Promise<SlotsReplay | null> {
  const origin = resolveOrigin(params.origin);
  if (!origin) return null;

  const url = `${origin}/api/negotiate/slots?sessionId=${encodeURIComponent(params.sessionId)}`;
  const computedAt = new Date().toISOString();

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return {
        computedAt,
        sessionId: params.sessionId,
        slotsByDay: {},
        timezone: "",
        note: `replay fetch failed: HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      slotsByDay?: SlotsReplay["slotsByDay"];
      bilateralByDay?: SlotsReplay["bilateralByDay"];
      timezone?: string;
      hostTimezone?: string;
      duration?: number;
      minDuration?: number;
      isVip?: boolean;
    };
    return {
      computedAt,
      sessionId: params.sessionId,
      slotsByDay: json.slotsByDay ?? {},
      bilateralByDay: json.bilateralByDay,
      timezone: json.timezone ?? "",
      hostTimezone: json.hostTimezone,
      duration: json.duration,
      minDuration: json.minDuration,
      isVip: json.isVip,
      note:
        Object.keys(json.slotsByDay ?? {}).length === 0
          ? "slotsByDay empty — scoring returned no offerable slots"
          : undefined,
    };
  } catch (err) {
    return {
      computedAt,
      sessionId: params.sessionId,
      slotsByDay: {},
      timezone: "",
      note: `replay threw: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}
