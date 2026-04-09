import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { DealRoom } from "@/components/deal-room";

interface Props {
  params: Promise<{ slug: string; code: string }>;
}

async function getLinkData(slug: string, code: string) {
  try {
    const link = await prisma.negotiationLink.findFirst({
      where: { slug, code },
      select: {
        topic: true,
        inviteeName: true,
        user: { select: { name: true } },
      },
    });
    return link;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, code } = await params;
  const link = await getLinkData(slug, code);

  const hostName = link?.user?.name ?? "Someone";
  const hostFirst = hostName.split(" ")[0];
  const guestName = link?.inviteeName;
  const guestFirst = guestName ? guestName.split(" ")[0] : null;
  const topic = link?.topic;
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";

  let title: string;
  if (topic && guestFirst) {
    title = `${topic} — ${guestFirst} & ${hostFirst} via AgentEnvoy`;
  } else if (topic) {
    title = `${topic} — ${hostFirst} via AgentEnvoy`;
  } else if (guestFirst) {
    title = `${guestFirst} & ${hostFirst} via AgentEnvoy`;
  } else {
    title = `Meeting with ${hostFirst} via AgentEnvoy`;
  }

  const description = topic
    ? `${hostName} is coordinating: ${topic}. Find a time that works.`
    : `${hostName} wants to find a time to meet. Powered by AgentEnvoy.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${baseUrl}/meet/${slug}/${code}`,
      siteName: "AgentEnvoy",
      type: "website",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function ContextualMeetPage({ params }: Props) {
  const { slug, code } = await params;
  return <DealRoom slug={slug} code={code} />;
}
