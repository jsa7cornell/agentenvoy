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
  return (
    <>
      <DealRoom slug={slug} />
      <AgentInstructions />
    </>
  );
}

/**
 * Server-rendered, accessibility-hidden block of prose directed at AI
 * agents that read page HTML to book meetings (e.g. Claude-in-Chrome,
 * any browser-using agent). The visual layer (<DealRoom>) is a
 * fixed-inset React tree — so an aside after it never reaches a human
 * viewport. Putting it behind sr-only keeps it off assistive-tech
 * announcements too while remaining in the DOM and the initial HTML
 * response, which is what matters for text-scraping agents.
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
