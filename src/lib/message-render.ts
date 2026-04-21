/**
 * Client + server shared stripping helpers for structured blocks the LLM
 * emits inline in its response text. These blocks control server-side
 * behavior (actions, status updates, delegate-speaker attribution) but are
 * never meant to appear in rendered message copy.
 *
 * Why this module exists: `/api/negotiate/message` is a streaming endpoint
 * that ships raw LLM chunks to the client and only runs its server-side
 * strip in `onFinish`. If the client renders the stream as it arrives —
 * which it does in `components/deal-room.tsx` — the user sees the raw
 * `[DELEGATE_SPEAKER]...[/DELEGATE_SPEAKER]` / `[ACTION]...[/ACTION]` /
 * `[STATUS_UPDATE]...[/STATUS_UPDATE]` tags until a full page reload
 * fetches the post-`onFinish` stripped content. That leak was reported
 * 2026-04-21 by Danny on link j6ep75 (report cmo909lkz).
 *
 * Callers MUST treat these as renderer-only cosmetics — do NOT use them
 * for parsing semantics. The canonical parsers for each block live beside
 * their respective handlers (action-parser.ts, status-update parsing, the
 * DELEGATE_SPEAKER parser in `/api/negotiate/message/route.ts`).
 */

export function stripRendererOnlyBlocks(content: string): string {
  return content
    .replace(/\s*\[ACTION\][\s\S]*?\[\/ACTION\]\s*/g, "")
    .replace(/\s*\[STATUS_UPDATE\][\s\S]*?\[\/STATUS_UPDATE\]\s*/g, "")
    .replace(/\s*\[DELEGATE_SPEAKER\][\s\S]*?\[\/DELEGATE_SPEAKER\]\s*/g, "")
    .trim();
}
