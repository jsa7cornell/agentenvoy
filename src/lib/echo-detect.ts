/**
 * Deterministic near-verbatim echo detector.
 *
 * Proposal: 2026-04-22_chat-intent-router-context-carryover-and-echo-false-positive
 *   §4.4 — shared helper used by the chat-intent classifier (PR-β) and, later,
 *   the scheduling pass (PR-δ). Both playbooks key a rule on "is this message
 *   a near-verbatim copy of a recent envoy reply?", and we cannot rely on LLM
 *   judgment for this — hence a code-level detector with a tunable threshold.
 *
 * Algorithm: normalized longest-common-substring ratio. `overlap = lcsLen /
 * max(lenA, lenB)` — so a user message that is a strict substring of a longer
 * envoy message lands below 1.0 when the envoy message is longer, which is
 * the correct behavior (partial quote ≠ full echo).
 *
 * Normalization: trim, strip common markdown (bold, italic, inline code,
 * leading bullet markers), collapse whitespace, lowercase.
 *
 * Noise floor: envoy messages shorter than 40 characters are skipped. Short
 * messages can coincidentally overlap heavily with unrelated user text.
 */

const DEFAULT_THRESHOLD = 0.85;
const MIN_ENVOY_LENGTH = 40;

function normalize(input: string): string {
  return input
    .trim()
    // strip fenced code blocks first so their contents don't survive
    .replace(/```[\s\S]*?```/g, " ")
    // inline code
    .replace(/`([^`]*)`/g, "$1")
    // bold / italic markers — ** and * and _
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/__/g, "")
    .replace(/_/g, "")
    // leading bullet markers on each line
    .replace(/^[\s]*[-*+]\s+/gm, "")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Longest common substring length between two strings.
 * Straightforward O(m*n) DP. Both inputs are expected to be short
 * (chat-turn scale: hundreds of characters each, not thousands).
 */
function longestCommonSubstringLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  // Rolling row to keep memory small.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) best = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return best;
}

export interface EchoDetectResult {
  isEcho: boolean;
  matchedIndex: number | null;
  overlap: number;
}

/**
 * Check whether `userMessage` is a near-verbatim echo of any of the recent
 * envoy messages. `recentEnvoyMessages` should be ordered most-recent-first;
 * typically the last 3–5 envoy turns in the channel.
 *
 * Returns the best overlap across all eligible envoy messages and the index
 * of the one that matched. Envoy messages shorter than MIN_ENVOY_LENGTH after
 * normalization are skipped.
 */
export function isEchoOfRecentEnvoy(
  userMessage: string,
  recentEnvoyMessages: string[],
  threshold: number = DEFAULT_THRESHOLD,
): EchoDetectResult {
  const normUser = normalize(userMessage);
  if (!normUser) {
    return { isEcho: false, matchedIndex: null, overlap: 0 };
  }

  let bestOverlap = 0;
  let bestIndex: number | null = null;

  for (let i = 0; i < recentEnvoyMessages.length; i++) {
    const envoy = recentEnvoyMessages[i];
    if (typeof envoy !== "string") continue;
    const normEnvoy = normalize(envoy);
    if (normEnvoy.length < MIN_ENVOY_LENGTH) continue;

    const lcs = longestCommonSubstringLength(normUser, normEnvoy);
    const denom = Math.max(normUser.length, normEnvoy.length);
    const overlap = denom === 0 ? 0 : lcs / denom;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = i;
    }
  }

  return {
    isEcho: bestOverlap >= threshold,
    matchedIndex: bestOverlap >= threshold ? bestIndex : null,
    overlap: bestOverlap,
  };
}
