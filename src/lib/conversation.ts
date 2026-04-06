/**
 * Conversation history utilities.
 *
 * Prepares raw message histories for the Anthropic API, which requires
 * strictly alternating user/assistant turns with no consecutive same-role
 * messages.
 */

interface Message {
  role: string;
  content: string;
}

interface CleanMessage {
  role: "user" | "assistant";
  content: string;
}

interface SanitizeResult {
  messages: CleanMessage[];
  warnings: string[];
}

/**
 * Sanitize a raw message history for the Anthropic API.
 *
 * - Filters out system/host_note messages (not part of the AI conversation)
 * - Maps roles: "envoy"/"administrator" → "assistant", everything else → "user"
 * - Drops messages with empty content
 * - Merges consecutive same-role messages
 * - Ensures the history starts with a "user" message
 * - Returns warnings for any issues found (for logging)
 */
export function sanitizeHistory(
  raw: Message[],
  assistantRoles: string[] = ["assistant", "envoy", "administrator"]
): SanitizeResult {
  const warnings: string[] = [];
  const skipRoles = new Set(["system", "host_note"]);

  // Step 1: Filter and map roles
  const mapped: CleanMessage[] = [];
  for (const msg of raw) {
    if (skipRoles.has(msg.role)) continue;
    if (!msg.content || msg.content.trim() === "") {
      warnings.push(`Dropped empty ${msg.role} message`);
      continue;
    }
    const role: "user" | "assistant" = assistantRoles.includes(msg.role)
      ? "assistant"
      : "user";
    mapped.push({ role, content: msg.content });
  }

  // Step 2: Merge consecutive same-role messages
  const merged: CleanMessage[] = [];
  let mergeCount = 0;
  for (const msg of mapped) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content += "\n" + msg.content;
      mergeCount++;
    } else {
      merged.push({ ...msg });
    }
  }
  if (mergeCount > 0) {
    warnings.push(`Merged ${mergeCount} consecutive same-role message(s)`);
  }

  // Step 3: Ensure starts with "user"
  if (merged.length > 0 && merged[0].role !== "user") {
    warnings.push(`History started with ${merged[0].role} — prepended empty user turn`);
    merged.unshift({ role: "user", content: "(conversation started)" });
  }

  // Step 4: Ensure ends with "user" (Anthropic requires this)
  if (merged.length > 0 && merged[merged.length - 1].role !== "user") {
    warnings.push(`History ended with ${merged[merged.length - 1].role} — trimmed trailing assistant message(s)`);
    while (merged.length > 0 && merged[merged.length - 1].role !== "user") {
      merged.pop();
    }
  }

  return { messages: merged, warnings };
}

/**
 * Build a roles summary string for logging.
 * e.g., "user,assistant,user,assistant" or "user,user,assistant" (problematic)
 */
export function roleSummary(messages: Array<{ role: string }>): string {
  return messages.map((m) => m.role).join(",");
}
