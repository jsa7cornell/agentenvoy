/**
 * FAQ content for how Envoy's calendar and availability system works.
 * Update this file as the product evolves — the /faq page reads from it.
 */

export interface FaqSection {
  title: string;
  items: Array<{
    question: string;
    answer: string; // plain text, rendered with whitespace preserved
  }>;
}

export const FAQ_LAST_UPDATED = "April 7, 2026";

export const FAQ_SECTIONS: FaqSection[] = [
  {
    title: "How Envoy Reads Your Calendar",
    items: [
      {
        question: "Where does Envoy get my availability?",
        answer:
          "Envoy combines two sources to build your availability:\n\n" +
          "1. External calendar — your Google Calendar (or other connected calendars). Envoy syncs incrementally using Google's sync tokens, so changes show up within minutes.\n\n" +
          "2. Internal calendar — your preferences, blocked windows, and knowledge base from your profile page. Things like \"I surf 8-10 AM\" or \"no meetings before 10\" directly affect which slots Envoy offers.",
      },
      {
        question: "How often does Envoy sync my calendar?",
        answer:
          "Envoy checks for calendar changes whenever someone views your availability, with a 5-minute cache window. It uses Google's incremental sync, meaning it only fetches events that changed since the last check — not your entire calendar every time. This keeps it fast and efficient.",
      },
      {
        question: "Can Envoy see all my calendar details?",
        answer:
          "Envoy sees event titles, times, attendee counts, your RSVP status, and whether events are recurring. It uses this to make smart decisions about what to protect vs. offer. Envoy never shares your event details with guests — it only uses them for its own reasoning.",
      },
    ],
  },
  {
    title: "Protection Scores",
    items: [
      {
        question: "What are protection scores?",
        answer:
          "Every 30-minute slot on your calendar gets a protection score from -2 to 5. Lower scores = more available. Envoy uses these scores to decide what to offer guests and what to protect.\n\n" +
          "Here's the scale:\n" +
          "  -2  Exclusive — you've locked this event to ONLY these times\n" +
          "  -1  Preferred — you actively want to fill these slots\n" +
          "   0  Explicitly free — you declined an invite here\n" +
          "   1  Open — empty business hours, no conflicts\n" +
          "   2  Soft hold — Focus Time, tentative small meetings\n" +
          "   3  Moderate friction — tentative meetings, recurring 1:1s\n" +
          "   4  Protected — confirmed meetings, blocked windows, weekends\n" +
          "   5  Immovable — flights, legal proceedings, sacred items",
      },
      {
        question: "What do guests see?",
        answer:
          "Guests only see slots scored 2 or below (open, free, and soft holds). Anything scored 3 or higher is hidden from them entirely. In exclusive mode (score -2), guests see only the specific times you approved.\n\n" +
          "The calendar widget and Envoy's chat always show the same availability — they read from the same scored data, so there's never a mismatch.",
      },
      {
        question: "Can Envoy adjust scores on its own?",
        answer:
          "Scores 2 and 3 are \"low confidence\" — Envoy can adjust them based on context. For example, a phone call reduces friction by 1 point (you can take calls during Focus Time), and a VIP guest also reduces friction by 1 point.\n\n" +
          "Scores 0, 1, 4, and 5 are ground truth. Envoy never overrides them without your permission.",
      },
    ],
  },
  {
    title: "Setting Your Preferences",
    items: [
      {
        question: "How do I block recurring time (like workouts or surfing)?",
        answer:
          "Tell Envoy in the dashboard chat. Say something like \"I surf 8-10 AM every weekday\" and Envoy will create a blocked window that protects those slots (score 4). You can also set blocked windows on your profile page.\n\n" +
          "Blocked windows work just like calendar events — they're scored, cached, and respected by both the widget and Envoy's chat.",
      },
      {
        question: "What's the difference between persistent preferences and upcoming context?",
        answer:
          "Persistent preferences are things that rarely change — \"I prefer mornings,\" \"I never take calls before 9 AM,\" \"Focus Time is flexible.\" These shape Envoy's behavior long-term.\n\n" +
          "Upcoming context is near-term — \"I'm in Baja this week,\" \"keep meetings short, I'm recovering from travel.\" This overrides persistent preferences when there's a conflict.",
      },
      {
        question: "What happens when I create a specific meeting link?",
        answer:
          "When you tell Envoy to set up a meeting with someone, it creates a contextual link with rules tailored to that meeting — preferred days, time windows, format, duration. These rules create a per-event availability view on top of your base availability.\n\n" +
          "For example, if you say \"set up a call with Katie, ideally Tuesday morning,\" Envoy marks Tuesday morning slots as preferred (score -1) for that specific link. Katie sees those highlighted in the widget.",
      },
    ],
  },
  {
    title: "The Availability Pipeline",
    items: [
      {
        question: "How does availability flow from calendar to guest?",
        answer:
          "It's a progressive pipeline with three layers:\n\n" +
          "Layer 1: Base Availability\n" +
          "Your Google Calendar events + profile preferences + blocked windows are merged and scored. This is cached and only recomputed when something changes.\n\n" +
          "Layer 2: Event-Level Overrides\n" +
          "When you create a meeting link, your conversation with Envoy can add per-event rules — preferred times, exclusive slots, format constraints. These adjust the base scores for that specific guest.\n\n" +
          "Layer 3: Contextual Judgment\n" +
          "Envoy applies real-time judgment on top of scores — adjusting low-confidence slots based on meeting format, guest priority, and day density. The widget shows the scored view; Envoy's chat adds contextual reasoning.",
      },
      {
        question: "Do the calendar widget and Envoy's chat always agree?",
        answer:
          "Yes. Both read from the same pre-scored schedule. The widget shows slots visually; Envoy references the same scores in conversation. If you tell Envoy \"only offer these 5 slots,\" the widget shows only those 5 and Envoy's text reflects the same constraint.",
      },
    ],
  },
  {
    title: "Calibration",
    items: [
      {
        question: "What is calibration?",
        answer:
          "The first time you use Envoy, it runs a short conversational calibration — looking at your calendar for the next week and asking about judgment calls. For example: should Focus Time be protected or flexible? Are evening slots off-limits? Is there anything not on your calendar that Envoy should know about?\n\n" +
          "This takes 3-5 exchanges and teaches Envoy how to handle your specific schedule.",
      },
      {
        question: "Does Envoy re-calibrate?",
        answer:
          "If it's been 10+ days since your last calibration, or if Envoy notices you've been overriding its proposals frequently, it'll offer a light check-in — not a full re-calibration, just 2-3 questions about what's changed.",
      },
    ],
  },
];

/**
 * ASCII diagram of the availability pipeline.
 * Rendered in a <pre> block on the FAQ page.
 */
export const PIPELINE_DIAGRAM = `
  External Calendar          Internal Calendar
  (Google Calendar)          (Profile Page)
        |                          |
        |  sync every 5 min        |  blocked windows,
        |  via incremental sync    |  business hours,
        |                          |  knowledge base
        v                          v
  +------------------------------------------+
  |        Base Availability (cached)        |
  |   Every 30-min slot scored 0-5           |
  |   Recomputed only when inputs change     |
  +------------------------------------------+
                    |
                    v
  +------------------------------------------+
  |       Per-Event Overrides (on-the-fly)   |
  |   Host dialog adds -2, -1 scores         |
  |   Preferred days, exclusive slots         |
  +------------------------------------------+
                    |
          +---------+---------+
          |                   |
          v                   v
    Calendar Widget      Envoy Chat
    (same scores)        (same scores
                          + context)
`.trim();
