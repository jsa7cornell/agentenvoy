import { generateText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import { composeAdministratorPrompt, parseSynthesis } from "@/lib/negotiator/administrator";
import type { AgentConfig, ResearchResult } from "@/lib/negotiator/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const {
    apiKey,
    model,
    question,
    sharedContext,
    hostPrivateContext,
    agents,
    research,
    priorAgreements,
    humanDecisions,
    hostClarifications,
    round,
  } = body as {
    apiKey?: string;
    model?: string;
    question: string;
    sharedContext: string;
    hostPrivateContext: string;
    agents: AgentConfig[];
    research: ResearchResult[];
    priorAgreements?: string[];
    humanDecisions?: string[];
    hostClarifications?: string[];
    round: number;
  };

  const adminModel = getModel(
    "anthropic",
    model || "claude-sonnet-4-6",
    apiKey || undefined
  );

  const systemPrompt = composeAdministratorPrompt({
    question,
    sharedContext,
    hostPrivateContext,
    agents,
    research,
    priorAgreements,
    humanDecisions,
    hostClarifications,
    round,
  });

  const result = await generateText({
    model: adminModel,
    system: systemPrompt,
    prompt:
      "Analyze all agent positions and produce your synthesis as a JSON object. Remember: output ONLY the JSON, no preamble or explanation.",
    maxOutputTokens: 4096,
  });

  const synthesis = parseSynthesis(result.text);
  const tokensUsed =
    (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);

  return Response.json({ synthesis, tokensUsed });
}
