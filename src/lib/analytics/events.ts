/**
 * Event-name allowlist for F2 (revised) — the ONLY names permitted into
 * ProductEvent.name. Adding a new name is a diff reviewers see.
 *
 * Naming convention: `<domain>.<verb>` in snake_case, past-tense or
 * imperative (e.g., `onboarding.phase_entered`, `confirm.succeeded`).
 * Keep the domain prefix stable so `GROUP BY name` partitions cleanly.
 */

export const PRODUCT_EVENTS = [
  // Onboarding funnel
  "onboarding.phase_entered",
  "onboarding.phase_completed",
  "onboarding.completed",
  // OAuth / calendar hygiene
  "oauth.explainer_shown",
  "oauth.explainer_continued",
  "oauth.scope_granted",
  "oauth.scope_denied",
  // Session lifecycle (negotiation / deal-room)
  "session.greeting_rendered",
  "session.link_opened",
  // Confirmation outcomes
  "confirm.succeeded",
  "confirm.failed",
  // Feedback pipeline (F3)
  "feedback.report_submitted",
] as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[number];

const ALLOWED_NAMES = new Set<string>(PRODUCT_EVENTS);

export function isAllowedEventName(name: string): name is ProductEventName {
  return ALLOWED_NAMES.has(name);
}
