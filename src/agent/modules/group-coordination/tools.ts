/**
 * Group coordination module — composer-callable tools.
 *
 * Three probabilistic tools the LLM decides when to call:
 *   record_availability   — store one participant's window + preference data
 *   propose_convergence   — synthesize all collected responses; increment synthesisVersion
 *   collect_suggestion    — record an activity/venue/preference suggestion
 *
 * All writes are upsert-safe and idempotent on re-call.
 * Free-form `responses` JSON shape: { person, windows, preferences, unavailable }[]
 * (decided 2026-05-06: no promptId linkage, free-form wins).
 */
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { ComposerTool, ModuleContext } from "@/agent/modules/types";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// record_availability
// ---------------------------------------------------------------------------

const recordAvailabilityInput = z.object({
  sessionId: z.string().describe("GroupCoordination sessionId."),
  person: z.string().describe("Display name or email of the participant."),
  windows: z
    .array(
      z.object({
        label: z.string(),
        start: z.string(),
        end: z.string(),
        confidence: z.enum(["high", "maybe", "low"]).optional(),
      }),
    )
    .describe("Time windows the person is available. ISO 8601 start/end strings."),
  preferences: z
    .record(z.string(), z.string())
    .optional()
    .describe("Free-form preference key-value pairs (format, location, etc.)."),
  unavailable: z
    .array(z.string())
    .optional()
    .describe("Windows that are hard blocks for this person."),
}).strict();

type RecordAvailabilityInput = z.infer<typeof recordAvailabilityInput>;

export const recordAvailabilityTool: ComposerTool<
  RecordAvailabilityInput,
  { ok: boolean; responseCount: number }
> = {
  name: "record_availability",
  description: `Store one participant's availability for a group coordination session.
Call this when:
- The host provides a participant's windows (in-person or pasted)
- You're capturing data the host just received from a participant

The responses array is append/replace per person — calling again with the same
person name overwrites the previous entry (latest-wins). All other entries are preserved.`,
  inputSchema: recordAvailabilityInput,
  execute: async (input: RecordAvailabilityInput, _ctx: ModuleContext) => {
    const gc = await prisma.groupCoordination.findUnique({
      where: { sessionId: input.sessionId },
      select: { id: true, responses: true },
    });
    if (!gc) return { ok: false, responseCount: 0 };

    const existing = Array.isArray(gc.responses) ? gc.responses as Array<Record<string, unknown>> : [];
    const filtered = existing.filter((r) => r.person !== input.person);
    const updated = [
      ...filtered,
      {
        person: input.person,
        windows: input.windows,
        preferences: input.preferences ?? {},
        unavailable: input.unavailable ?? [],
        recordedAt: new Date().toISOString(),
      },
    ];

    await prisma.groupCoordination.update({
      where: { sessionId: input.sessionId },
      data: { responses: updated as unknown as Prisma.InputJsonValue },
    });

    return { ok: true, responseCount: updated.length };
  },
};

// ---------------------------------------------------------------------------
// propose_convergence
// ---------------------------------------------------------------------------

const proposeConvergenceInput = z.object({
  sessionId: z.string().describe("GroupCoordination sessionId."),
}).strict();

type ProposeConvergenceInput = z.infer<typeof proposeConvergenceInput>;

export const proposeConvergenceTool: ComposerTool<
  ProposeConvergenceInput,
  { ok: boolean; synthesisVersion: number; responseCount: number; responses: unknown }
> = {
  name: "propose_convergence",
  description: `Load all collected availability responses and increment the synthesis version.
Call this when the host asks for a summary, overlap analysis, or "where do we land?"

The tool returns all raw responses so you can reason across them and produce
a generative table or prose summary. You decide the rendering — this is an
intentional LLM boundary test (decided 2026-05-06). Show candidate windows
ranked by overlap, flag hard conflicts, and call out who has not responded yet.`,
  inputSchema: proposeConvergenceInput,
  execute: async (input: ProposeConvergenceInput, _ctx: ModuleContext) => {
    const gc = await prisma.groupCoordination.findUnique({
      where: { sessionId: input.sessionId },
      select: { responses: true, synthesisVersion: true },
    });
    if (!gc) return { ok: false, synthesisVersion: 0, responseCount: 0, responses: [] };

    const nextVersion = gc.synthesisVersion + 1;
    await prisma.groupCoordination.update({
      where: { sessionId: input.sessionId },
      data: { synthesisVersion: nextVersion },
    });

    const responses = Array.isArray(gc.responses) ? gc.responses : [];
    return {
      ok: true,
      synthesisVersion: nextVersion,
      responseCount: responses.length,
      responses,
    };
  },
};

// ---------------------------------------------------------------------------
// collect_suggestion
// ---------------------------------------------------------------------------

const collectSuggestionInput = z.object({
  sessionId: z.string().describe("GroupCoordination sessionId."),
  person: z.string().describe("Who is making the suggestion."),
  category: z
    .enum(["venue", "activity", "format", "other"])
    .describe("Suggestion category."),
  value: z.string().min(1).max(500).describe("The suggestion text as-said."),
  normalizedValue: z
    .string()
    .min(1)
    .max(200)
    .describe("Lowercased, trimmed canonical form for dedup (e.g., 'rooftop bar')."),
}).strict();

type CollectSuggestionInput = z.infer<typeof collectSuggestionInput>;

export const collectSuggestionTool: ComposerTool<
  CollectSuggestionInput,
  { ok: boolean; isDuplicate: boolean }
> = {
  name: "collect_suggestion",
  description: `Record an activity, venue, or format suggestion from a participant.
Call this when the host conveys a participant's suggestion (venue idea, activity, etc.).
Duplicate suggestions (same sessionId + normalizedValue + category) are silently ignored.`,
  inputSchema: collectSuggestionInput,
  execute: async (input: CollectSuggestionInput, _ctx: ModuleContext) => {
    try {
      await prisma.activitySuggestion.create({
        data: {
          sessionId: input.sessionId,
          person: input.person,
          category: input.category,
          value: input.value,
          normalizedValue: input.normalizedValue,
        },
      });
      return { ok: true, isDuplicate: false };
    } catch (err: unknown) {
      // Unique constraint violation — duplicate; treat as no-op
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unique constraint")) {
        return { ok: true, isDuplicate: true };
      }
      throw err;
    }
  },
};
