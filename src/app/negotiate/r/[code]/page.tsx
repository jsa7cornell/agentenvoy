import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { NegotiatorResultView } from "./result-view";
import type { Metadata } from "next";

interface Props {
  params: { code: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const result = await prisma.negotiatorResult.findUnique({
    where: { shareCode: params.code },
    select: { question: true, adminSummary: true },
  });

  if (!result) return { title: "Not Found" };

  const title = result.question.slice(0, 60);
  // Use admin summary as OG description for social preview (WhatsApp, etc.)
  const description = result.adminSummary
    ? result.adminSummary.replace(/[#*_\-\[\]]/g, "").slice(0, 200)
    : `Multi-agent negotiation: ${result.question.slice(0, 150)}`;

  return {
    title: `Negotiation: ${title}`,
    description,
    openGraph: {
      title: `Negotiation: ${title}`,
      description,
      siteName: "AgentNegotiator by AgentEnvoy",
    },
  };
}

export default async function ResultPage({ params }: Props) {
  const result = await prisma.negotiatorResult.findUnique({
    where: { shareCode: params.code },
  });

  if (!result) notFound();

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-6 light" data-theme="light" style={{ colorScheme: "light" }}>
      <NegotiatorResultView
        question={result.question}
        agents={result.agents as Record<string, unknown>[]}
        research={result.research as Record<string, unknown>[]}
        syntheses={result.syntheses as Record<string, unknown>[]}
        humanDecisions={result.humanDecisions as string[]}
        finalResponses={result.finalResponses as Record<string, unknown>[]}
        adminSummary={result.adminSummary}
        totalTokens={result.totalTokens}
        transcript={result.transcript}
        usageRows={(result.usageRows as Record<string, unknown>[]) || []}
        createdAt={result.createdAt.toISOString()}
      />
    </main>
  );
}
