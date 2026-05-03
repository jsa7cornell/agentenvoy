"use client";

/**
 * Create-a-reusable-link suggestion picker — three type cards with
 * Calendly-influenced starter scenarios.
 *
 * Visual contract: `previews/event-links-page-redesign.html` lines 449–540.
 * Three colored cards (Bookable Hours · Recurring Sessions · Group Meeting)
 * each carry a small illustration, a short pitch, and four starter
 * scenarios. Clicking a starter prefills the chat composer with a typed
 * prompt that the agent's intent classifier routes to the right create
 * action.
 *
 * **V1 honesty note** — Recurring Sessions and Group Meeting are forward-
 * looking framings. Today the agent only fully implements Office Hours
 * (Bookable Hours). Starters from the other two cards still prefill the
 * composer — the agent will respond with what it can do today and won't
 * silently produce a wrong link. Treating the cards as IDEA carriers, not
 * type contracts.
 *
 * Mobile variant — same data, different chrome (horizontal scroll, smaller
 * starter list). Both consume `LINK_TYPE_DEFINITIONS` so copy stays in
 * exactly one place.
 */

import { useRouter } from "next/navigation";

export type LinkTypeKind = "bookable" | "recurring" | "group";

interface Starter {
  /** Bold title rendered in the starter chip (e.g. "Sales discovery"). */
  label: string;
  /** Trailing meta after the dot (e.g. "30m", "60m × 10"). */
  meta: string;
  /** Prefill text dispatched to the chat composer when the starter is
   *  picked. Phrased as a user utterance the intent classifier can route. */
  prefill: string;
}

interface LinkTypeDef {
  kind: LinkTypeKind;
  title: string;
  pitch: string;
  starters: Starter[];
  /** Tailwind classes for the soft tinted chrome (icon bg, border accent,
   *  starter chip hover). */
  classes: {
    border: string;
    iconBg: string;
    iconText: string;
    starterHover: string;
  };
  /** Inline SVG icon — kept here so each card's stroke color tokenizes
   *  cleanly with `currentColor`. */
  icon: React.ReactNode;
  /** Free-text fallback prefill for "Or start from scratch →". */
  scratchPrefill: string;
}

const ClockIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const RepeatIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <polyline points="3 4 3 10 9 10" />
  </svg>
);

const GroupIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const LINK_TYPE_DEFINITIONS: LinkTypeDef[] = [
  {
    kind: "bookable",
    title: "Bookable Hours Links",
    pitch:
      "Purpose-built links for specific meetings with specific hours or preferences — share once, people pick a slot, Envoy books it.",
    starters: [
      { label: "Sales discovery", meta: "30m", prefill: "Create a sales discovery link — 30 min slots, weekday afternoons" },
      { label: "Customer office hours", meta: "30m", prefill: "Create a customer office hours link — 30 min slots, weekly" },
      { label: "Mentor / advisor sessions", meta: "45m", prefill: "Create a mentor sessions link — 45 min slots" },
      { label: "Candidate screens", meta: "30m", prefill: "Create a candidate screen link — 30 min slots, weekday mornings" },
    ],
    classes: {
      border: "border-l-[3px] border-cyan-600",
      iconBg: "bg-cyan-100 dark:bg-cyan-950/40",
      iconText: "text-cyan-700 dark:text-cyan-300",
      starterHover: "hover:bg-cyan-50 dark:hover:bg-cyan-950/30",
    },
    icon: ClockIcon,
    scratchPrefill: "Create a reusable link — ",
  },
  {
    kind: "recurring",
    title: "Recurring Sessions Links",
    pitch:
      "Purpose-built links for multi-session programs — every booking spins up the whole series for that guest.",
    starters: [
      { label: "Music / language lessons", meta: "60m × 10", prefill: "Create a recurring lessons link — 60 min, 10 sessions" },
      { label: "Coaching program", meta: "45m × 8", prefill: "Create a coaching program link — 45 min, 8 sessions" },
      { label: "Tutoring sessions", meta: "30m × weekly", prefill: "Create a tutoring link — 30 min, weekly" },
      { label: "Customer check-ins", meta: "30m × monthly", prefill: "Create a customer check-in link — 30 min, monthly" },
    ],
    classes: {
      border: "border-l-[3px] border-amber-600",
      iconBg: "bg-amber-100 dark:bg-amber-950/40",
      iconText: "text-amber-700 dark:text-amber-300",
      starterHover: "hover:bg-amber-50 dark:hover:bg-amber-950/30",
    },
    icon: RepeatIcon,
    scratchPrefill: "Create a recurring sessions link — ",
  },
  {
    kind: "group",
    title: "Group Meeting Links",
    pitch:
      "Purpose-built links for events with many guests — Envoy negotiates a time everyone can make.",
    starters: [
      { label: "Workshop / class", meta: "90m", prefill: "Create a workshop link — 90 min, group event" },
      { label: "Team kickoff", meta: "60m", prefill: "Create a team kickoff link — 60 min, group event" },
      { label: "Founder dinner", meta: "2h", prefill: "Create a founder dinner link — 2 hours, group event" },
      { label: "Panel interview", meta: "45m", prefill: "Create a panel interview link — 45 min, group event" },
    ],
    classes: {
      border: "border-l-[3px] border-pink-600",
      iconBg: "bg-pink-100 dark:bg-pink-950/40",
      iconText: "text-pink-700 dark:text-pink-300",
      starterHover: "hover:bg-pink-50 dark:hover:bg-pink-950/30",
    },
    icon: GroupIcon,
    scratchPrefill: "Create a group meeting link — ",
  },
];

interface CreateLinkPickerProps {
  /** Optional className for outer container (e.g. for layout overrides). */
  className?: string;
}

/**
 * Stash a prefill in sessionStorage and route home so the chat composer
 * picks it up on mount. Same one-shot semantics as the existing
 * `handleCreateReusable` flow on the page (CustomEvent dispatch races the
 * mount; sessionStorage doesn't).
 */
function dispatchPrefill(text: string, push: (path: string) => void) {
  if (typeof window !== "undefined") {
    try {
      sessionStorage.setItem("envoy:pending-prefill", text);
    } catch {
      // sessionStorage can throw in private-mode browsers — fall through
      // to navigation; user will land on dashboard with no prefill.
    }
  }
  push("/dashboard");
}

export function CreateLinkPicker({ className = "" }: CreateLinkPickerProps) {
  const router = useRouter();

  return (
    <section
      aria-labelledby="create-link-heading"
      className={className}
      data-testid="desktop-event-links-create-picker"
    >
      <div className="mb-4">
        <h3
          className="text-[11px] font-semibold tracking-wider uppercase text-muted mb-1"
          id="create-link-eyebrow"
        >
          Create a reusable link
        </h3>
        <h2
          id="create-link-heading"
          className="text-base font-semibold text-primary"
        >
          What kind of meeting do you want a link for?
        </h2>
        <p className="text-xs text-muted mt-1 max-w-2xl">
          Reusable links carry your hours, duration, and rules — share once and
          Envoy handles every booking. Pick a starter or customize.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {LINK_TYPE_DEFINITIONS.map((def) => (
          <div
            key={def.kind}
            className={`rounded-xl border border-secondary bg-surface-secondary/40 ${def.classes.border} flex flex-col`}
            data-testid={`desktop-create-card-${def.kind}`}
          >
            {/* Title row */}
            <div className="flex items-center gap-2 px-4 pt-4">
              <span
                className={`flex items-center justify-center w-6 h-6 rounded-md ${def.classes.iconBg} ${def.classes.iconText}`}
                aria-hidden
              >
                {def.icon}
              </span>
              <h4 className="text-sm font-semibold text-primary">{def.title}</h4>
            </div>

            <p className="text-[11.5px] text-muted leading-relaxed px-4 mt-1.5 mb-3">
              {def.pitch}
            </p>

            {/* Starters */}
            <div className="px-4 pb-2">
              <div className="text-[10px] font-semibold tracking-wider uppercase text-muted mb-1.5">
                Pick a starter
              </div>
              <div className="flex flex-col gap-1">
                {def.starters.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => dispatchPrefill(s.prefill, router.push)}
                    className={`flex items-center justify-between text-left text-[12px] px-2.5 py-1.5 rounded-md text-secondary ${def.classes.starterHover} transition-colors group`}
                    data-testid={`desktop-create-starter-${def.kind}-${s.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  >
                    <span className="truncate">
                      <span className="font-semibold text-primary">{s.label}</span>
                      <span className="text-muted"> · {s.meta}</span>
                    </span>
                    <span className="text-muted opacity-0 group-hover:opacity-100 transition-opacity ml-2 flex-shrink-0">
                      →
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Or start from scratch */}
            <button
              type="button"
              onClick={() => dispatchPrefill(def.scratchPrefill, router.push)}
              className="border-t border-secondary px-4 py-2.5 text-[11.5px] text-accent hover:text-accent/80 transition-colors text-left mt-auto"
              data-testid={`desktop-create-scratch-${def.kind}`}
            >
              Or start from scratch →
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Mobile horizontal-scroll variant — same data, condensed chrome.
 * Per `previews/event-links-mobile-and-edit-flow.html` Track 1 option A
 * (the H-scroll approach the user picked).
 */
export function CreateLinkPickerMobile({ className = "" }: CreateLinkPickerProps) {
  const router = useRouter();

  return (
    <section
      aria-labelledby="create-link-mobile-heading"
      className={className}
      data-testid="mobile-event-links-create-picker"
    >
      <h3
        id="create-link-mobile-heading"
        className="text-[10px] font-semibold tracking-wider uppercase text-muted px-4 mb-2"
      >
        Create a reusable link
      </h3>

      <div
        className="flex gap-2 overflow-x-auto px-4 pb-2 snap-x snap-mandatory"
        style={{ scrollbarWidth: "none" }}
      >
        {LINK_TYPE_DEFINITIONS.map((def) => (
          <div
            key={def.kind}
            className={`flex-shrink-0 w-[260px] snap-start rounded-xl border border-secondary bg-surface-secondary/40 border-t-[3px] ${def.classes.border.replace("border-l-", "border-t-")}`}
            data-testid={`mobile-create-card-${def.kind}`}
          >
            <div className="flex items-center gap-2 px-3 pt-3">
              <span
                className={`flex items-center justify-center w-6 h-6 rounded-md ${def.classes.iconBg} ${def.classes.iconText}`}
                aria-hidden
              >
                {def.icon}
              </span>
              <h4 className="text-[13px] font-semibold text-primary">{def.title.replace(" Links", "")}</h4>
            </div>
            <p className="text-[11px] text-muted leading-snug px-3 mt-1.5 mb-2">{def.pitch}</p>
            <button
              type="button"
              onClick={() => dispatchPrefill(def.scratchPrefill, router.push)}
              className="px-3 pb-2.5 text-[11px] text-accent hover:text-accent/80 transition-colors"
              data-testid={`mobile-create-setup-${def.kind}`}
            >
              Set up →
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
