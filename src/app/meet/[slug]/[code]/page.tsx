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
        rules: true,
        mode: true,
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
  const rules = (link?.rules as Record<string, unknown>) || {};
  const format = rules.format as string | undefined;
  const duration = rules.duration as string | undefined;
  const isGroup = link?.mode === "group";
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";

  // --- Title ---
  let title: string;
  if (topic && guestFirst) {
    title = `${topic} — ${guestFirst} & ${hostFirst}`;
  } else if (topic) {
    title = `${topic} — ${hostFirst}`;
  } else if (guestFirst) {
    title = `${guestFirst} & ${hostFirst} — Schedule a meeting`;
  } else {
    title = `Meet with ${hostFirst}`;
  }

  // --- Description ---
  const details: string[] = [];

  if (topic) {
    details.push(topic);
  }

  // Format + duration line: "30m video call" or "phone call" etc.
  if (duration || format) {
    const parts = [];
    if (duration) parts.push(duration);
    if (format) parts.push(format);
    details.push(parts.join(" "));
  }

  if (isGroup) {
    details.push("Group event");
  }

  if (guestName) {
    details.push(`Invited: ${guestName}`);
  }

  let description: string;
  if (details.length > 0) {
    description = `${details.join(" · ")} — Coordinate with ${hostFirst}'s AI scheduling agent.`;
  } else {
    description = `${hostName} wants to find a time to meet. Powered by Envoy, an AI scheduling agent.`;
  }

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
