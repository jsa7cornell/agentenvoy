import { generateText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import type { AgentConfig, DecisionPoint, FinalResponse } from "@/lib/negotiator/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const { agents, question, decisions, decisionPoints } = body as {
    agents: AgentConfig[];
    question: string;
    decisions: string[];
    decisionPoints: DecisionPoint[];
  };

  const decisionSummary = decisionPoints
    .map((dp, i) => `- ${dp.topic}: ${decisions[i] || "No decision"}`)
    .join("\n");

  let totalTokens = 0;
  const responses: FinalResponse[] = [];

  // Get final responses from each agent in parallel
  await Promise.all(
    agents.map(async (agent) => {
      const model = getModel(agent.provider, agent.model, agent.apiKey || undefined);
      const result = await generateText({
        model,
        system: `You are ${agent.name}. The host has made final decisions on the negotiation "${question}". Acknowledge the decisions briefly and offer any final thoughts or caveats in 2-3 sentences. Do NOT re-argue your position.`,
        prompt: `The host decided:\n${decisionSummary}`,
        maxOutputTokens: 512,
      });

      totalTokens += (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);
      responses.push({
        agentId: agent.id,
        agentName: agent.name,
        provider: agent.provider,
        model: agent.model,
        content: result.text,
      });
    })
  );

  // Administrator final summary
  const adminModel = getModel("anthropic", "claude-sonnet-4-6");
  const agentResponsesSummary = responses
    .map((r) => `**${r.agentName}:** ${r.content}`)
    .join("\n\n");

  const adminResult = await generateText({
    model: adminModel,
    system: `You are the Administrator — a neutral facilitator. The host has made final decisions and the agents have responded. Write a brief final summary (3-5 sentences) covering: what was decided, key caveats from the agents worth noting, and any recommended next steps. Be concise and actionable.`,
    prompt: `Question: ${question}\n\nDecisions made:\n${decisionSummary}\n\nAgent responses:\n${agentResponsesSummary}`,
    maxOutputTokens: 512,
  });

  totalTokens += (adminResult.usage?.inputTokens || 0) + (adminResult.usage?.outputTokens || 0);

  return Response.json({
    responses,
    adminSummary: adminResult.text,
    tokensUsed: totalTokens,
  });
}
