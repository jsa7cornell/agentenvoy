/**
 * Server-side product-event tracker (F2 revised — self-hosted Supabase
 * table, not PostHog). Call this from server routes + server components
 * when a meaningful funnel/state transition happens.
 *
 * Hard rules enforced here (so they're enforced by construction, not by
 * convention at every callsite):
 *   - `name` must be in the allowlist at src/lib/analytics/events.ts.
 *     Unknown names throw in dev, are swallowed in prod so an analytics
 *     miss never takes a request down.
 *   - `props` values must be scalar: string | number | boolean | null.
 *     No nested objects, no arrays. Strings are truncated at 200 chars.
 *     This is the guardrail that prevents message bodies or calendar
 *     titles from leaking into the event stream via a careless caller.
 *   - Insert failures are swallowed with console.error. Analytics must
 *     never become a point of failure for the request hot path.
 *
 * `userId` is raw (not hashed) — internal stack already sees it and the
 * stream stays on our own Postgres. Hashing would add indirection
 * without reducing blast radius.
 */

import { prisma } from "@/lib/prisma";
import { isAllowedEventName, type ProductEventName } from "./events";

const MAX_STRING_LEN = 200;
const MAX_PROP_KEYS = 16;

export type ScalarPropValue = string | number | boolean | null;
export type EventProps = Record<string, ScalarPropValue>;

export interface TrackInput {
  name: ProductEventName | string;
  userId?: string | null;
  sessionId?: string | null;
  props?: EventProps;
}

function sanitizeProps(props: EventProps | undefined): EventProps | null {
  if (!props) return null;
  const entries = Object.entries(props);
  if (entries.length === 0) return null;
  const sanitized: EventProps = {};
  let keysWritten = 0;
  for (const [key, value] of entries) {
    if (keysWritten >= MAX_PROP_KEYS) break;
    const t = typeof value;
    if (value === null || t === "number" || t === "boolean") {
      sanitized[key] = value;
      keysWritten += 1;
      continue;
    }
    if (t === "string") {
      const s = value as string;
      sanitized[key] = s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) : s;
      keysWritten += 1;
      continue;
    }
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `track: non-scalar prop at key "${key}" (got ${t}). Allowed: string | number | boolean | null`,
      );
    }
    console.error("[analytics.track] dropping non-scalar prop", { key, type: t });
  }
  return Object.keys(sanitized).length === 0 ? null : sanitized;
}

export async function track(input: TrackInput): Promise<void> {
  if (!isAllowedEventName(input.name)) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `track: event name "${input.name}" is not in the allowlist (see src/lib/analytics/events.ts)`,
      );
    }
    console.error("[analytics.track] unknown event name, dropping", { name: input.name });
    return;
  }

  let props: EventProps | null;
  try {
    props = sanitizeProps(input.props);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") throw err;
    console.error("[analytics.track] prop sanitize failed, dropping event", {
      name: input.name,
      err,
    });
    return;
  }

  try {
    await prisma.productEvent.create({
      data: {
        name: input.name,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        props: (props ?? undefined) as never,
      },
    });
  } catch (err) {
    console.error("[analytics.track] insert failed (non-blocking)", {
      name: input.name,
      err,
    });
  }
}

/** Fire-and-forget variant for hot paths where awaiting adds latency. */
export function trackAsync(input: TrackInput): void {
  void track(input).catch(() => {});
}
