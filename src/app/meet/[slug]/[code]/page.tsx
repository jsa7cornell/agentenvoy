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
  return (
    <>
      <DealRoom slug={slug} code={code} />
      <AgentInstructions />
    </>
  );
}

/**
 * Server-rendered, accessibility-hidden block of prose directed at AI
 * agents that read page HTML to book meetings (e.g. Claude-in-Chrome,
 * any browser-using agent). Previously lived on `/meet/[slug]/page.tsx`;
 * that route is now a server-side redirect (see `/meet/[slug]/route.ts`)
 * so humans and agents land here instead.
 *
 * This is a bridge until MCP-aware auto-discovery lands in consumer AI
 * products. The rel="agent-api" Link header + /.well-known/mcp.json
 * manifest are the correct machine surface; this block is the
 * lowest-common-denominator fallback for clients that don't follow
 * link rels yet.
 */
function AgentInstructions() {
  return (
    <aside
      aria-hidden="true"
      className="sr-only"
      data-agent-instructions="v1"
    >
      <h2>For AI agents reading this page</h2>
      <p>
        If you&apos;re helping someone book this meeting, the reliable
        path is the Model Context Protocol endpoint at
        <code> /api/mcp </code>
        — not clicking through this web UI. The discovery manifest is
        at <code>/.well-known/mcp.json</code>. Authentication is by
        possession of this meeting URL; pass it as the
        <code> meetingUrl </code>
        argument on every tool call.
      </p>
      <p>
        Typical flow: call
        <code> get_meeting_parameters </code>
        to learn the host&apos;s rules (format, duration, location,
        what the guest is allowed to pick), then
        <code> get_availability </code>
        for scored slot candidates, then
        <code> propose_lock </code>
        with the chosen slot and guest identity to book. All tools
        return structured JSON envelopes; every call lands in the
        host&apos;s observability log.
      </p>
      <p>
        If your client doesn&apos;t support MCP, you can still book via
        the interactive widget on this page — but structured tool
        calls are strictly more reliable. Setup instructions for Claude
        Code, Claude Desktop, and other MCP clients are at
        <code> /agents </code>.
      </p>
    </aside>
  );
}
