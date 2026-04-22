/**
 * Fixture builder for /bench-intent.
 *
 * Turns a scenario seed (named preset or free-text string) into a
 * concrete `ClassifyContext` that the runner pipes through
 * `classifyChatIntent()`.
 *
 * Named presets are canonical — they match scenarios from real
 * feedback reports (the "john-jon-bike-ride" preset reproduces the
 * cmo9n0t5u cascade). Free-text strings are parsed via a one-shot
 * Haiku call with a forced schema.
 *
 * Proposal reference: 2026-04-22 §9.5.2.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { envoyModel } from "@/lib/model";
import type { ClassifyContext } from "@/agent/intent-classifier";

export type ScenarioSeed =
  | { kind: "preset"; name: PresetName }
  | { kind: "adhoc"; text: string };

export type PresetName =
  | "john-jon-bike-ride"
  | "john-bob-quarterly"
  | "empty-new-host";

export interface Fixture {
  host: string;
  activeSessionsSummary: string;
  priorEnvoyTurn?: string;
  /** Short recap emitted in failure rows. */
  recap: string;
}

const PRESETS: Record<PresetName, Fixture> = {
  "john-jon-bike-ride": {
    host: "John Anderson",
    activeSessionsSummary: [
      "- John + Jon — guest: Jon — status: active — link: qx4bmg — topic: bike ride — note: Waiting for Jon",
    ].join("\n"),
    priorEnvoyTurn:
      "Looks like you're quoting back my last reply — did you mean to send a new request?",
    recap:
      "John has an active Jon bike-ride session (qx4bmg); Envoy just asked if he meant to send a new request.",
  },
  "john-bob-quarterly": {
    host: "John Anderson",
    activeSessionsSummary: [
      "- John + Bob — guest: Bob — status: active — link: p2xq9k — topic: quarterly review",
      "- John + Jon — guest: Jon — status: active — link: qx4bmg — topic: bike ride",
    ].join("\n"),
    priorEnvoyTurn: "What would you like to schedule?",
    recap: "John has two active sessions (Bob quarterly, Jon bike ride).",
  },
  "empty-new-host": {
    host: "New Host",
    activeSessionsSummary: "",
    priorEnvoyTurn: undefined,
    recap: "Fresh host, no sessions, no prior envoy turn.",
  },
};

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function isPresetName(value: string): value is PresetName {
  return (PRESET_NAMES as string[]).includes(value);
}

const AdhocFixtureSchema = z.object({
  host: z.string(),
  activeSessions: z
    .array(
      z.object({
        guest: z.string(),
        topic: z.string().optional(),
        linkCode: z.string().optional(),
        status: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .default([]),
  priorEnvoyTurn: z.string().optional(),
  recap: z.string(),
});

function renderActiveSessions(
  rows: z.infer<typeof AdhocFixtureSchema>["activeSessions"],
): string {
  return rows
    .map((row) => {
      const parts = [`- ${row.guest}`];
      if (row.topic) parts.push(`topic: ${row.topic}`);
      if (row.linkCode) parts.push(`link: ${row.linkCode}`);
      if (row.status) parts.push(`status: ${row.status}`);
      if (row.note) parts.push(`note: ${row.note}`);
      return parts.join(" — ");
    })
    .join("\n");
}

async function parseAdhocScenario(text: string): Promise<Fixture> {
  const { object } = await generateObject({
    model: envoyModel("claude-haiku-4-5-20251001"),
    maxOutputTokens: 512,
    system:
      "Parse a free-text bench-test scenario description into a structured fixture for an intent-classifier bench harness. Extract the host name, any active scheduling sessions (guest names + topics + link codes if mentioned), and the most recent envoy/assistant turn if quoted. Write a one-sentence recap. If a field is absent, omit it.",
    prompt: `Scenario text:\n${text}`,
    schema: AdhocFixtureSchema,
  });

  return {
    host: object.host,
    activeSessionsSummary: renderActiveSessions(object.activeSessions),
    priorEnvoyTurn: object.priorEnvoyTurn,
    recap: object.recap,
  };
}

/**
 * Build a fixture from a parsed seed. Named presets return synchronously
 * (no LLM call); ad-hoc strings call Haiku once.
 */
export async function buildFixture(seed: ScenarioSeed): Promise<Fixture> {
  if (seed.kind === "preset") {
    const preset = PRESETS[seed.name];
    if (!preset) throw new Error(`Unknown preset: ${seed.name}`);
    return { ...preset };
  }
  return parseAdhocScenario(seed.text);
}

/**
 * Thin adapter: fixture → ClassifyContext the real classifier consumes.
 */
export function fixtureToClassifyContext(fixture: Fixture): ClassifyContext {
  return {
    activeSessionsSummary: fixture.activeSessionsSummary || undefined,
    priorEnvoyTurn: fixture.priorEnvoyTurn,
  };
}

export const __PRESETS_FOR_TEST = PRESETS;
