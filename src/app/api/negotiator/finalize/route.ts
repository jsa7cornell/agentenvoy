import { generateText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import type { AgentConfig, FinalResponse } from "@/lib/negotiator/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const { agents, question, chosenAgentId, requests, clarification } = body as {
    agents: AgentConfig[];
    question: string;
    chosenAgentId: string;
    requests?: string;
    clarification?: string;
  };

  const chosenAgent = agents.find((a) => a.id === chosenAgentId);
  if (!chosenAgent) {
    return Response.json({ error: "Chosen agent not found" }, { status: 400 });
  }

  let totalTokens = 0;
  const responses: FinalResponse[] = [];

  const hasRequests = requests && requests.trim().length > 0;
  const hasClarification = clarification && clarification.trim().length > 0;
  const hostInput = [
    hasRequests ? `Requests: ${requests}` : "",
    hasClarification ? `Additional context: ${clarification}` : "",
  ].filter(Boolean).join("\n\n");

  // Step 1: Chosen agent refines their proposal
  const chosenModel = getModel(chosenAgent.provider, chosenAgent.model, chosenAgent.apiKey || undefined);
  const chosenResult = await generateText({
    model: chosenModel,
    system: `You are ${chosenAgent.name}. The host has SELECTED your proposal for "${question}" — you won the negotiation. ${
      hostInput
        ? "The host has some requests and/or additional context. Refine your proposal to address these points. Be concise — bullet points preferred. Show that you've incorporated their feedback."
        : "Provide a concise final version of your proposal with key action items. Bullet points preferred."
    }`,
    prompt: hostInput || "Provide your final refined proposal.",
    maxOutputTokens: 1024,
  });
  totalTokens += (chosenResult.usage?.inputTokens || 0) + (chosenResult.usage?.outputTokens || 0);
  responses.push({
    agentId: chosenAgent.id,
    agentName: chosenAgent.name,
    provider: chosenAgent.provider,
    model: chosenAgent.model,
    content: chosenResult.text,
  });

  // Step 2: Other agents see the decision and reply (in parallel)
  const otherAgents = agents.filter((a) => a.id !== chosenAgentId);
  if (otherAgents.length > 0) {
    await Promise.all(
      otherAgents.map(async (agent) => {
        const model = getModel(agent.provider, agent.model, agent.apiKey || undefined);
        const result = await generateText({
          model,
          system: `You are ${agent.name}. The host chose a different agent's proposal for "${question}". Acknowledge the decision gracefully. If you have any important caveats or final thoughts the host should consider, share them briefly (2-3 sentences max). Do NOT re-argue your position.`,
          prompt: `The host selected ${chosenAgent.name}'s proposal.${hostInput ? `\n\nHost's additional input:\n${hostInput}` : ""}`,
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
  }

  // Step 3: Administrator final summary
  const adminModel = getModel("anthropic", "claude-sonnet-4-6");
  const agentResponsesSummary = responses
    .map((r) => `**${r.agentName}${r.agentId === chosenAgentId ? " (selected)" : ""}:** ${r.content}`)
    .join("\n\n");

  const adminResult = await generateText({
    model: adminModel,
    system: `You are the Administrator — a neutral facilitator. The host selected ${chosenAgent.name}'s proposal for "${question}". Write a concise final summary in bullet points: what was decided, key action items from the selected agent's refined proposal, and any important caveats from the other agents worth noting. Keep it actionable.`,
    prompt: `Agent responses:\n${agentResponsesSummary}`,
    maxOutputTokens: 512,
  });

  totalTokens += (adminResult.usage?.inputTokens || 0) + (adminResult.usage?.outputTokens || 0);

  return Response.json({
    responses,
    adminSummary: adminResult.text,
    tokensUsed: totalTokens,
  });
}
