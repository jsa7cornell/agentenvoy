import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { DealRoom } from "@/components/deal-room";
import { GuestLightTheme } from "@/components/guest-light-theme";
import { formatDuration } from "@/lib/format-duration";
import { parseLinkParameters } from "@/lib/link-parameters";
import { buildAgentSnapshot, type AgentSnapshot } from "@/lib/agent-snapshot";
import { readRecurrence } from "@/lib/recurrence";
import { formatCadenceWord, formatEndByLabel } from "@/lib/format-recurrence";

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
        parameters: true,
        mode: true,
        // recurrence: surfaced in the iMessage / link unfurl ("8 weekly
        // sessions, 45 min") per proposal §5.8.
        recurrence: true,
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
  const rules = parseLinkParameters(link?.parameters);
  const format = rules.format;
  // rules.duration is stored as raw minutes (number or numeric string).
  // Previously coerced straight into the description, which leaked raw
  // "180" into the iMessage unfurl for a 3h link. Run through formatDuration
  // so the preview reads "3h" / "30 min" etc.
  const durationRaw = rules.duration;
  const durationMinutes =
    typeof durationRaw === "number"
      ? durationRaw
      : typeof durationRaw === "string"
      ? Number.parseInt(durationRaw, 10)
      : null;
  const duration =
    durationMinutes != null && Number.isFinite(durationMinutes)
      ? formatDuration(durationMinutes)
      : undefined;
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

  // Recurrence line: "8 weekly sessions" / "sessions through Aug 30, every other week".
  // Renders alongside the duration line so the iMessage unfurl carries
  // series-ness up-front. Per proposal §5.8 — supports both the direct
  // contextual recurring meeting and (post-PR2) the office-hours-with-series
  // materialized child.
  const recurrence = readRecurrence(link?.recurrence ?? null);
  if (recurrence) {
    details.push(`${formatEndByLabel(recurrence)}, ${formatCadenceWord(recurrence)}`);
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

  const meetingUrl = `${baseUrl}/meet/${slug}/${code}`;

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
      // Machine-readable discovery for AI agents doing web_fetch on this URL.
      // These render as <meta> tags in the HTML <head> — visible to any HTTP
      // client that reads the page source, even if JavaScript doesn't run.
      "agentenvoy:type": "scheduling-page",
      "agentenvoy:mcp-endpoint": `${baseUrl}/api/mcp`,
      "agentenvoy:meeting-url": meetingUrl,
      "agentenvoy:mcp-manifest": `${baseUrl}/.well-known/mcp.json`,
      "agentenvoy:agent-docs": `${baseUrl}/llms.txt`,
    },
  };
}

export default async function ContextualMeetPage({ params }: Props) {
  const { slug, code } = await params;
  const baseUrl = process.env.NEXTAUTH_URL ?? "https://agentenvoy.ai";
  const meetingUrl = `${baseUrl}/meet/${slug}/${code}`;

  // Build the agent snapshot for the embedded discovery surface. ONLY
  // contextual links (`/meet/<slug>/<code>`) get the embed — bare-vanity
  // primary links don't, per the 2026-04-30 single-fetch-agent-surface
  // proposal §B3 (privacy posture: the bare URL is widely shared and
  // crawlable; embedding bookable detail there would leak calendar
  // density to search engines).
  let snapshot: AgentSnapshot | null = null;
  try {
    const link = await prisma.negotiationLink.findFirst({
      where: { slug, code },
    });
    if (link && (!link.expiresAt || link.expiresAt.getTime() >= Date.now())) {
      const host = await prisma.user.findUnique({
        where: { id: link.userId },
        select: { name: true, preferences: true },
      });
      if (host) {
        snapshot = await buildAgentSnapshot(link, host);
      }
    }
  } catch (e) {
    // Snapshot is purely additive discoverability; never block the page.
    console.error("[meet/[slug]/[code]] agent-snapshot build failed:", e);
  }

  return (
    <>
      <GuestLightTheme />
      <DealRoom slug={slug} code={code} />
      <AgentInstructions meetingUrl={meetingUrl} baseUrl={baseUrl} />
      {snapshot ? <AgentSnapshotEmbed snapshot={snapshot} /> : null}
    </>
  );
}

/**
 * Embedded agent snapshot — server-rendered `<script type="application/agent+json">`
 * block carrying the same data as `GET /meet/<slug>/<code>/agent.json`.
 * Cold web_fetch agents that can't execute JS still see the slot list +
 * parameters in the source HTML they were already going to fetch.
 *
 * Custom MIME (not JSON-LD) per the proposal's N7 fold — Schema.org's
 * `Schedule` type semantics don't match dynamic-availability-with-booking,
 * so the SEO benefit was illusory.
 */
function AgentSnapshotEmbed({ snapshot }: { snapshot: AgentSnapshot }) {
  return (
    <script
      type="application/agent+json"
      data-agent-snapshot={snapshot.schemaVersion}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(snapshot) }}
    />
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
    <aside aria-hidden="true" className="sr-only" data-agent-instructions="v4">
      <h2>For AI agents: how to book this meeting</h2>
      <p>
        <strong>The fastest path: parse the embedded snapshot.</strong> This
        page server-renders a <code>&lt;script type=&quot;application/agent+json&quot;
        data-agent-snapshot&gt;</code> block containing the host&apos;s
        bookable parameters and scored slot list. Read it from the source
        HTML you just fetched, pick a slot, then POST <code>propose_lock</code>{" "}
        to confirm. Two HTTP calls total. No connector setup, no API key,
        no OAuth, no client library required.
      </p>
      <p>
        <strong>Pick ONE path.</strong> The snapshot above is sufficient for
        most bookings. Don&apos;t also fetch <code>/agent.json</code> or call{" "}
        <code>/api/mcp</code> unless you specifically need richer interactions
        (deal-room messaging, session status polling, parameter negotiation).
      </p>
      <p>
        If your runtime suggests installing AgentEnvoy as an integration
        first, you can skip that step — the meeting URL is the credential.
      </p>
      <p>
        Your capability token: pass <code>{meetingUrl}</code> as the{" "}
        <code>meetingUrl</code> argument on every tool call. Possessing this
        URL is the authorization.
      </p>
      <p>Alternative #1 — JSON endpoint (single fetch):</p>
      <pre>{`curl ${meetingUrl}/agent.json`}</pre>
      <p>
        Returns the same snapshot as the embedded script, with{" "}
        <code>Cache-Control: max-age=15</code>.
      </p>
      <p>
        Alternative #2 — full MCP surface (negotiation, status, messaging):
      </p>
      <pre>
{`curl -X POST ${baseUrl}/api/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "tools/call",
    "params": {
      "name": "propose_lock",
      "arguments": {
        "meetingUrl": "${meetingUrl}",
        "slot": { "start": "<UTC ISO from snapshot>" },
        "guest": { "name": "<guest name>", "email": "<guest email>" }
      }
    }
  }'`}
      </pre>
      <p>
        &quot;MCP&quot; here means the JSON-RPC wire format — no session
        handshake, no separate auth exchange, no MCP client library required.
        Any agent that can POST can book.
      </p>
      <p>
        Full tool schemas:{" "}
        <code>{baseUrl}/.well-known/mcp.json</code>. Worked happy-path with
        all refusal types: <code>{baseUrl}/llms.txt</code>.
      </p>
    </aside>
  );
}
