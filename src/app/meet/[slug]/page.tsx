import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { DealRoom } from "@/components/deal-room";

interface Props {
  params: Promise<{ slug: string }>;
}

async function getHostData(slug: string) {
  try {
    const user = await prisma.user.findUnique({
      where: { meetSlug: slug },
      select: { name: true },
    });
    return user;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const user = await getHostData(slug);

  const hostName = user?.name ?? "Someone";
  const hostFirst = hostName.split(" ")[0];
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";

  const title = `Meet with ${hostFirst}`;
  const description = `Find a time to meet with ${hostName}. Powered by Envoy, an AI scheduling agent that navigates busy calendars.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${baseUrl}/meet/${slug}`,
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

export default async function GenericMeetPage({ params }: Props) {
  const { slug } = await params;
  return <DealRoom slug={slug} />;
}
