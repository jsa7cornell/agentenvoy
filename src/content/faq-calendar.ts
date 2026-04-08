/**
 * FAQ content for AgentEnvoy's public "How It Works" page.
 * Update this file as the product evolves — the /faq page reads from it.
 *
 * Last reviewed: 2026-04-08
 */

export interface FaqSection {
  id: string; // anchor link target
  title: string;
  intro?: string; // optional paragraph before items
  items: Array<{
    question: string;
    answer: string; // plain text, rendered with whitespace preserved
  }>;
}

export const FAQ_LAST_UPDATED = "April 8, 2026";

export const FAQ_HERO = {
  headline: "Scheduling that understands context",
  subline:
    "Most calendar tools show open slots. Envoy understands why a slot is open, " +
    "who's asking for it, and what kind of meeting it is — then negotiates the " +
    "best time on your behalf. For one-on-ones, group events, or anything in between.",
};

export const FAQ_SECTIONS: FaqSection[] = [
  // ── Section 1: What makes it different ──────────────────────────
  {
    id: "how-it-works",
    title: "What Makes Envoy Different",
    intro:
      "Traditional calendar tools show you a grid of open slots. Envoy adds three layers of " +
      "awareness on top of that grid, so the times it offers are genuinely good — not just empty.",
    items: [
      {
        question: "Layer 1: Your calendar (the base)",
        answer:
          "Envoy connects to your Google Calendar and syncs incrementally — only fetching " +
          "events that changed since the last check. It sees titles, attendee counts, your " +
          "RSVP status, and whether events are recurring. This forms the base layer of your " +
          "availability.\n\n" +
          "But unlike a basic free/busy check, Envoy understands nuance. A declined invite " +
          "means you're free. A tentative 1:1 is probably movable. A board meeting with 12 " +
          "attendees is not.",
      },
      {
        question: "Layer 2: Your preferences and scheduling context",
        answer:
          "On top of your calendar, Envoy layers in your preferences — both general and current:\n\n" +
          "General preferences: \"I surf 8-10 AM every weekday,\" \"I prefer mornings for calls,\" " +
          "\"Focus Time is flexible but don't schedule over it unless it's important.\"\n\n" +
          "Current context: \"I'm in Baja through Thursday,\" \"keep meetings short this week, " +
          "I'm recovering from travel,\" \"Katie is evaluating AgentEnvoy — treat her as a VIP.\"\n\n" +
          "These preferences are stored as structured data that directly affects scoring — not " +
          "just free text that gets ignored. When you say \"I surf 8-10 AM,\" those slots are " +
          "protected just like a calendar event.",
      },
      {
        question: "Layer 3: Event-specific context",
        answer:
          "When you create a specific meeting invite, you can give Envoy additional context " +
          "that applies only to that event:\n\n" +
          "\"Set up a call with Katie — ideally Tuesday morning.\" Envoy marks Tuesday morning " +
          "slots as preferred for Katie's invite, but your general availability stays the same " +
          "for everyone else.\n\n" +
          "\"Only offer 10-11 Tuesday and 2-3 Wednesday for the board review.\" Envoy locks " +
          "the invite to exactly those windows — nothing else is shown.\n\n" +
          "\"Nathan is a VIP — be generous with availability.\" Envoy relaxes the usual " +
          "protections for Nathan's invite, offering slots it would normally hold back.\n\n" +
          "This layering means every invite can be as broad or as narrow as the situation requires.",
      },
    ],
  },

  // ── Section 2: Getting started ──────────────────────────────────
  {
    id: "getting-started",
    title: "Getting Started",
    intro:
      "Setting up takes about 5 minutes. You'll connect your calendar and have a short " +
      "conversation with Envoy to teach it how you like to schedule.",
    items: [
      {
        question: "Step 1: Connect your calendar",
        answer:
          "Sign in with Google and grant Envoy access to your calendar. Envoy needs to read " +
          "your events to understand your schedule, and optionally write events to create " +
          "calendar invites when meetings are confirmed.\n\n" +
          "Envoy never shares your event details with guests. It uses them for its own reasoning only.",
      },
      {
        question: "Step 2: Calibrate with Envoy",
        answer:
          "On your first visit, Envoy looks at your upcoming week and asks a few questions:\n\n" +
          "- \"You have Focus Time on Wednesday. Should I protect it or treat it as flexible?\"\n" +
          "- \"Your Thursday evening is open. Should I offer evening slots?\"\n" +
          "- \"Anything not on your calendar I should protect? Workouts, commute, family time?\"\n\n" +
          "This takes 3-5 exchanges. Envoy saves what it learns — both as structured data " +
          "(blocked windows, business hours) and as general knowledge (your scheduling philosophy).\n\n" +
          "Calibration isn't one-and-done. As your calendar evolves, Envoy periodically " +
          "offers a light check-in to stay current.",
      },
      {
        question: "Step 3: Share your link",
        answer:
          "Once calibrated, you have a personal scheduling link (e.g., agentenvoy.ai/meet/yourname). " +
          "Share it anywhere — email signature, LinkedIn, Slack — and Envoy handles the rest.\n\n" +
          "When someone opens your link, they see a calendar widget with your available times " +
          "and a chat with Envoy. Envoy proposes times, answers questions, and negotiates " +
          "back and forth until a time is agreed.",
      },
    ],
  },

  // ── Section 3: Two types of invites ─────────────────────────────
  {
    id: "invite-types",
    title: "Two Types of Invites",
    items: [
      {
        question: "Your general link",
        answer:
          "Your general scheduling link (agentenvoy.ai/meet/yourname) works for anyone, " +
          "anytime. It shows availability based on your calendar and general preferences " +
          "— no event-specific context.\n\n" +
          "Put it in your email signature, share it on your website, or drop it in a Slack " +
          "message. It always shows your current availability because Envoy syncs your " +
          "calendar in real-time.\n\n" +
          "When a guest opens it, Envoy asks their name, what the meeting is about, and " +
          "proposes times. It's a full scheduling conversation, not just a slot picker.",
      },
      {
        question: "Event-specific links",
        answer:
          "When you need more control, tell Envoy to create a specific invite:\n\n" +
          "\"Set up a call with Sarah about the Q2 roadmap, ideally Tuesday.\"\n\n" +
          "Envoy creates a unique link for that meeting. It knows the guest's name, the topic, " +
          "your preferred times, the format (phone/video/in-person), and any special rules. " +
          "The calendar widget and Envoy's conversation both reflect those constraints.\n\n" +
          "You can also lock an invite to specific time slots — \"only offer 10-11 Tuesday " +
          "and 2-3 Wednesday\" — and nothing else will be shown.\n\n" +
          "Each event-specific link is unique. You can create as many as you need, each with " +
          "different rules and context.",
      },
    ],
  },

  // ── Section 4: Group scheduling ─────────────────────────────────
  {
    id: "group-events",
    title: "Group Events",
    intro:
      "Envoy can coordinate meetings with multiple people — not just one-on-ones.",
    items: [
      {
        question: "How do group invites work?",
        answer:
          "Tell Envoy to create a group event:\n\n" +
          "\"Set up a surf retreat with Sarah, Mike, Nathan, and Katie — sometime the week of April 14.\"\n\n" +
          "Envoy creates individual scheduling links for each participant. Each person has " +
          "their own private conversation with Envoy — they share their availability, ask " +
          "questions, and state preferences. Envoy sees all the responses and works to find " +
          "a window that works for everyone.\n\n" +
          "Envoy respects privacy across participants. It won't tell Katie that Mike has " +
          "therapy on Tuesday — it just says \"Tuesday afternoon doesn't work for the group.\" " +
          "It shares names and aggregate availability, not private details.",
      },
      {
        question: "How does Envoy find group overlap?",
        answer:
          "As responses come in, Envoy narrows the options:\n\n" +
          "\"Most people are free Thursday-Sunday. A couple have afternoon conflicts on Friday.\"\n\n" +
          "It doesn't wait for everyone before proposing — it starts suggesting times as " +
          "soon as patterns emerge. If 4 out of 5 agree and the last person hasn't responded, " +
          "Envoy may recommend locking it in.\n\n" +
          "The host (you) has final authority on confirmation. Envoy proposes, you decide.",
      },
    ],
  },

  // ── Section 5: Accounts ─────────────────────────────────────────
  {
    id: "accounts",
    title: "Accounts and Access",
    items: [
      {
        question: "Do guests need an account?",
        answer:
          "No. Guests can schedule with you without creating an account — they just open " +
          "your link and start chatting with Envoy.\n\n" +
          "However, if a guest creates an account and connects their own calendar, Envoy " +
          "can cross-reference both calendars to find mutually ideal times automatically. " +
          "This is optional and entirely up to the guest.",
      },
      {
        question: "What do hosts need?",
        answer:
          "Hosts need a free AgentEnvoy account (sign in with Google) and a connected " +
          "calendar. That's it. Envoy handles everything else — the scheduling page, the " +
          "chat, the calendar widget, and the confirmation flow.",
      },
    ],
  },

  // ── Section 6: Under the hood ───────────────────────────────────
  {
    id: "under-the-hood",
    title: "Under the Hood",
    intro:
      "For those curious about how it all works technically.",
    items: [
      {
        question: "How does Envoy sync with Google Calendar?",
        answer:
          "Envoy uses Google Calendar's incremental sync API. On the first connection, it " +
          "fetches all events in a 2-week window and stores a sync token. On subsequent " +
          "checks, it sends the sync token back to Google, which returns only the events " +
          "that changed since the last sync — additions, updates, and cancellations.\n\n" +
          "This means Envoy doesn't re-download your entire calendar every time. A typical " +
          "sync takes milliseconds and transfers only a handful of events. Syncs happen " +
          "automatically whenever your availability is accessed, with a 5-minute cache window.",
      },
      {
        question: "How does the scoring system work?",
        answer:
          "Every 30-minute slot in a 2-week window gets a protection score from -2 to 5:\n\n" +
          "  -2  Exclusive (event-specific: ONLY these times)\n" +
          "  -1  Preferred (event-specific: offer these first)\n" +
          "   0  Explicitly free (you declined an invite)\n" +
          "   1  Open (empty business hours)\n" +
          "   2  Soft hold (Focus Time, tentative small meetings)\n" +
          "   3  Moderate friction (tentative meetings, recurring 1:1s)\n" +
          "   4  Protected (confirmed meetings, blocked windows)\n" +
          "   5  Immovable (flights, legal, sacred items)\n\n" +
          "Scores are computed deterministically from your calendar events, blocked windows, " +
          "and business hours. The result is cached and only recomputed when the inputs change " +
          "(checked via an input hash). The computation itself is pure JavaScript — no AI " +
          "calls — and takes under 10ms.\n\n" +
          "Guests see only slots scored 2 or below. Scores 3+ are hidden entirely.",
      },
      {
        question: "How does Envoy negotiate?",
        answer:
          "Envoy uses mediation tactics to find mutually ideal times:\n\n" +
          "- It leads with the broadest, best availability — not a few random slots.\n" +
          "- It adjusts low-confidence scores (2, 3) based on meeting format, guest priority, " +
          "and day density. A phone call during Focus Time is fine; a video call isn't.\n" +
          "- When a guest counter-proposes, Envoy checks the suggested time against the " +
          "scored schedule and either confirms, offers the nearest alternative, or explains " +
          "why it doesn't work.\n" +
          "- For group events, Envoy synthesizes individual responses into aggregate overlap, " +
          "preserving privacy across participants.\n\n" +
          "The calendar widget and Envoy's chat always read from the same scored schedule, " +
          "so there's never a mismatch between what the widget shows and what Envoy says.",
      },
    ],
  },
];
