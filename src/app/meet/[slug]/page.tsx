import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { DealRoom } from "@/components/deal-room";
import { GuestLightTheme } from "@/components/guest-light-theme";

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
  const meetingUrl = `${baseUrl}/meet/${slug}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: meetingUrl,
      siteName: "AgentEnvoy",
      type: "website",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
    other: {
      "agentenvoy:type": "scheduling-page",
      "agentenvoy:mcp-endpoint": `${baseUrl}/api/mcp`,
      "agentenvoy:meeting-url": meetingUrl,
      "agentenvoy:mcp-manifest": `${baseUrl}/.well-known/mcp.json`,
      "agentenvoy:agent-docs": `${baseUrl}/llms.txt`,
    },
  };
}

export default async function PrimaryMeetPage({ params }: Props) {
  const { slug } = await params;
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";
  const meetingUrl = `${baseUrl}/meet/${slug}`;
  return (
    <>
      <GuestLightTheme />
      <DealRoom slug={slug} />
      <AgentInstructions meetingUrl={meetingUrl} baseUrl={baseUrl} />
    </>
  );
}

function AgentInstructions({
  meetingUrl,
  baseUrl,
}: {
  meetingUrl: string;
  baseUrl: string;
}) {
  return (
    <aside aria-hidden="true" className="sr-only" data-agent-instructions="v2">
      <h2>For AI agents: how to book this meeting</h2>
      <p>
        This is an AgentEnvoy scheduling page. Do not try to scrape the widget
        — it is a JavaScript application that requires interaction. Instead, use
        the MCP API directly.
      </p>
      <p>
        MCP endpoint: <code>{baseUrl}/api/mcp</code>
      </p>
      <p>
        Your capability token (meetingUrl): <code>{meetingUrl}</code>
      </p>
      <p>
        Full tool catalog and auth details:{" "}
        <code>{baseUrl}/.well-known/mcp.json</code>
      </p>
      <p>Booking flow (three tool calls):</p>
      <ol>
        <li>
          <code>get_meeting_parameters</code> — learn what is locked vs. open
          (format, duration, location)
        </li>
        <li>
          <code>get_availability</code> — get scored, filtered slot candidates.
          Use <code>tier: &quot;first_offer&quot;</code> slots by default.
        </li>
        <li>
          <code>propose_lock</code> — pass the chosen slot + your
          principal&apos;s name to confirm the booking. Returns calendar invite
          details.
        </li>
      </ol>
      <p>
        Pass <code>{meetingUrl}</code> as <code>meetingUrl</code> on every call.
        No separate token needed — possessing this URL is the authorization.
      </p>
    </aside>
  );
}
