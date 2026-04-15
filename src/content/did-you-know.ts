/**
 * "Did You Know?" tips for the dashboard sidebar card.
 *
 * Each tip is a short product-awareness nudge with an optional CTA that deep-links
 * into the feature it's describing. Keep titles plain-spoken ("Envoy lets you X")
 * and body copy to ~3–4 sentences. CTAs are optional — tips with `cta: null` are
 * quiet facts that don't need an action.
 *
 * Adding a tip: append an entry. Ordering doesn't matter — the card shuffles.
 * Removing a tip: delete the entry. No migration needed.
 */

export interface DidYouKnowTip {
  id: string; // stable slug for analytics / dedup
  title: string; // short, plain-spoken hook
  body: string; // 3–4 sentences
  cta: {
    label: string; // imperative action ("Create office hours")
    href: string; // absolute route in the app
  } | null;
}

export const DID_YOU_KNOW_TIPS: DidYouKnowTip[] = [
  {
    id: "office-hours",
    title: "Envoy lets you book office hours",
    body: "Declare a recurring window once — \"Tuesdays 2–4pm, 20-minute video calls\" — and share a single link. Anyone who has it can book an open slot independently, no back-and-forth or polling required. As guests claim times, already-booked slots disappear for the next visitor. One link, many bookings, zero coordination work on your end.",
    cta: { label: "Create office hours", href: "/dashboard/availability" },
  },
  {
    id: "rules",
    title: "Set up calendar rules with Envoy",
    body: "Type rules the way you'd say them out loud. \"No meetings Mondays before 10.\" \"Surf 8–10 every weekday — protect it.\" \"Keep Fridays light.\" Envoy parses what you wrote, shows you how it'll apply, and you confirm. Rules live alongside your calendar and update instantly — no form-filling, no nested menus.",
    cta: { label: "Open rules", href: "/dashboard/availability" },
  },
  {
    id: "group-events",
    title: "Envoy now lets you schedule group events",
    body: "Tell Envoy \"Set up a surf retreat with Sarah, Mike, and Nathan the week of April 14\" and it creates a private scheduling link for each person. Every guest has their own conversation with Envoy; you see aggregate overlap as responses come in. Envoy proposes times as soon as patterns emerge — you don't have to wait for everyone to reply before locking something in.",
    cta: { label: "Start a group event", href: "/dashboard" },
  },
  {
    id: "vip-guest",
    title: "Envoy gives your VIPs better treatment",
    body: "Tell Envoy \"Katie is evaluating us — treat her as a VIP\" and her invite gets more generous availability than a typical guest: softer protections, earlier slots, and times you'd normally hold back. The rest of your scheduling stays untouched — the VIP treatment applies only to that one invite, not your general link.",
    cta: { label: "Tell Envoy", href: "/dashboard" },
  },
  {
    id: "manage-calendars",
    title: "Select which Google calendars Envoy uses",
    body: "If you have multiple Google calendars — personal, work, family, a shared team calendar — you can choose which ones count toward your availability. Unchecked calendars are ignored completely: their events won't block your schedule and Envoy won't read them. Flip calendars on and off anytime; your availability updates the moment you save.",
    cta: { label: "Manage calendars", href: "/dashboard/availability?manageCalendars=1" },
  },
];
