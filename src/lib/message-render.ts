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
  let out = content
    .replace(/\s*\[ACTION\][\s\S]*?\[\/ACTION\]\s*/g, "")
    .replace(/\s*\[STATUS_UPDATE\][\s\S]*?\[\/STATUS_UPDATE\]\s*/g, "")
    .replace(/\s*\[DELEGATE_SPEAKER\][\s\S]*?\[\/DELEGATE_SPEAKER\]\s*/g, "");

  // Mid-stream partial-block strip (2026-05-11). Streamed chunks arrive
  // before the closing tag does, so a partial `[ACTION]{"action":...`
  // would flash as raw JSON in the chat bubble until the closer landed.
  // After the complete-block strip above, any remaining opening tag must
  // be a partial — hide everything from it to the end of the buffer.
  // The next chunk will arrive with the closer and the complete-block
  // pass on the following render will catch it.
  out = out.replace(
    /\s*\[(?:ACTION|STATUS_UPDATE|DELEGATE_SPEAKER)\][\s\S]*$/,
    "",
  );

  return out.trim();
}
