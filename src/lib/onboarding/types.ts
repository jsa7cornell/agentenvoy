/**
 * Shared onboarding types — used by both tuning routes (primary-link,
 * preferences-extended) and their thin renderers in components/onboarding.
 *
 * The legacy 9-phase state machine in `onboarding-machine.ts` was retired
 * 2026-05-04 (cold sign-up has been seed-everything since 2026-04-26 PR
 * #142). These types lived there and survived the deletion.
 */

export interface QuickReplyOption {
  number: number;
  label: string;
  value: string;
}

export interface EnvoyMessage {
  content: string;
  options?: QuickReplyOption[];
  delay?: number;
}
