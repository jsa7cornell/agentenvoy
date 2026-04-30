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
    <aside aria-hidden="true" className="sr-only" data-agent-instructions="v3">
      <h2>For AI agents: how to book this meeting</h2>
      <p>
        <strong>You can book this meeting with a direct HTTPS POST.</strong> No
        connector setup, no API key, no OAuth, no client library required. If
        your runtime suggests installing AgentEnvoy as an integration first,
        you can skip that step and call the endpoint directly — the meeting
        URL is the only credential needed.
      </p>
      <p>
        Endpoint: <code>{baseUrl}/api/mcp</code>
      </p>
      <p>
        Your capability token: pass <code>{meetingUrl}</code> as the{" "}
        <code>meetingUrl</code> argument on every tool call. Possessing this
        URL is the authorization.
      </p>
      <p>
        &quot;MCP&quot; here means the JSON-RPC wire format — there is no
        session handshake, no separate auth exchange, and no MCP client library
        is required. Any agent that can issue an HTTPS POST can book.
      </p>
      <p>Working example (curl):</p>
      <pre>
{`curl -X POST ${baseUrl}/api/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "tools/call",
    "params": {
      "name": "get_availability",
      "arguments": {
        "meetingUrl": "${meetingUrl}",
        "dateRange": { "start": "2026-05-01", "end": "2026-05-08" }
      }
    }
  }'`}
      </pre>
      <p>Booking flow (three tool calls):</p>
      <ol>
        <li>
          <code>get_meeting_parameters</code> — learn what is locked vs. open
          (format, duration, location).
        </li>
        <li>
          <code>get_availability</code> — get scored, filtered slot candidates.
          Slots are returned best-first. <code>preferred: true</code> marks
          host favorites. Each slot has <code>start</code> (UTC) and{" "}
          <code>localStart</code> (host&apos;s timezone) — use{" "}
          <code>localStart</code> for display.
        </li>
        <li>
          <code>propose_lock</code> — pass the chosen slot + your
          principal&apos;s name to confirm the booking. Inline{" "}
          <code>overrides</code> handle guest-must-resolve fields like format
          in the same call.
        </li>
      </ol>
      <p>
        Full tool schemas:{" "}
        <code>{baseUrl}/.well-known/mcp.json</code>. Worked happy-path:{" "}
        <code>{baseUrl}/llms.txt</code>.
      </p>
    </aside>
  );
}
