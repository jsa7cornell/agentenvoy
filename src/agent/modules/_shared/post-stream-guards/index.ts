/**
 * _shared/post-stream-guards — wraps the canonical Layer 2a/2b/F6 guards as
 * `PostStreamGuard` instances for module declarations.
 *
 * Per proposal §1.1.3: these guards are stateless and surface-agnostic; they
 * become the *default* postStreamGuards on every module that emits actions.
 * Modules can opt out via `useDefaultPostStreamGuards: false` (per Ni4).
 *
 * The underlying functions live in `src/agent/action-emission-guard.ts`. PR3
 * absorbs that file and lifts the bodies in here entirely; PR1a imports them
 * directly to avoid premature deletion of the legacy file.
 */
import {
  needsActionEmissionRetry,
  needsActionShapeRetry,
  needsActionRedundancyRetry,
} from "@/agent/action-emission-guard";
import type { PostStreamGuard } from "../../types";

/**
 * Layer 2a — emission guard. Catches "I set up the link" prose without an
 * accompanying [ACTION] block. Original 2026-04-18 guard.
 */
export const layer2aEmissionGuard: PostStreamGuard = {
  name: "layer-2a-emission",
  check: ({ text }) => {
    if (!needsActionEmissionRetry(text)) return null;
    return {
      flaggedReason: "no-action-emitted",
      hint: "You just described an action but didn't emit the corresponding `[ACTION]{...}[/ACTION]` block. Emit the block now — ONLY the block, no conversational text, no preamble. If multiple actions apply, emit multiple blocks. Use the exact format and fields documented in the system prompt.",
    };
  },
};

/**
 * Layer 2b — shape guard. Catches "she picks the spot" prose with a
 * `create_link`/`update_link` action that doesn't have `guestPicks.location: true`.
 * Added 2026-04-30 per `composer-action-fidelity` proposal.
 */
export const layer2bShapeGuard: PostStreamGuard = {
  name: "layer-2b-shape",
  check: ({ text, parsedActions }) => {
    const result = needsActionShapeRetry(text, parsedActions);
    if (!result) return null;
    return { flaggedReason: result.flaggedReason, hint: result.hint };
  },
};

/**
 * F6 redundancy guard. Catches "Apologies — I hadn't emitted X yet" prose
 * paired with an [ACTION] block (the false-apology-then-duplicate-emit pattern).
 * Added 2026-05-01 per F6 row in COMPOSER.md §2.
 */
export const f6RedundancyGuard: PostStreamGuard = {
  name: "f6-redundancy",
  check: ({ text, parsedActions }) => {
    const result = needsActionRedundancyRetry(text, parsedActions);
    if (!result) return null;
    return { flaggedReason: result.flaggedReason, hint: result.hint };
  },
};

/**
 * Default guard set auto-injected by the runner unless the module sets
 * `useDefaultPostStreamGuards: false`.
 *
 * Order matters: emission first (loudest case), then shape, then redundancy.
 * The runner short-circuits on the first firing, so earlier-listed guards
 * have priority.
 */
export const DEFAULT_POST_STREAM_GUARDS: readonly PostStreamGuard[] = [
  layer2aEmissionGuard,
  layer2bShapeGuard,
  f6RedundancyGuard,
];
