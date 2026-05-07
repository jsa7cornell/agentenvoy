/**
 * POST /api/admin/replay — replay a FeedbackReport's incident turn against the current prompt.
 *
 * FB-4: Admin diagnostic only. Extracts the conversation history from the stored bundle,
 * sends it to the current system prompt via streamText, and streams the response as plain text.
 *
 * IMPORTANT: Uses live DB context (current system prompt + model), not the frozen bundle
 * snapshot. This answers "does the current prompt handle this better?" not
 * "would the bug reproduce exactly?" — appropriate for verifying fixes, not regression testing.
 * The UI shows a disclaimer to this effect.
 *
 * No DB writes. Purely diagnostic.
 */

import { NextResponse, type NextRequest } from "next/server";
import { streamText } from "ai";
import { requireAdminContext } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { envoyModel } from "@/lib/model";
import { unifiedAgentSystemPrompt } from "@/agent/runtime-prompts";

export const dynamic = "force-dynamic";

const REPLAY_MODEL = "claude-sonnet-4-6";
const SYSTEM_PROMPT = unifiedAgentSystemPrompt();

type BundleMessage = {
  role: string;
  content: string;
};

function extractHistory(bundle: Record<string, unknown>): BundleMessage[] {
  if (bundle.version !== 2) return [];
  const msgs = bundle.messages as { recentTurns?: unknown[]; priorContext?: unknown[] } | undefined;
  const prior = msgs?.priorContext ?? [];
  const recent = msgs?.recentTurns ?? [];
  const all = [...prior, ...recent] as Array<Record<string, unknown>>;
  return all
    .filter((m) => typeof m.role === "string" && typeof m.content === "string")
    .map((m) => ({ role: m.role as string, content: m.content as string }));
}

export async function POST(request: NextRequest) {
  const admin = await requireAdminContext("/api/admin/replay");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const { reportId } = body as { reportId?: string };
  if (!reportId || typeof reportId !== "string") {
    return NextResponse.json({ ok: false, error: "reportId required" }, { status: 400 });
  }

  const report = await prisma.feedbackReport.findUnique({
    where: { id: reportId },
    select: { bundle: true, userId: true },
  });
  if (!report) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const bundle = report.bundle as Record<string, unknown> | null;
  if (!bundle) {
    return NextResponse.json({ ok: false, error: "No bundle attached to this report" }, { status: 422 });
  }

  const history = extractHistory(bundle);
  if (history.length === 0) {
    return NextResponse.json({ ok: false, error: "Bundle has no conversation history to replay (v1 or empty bundle)" }, { status: 422 });
  }

  // Normalize roles: "envoy" → "assistant", "user" stays.
  const messages = history.map((m) => ({
    role: m.role === "envoy" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

  // Strip the last assistant message so we can re-run the model on that final user turn.
  // If the last message is already a user message, use it as-is.
  const lastMsg = messages[messages.length - 1];
  const replayMessages = lastMsg?.role === "assistant" ? messages.slice(0, -1) : messages;

  if (replayMessages.length === 0 || replayMessages[replayMessages.length - 1]?.role !== "user") {
    return NextResponse.json({ ok: false, error: "Cannot determine replay user turn" }, { status: 422 });
  }

  void admin; // used only for auth gate above

  const result = streamText({
    model: envoyModel(REPLAY_MODEL),
    system: SYSTEM_PROMPT,
    messages: replayMessages,
  });

  return result.toTextStreamResponse();
}
