/**
 * Calibrate-followthrough dispatch override predicate.
 *
 * After the picker submit, `/api/onboarding/calibrate-opener` writes two
 * Envoy messages in this order:
 *   1. `subkind: "calibrate-seed-info"` (earlier createdAt — FIRST in feed)
 *   2. `subkind: "calibrate-opener"`    (later createdAt   — SECOND in feed)
 *
 * The host's first reply post-picker should force-route to
 * `recalibrate.first-time` so the multi-action-emit fidelity check + first-time
 * fragment fire. The dispatch route in `app/api/channel/chat/route.ts`
 * imports this predicate and applies the override before the dispatch chain.
 *
 * **Hotfix-1 (2026-05-05)** introduced the override checking ONLY for
 * `subkind === "calibrate-opener"` on the single most-recent envoy turn.
 *
 * **Hotfix-2 (2026-05-05)** added the seed-info message — but seed-info ended
 * up MORE RECENT than the opener, making the most-recent envoy turn
 * `calibrate-seed-info`. The Hotfix-1 predicate missed it; the override
 * stopped firing; user replies routed to `manage_setup` and emitted phantom
 * `create_bookable_link` actions. Production report `cmotkhjwa000lj7qmg0kx53qi`.
 *
 * **Hotfix-3 (2026-05-05)** widens the predicate two ways:
 *   1. Match EITHER `calibrate-seed-info` OR `calibrate-opener` subkinds.
 *   2. Look at the most recent N envoy messages (default 5), not just the
 *      one most recent — robust to future order changes or interleaved
 *      system messages. The override fires if ANY of those N envoy messages
 *      carries a calibrate-* subkind AND no host turn has been processed
 *      since (handled separately by the route — once the host's first reply
 *      lands and the composer responds, the most recent envoy message is
 *      the composer's response, which carries no calibrate-* subkind, and
 *      the predicate stops matching).
 *
 * The 30-minute time window stays as a backstop.
 */
import type { Prisma } from "@prisma/client";
import { parseChannelMessageMetadata } from "@/lib/channel/metadata-schema";

export const CALIBRATE_FOLLOWTHROUGH_SUBKINDS = [
  "calibrate-seed-info",
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
 * calibrate-seed-info or calibrate-opener metadata AND the most-recent of
 * those calibrate-* messages landed within the time window.
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
