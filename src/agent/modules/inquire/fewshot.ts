/**
 * Inquire module — few-shot demonstrations.
 *
 * Per Rule 27 (proposal `2026-05-05_examples-vs-instructions-prompt-separation`):
 * worked-dialogue examples live OUT of the operational prompt fragment and
 * in this per-module `fewshot.ts`. The runner attaches these as past
 * user/assistant turns at the head of the messages array, with the
 * prompt-cache breakpoint on the last assistant turn.
 *
 * These four examples were migrated from
 * `app/src/agent/runtime-prompts/composers/inquire-composer.md` §"Examples"
 * (commit pre-Phase-1 of the example-vs-instruction separation work). The
 * fragment retains the operational rules; the worked dialogues live here.
 *
 * Names follow Rule 26 — placeholders only (`[Name]`, `{slug}/{code}`).
 */
import type { FewShotTurn } from "@/agent/modules/types";

export const inquireFewShot: readonly FewShotTurn[] = [
  {
    user: "What's on my calendar tomorrow?",
    assistant:
      "Tomorrow (Tue) you've got a call with [Name] at 2pm and a block at 4:30 for the [Name] sync. Nothing after 6.",
  },
  {
    user: "How many pending meetings do I have?",
    assistant:
      "Three pending — [Name], [Name], and [Name]. [Name] is the oldest (5 days).",
  },
  {
    user: "What did [Name] say?",
    assistant:
      "[Name] asked for something next week after Tuesday — she's got a conflict Tuesday morning.",
  },
  {
    user: "How do I share a link?",
    assistant:
      "Once you create a link, the URL is at `/meet/{slug}/{code}` — copy it from the session card and send it over. The guest picks from the slots you offered.",
  },
];
