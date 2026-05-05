/**
 * `resolve_contact` — composer-callable tool (bookings module).
 *
 * Wraps `resolveContact` from `@/lib/resolve-contact` as a ComposerTool.
 * Per handoff doc §"Tool shapes" + book_time_with proposal §3.3.
 */
import { z } from "zod";
import type { ComposerTool, ModuleContext } from "@/agent/modules/types";
import {
  resolveContact,
  type ResolveContactResult,
} from "@/lib/resolve-contact";

const inputSchema = z.object({
  hint: z
    .object({
      email: z.string().email().optional(),
      name: z.string().min(1).max(200).optional(),
    })
    .refine(
      (h) => h.email !== undefined || h.name !== undefined,
      "At least one of email or name must be provided.",
    )
    .describe(
      "Identity hint for the person you want to book with. Provide email when known (most reliable); " +
        "provide name for fuzzy lookup against your meeting history and the AgentEnvoy directory.",
    ),
}).strict();

export type ResolveContactInput = z.infer<typeof inputSchema>;

const TOOL_DESCRIPTION = `Resolve a person's identity for booking. Given a name or email, this tool:
1. Looks up their AgentEnvoy account (if they have one) to enable bilateral scoring.
2. Counts your prior meetings with them so you can surface "first time with Bryan" for confirmation.
3. Returns how the identity was resolved (explicit email vs history match vs account directory).

When to call:
- ALWAYS at the start of a booking flow, before calling intersect_availability.

Returns:
- ok: true, result: { email, hasAgentEnvoyAccount, meetSlug?, userId?, priorMeetingsCount, resolvedFrom }
- ok: false, reason: "not_found" — suggest using create_link with a direct email instead
- ok: false, reason: "ambiguous", candidates — ask the host to clarify which person`;

export const resolveContactTool: ComposerTool<
  ResolveContactInput,
  ResolveContactResult
> = {
  name: "resolve_contact",
  description: TOOL_DESCRIPTION,
  inputSchema,
  execute: async (input: ResolveContactInput, ctx: ModuleContext) => {
    const hint = input.hint;
    const contactHint =
      hint.email && hint.name
        ? { email: hint.email, name: hint.name }
        : hint.email
          ? { email: hint.email }
          : { name: hint.name! };

    return resolveContact(ctx.user.id, contactHint);
  },
};
