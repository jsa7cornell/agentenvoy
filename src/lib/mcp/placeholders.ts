/**
 * Allow-listed placeholder tokens for rationale templates.
 *
 * Rationale templates are short host-authored strings with `{{placeholder}}`
 * slots. The post-generation validator and the template renderer both gate
 * on this exact list — any token not present here is rejected at render
 * time. See SPEC §3.1 and §9 Q4.
 *
 * Keep this list short. Expansion requires a SPEC amendment: new
 * placeholders widen the surface the LLM can inject through, so each one
 * needs an explicit "what bad thing could this leak?" argument before
 * landing here.
 */
export const RATIONALE_PLACEHOLDERS = [
  "format",
  "provider",
  "duration",
  "location",
  "host_first",
  "origin",
  "meeting_type",
  // TODO v1.1 candidates (SPEC §9 Q4 — require explicit review):
  //   "day_of_week", "host_timezone", "guest_timezone"
] as const;

export type RationalePlaceholder = (typeof RATIONALE_PLACEHOLDERS)[number];

/**
 * Typed set for O(1) membership checks in the validator / renderer.
 */
export const RATIONALE_PLACEHOLDER_SET: ReadonlySet<string> = new Set(
  RATIONALE_PLACEHOLDERS,
);
