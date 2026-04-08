import { generateText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import type { AgentConfig, FinalResponse } from "@/lib/negotiator/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const { agents, question, chosenAgentId, blendInstruction } = body as {
    agents: AgentConfig[];
    question: string;
    chosenAgentId: string;
    blendInstruction?: string;
  };

  const chosenAgent = agents.find((a) => a.id === chosenAgentId);
  if (!chosenAgent) {
    return Response.json({ error: "Chosen agent not found" }, { status: 400 });
  }

  let totalTokens = 0;
  const responses: FinalResponse[] = [];

  if (blendInstruction) {
    // Blend flow: ask chosen agent to incorporate the modification
    const model = getModel(chosenAgent.provider, chosenAgent.model, chosenAgent.apiKey || undefined);
    const result = await generateText({
      model,
      system: `You are ${chosenAgent.name}. The host has chosen to follow your proposal for "${question}" but wants a modification. Accept the modification gracefully and produce a revised, final recommendation that incorporates it. Be concise — bullet points preferred.`,
      prompt: `Modification requested:\n${blendInstruction}`,
      maxOutputTokens: 1024,
    });
    totalTokens += (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);
    responses.push({
      agentId: chosenAgent.id,
      agentName: chosenAgent.name,
      provider: chosenAgent.provider,
      model: chosenAgent.model,
      content: result.text,
    });
  }

  // Administrator final summary
  const adminModel = getModel("anthropic", "claude-sonnet-4-6");
  const chosenLabel = blendInstruction
    ? `${chosenAgent.name}'s revised proposal (with blend)`
    : `${chosenAgent.name}'s proposal`;

  const adminResult = await generateText({
    model: adminModel,
    system: `You are the Administrator — a neutral facilitator. The host has chosen to follow ${chosenLabel} for "${question}". Write a concise final summary in bullet points: what was decided, key action items, and any caveats worth noting. Keep it actionable.`,
    prompt: blendInstruction
      ? `Chosen agent: ${chosenAgent.name}\nBlend instruction: ${blendInstruction}\nRevised response: ${responses[0]?.content || ""}`
      : `Chosen agent: ${chosenAgent.name}\nThe host chose to follow this agent's proposal directly.`,
    maxOutputTokens: 512,
  });

  totalTokens += (adminResult.usage?.inputTokens || 0) + (adminResult.usage?.outputTokens || 0);

  return Response.json({
    responses,
    adminSummary: adminResult.text,
    tokensUsed: totalTokens,
  });
}
