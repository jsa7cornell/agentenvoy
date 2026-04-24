/**
 * Single read path for invitee name display across all consumers.
 * Handles the inviteeNames[] → inviteeName migration bridge and all
 * 1/2/3+ guest formatting rules.
 */

interface LinkWithInvitees {
  inviteeNames?: string[];
  inviteeName?: string | null;
}

/** Canonical ordered list of guest names, bridging old and new schema. */
export function getInviteeNames(link: LinkWithInvitees): string[] {
  if (link.inviteeNames && link.inviteeNames.length > 0) return link.inviteeNames;
  if (link.inviteeName) return [link.inviteeName];
  return [];
}

/**
 * Human-readable display string for the invitee(s).
 *   0 guests → ""
 *   1 guest  → "Will"
 *   2 guests → "Will & Andrew"
 *   3+       → "Will, Andrew & 1 other"
 */
export function getInviteeDisplay(link: LinkWithInvitees): string {
  const names = getInviteeNames(link);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}, ${names[1]} & ${names.length - 2} other${names.length - 2 === 1 ? "" : "s"}`;
}

/**
 * Status label for "Waiting for …" — falls back to "invitee" when no names.
 *   1 guest  → "Waiting for Will"
 *   2 guests → "Waiting for Will and Andrew"
 *   3+       → "Waiting for Will and 2 others"
 */
export function getWaitingLabel(link: LinkWithInvitees): string {
  const names = getInviteeNames(link);
  if (names.length === 0) return "Waiting for invitee";
  if (names.length === 1) return `Waiting for ${names[0]}`;
  if (names.length === 2) return `Waiting for ${names[0]} and ${names[1]}`;
  return `Waiting for ${names[0]} and ${names.length - 1} others`;
}

/** First guest's first name — used in greeting salutations. */
export function getInviteeFirstName(link: LinkWithInvitees): string | null {
  const names = getInviteeNames(link);
  if (names.length === 0) return null;
  return names[0].split(/\s+/)[0] || null;
}

/**
 * First-names-only display, same shape as getInviteeDisplay.
 *   0 guests → ""
 *   1 guest  → "Will"
 *   2 guests → "Will & Andrew"
 *   3+       → "Will, Andrew & 1 other"
 * Used for greeting salutations where last names would feel stiff.
 */
export function getInviteeFirstNamesDisplay(link: LinkWithInvitees): string {
  const firsts = getInviteeNames(link)
    .map((n) => n.split(/\s+/)[0])
    .filter((n): n is string => Boolean(n));
  if (firsts.length === 0) return "";
  if (firsts.length === 1) return firsts[0];
  if (firsts.length === 2) return `${firsts[0]} & ${firsts[1]}`;
  return `${firsts[0]}, ${firsts[1]} & ${firsts.length - 2} other${firsts.length - 2 === 1 ? "" : "s"}`;
}
