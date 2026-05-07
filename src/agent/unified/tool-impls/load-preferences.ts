import { prisma } from "@/lib/prisma";
import type { UserPreferences } from "@/lib/scoring";

type LoadPreferencesResult = {
  preferences: UserPreferences;
  persistentKnowledge: string | null;
  upcomingSchedulePreferences: string | null;
  hostDirectives: string | null;
  note: string;
};

/**
 * Returns the host's preferences, availability rules, and knowledge fields.
 * Used before editing rules, preferences, or knowledge.
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

  return {
    preferences: (user?.preferences as UserPreferences | null) ?? {},
    persistentKnowledge: (user?.persistentKnowledge as string | null) ?? null,
    upcomingSchedulePreferences: (user?.upcomingSchedulePreferences as string | null) ?? null,
    hostDirectives: (user?.hostDirectives as string | null) ?? null,
    note: "Loaded host preferences and knowledge.",
  };
}
