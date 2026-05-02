/**
 * Link-scoped posture propagation — the fan-out helper.
 *
 * `applyPostureToScope(updates, scope, userId)` writes a partial posture
 * update to a chosen set of links. Used by:
 *
 *  - The modal **"Apply to all reusable links?"** prompt (parent
 *    proposal §2.2) — when the host saves a Primary edit and confirms
 *    propagation, this helper writes the changed fields to every
 *    affected variance link.
 *  - The **chat-action fan-out** (V1.5 §2.5) — when the host says "block
 *    Tuesday next week" and the agent emits an `update_knowledge`
 *    action, the handler calls this to write the new rule's compiled
 *    state across every link by default.
 *
 * Scope semantics:
 *  - `"all"` — Primary (writes to `User.preferences.explicit.*`) AND
 *    every variance link (writes to `link.parameters.*`).
 *  - `LinkID[]` — only the named links. If the array contains a sentinel
 *    `"primary"` value, Primary is included; otherwise variance-only.
 *
 * Decision references:
 *  - `proposals/2026-05-02_per-link-config-storage-and-scoring-link-scope_*`
 *    §2.5 (fan-out unifies modal + chat propagation)
 *  - `proposals/2026-05-02_primary-as-posture-and-reusable-link-propagation_*`
 *    §2.2 (default = all, scope-down on correction)
 */

import { prisma } from "../prisma";
import { parseLinkParameters } from "../link-parameters";
import type { ResolvedPosture } from "./posture";

/** Subset of posture fields a propagation can carry. Mirror the
 *  `LinkParameters` posture additions from V1.5 — every field optional
 *  so callers can send only what changed. */
export type PostureUpdate = Partial<{
  hoursStartMinutes: number;
  hoursEndMinutes: number;
  daysOfWeek: number[];
  duration: number;
  bufferMinutes: number;
  format: string;
  eveningsPosture: ResolvedPosture["eveningsPosture"];
  /** Compiled rule state — used by chat-driven rule edits. The handler
   *  recompiles user-level rules first, then fans out the new compiled
   *  blob via this field. */
  compiled: ResolvedPosture["compiled"];
}>;

export type Scope = "all" | string[];

/** Sentinel for naming Primary in a scoped list. */
export const PRIMARY_SCOPE_ID = "primary";

export interface ApplyPostureResult {
  /** Number of variance links written. */
  varianceWrites: number;
  /** Whether Primary (User.preferences) was written. */
  primaryWritten: boolean;
}

/** Apply a partial posture update to the chosen scope.
 *
 *  @param updates  The posture fields to write. Empty object is a no-op.
 *  @param scope    `"all"` (default fan-out) or an explicit list of
 *                  link IDs (use `PRIMARY_SCOPE_ID` to include Primary).
 *  @param userId   The host whose links are affected.
 *
 *  @returns counts of what was written (for logging / telemetry).
 */
export async function applyPostureToScope(
  updates: PostureUpdate,
  scope: Scope,
  userId: string
): Promise<ApplyPostureResult> {
  if (Object.keys(updates).length === 0) {
    return { varianceWrites: 0, primaryWritten: false };
  }

  const includePrimary =
    scope === "all" || (Array.isArray(scope) && scope.includes(PRIMARY_SCOPE_ID));

  // Resolve the variance link IDs to write to.
  let varianceLinkIds: string[];
  if (scope === "all") {
    const links = await prisma.negotiationLink.findMany({
      where: { userId, type: { not: "primary" } },
      select: { id: true },
    });
    varianceLinkIds = links.map((l) => l.id);
  } else {
    varianceLinkIds = scope.filter((id) => id !== PRIMARY_SCOPE_ID);
  }

  // Primary write — to User.preferences.explicit (and .compiled for
  // compiled-rule updates). The shape mapping matches today's read
  // sites at User.preferences level.
  let primaryWritten = false;
  if (includePrimary) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    if (user) {
      const prevPrefs = (user.preferences ?? {}) as Record<string, unknown>;
      const prevExplicit =
        (prevPrefs.explicit as Record<string, unknown> | undefined) ?? {};
      const nextExplicit = { ...prevExplicit };

      if ("hoursStartMinutes" in updates)
        nextExplicit.businessHoursStartMinutes = updates.hoursStartMinutes;
      if ("hoursEndMinutes" in updates)
        nextExplicit.businessHoursEndMinutes = updates.hoursEndMinutes;
      if ("bufferMinutes" in updates)
        nextExplicit.bufferMinutes = updates.bufferMinutes;
      if ("duration" in updates)
        nextExplicit.defaultDuration = updates.duration;
      // daysOfWeek and eveningsPosture aren't first-class on User.preferences
      // today — they live in compiled.allowWindows / structuredRules. Skip
      // those for Primary writes; they apply to variances only until the
      // posture-on-User extension lands.

      const nextPrefs: Record<string, unknown> = {
        ...prevPrefs,
        explicit: nextExplicit,
      };
      if ("compiled" in updates && updates.compiled) {
        nextPrefs.compiled = updates.compiled;
      }

      await prisma.user.update({
        where: { id: userId },
        data: { preferences: nextPrefs as object },
      });
      primaryWritten = true;
    }
  }

  // Variance writes — fan out the matching fields onto each link's
  // parameters JSON. Single transaction per link; one query per write
  // (Prisma JSON updates aren't bulkable when the merge logic is
  // field-specific).
  let varianceWrites = 0;
  for (const linkId of varianceLinkIds) {
    const link = await prisma.negotiationLink.findUnique({
      where: { id: linkId },
      select: { parameters: true },
    });
    if (!link) continue;

    const existing = parseLinkParameters(link.parameters);
    const next = { ...existing };

    if ("hoursStartMinutes" in updates)
      next.hoursStartMinutes = updates.hoursStartMinutes;
    if ("hoursEndMinutes" in updates)
      next.hoursEndMinutes = updates.hoursEndMinutes;
    if ("daysOfWeek" in updates) next.daysOfWeek = updates.daysOfWeek;
    if ("duration" in updates) next.duration = updates.duration;
    if ("bufferMinutes" in updates) next.bufferMinutes = updates.bufferMinutes;
    if ("format" in updates) next.format = updates.format;
    if ("eveningsPosture" in updates)
      next.eveningsPosture = updates.eveningsPosture;
    if ("compiled" in updates && updates.compiled) {
      // Map ResolvedPosture's compiled shape onto LinkParameters' compiled
      // shape — only the fields the schema persists per-link.
      next.compiled = {
        buffers: updates.compiled.buffers ?? [],
        priorityBuckets: updates.compiled.priorityBuckets ?? [],
        allowWindows: updates.compiled.allowWindows ?? [],
        ambiguities: updates.compiled.ambiguities ?? [],
      };
    }

    await prisma.negotiationLink.update({
      where: { id: linkId },
      data: { parameters: next as object },
    });
    varianceWrites += 1;
  }

  return { varianceWrites, primaryWritten };
}

/** Helper: resolve which variance links would be affected by a given
 *  posture update — used by the modal Apply-to-all prompt to populate
 *  the affected-list (cap at 3 + "+N more" per parent §2.2).
 *
 *  Returns links whose current value for any of `updates`'s keys
 *  differs from the proposed new value. Links that already have the
 *  same value are excluded (no behavior change → don't bother prompting).
 */
export async function findAffectedVariances(
  updates: PostureUpdate,
  userId: string
): Promise<Array<{ id: string; name: string }>> {
  const links = await prisma.negotiationLink.findMany({
    where: { userId, type: { not: "primary" } },
    select: { id: true, slug: true, parameters: true, topic: true },
  });

  const affected: Array<{ id: string; name: string }> = [];
  for (const link of links) {
    const params = parseLinkParameters(link.parameters);
    let differs = false;
    if ("hoursStartMinutes" in updates && params.hoursStartMinutes !== updates.hoursStartMinutes) differs = true;
    if ("hoursEndMinutes" in updates && params.hoursEndMinutes !== updates.hoursEndMinutes) differs = true;
    if ("duration" in updates && params.duration !== updates.duration) differs = true;
    if ("bufferMinutes" in updates && params.bufferMinutes !== updates.bufferMinutes) differs = true;
    if ("format" in updates && params.format !== updates.format) differs = true;
    if ("eveningsPosture" in updates && params.eveningsPosture !== updates.eveningsPosture) differs = true;
    if ("daysOfWeek" in updates && !arraysEqual(params.daysOfWeek, updates.daysOfWeek)) differs = true;

    if (differs) {
      affected.push({
        id: link.id,
        name: link.topic || link.slug,
      });
    }
  }
  return affected;
}

function arraysEqual(a: number[] | undefined, b: number[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
