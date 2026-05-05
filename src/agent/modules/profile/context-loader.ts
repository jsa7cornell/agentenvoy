/**
 * Profile module context loader.
 *
 * Reads profile gaps via `computeProfileGaps` and renders them into the
 * CONTEXT block as opportunity-hints. Mirrors the prior dispatch-handler
 * profile path (chat/route.ts:428-432 + dispatch-handler.ts:204-215) so
 * observable behavior is preserved.
 *
 * Test seam: `__testProfileGapHints` injects fixed hints; production calls
 * `computeProfileGaps(userId)`.
 */
import { computeProfileGaps } from "@/lib/profile-gaps";
import type {
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
} from "@/agent/modules/types";

export interface ProfileContext extends ModuleContextOutput {
  gapHints: string[];
}

export interface ProfileContextTestInjection {
  __testProfileGapHints?: string[];
}

const GAP_PREAMBLE = [
  "These are opportunities, not blockers. Weave them into the turn only if they fit naturally; never lecture the user.",
  "Never save a value that the host mentions in passing — always require an explicit confirmation turn from the host before calling any profile-write action.",
  "Profile writes must reflect the host's confirmed intent, not a parsed mention.",
];

function renderGapsLines(hints: readonly string[]): string[] {
  if (hints.length === 0) return [];
  return [
    "Profile gaps:",
    ...hints.map((h) => `- ${h}`),
    "",
    ...GAP_PREAMBLE,
  ];
}

export async function loadProfileContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  userMessage: string,
): Promise<ProfileContext> {
  void matchResult;
  void userMessage;

  const ctx = moduleContext as ModuleContext & ProfileContextTestInjection;
  if (ctx.__testProfileGapHints) {
    return {
      contextLines: renderGapsLines(ctx.__testProfileGapHints),
      gapHints: [...ctx.__testProfileGapHints],
    };
  }

  let hints: string[] = [];
  try {
    const gaps = await computeProfileGaps(moduleContext.user.id);
    hints = gaps.map((g) => g.hint);
  } catch (e) {
    console.warn(
      `[profile/context-loader] computeProfileGaps failed for ${moduleContext.user.id}:`,
      e,
    );
  }

  return {
    contextLines: renderGapsLines(hints),
    gapHints: hints,
  };
}
