/**
 * Principal-name helpers.
 *
 * `firstName` is the canonical derive-at-render helper referenced by the
 * external-agent-banner micro-spec §1 (and the parent MCP SPEC). The DB
 * stores the full `principal.name`; the UI and telemetry derive first name
 * at display time so there is never a dual-field inconsistency risk.
 *
 * Trim, split on whitespace runs, take the first token. Empty / whitespace
 * input returns `null` — callers decide the fallback label ("there",
 * "Guest", etc).
 */

export function firstName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first || null;
}
