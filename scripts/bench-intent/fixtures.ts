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
  | "empty-new-host"
  | "host-with-named-links"
  | "host-general-only"
  | "host-katie-bike-ride"
  | "host-recurring-piano-lessons"
  | "host-iterates-office-hours";

export interface Fixture {
  host: string;
  activeSessionsSummary: string;
  priorEnvoyTurn?: string;
  /** Short recap emitted in failure rows. */
  recap: string;
  /**
   * When true, the bench runner invokes `classifyChatIntent(msg, ctx, "host")`
   * instead of the default guest path. Use for scenarios that probe the host
   * intent enum (create_link / modify_link / cancel_link / edit_preference /
   * query_calendar / query_event / chat) per the 2026-04-27
   * chat-decisioning-layer-redesign PR1.
   */
  isHost?: boolean;
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
  // Recall-surface fixture: host has two reusable links beyond General.
  // Use with messages like "what's my sales pitch link" (→ inquire) or
  // "rename my coaching link to mentoring" (→ rule).
  "host-with-named-links": {
    host: "John Anderson",
    activeSessionsSummary: "",
    priorEnvoyTurn: undefined,
    recap:
      "Host has reusable links: General, 'Sales pitch', 'Coaching' (office-hours).",
  },
  // Create-surface fixture: host has only the General link. Use with
  // messages like "set up an office hours link" (→ rule).
  "host-general-only": {
    host: "John Anderson",
    activeSessionsSummary: "",
    priorEnvoyTurn: undefined,
    recap: "Host has only the default General link — no office-hours rules yet.",
  },
  // Bug #4 regression fixture (2026-04-27 chat-decisioning-layer-redesign).
  // Pre-PR1: "2 hour bike ride with katie" with an active Katie link routed to
  // marco-disambiguate. Post-PR1: single match under create_link defaults to
  // deterministic-create (R1). Use with `classifyChatIntent(msg, ctx, "host")`.
  "host-katie-bike-ride": {
    host: "John Anderson",
    activeSessionsSummary: [
      "- John + Katie — guest: Katie — status: active — link: katielink — topic: catch up — note: Waiting for Katie",
    ].join("\n"),
    priorEnvoyTurn: undefined,
    recap:
      "John has a single active Katie catch-up session; a new 'bike ride with Katie' should classify as create_link (R1 default-to-create).",
    isHost: true,
  },
  // Recurring-meeting-create gate — covers the F8 single-turn-emit
  // regression class. Per proposal §5.16: utterances like "set up weekly
  // piano lessons with Pat, 30 min, in-person — at my studio" must classify
  // as `create_link` on the host enum (no clarifier ladder, no `unclear`).
  // Pair with axis "recurring meeting create" in corpus-gen.
  "host-recurring-piano-lessons": {
    host: "John Anderson",
    activeSessionsSummary: "",
    priorEnvoyTurn: undefined,
    recap:
      "Fresh host context for recurring-meeting-create; 'set up weekly piano lessons with Pat' must classify as create_link in one turn (F8 hard-pass).",
    isHost: true,
  },
  // Iterative-blabbering office hours — covers the chat-driven reshape's
  // multi-turn config tracking. Per proposal `2026-05-03_recurring-and-
  // office-hours-widgets` §3.14: composer must (i) emit the initial
  // office_hours add as `update_availability_rule` create_link-equivalent,
  // (ii) emit `update` operations on follow-up tweaks ("actually 45 min" /
  // "also Thursdays"), (iii) handle "what's it set to now" as a query
  // intent that reads live state without emitting an action. Prior turn
  // context simulates a freshly-created Sales pitch link.
  "host-iterates-office-hours": {
    host: "John Anderson",
    activeSessionsSummary: "",
    priorEnvoyTurn:
      "Set up — guests can book 30-minute video meetings on Tuesdays from 2 to 4 PM. I'll drop the URL in once it saves. Let me know if you want to change anything.",
    recap:
      "John just created Sales pitch office hours (Tue 2-4pm, 30-min video). Iterative tweaks ('actually 45 min', 'also Thursdays', 'what's it set to now') must route to update_availability_rule patches OR to a state-of-record narration without an action.",
    isHost: true,
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
