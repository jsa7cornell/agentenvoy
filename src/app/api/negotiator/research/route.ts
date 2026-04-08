import { streamText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import type { ModelProvider } from "@/lib/negotiator/types";

export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json();
  const {
    provider,
    model,
    apiKey,
    agentName,
    agentContext,
    sharedContext,
    question,
  } = body as {
    provider: ModelProvider;
    model: string;
    apiKey?: string;
    agentName: string;
    agentContext: string;
    sharedContext: string;
    question: string;
  };

  const systemPrompt = `You are ${agentName}, an independent research agent participating in a multi-agent negotiation.

Your task: Research the question below thoroughly and produce your position. Be honest about tradeoffs — acknowledge weaknesses in your approach where relevant. Your goal is the best outcome, not winning an argument.

At the end of your response, include a section called "Key Assumptions" listing any assumptions you made that might differ from other agents' assumptions.

${sharedContext ? `## Shared Context (all agents see this)\n${sharedContext}` : ""}

${agentContext ? `## Your Private Context (only you and the Administrator see this)\n${agentContext}` : ""}`;

  try {
    console.log(`[negotiator/research] Starting ${agentName} (${provider}/${model})`);
    const modelInstance = getModel(provider, model, apiKey || undefined);

    const result = streamText({
      model: modelInstance,
      system: systemPrompt,
      prompt: question,
      maxOutputTokens: 1500,
    });

    // Wrap the stream so async provider errors (bad key, rate limit, etc.)
    // surface as a text chunk the client can display instead of silently stalling.
    const originalStream = result.toTextStreamResponse();
    const reader = originalStream.body!.getReader();

    const wrapped = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[negotiator/research] stream error for ${agentName} (${provider}/${model}):`, msg);
          controller.enqueue(new TextEncoder().encode(`\n\n[Error: ${msg}]`));
          controller.close();
        }
      },
      cancel() {
        reader.cancel();
      },
    });

    return new Response(wrapped, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[negotiator/research] ${agentName} (${provider}/${model}) error:`, message);
    return new Response(`[Error: ${message}]`, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
