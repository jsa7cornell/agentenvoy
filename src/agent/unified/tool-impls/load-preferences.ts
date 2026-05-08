import { prisma } from "@/lib/prisma";
import type { UserPreferences } from "@/lib/scoring";
import type { AvailabilityRule } from "@/lib/availability-rules";

const MAX_ENTRIES = 30;

type RuleProjection = {
  id: string;
  label?: string;
  action: AvailabilityRule["action"];
  type: AvailabilityRule["type"];
  status: AvailabilityRule["status"];
  daysOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
};

type BookableLinkProjection = {
  id: string;
  code: string;
  name: string;
  format: "video" | "phone" | "in-person";
  durationMinutes: number;
  archived: boolean;
};

type LoadPreferencesResult = {
  preferences: UserPreferences;
  persistentKnowledge: string | null;
  upcomingSchedulePreferences: string | null;
  hostDirectives: string | null;
  availabilityRules: RuleProjection[];
  availabilityRulesOverflow: number;
  bookableLinks: BookableLinkProjection[];
  bookableLinksOverflow: number;
  note: string;
};

/**
 * Returns the host's preferences, availability rules, bookable links, and
 * knowledge fields. Used before editing rules, bookable links, or knowledge —
 * the agent grounds rule_update / rule_remove / bookable_link_update /
 * bookable_link_set_archived calls in the IDs/codes returned here.
 *
 * Rules and bookable links both live in `preferences.explicit.structuredRules`
 * (no separate Prisma model). Bookable links are rules with `action === "bookable"`
 * and a populated `bookable` block; their `code` is `bookable.linkCode` —
 * what `personal_link_create.seedFromBookableCode` resolves against.
 *
 * Lists are capped at 30 entries each. Full rule bodies (timeStart/timeEnd/
 * daysOfWeek/etc.) are intentionally omitted from non-bookable rules beyond a
 * concise identifying projection — the action handlers read full state from
 * the source on edit. Expired rules (status === "expired") are excluded;
 * paused bookables are returned with `archived: true` so the agent can
 * unarchive them.
 */
export async function loadPreferences(userId: string): Promise<LoadPreferencesResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      preferences: true,
      persistentKnowledge: true,
      upcomingSchedulePreferences: true,
      hostDirectives: true,
    },
  });

  const preferences = (user?.preferences as UserPreferences | null) ?? {};
  const explicit = (preferences.explicit ?? {}) as UserPreferences["explicit"] & {
    structuredRules?: AvailabilityRule[];
  };
  const allRules = (explicit?.structuredRules ?? []).filter(
    (r) => r && r.status !== "expired",
  );

  // Bookable links are rules with action === "bookable" AND a populated bookable block.
  const bookableRules = allRules.filter(
    (r): r is AvailabilityRule & { bookable: NonNullable<AvailabilityRule["bookable"]> } =>
      r.action === "bookable" && !!r.bookable,
  );
  // Non-bookable rules — anything else surfaced for rule_update / rule_remove grounding.
  const nonBookableRules = allRules.filter(
    (r) => !(r.action === "bookable" && r.bookable),
  );

  const availabilityRules: RuleProjection[] = nonBookableRules
    .slice(0, MAX_ENTRIES)
    .map((r) => {
      const out: RuleProjection = {
        id: r.id,
        action: r.action,
        type: r.type,
        status: r.status,
      };
      if (r.originalText) out.label = r.originalText;
      if (r.daysOfWeek?.length) out.daysOfWeek = r.daysOfWeek;
      if (r.timeStart) out.timeStart = r.timeStart;
      if (r.timeEnd) out.timeEnd = r.timeEnd;
      return out;
    });
  const availabilityRulesOverflow = Math.max(0, nonBookableRules.length - availabilityRules.length);

  const bookableLinks: BookableLinkProjection[] = bookableRules
    .slice(0, MAX_ENTRIES)
    .map((r) => ({
      id: r.id,
      code: r.bookable.linkCode,
      name: r.bookable.name ?? r.bookable.title,
      format: r.bookable.format,
      durationMinutes: r.bookable.durationMinutes,
      archived: r.status === "paused",
    }));
  const bookableLinksOverflow = Math.max(0, bookableRules.length - bookableLinks.length);

  const noteParts: string[] = [
    `${availabilityRules.length} rule(s)` +
      (availabilityRulesOverflow > 0 ? ` (+${availabilityRulesOverflow} more)` : ""),
    `${bookableLinks.length} bookable link(s)` +
      (bookableLinksOverflow > 0 ? ` (+${bookableLinksOverflow} more)` : ""),
  ];

  return {
    preferences,
    persistentKnowledge: (user?.persistentKnowledge as string | null) ?? null,
    upcomingSchedulePreferences: (user?.upcomingSchedulePreferences as string | null) ?? null,
    hostDirectives: (user?.hostDirectives as string | null) ?? null,
    availabilityRules,
    availabilityRulesOverflow,
    bookableLinks,
    bookableLinksOverflow,
    note: `Loaded host preferences and knowledge. ${noteParts.join(", ")}.`,
  };
}
