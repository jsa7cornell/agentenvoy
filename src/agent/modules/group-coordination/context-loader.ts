/**
 * Group coordination module context loader.
 *
 * Injects:
 *   - Host name + timezone
 *   - GroupCoordination state (if a session is in scope)
 *   - Response count + who has responded
 *   - Activity suggestions collected so far
 *
 * Pre-flight phase (no session yet): contextLines carry only host identity
 * and current time — the LLM handles the gathering conversation and emits
 * create_link when the host confirms. The create_link handler mints a
 * GroupCoordination row (Model A, decided 2026-05-06).
 */
import { prisma } from "@/lib/prisma";
import { getUserTimezone, shortTimezoneLabel } from "@/lib/timezone";
import type {
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
} from "@/agent/modules/types";
import type { UserPreferences } from "@/lib/scoring";

export interface GroupCoordinationContext extends ModuleContextOutput {
  hostTimezone: string | null;
  tzLabel: string | null;
  /** Resolved sessionId when an active group session is in scope. */
  sessionId: string | null;
  /** Number of participants who have responded so far. */
  responseCount: number;
}

export async function loadGroupCoordinationContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  __userMessage: string,
): Promise<GroupCoordinationContext> {
  const userId = moduleContext.user.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });

  const prefs = (user?.preferences ?? null) as UserPreferences | null;
  const hostTimezone = getUserTimezone(prefs as Record<string, unknown> | null);
  const tzLabel = hostTimezone ? shortTimezoneLabel(hostTimezone) : null;

  const now = new Date().toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(hostTimezone ? { timeZone: hostTimezone } : {}),
  });

  const contextLines: string[] = [
    `Host: ${moduleContext.user.name ?? "unknown"} (${moduleContext.user.email})`,
    `Current time: ${now}`,
  ];

  // Resolve sessionId from deterministic match (if host is checking an in-flight session)
  let sessionId: string | null = null;
  let responseCount = 0;

  if (matchResult.kind === "deterministic" && matchResult.resolved.sessionId) {
    sessionId = matchResult.resolved.sessionId;

    const gc = await prisma.groupCoordination.findUnique({
      where: { sessionId },
      select: { responses: true, status: true, suggestionsEnabled: true, synthesisVersion: true },
    });

    if (gc) {
      const responses = Array.isArray(gc.responses) ? gc.responses as Array<{ person?: string }> : [];
      responseCount = responses.length;
      const respondents = responses.map((r) => r.person ?? "unknown").join(", ");

      contextLines.push(`Group session: ${sessionId}`);
      contextLines.push(`Status: ${gc.status}`);
      contextLines.push(`Responses received: ${responseCount}${responseCount > 0 ? ` (${respondents})` : ""}`);
      contextLines.push(`Synthesis version: ${gc.synthesisVersion}`);

      if (gc.suggestionsEnabled) {
        const suggestions = await prisma.activitySuggestion.findMany({
          where: { sessionId },
          select: { person: true, category: true, value: true },
          orderBy: { createdAt: "asc" },
        });
        if (suggestions.length > 0) {
          const suggestionLines = suggestions
            .map((s) => `  ${s.person} [${s.category}]: ${s.value}`)
            .join("\n");
          contextLines.push(`Suggestions:\n${suggestionLines}`);
        }
      }
    }
  } else {
    contextLines.push("Phase: pre-flight (no active group session)");
    contextLines.push(
      "Guide the host through: event title, participant list, candidate windows, " +
        "and what you'll ask participants. When host confirms, emit create_link.",
    );
  }

  return {
    contextLines,
    hostTimezone,
    tzLabel,
    sessionId,
    responseCount,
  };
}
