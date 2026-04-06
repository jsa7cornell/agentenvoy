import { streamText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import type { ModelProvider } from "@/lib/negotiator/types";

export const maxDuration = 60;

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
    const modelInstance = getModel(provider, model, apiKey || undefined);

    const result = streamText({
      model: modelInstance,
      system: systemPrompt,
      prompt: question,
      maxOutputTokens: 4096,
    });

    return result.toTextStreamResponse();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[negotiator/research] ${agentName} (${provider}/${model}) error:`, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
