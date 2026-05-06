/**
 * Canonical static opener for the recalibrate first-time arc.
 *
 * Source of truth: `runtime-prompts/composers/recalibrate/first-time.md`
 * "Anchor opener (canonical reference)" section. John's verbatim §2.7a
 * opener (decided proposal `2026-05-05_conversational-onboarding-vision`).
 *
 * This const is what the `/api/onboarding/calibrate-opener` endpoint persists
 * as a deterministic Envoy ChannelMessage when the calendar picker submits.
 * It replaces the PR-B synthetic-host-message hack that classified to the
 * wrong intent and produced a generic clarifying turn.
 *
 * The worked-example sentence is wrapped in `_..._` so feed.tsx's
 * `renderMarkdown` (which gained `_italic_` support in PR-B) renders it
 * italicized — visually separates the "user could say" demonstration from
 * Envoy's voice (proposal §Q5b).
 *
 * Keep in sync: if the fragment's anchor opener changes, update this const
 * AND the warning comment in `composers/recalibrate/first-time.md`.
 */
export const CALIBRATE_FIRST_TIME_OPENER_TEXT = `I'd love to hear a little bit more about how you work so that I can tune your primary availability link.

For instance, you could say: _"I want to offer MWF, but I protect lunchtime every day. My standard meeting slots are 25 minutes, with a 5-minute buffer after each. I also protect Friday afternoons and Tuesday mornings."_

Specific things that help me are times that you want to protect, format and length of meetings, and more. Anything you can give me is a great start, and you can always change and modify this and create different types of bookable links for different types of meetings.

This first shot is for your standard or primary meeting availability that you can share with your primary link.`;
