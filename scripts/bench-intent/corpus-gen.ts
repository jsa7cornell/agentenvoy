/**
 * Haiku-driven utterance synthesis for /bench-intent.
 *
 * Given an axis name + a fixture, generate `count` adversarial
 * utterances shaped like the failure modes we care about. Each
 * named axis has a curated prompt.
 *
 * Proposal reference: 2026-04-22 §9.5.2, axes listed in the build
 * prompt (§9.5.6).
 */

import { generateObject } from "ai";
import { z } from "zod";
import { envoyModel } from "@/lib/model";
import type { Fixture } from "./fixtures";
import type { ChatIntent } from "@/lib/intent";

export type Axis =
  | "short affirmatives after Envoy clarifier"
  | "bare-noun continuations"
  | "echo of prior envoy reply"
  | "multi-intent conjunctions"
  | "ambiguous pronouns"
  | "off-topic injections"
  | "mixed adversarial";

export const AXES: Axis[] = [
  "short affirmatives after Envoy clarifier",
  "bare-noun continuations",
  "echo of prior envoy reply",
  "multi-intent conjunctions",
  "ambiguous pronouns",
  "off-topic injections",
  "mixed adversarial",
];

export function isAxis(v: string): v is Axis {
  return (AXES as string[]).includes(v);
}

const AXIS_INSTRUCTIONS: Record<Exclude<Axis, "mixed adversarial">, string> = {
  "short affirmatives after Envoy clarifier":
    "Generate very short affirmative follow-ups a host might type after Envoy asked a clarifying yes/no question. Examples: 'yes', 'yeah', 'new', 'new one', 'go ahead', 'do it', 'sure', 'yep', bare tokens. Most should classify as `schedule` when the prior envoy turn was a schedule clarifier.",
  "bare-noun continuations":
    "Generate bare noun-phrase continuations of a scheduling thread. Examples: 'bike ride', 'coffee', '1:1', 'standup', 'the review', 'dinner'. These should classify as `schedule` when the topic is referenced in prior context.",
  "echo of prior envoy reply":
    "Generate messages that are either verbatim copies of the prior envoy turn or 85-95% paraphrases of it. The goal is to probe the echo-detection path.",
  "multi-intent conjunctions":
    "Generate utterances that combine two intents via 'and'/','/';', e.g. 'book Bob AND update my phone number', 'schedule Jon then change my default duration'. These are genuinely ambiguous.",
  "ambiguous pronouns":
    "Generate utterances with unresolved pronouns: 'move it to Tuesday', 'change that one', 'can you tweak this?', 'reschedule them'.",
  "off-topic injections":
    "Generate non-scheduling utterances: weather chatter, greetings, random questions, quick thank-yous.",
};

const ExpectedTierSchema = z
  .enum(["schedule", "profile", "rule", "inquire", "unclear"])
  .optional();

const UtteranceSchema = z.object({
  utterance: z.string(),
  expectedTier: ExpectedTierSchema,
  rationale: z.string().optional(),
});

const BatchSchema = z.object({
  utterances: z.array(UtteranceSchema),
});

export interface GeneratedUtterance {
  utterance: string;
  expectedTier?: ChatIntent;
  axis: Axis;
  rationale?: string;
}

export interface GenerateCorpusArgs {
  axis: Axis;
  count: number;
  fixture: Fixture;
}

function promptFor(axis: Axis, count: number, fixture: Fixture): string {
  const ctx = [
    `Host: ${fixture.host}`,
    fixture.activeSessionsSummary
      ? `Active sessions:\n${fixture.activeSessionsSummary}`
      : "Active sessions: (none)",
    fixture.priorEnvoyTurn
      ? `Prior envoy turn: "${fixture.priorEnvoyTurn}"`
      : "Prior envoy turn: (none)",
  ].join("\n");

  const instructions =
    axis === "mixed adversarial"
      ? "Generate a mix across all six named axes below. Roughly 20% of each:\n" +
        Object.entries(AXIS_INSTRUCTIONS)
          .map(([a, inst]) => `  - ${a}: ${inst}`)
          .join("\n")
      : AXIS_INSTRUCTIONS[axis as Exclude<Axis, "mixed adversarial">];

  return [
    `You are generating a synthetic adversarial corpus for an intent-classifier bench test.`,
    ``,
    `Scenario context:`,
    ctx,
    ``,
    `Axis: ${axis}`,
    `Instructions: ${instructions}`,
    ``,
    `Generate exactly ${count} distinct utterances. For each, emit:`,
    `  - utterance (what the host types)`,
    `  - expectedTier (one of: schedule, profile, rule, inquire, unclear) — omit if genuinely ambiguous`,
    `  - rationale (one short phrase explaining what this probes)`,
    ``,
    `Vary punctuation, capitalization, length. Don't repeat phrasing. Keep each utterance under 200 chars.`,
  ].join("\n");
}

export async function generateCorpus(
  args: GenerateCorpusArgs,
): Promise<GeneratedUtterance[]> {
  const { axis, count, fixture } = args;
  const { object } = await generateObject({
    model: envoyModel("claude-haiku-4-5-20251001"),
    maxOutputTokens: Math.min(4096, 80 * count + 512),
    system:
      "You synthesize adversarial test utterances for a chat intent classifier. Stay concrete, avoid duplicates, respect the count exactly.",
    prompt: promptFor(axis, count, fixture),
    schema: BatchSchema,
  });

  return object.utterances.slice(0, count).map((u) => ({
    utterance: u.utterance,
    expectedTier: u.expectedTier,
    axis,
    rationale: u.rationale,
  }));
}
