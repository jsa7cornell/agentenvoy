/**
 * Fan-out a Primary posture change to all reusable variance links.
 *
 * Called from the "Apply to all reusable links?" prompt that appears after
 * a host saves a Primary edit. The save itself lands at
 * `/api/me/scheduling-defaults` (writes `User.preferences`). This endpoint
 * is the optional second step: when the host confirms, copy the same
 * fields into every variance link's `parameters.*`.
 *
 * GET  → preview which variance links would change. Returns
 *        `{ affected: [{ id, name }, ...] }` so the prompt can surface the
 *        first few names ("Customer 1:1s, Piano Lessons, +N more"). Cap
 *        applied client-side.
 * POST → execute the fan-out. Body: partial `PostureUpdate` matching the
 *        fields the host changed. Internally calls `applyPostureToScope`
 *        with scope `"all"` (which also re-writes Primary with the same
 *        idempotent values — see `applyPostureToScope` for the rationale
 *        on the harmless double-write). Returns counts.
 *
 * Decision references:
 *  - `proposals/2026-05-02_per-link-config-storage-and-scoring-link-scope` §2.5
 *  - `proposals/2026-05-02_primary-as-posture-and-reusable-link-propagation` §2.2
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  applyPostureToScope,
  findAffectedVariances,
  type PostureUpdate,
} from "@/lib/links/scope";

const ALLOWED_DURATIONS = new Set([15, 30, 45, 60, 90]);
const ALLOWED_BUFFERS = new Set([0, 5, 10, 15, 30]);
const ALLOWED_FORMATS = new Set(["video", "phone", "in-person"]);
const ALLOWED_EVENINGS = new Set(["protected", "vip_only", "open"]);

function parseMinuteOfDay(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.trunc(v);
  if (n < 0 || n > 1440) return undefined;
  return n;
}

/** Coerce a raw payload into a sanitized `PostureUpdate`. Unknown / invalid
 *  fields are dropped silently — the caller can validate the result. */
function parsePostureUpdate(raw: Record<string, unknown>): PostureUpdate {
  const out: PostureUpdate = {};
  if (raw.hoursStartMinutes !== undefined) {
    const v = parseMinuteOfDay(raw.hoursStartMinutes);
    if (v !== undefined) out.hoursStartMinutes = v;
  }
  if (raw.hoursEndMinutes !== undefined) {
    const v = parseMinuteOfDay(raw.hoursEndMinutes);
    if (v !== undefined) out.hoursEndMinutes = v;
  }
  if (raw.duration !== undefined) {
    const n = Number(raw.duration);
    if (Number.isFinite(n) && ALLOWED_DURATIONS.has(n)) out.duration = n;
  }
  if (raw.bufferMinutes !== undefined) {
    const n = Number(raw.bufferMinutes);
    if (Number.isFinite(n) && ALLOWED_BUFFERS.has(n)) out.bufferMinutes = n;
  }
  if (typeof raw.format === "string" && ALLOWED_FORMATS.has(raw.format)) {
    out.format = raw.format;
  }
  if (typeof raw.eveningsPosture === "string" && ALLOWED_EVENINGS.has(raw.eveningsPosture)) {
    out.eveningsPosture = raw.eveningsPosture as PostureUpdate["eveningsPosture"];
  }
  if (Array.isArray(raw.daysOfWeek)) {
    const arr = (raw.daysOfWeek as unknown[])
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    out.daysOfWeek = arr;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Build a posture update from the query string. Fields not present in
  // the query default to "match nothing" — i.e. no variance links flagged
  // as affected. Caller passes the fields they're about to change.
  const params = req.nextUrl.searchParams;
  const raw: Record<string, unknown> = {};
  for (const k of [
    "hoursStartMinutes",
    "hoursEndMinutes",
    "duration",
    "bufferMinutes",
    "format",
    "eveningsPosture",
  ]) {
    const v = params.get(k);
    if (v !== null) raw[k] = Number.isFinite(Number(v)) ? Number(v) : v;
  }
  const daysParam = params.get("daysOfWeek");
  if (daysParam) {
    raw.daysOfWeek = daysParam.split(",").map((s) => Number(s));
  }

  const updates = parsePostureUpdate(raw);
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ affected: [] });
  }

  const affected = await findAffectedVariances(updates, session.user.id);
  return NextResponse.json({ affected });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates = parsePostureUpdate(body);
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No recognized posture fields in payload" },
      { status: 400 },
    );
  }

  const result = await applyPostureToScope(updates, "all", session.user.id);

  // Invalidate the host's computed schedule so the next read picks up the
  // new compiled state. Variance links don't cache, but Primary does.
  const { invalidateSchedule } = await import("@/lib/calendar");
  await invalidateSchedule(session.user.id);

  return NextResponse.json({
    ok: true,
    varianceWrites: result.varianceWrites,
    primaryWritten: result.primaryWritten,
  });
}
