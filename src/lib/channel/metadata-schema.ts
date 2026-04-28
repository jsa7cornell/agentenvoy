/**
 * Zod schema for ChannelMessage.metadata and Message.metadata.
 *
 * Today's writers stuff assorted shapes into the JSON column
 * (`{ overriddenNarration }`, `{ delegateSpeaker }`, sessionId/linkCode on
 * some paths). This schema enumerates the full superset and validates at
 * write-time so new writers don't drift.
 *
 * The feedback bundle builder reads this through the same schema — for
 * guest bundles, only a narrow allowlist passes through (see GUEST_METADATA_ALLOWLIST).
 *
 * See proposals/2026-04-21_agent-accessible-feedback-pipeline §5.3 + §T1a/b/c/T2a.
 */

import { z } from "zod";

export const ActionCallSchema = z.object({
  action: z.string(),
  params: z.record(z.string(), z.unknown()),
  rawBlock: z.string().optional(),
});
export type ActionCall = z.infer<typeof ActionCallSchema>;

export const ActionResultRecordSchema = z.object({
  action: z.string(),
  success: z.boolean(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ActionResultRecord = z.infer<typeof ActionResultRecordSchema>;

export const PromptContextSchema = z.object({
  systemPrompt: z.string(),
  contextBlock: z.string().optional(),
  modelId: z.string(),
  tokenCount: z.number().optional(),
});
export type PromptContext = z.infer<typeof PromptContextSchema>;

export const DelegateSpeakerSchema = z.object({
  kind: z.string(),
  name: z.string().optional(),
});

/**
 * Marco-pending follow-up state. Persisted on the *next* envoy
 * `ChannelMessage.metadata` after a multi-match-disambiguate fires
 * (per the 2026-04-27 chat-decisioning-layer-redesign §11.3 P5 / §11.4 Q2).
 *
 * Single-shot: cleared after the host's next turn is consumed (or on any
 * unparseable reply). Host-only — explicitly NOT in `GUEST_METADATA_ALLOWLIST`.
 */
export const MarcoPendingSchema = z.object({
  matchedLinkIds: z.array(z.string()),
  originatingIntent: z.enum(["create_link", "modify_link", "cancel_link"]),
});
export type MarcoPending = z.infer<typeof MarcoPendingSchema>;

export const ChannelMessageMetadataSchema = z
  .object({
    kind: z.string().optional(),
    threadId: z.string().optional(),
    sessionId: z.string().optional(),
    linkCode: z.string().optional(),
    overriddenNarration: z.string().nullable().optional(),
    reaction: z.string().optional(),
    delegateSpeaker: DelegateSpeakerSchema.optional(),
    actions: z.array(ActionCallSchema).optional(),
    actionResults: z.array(ActionResultRecordSchema).optional(),
    promptContext: PromptContextSchema.optional(),
    marcoPending: MarcoPendingSchema.nullable().optional(),
  })
  .passthrough();
export type ChannelMessageMetadata = z.infer<typeof ChannelMessageMetadataSchema>;

/**
 * Keys that survive the guest-bundle metadata filter. Host-only fields
 * (promptContext, overriddenNarration) are stripped. See build-guest-bundle.ts.
 */
export const GUEST_METADATA_ALLOWLIST = new Set<keyof ChannelMessageMetadata>([
  "kind",
  "threadId",
  "sessionId",
  "linkCode",
  "actions",
  "actionResults",
]);

/**
 * Parse a raw JSON metadata value. Returns an empty object on parse failure
 * rather than throwing — historical rows may have non-conforming shapes we
 * don't want to crash on.
 */
export function parseChannelMessageMetadata(raw: unknown): ChannelMessageMetadata {
  if (raw === null || raw === undefined) return {};
  const parsed = ChannelMessageMetadataSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {};
}

/**
 * Strip host-only fields for guest-visible bundles. Operates on already-parsed
 * metadata to keep the Zod boundary in one place.
 */
export function filterMetadataForGuest(
  metadata: ChannelMessageMetadata,
): ChannelMessageMetadata {
  const out: ChannelMessageMetadata = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (GUEST_METADATA_ALLOWLIST.has(k as keyof ChannelMessageMetadata)) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * Merge new metadata keys onto an existing row's metadata, preserving unknown
 * keys that writers before this schema added. Used at write-site to avoid
 * clobbering `{ overriddenNarration }` or `{ delegateSpeaker }` when we're
 * only populating `{ actions, actionResults, promptContext }`.
 */
export function mergeChannelMetadata(
  existing: unknown,
  additions: Partial<ChannelMessageMetadata>,
): ChannelMessageMetadata {
  const base = parseChannelMessageMetadata(existing);
  return { ...base, ...additions };
}
