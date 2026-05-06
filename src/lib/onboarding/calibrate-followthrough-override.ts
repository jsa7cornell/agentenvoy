/**
 * Calibrate-followthrough dispatch override predicate.
 *
 * Architecture (2026-05-06 choice-panel refactor):
 *   - `/api/onboarding/calibrate-opener` writes seed-info only.
 *   - If the host picks path (b) "Customize my preferences", the client
 *     POSTs to `/api/onboarding/calibrate-proceed` which writes the
 *     calibrate-opener message.
 *   - The host's first reply after the opener should force-route to
 *     `recalibrate.first-time`.
 *   - If the host picks path (a) "Good enough to start", no opener is
 *     written and subsequent messages should NOT be force-routed.
 *
 * Therefore this predicate matches ONLY `subkind === "calibrate-opener"`.
 * Seed-info alone must not trigger the override — that would incorrectly
 * force-route path (a) users who already indicated they don't want the
 * full calibration arc.
 *
 * The N-message lookback (default 5) is kept for robustness: if future
 * system/composer messages are interleaved between the opener and the
 * host's reply, we still detect the opener within the window.
 *
 * History of changes:
 *   Hotfix-1 (2026-05-05): introduced, matched calibrate-opener only.
 *   Hotfix-2 (2026-05-05): broke — seed-info was written after opener with
 *     an identical createdAt (Postgres now() = transaction start). Widened
 *     to match either subkind.
 *   Hotfix-3 (2026-05-05): widened to look at last N messages + match either
 *     subkind. Fixed ordering with explicit JS timestamps.
 *   Choice-panel refactor (2026-05-06): reverted to calibrate-opener only.
 *     Seed-info is now written first; opener is written lazily on path (b).
 *     Seed-info alone must not trigger the override.
 *
 * The 30-minute time window stays as a backstop.
 */
import type { Prisma } from "@prisma/client";
import { parseChannelMessageMetadata } from "@/lib/channel/metadata-schema";

export const CALIBRATE_FOLLOWTHROUGH_SUBKINDS = [
  "calibrate-opener",
] as const;

export type CalibrateFollowthroughSubkind =
  (typeof CALIBRATE_FOLLOWTHROUGH_SUBKINDS)[number];

export const CALIBRATE_FOLLOWTHROUGH_WINDOW_MS = 30 * 60 * 1000;
export const CALIBRATE_FOLLOWTHROUGH_LOOKBACK = 5;

export interface CalibrateFollowthroughCandidate {
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}

/**
 * Returns true when the most-recent N envoy messages contain a
 * calibrate-opener message AND the most-recent such message landed within
 * the time window. Seed-info alone does NOT trigger the override.
 *
 * Pass envoy messages ordered MOST-RECENT-FIRST. Non-calibrate envoy messages
 * interleaved among the lookback window are ignored — the override fires as
 * long as a calibrate-* message is found within the lookback. The route is
 * separately responsible for not re-running this once a host turn has been
 * processed (in practice that's automatic: once the composer responds, its
 * response is the most-recent envoy turn and won't carry a calibrate-* subkind).
 */
export function shouldForceCalibrateFirstTime(
  recentEnvoyMessages: readonly CalibrateFollowthroughCandidate[],
  now: number = Date.now(),
  lookback: number = CALIBRATE_FOLLOWTHROUGH_LOOKBACK,
  windowMs: number = CALIBRATE_FOLLOWTHROUGH_WINDOW_MS,
): boolean {
  const slice = recentEnvoyMessages.slice(0, lookback);
  for (const msg of slice) {
    if (!msg.metadata) continue;
    const meta = parseChannelMessageMetadata(msg.metadata) as Record<
      string,
      unknown
    >;
    const subkind = typeof meta.subkind === "string" ? meta.subkind : null;
    if (
      subkind &&
      (CALIBRATE_FOLLOWTHROUGH_SUBKINDS as readonly string[]).includes(subkind)
    ) {
      const ageMs = now - msg.createdAt.getTime();
      if (ageMs <= windowMs) {
        return true;
      }
    }
  }
  return false;
}
