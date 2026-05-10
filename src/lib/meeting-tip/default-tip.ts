/**
 * Universal default tip — surfaced when no host-authored tip exists on a link.
 *
 * Locked 2026-05-10 per John: same sentence for primary, variance, and
 * anonymous links. NO activity substitution (the card already shows the
 * activity in title/channel rows; the tip should add personality, not
 * duplicate facts).
 *
 * The default is rendered as a FALLBACK in `renderTip()` when
 * `linkAuthoredTip` is absent. Hosts see this same text pre-populated in
 * the link-edit-modal textarea and can override it.
 */
export const DEFAULT_TIP = "Looking forward to it — pick whatever time works.";
