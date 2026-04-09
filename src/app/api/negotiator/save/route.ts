import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";

export async function POST(req: Request) {
  const body = await req.json();
  const {
    question,
    agents,
    research,
    syntheses,
    humanDecisions,
    hostClarifications,
    finalResponses,
    adminSummary,
    totalTokens,
    transcript,
    usageRows,
  } = body;

  if (!question || !agents || !research || !syntheses || !transcript) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  // Strip API keys from agent configs before persisting
  const safeAgents = agents.map((a: Record<string, unknown>) => ({
    id: a.id,
    name: a.name,
    provider: a.provider,
    model: a.model,
    context: a.context,
  }));

  // Generate unique share code with retry
  let shareCode = "";
  for (let i = 0; i < 5; i++) {
    const candidate = generateCode(6);
    const existing = await prisma.negotiatorResult.findUnique({
      where: { shareCode: candidate },
    });
    if (!existing) {
      shareCode = candidate;
      break;
    }
  }

  if (!shareCode) {
    return NextResponse.json(
      { error: "Failed to generate unique share code" },
      { status: 500 }
    );
  }

  const result = await prisma.negotiatorResult.create({
    data: {
      shareCode,
      question,
      agents: safeAgents,
      research,
      syntheses,
      humanDecisions: humanDecisions || [],
      hostClarifications: hostClarifications || [],
      finalResponses: finalResponses || [],
      adminSummary: adminSummary || null,
      totalTokens: totalTokens || 0,
      transcript,
      usageRows: usageRows || [],
    },
  });

  return NextResponse.json({ shareCode: result.shareCode });
}
