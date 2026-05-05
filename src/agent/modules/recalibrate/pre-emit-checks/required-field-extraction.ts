/**
 * `requiredFieldExtractionCheck` — preEmitCheck for the recalibrate module.
 *
 * Multi-action-emit fidelity guard for the conversational calibration arc
 * (especially the `first-time` variant). Catches two failure modes:
 *
 *   F4 (silent omission) — the user names N distinct fields in one turn,
 *      the composer extracts only a subset (e.g., user said "I do MWF,
 *      25-minute meetings, protect lunchtime" — composer emits the rule
 *      for MWF + lunch protection but skips the `defaultDuration: 25`
 *      update_meeting_settings).
 *
 *   F14 (fabrication) — the composer emits an action whose field/value
 *      doesn't appear anywhere in the user's current message (e.g., user
 *      said nothing about phone; composer emits
 *      `update_meeting_settings { phone: "..." }`).
 *
 * Per proposal `2026-05-05_conversational-onboarding-vision` Author Response
 * B4: this check ships in PR-A; bench fixtures land in PR-D.
 *
 * Severity: advisory. When retries exhaust, ship the original emission
 * with `moduleGuard.requiredFieldExtractionCheck.exhaustedRetries: true`
 * per Rule 25(i). The fidelity loss is recorded for telemetry but does
 * not block the user-facing turn — the alternative (blocking) would
 * silently drop legitimate emissions when the heuristic mis-classifies.
 *
 * Heuristic shape: light token / regex matching against a known
 * field-vocabulary list. False positives are expected (the heuristic
 * doesn't understand semantics; it sees lexical hooks). Severity advisory
 * means false positives cost a retry, not a dropped action.
 */
import type { PreEmitCheck } from "@/agent/modules/types";
import type { RecalibrateContext } from "../context-loader";

// ---------------------------------------------------------------------------
// Field vocabulary — lexical hooks the user uses for each scheduling field
// ---------------------------------------------------------------------------

/** Field-vocabulary entry: a logical field name + the action types that
 *  carry it + the regex/token patterns that signal the user named it. */
interface FieldVocabulary {
  /** Canonical field name (used for telemetry + hint construction). */
  field: string;
  /** Action types that legitimately carry this field. An emission of one
   *  of these action types whose params reference the field is the
   *  "extraction" we're checking for. */
  actionTypes: ReadonlySet<string>;
  /** Per-action-type predicate: did the emitted params actually include
   *  this field? Keeps the action-type → field mapping local. */
  paramKeys?: ReadonlySet<string>;
  /** Regex (case-insensitive) — matches a substring of the user's message
   *  when the user has named this field. */
  patterns: readonly RegExp[];
}

// Common day-of-week tokens (used by availability + protection rules).
const DOW_PATTERN = /\b(?:mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mwf|tth|tr|weekday|weekend|every day|daily|each day)s?\b/i;

const FIELD_VOCAB: readonly FieldVocabulary[] = [
  {
    field: "timezone",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["timezone"]),
    patterns: [
      /\b(?:tz|time ?zone|timezone)\b/i,
      // Common IANA region prefixes + colloquial names.
      /\b(?:america|europe|asia|africa|australia|pacific|atlantic)\/[a-z_]+/i,
      /\b(?:est|edt|cst|cdt|mst|mdt|pst|pdt|gmt|utc|bst|cet)\b/i,
      /\b(?:eastern|central|mountain|pacific) (?:time|standard time|daylight time)\b/i,
    ],
  },
  {
    field: "defaultDuration",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["defaultDuration", "duration"]),
    patterns: [
      // "25 min", "30-minute", "1 hour", "90 minutes"
      /\b\d{1,3}\s*(?:-|\s)?\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours)\b/i,
    ],
  },
  {
    field: "defaultBuffer",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["defaultBuffer", "buffer"]),
    patterns: [/\bbuffer\b/i, /\bbreathing room\b/i, /\bgap between\b/i],
  },
  {
    field: "defaultFormat",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["defaultFormat", "format"]),
    patterns: [
      /\b(?:zoom|google ?meet|gmeet|meet|teams|webex)\b/i,
      /\b(?:phone|call|dial in|dial-in|telephone)\b/i,
      /\b(?:in[- ]person|in office|at the office|coffee shop)\b/i,
      /\b(?:video|video call|video meeting)\b/i,
    ],
  },
  {
    field: "phone",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["phone", "phoneNumber"]),
    patterns: [
      /\bphone (?:number|#)\b/i,
      /\b\+?\d[\d\s().-]{6,}\b/, // bare phone-shaped digits
    ],
  },
  {
    field: "videoLink",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["videoLink", "zoom_link", "zoomLink"]),
    patterns: [
      /\bzoom\.us\//i,
      /\bmeet\.google\.com\//i,
      /\bteams\.microsoft\.com\//i,
      /\bvideo (?:link|url)\b/i,
    ],
  },
  {
    field: "businessHours",
    actionTypes: new Set(["update_business_hours", "update_meeting_settings"]),
    paramKeys: new Set([
      "businessHoursStart",
      "businessHoursEnd",
      "start",
      "end",
      "hours",
    ]),
    patterns: [
      /\bbusiness hours?\b/i,
      /\bworking hours?\b/i,
      /\bwork hours?\b/i,
      /\b(?:from\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\s*(?:-|to|–|—)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\b/i,
    ],
  },
  {
    field: "availabilityRule",
    actionTypes: new Set(["update_availability_rule"]),
    patterns: [
      // Protection / blocking phrasing.
      /\b(?:protect|block|keep .*free|never|don't (?:let|book)|no meetings)\b/i,
      // Time-of-day windows that imply availability/protection rules.
      /\b(?:lunch ?time|lunch|morning|afternoon|evening|midday|noon)\b/i,
      // Day-window phrasing.
      DOW_PATTERN,
    ],
  },
  {
    field: "guestFlex",
    actionTypes: new Set(["update_meeting_settings"]),
    paramKeys: new Set(["guestFlex"]),
    patterns: [/\b(?:guest|other person|the other side) (?:can|may|should)\b/i, /\bflex(?:ible)?\b/i],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the set of field names the user appears to have named in the
 *  current message based on lexical hooks. */
function fieldsNamedByUser(userMessage: string): Set<string> {
  const named = new Set<string>();
  for (const entry of FIELD_VOCAB) {
    for (const pat of entry.patterns) {
      if (pat.test(userMessage)) {
        named.add(entry.field);
        break;
      }
    }
  }
  return named;
}

/** Returns the set of field names the emitted actions appear to update. */
function fieldsEmittedByActions(
  parsedActions: ReadonlyArray<{ action: string; params: Record<string, unknown> }>,
): Set<string> {
  const emitted = new Set<string>();
  for (const action of parsedActions) {
    for (const entry of FIELD_VOCAB) {
      if (!entry.actionTypes.has(action.action)) continue;
      // For action types that don't have specific paramKeys (e.g.,
      // update_availability_rule covers any rule edit), any emission of
      // that action type counts as "field emitted".
      if (!entry.paramKeys || entry.paramKeys.size === 0) {
        emitted.add(entry.field);
        continue;
      }
      for (const pk of entry.paramKeys) {
        if (pk in action.params) {
          emitted.add(entry.field);
          break;
        }
      }
    }
  }
  return emitted;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export const requiredFieldExtractionCheck: PreEmitCheck<RecalibrateContext> = {
  name: "required-field-extraction-check",
  severity: "advisory",
  check: async ({ parsedActions, contextOutput, moduleContext }) => {
    // The contextLoader stashes the current host turn on the context
    // output so this check can run lexical matching against it without
    // requiring a runner-level args change. See `RecalibrateContext`.
    const userMessage = contextOutput.currentUserMessage;
    if (!userMessage) return null;

    // Only run on emissions that contain at least one action this check
    // cares about. If the composer emitted only out-of-scope actions
    // (none should — allowedActions enforcement runs after this), there's
    // nothing to compare against.
    const relevantActions = parsedActions.filter((a) =>
      FIELD_VOCAB.some((v) => v.actionTypes.has(a.action)),
    ) as Array<{ action: string; params: Record<string, unknown> }>;
    if (relevantActions.length === 0) return null;

    const namedByUser = fieldsNamedByUser(userMessage);
    const emittedByActions = fieldsEmittedByActions(relevantActions);

    // Branch 1 — silent omission: user named a field; no corresponding
    // emission. Skip when the user named NO fields (the heuristic has
    // nothing to assert).
    const omitted: string[] = [];
    if (namedByUser.size > 0) {
      for (const f of namedByUser) {
        if (!emittedByActions.has(f)) omitted.push(f);
      }
    }

    // Branch 2 — fabrication: emission references a field the user
    // didn't name. Tighter constraint — only flags fields with explicit
    // paramKeys (so we don't accuse update_availability_rule of making
    // up a rule when the user said "protect lunch" — the rule is the
    // correct emission shape even if our patterns are noisy).
    const fabricated: string[] = [];
    for (const f of emittedByActions) {
      const entry = FIELD_VOCAB.find((v) => v.field === f);
      if (!entry || !entry.paramKeys || entry.paramKeys.size === 0) continue;
      if (!namedByUser.has(f)) fabricated.push(f);
    }

    if (omitted.length === 0 && fabricated.length === 0) return null;

    const moduleSurface = moduleContext.surface;
    const variant = contextOutput.isFirstTime
      ? "recalibrate.first-time"
      : "recalibrate";

    const reasonParts: string[] = [];
    if (omitted.length > 0) {
      reasonParts.push(`silent-omission: user named [${omitted.join(", ")}] but no emission carries those fields`);
    }
    if (fabricated.length > 0) {
      reasonParts.push(`fabrication: emission carries [${fabricated.join(", ")}] but the user didn't name those fields`);
    }

    const hintLines: string[] = [
      `Multi-action-emit fidelity check fired on ${variant} (${moduleSurface}). ${reasonParts.join("; ")}.`,
    ];
    if (omitted.length > 0) {
      hintLines.push(
        `The user named these fields in their last message: ${[...namedByUser].join(", ")}. Re-emit, making sure every distinct field the user named has its own structured action. If a field's value is ambiguous, ask in prose rather than fabricate.`,
      );
    }
    if (fabricated.length > 0) {
      hintLines.push(
        `The fields ${fabricated.join(", ")} weren't in the user's message. Don't infer values the user didn't supply — drop those emissions and either ask for the missing detail or leave the field alone.`,
      );
    }

    return {
      flaggedReason: `required-field-extraction-${omitted.length > 0 ? "omission" : "fabrication"}`,
      hint: hintLines.join("\n"),
    };
  },
};
