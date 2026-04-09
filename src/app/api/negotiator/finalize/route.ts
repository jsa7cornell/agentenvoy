import { generateText } from "ai";
import { getModel } from "@/lib/negotiator/providers";
import type { AgentConfig, FinalResponse } from "@/lib/negotiator/types";

export const maxDuration = 120; // longer timeout for multi-agent finalize

export async function POST(req: Request) {
  const body = await req.json();
  const { agents, question, chosenAgentId, feedback, adminModel } = body as {
    agents: AgentConfig[];
    question: string;
    chosenAgentId: string;
    feedback?: string;
    adminModel?: string;
  };

  const chosenAgent = agents.find((a) => a.id === chosenAgentId);
  if (!chosenAgent) {
    return Response.json({ error: "Chosen agent not found" }, { status: 400 });
  }

  let totalTokens = 0;
  const responses: FinalResponse[] = [];
  const errors: string[] = [];

  const hasFeedback = feedback && feedback.trim().length > 0;

  // Step 1: Chosen agent refines their proposal
  try {
    const chosenModel = getModel(chosenAgent.provider, chosenAgent.model, chosenAgent.apiKey || undefined);
    const chosenResult = await generateText({
      model: chosenModel,
      system: `You are ${chosenAgent.name}. The host has SELECTED your proposal for "${question}" — you won the negotiation. ${
        hasFeedback
          ? "The host has feedback. Refine your proposal to address these points. Be concise — bullet points preferred. Show that you've incorporated their feedback."
          : "Provide a concise final version of your proposal with key action items. Bullet points preferred."
      }`,
      prompt: hasFeedback ? feedback : "Provide your final refined proposal.",
      maxOutputTokens: 1024,
    });
    totalTokens += (chosenResult.usage?.inputTokens || 0) + (chosenResult.usage?.outputTokens || 0);

    const content = chosenResult.text?.trim();
    if (!content) {
      errors.push(`${chosenAgent.name} returned an empty response`);
    }

    responses.push({
      agentId: chosenAgent.id,
      agentName: chosenAgent.name,
      provider: chosenAgent.provider,
      model: chosenAgent.model,
      content: content || "(No response received — the model may have timed out. Try a different model.)",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${chosenAgent.name}: ${msg}`);
    responses.push({
      agentId: chosenAgent.id,
      agentName: chosenAgent.name,
      provider: chosenAgent.provider,
      model: chosenAgent.model,
      content: `(Error: ${msg})`,
    });
  }

  // Step 2: Other agents see the decision and reply (in parallel)
  const otherAgents = agents.filter((a) => a.id !== chosenAgentId);
  if (otherAgents.length > 0) {
    await Promise.allSettled(
      otherAgents.map(async (agent) => {
        try {
          const model = getModel(agent.provider, agent.model, agent.apiKey || undefined);
          const result = await generateText({
            model,
            system: `You are ${agent.name}. The host chose a different agent's proposal for "${question}". Acknowledge the decision gracefully. If you have any important caveats or final thoughts the host should consider, share them briefly (2-3 sentences max). Do NOT re-argue your position.`,
            prompt: `The host selected ${chosenAgent.name}'s proposal.${hasFeedback ? `\n\nHost's feedback:\n${feedback}` : ""}`,
            maxOutputTokens: 512,
          });
          totalTokens += (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);

          const content = result.text?.trim();
          responses.push({
            agentId: agent.id,
            agentName: agent.name,
            provider: agent.provider,
            model: agent.model,
            content: content || "(No response received)",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${agent.name}: ${msg}`);
          responses.push({
            agentId: agent.id,
            agentName: agent.name,
            provider: agent.provider,
            model: agent.model,
            content: `(Error: ${msg})`,
          });
        }
      })
    );
  }

  // Step 3: Administrator final summary
  let adminSummary = "";
  try {
    const selectedAdminModel = adminModel || "claude-sonnet-4-6";
    // Determine provider from model name
    const adminProvider = selectedAdminModel.startsWith("gemini") ? "google"
      : selectedAdminModel.startsWith("gpt") || selectedAdminModel.startsWith("o1") || selectedAdminModel.startsWith("o3") ? "openai"
      : "anthropic";
    const adminModelInstance = getModel(adminProvider, selectedAdminModel);
    const agentResponsesSummary = responses
      .map((r) => `**${r.agentName}${r.agentId === chosenAgentId ? " (selected)" : ""}:** ${r.content}`)
      .join("\n\n");

    const adminResult = await generateText({
      model: adminModelInstance,
      system: `You are the Administrator — a neutral facilitator. The host selected ${chosenAgent.name}'s proposal for "${question}". Write a concise final summary in bullet points: what was decided, key action items from the selected agent's refined proposal, and any important caveats from the other agents worth noting. Keep it actionable.`,
      prompt: `Agent responses:\n${agentResponsesSummary}`,
      maxOutputTokens: 512,
    });

    totalTokens += (adminResult.usage?.inputTokens || 0) + (adminResult.usage?.outputTokens || 0);
    adminSummary = adminResult.text;
  } catch (err) {
    adminSummary = `Failed to generate summary: ${err instanceof Error ? err.message : String(err)}`;
  }

  return Response.json({
    responses,
    adminSummary,
    tokensUsed: totalTokens,
    errors: errors.length > 0 ? errors : undefined,
  });
}
