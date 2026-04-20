/**
 * /agents — Human-facing landing page for the MCP surface.
 *
 * Dual audience:
 *   - Curious humans who clicked the "Agent-bookable" badge on a meeting
 *     page and want to know what that means + how to try it.
 *   - AI agents discovering the page via the Link: rel="service-doc"
 *     header. They can follow the in-page links back to /.well-known/mcp.json
 *     for the machine-readable manifest.
 *
 * Copy tone mirrors /faq — first-person, conversational, not marketing-y.
 * The MCP endpoint details (transport, auth, tool list) all come from the
 * same registry that drives the manifest, so nothing here can drift from
 * the live spec without failing a test.
 */
import { PublicHeader } from "@/components/public-header";
import { MCP_TOOLS, MCP_TOOL_NAMES } from "@/lib/mcp/schemas";

export const metadata = {
  title: "For Agents | AgentEnvoy",
  description:
    "AgentEnvoy meeting links are bookable by AI agents via the Model Context Protocol. Point your agent at a meeting URL and it can negotiate and book on your behalf.",
};

export default function AgentsPage() {
  return (
    <div className="min-h-screen bg-surface text-primary">
      <PublicHeader />

      {/* Hero */}
      <div className="max-w-3xl mx-auto px-6 pt-16 pb-10">
        <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wider text-indigo-400 mb-3">
          <span>📡</span>
          <span>MCP-enabled scheduling</span>
        </div>
        <h1 className="text-3xl font-bold mb-4">
          Your AI can book this meeting for you.
        </h1>
        <p className="text-base text-secondary leading-relaxed max-w-2xl mb-5">
          Every AgentEnvoy meeting link doubles as a Model Context Protocol
          endpoint. If you&rsquo;ve been sent one, hand it to your AI assistant
          and it can negotiate the time, pick a slot that works, and book it —
          on the same scoring engine the host uses themselves.
        </p>
        <nav className="flex flex-wrap gap-2">
          <a
            href="#for-humans"
            className="text-xs px-3 py-1.5 rounded-full border border-secondary text-secondary hover:text-primary hover:border-DEFAULT transition"
          >
            For humans ↓
          </a>
          <a
            href="#why"
            className="text-xs px-3 py-1.5 rounded-full border border-secondary text-secondary hover:text-primary hover:border-DEFAULT transition"
          >
            Why this matters ↓
          </a>
          <a
            href="#for-agents"
            className="text-xs px-3 py-1.5 rounded-full border border-secondary text-secondary hover:text-primary hover:border-DEFAULT transition"
          >
            For agents ↓
          </a>
        </nav>
      </div>

      {/* For humans — try it with Claude */}
      <section id="for-humans" className="max-w-3xl mx-auto px-6 pb-12 scroll-mt-20">
        <h2 className="text-xl font-semibold mb-3">For curious humans</h2>
        <p className="text-sm text-secondary leading-relaxed mb-6">
          The fastest way to see this work is to point Claude at a meeting
          URL you&rsquo;ve been given and ask it to find you a time.
        </p>

        <div className="rounded-xl border border-secondary bg-surface-inset p-5 mb-4">
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">
            Claude Code
          </div>
          <p className="text-sm text-secondary leading-relaxed mb-3">
            Add AgentEnvoy as an MCP server once, then any meeting URL you
            paste into a conversation becomes actionable:
          </p>
          <pre className="text-xs bg-black/40 border border-DEFAULT rounded-lg p-3 overflow-x-auto text-primary">
            <code>{`claude mcp add --transport http agentenvoy https://agentenvoy.ai/api/mcp`}</code>
          </pre>
          <p className="text-sm text-secondary leading-relaxed mt-3">
            Then, in a Claude Code session:
          </p>
          <pre className="text-xs bg-black/40 border border-DEFAULT rounded-lg p-3 overflow-x-auto text-primary mt-2 whitespace-pre-wrap">
            <code>{`I got this invite: https://agentenvoy.ai/meet/abc123
Can you find me a time next Tuesday or Wednesday afternoon
and book it? My name is Alex, email alex@example.com.`}</code>
          </pre>
        </div>

        <div className="rounded-xl border border-secondary bg-surface-inset p-5 mb-4">
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">
            Claude Desktop
          </div>
          <p className="text-sm text-secondary leading-relaxed mb-3">
            Open Settings → Developer → Edit Config and add:
          </p>
          <pre className="text-xs bg-black/40 border border-DEFAULT rounded-lg p-3 overflow-x-auto text-primary whitespace-pre-wrap">
            <code>{`{
  "mcpServers": {
    "agentenvoy": {
      "transport": { "type": "http" },
      "url": "https://agentenvoy.ai/api/mcp"
    }
  }
}`}</code>
          </pre>
          <p className="text-xs text-muted mt-3">
            Restart Claude Desktop; the eight MCP tools appear under the
            tools affordance.
          </p>
        </div>

        <div className="rounded-xl border border-secondary bg-surface-inset p-5">
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">
            Any other MCP client
          </div>
          <p className="text-sm text-secondary leading-relaxed">
            The discovery manifest is at{" "}
            <a
              href="/.well-known/mcp.json"
              className="text-indigo-400 hover:text-indigo-300"
            >
              /.well-known/mcp.json
            </a>
            . Transport: streamable HTTP. No auth token to install — the
            meeting URL itself is the bearer.
          </p>
        </div>
      </section>

      {/* Why this is awesome */}
      <section id="why" className="max-w-3xl mx-auto px-6 pb-12 scroll-mt-20">
        <h2 className="text-xl font-semibold mb-3">Why this matters</h2>
        <div className="space-y-4 text-sm text-secondary leading-relaxed">
          <p>
            Most scheduling tools give AI agents a stripped-down read-only
            view of availability. AgentEnvoy doesn&rsquo;t. Your agent gets
            the <em>same</em> scored, filtered slot list the host&rsquo;s own
            dashboard uses — including the host&rsquo;s preferences, office
            hours, priority tiers, and soft / hard conflict rules.
          </p>
          <p>
            When your agent proposes a time, it flows through the same
            confirmation pipeline as the web UI: compare-and-swap on the
            session row, atomic calendar write, email dispatch. No &ldquo;I
            tried to book but actually someone else got it&rdquo; race.
          </p>
          <p>
            And because every tool call lands in an observability log, the
            host can see exactly what your agent asked for and why — building
            the trust surface that makes agent-to-agent negotiation work.
          </p>
        </div>
      </section>

      {/* For agents — the spec surface */}
      <section id="for-agents" className="max-w-3xl mx-auto px-6 pb-16 scroll-mt-20">
        <h2 className="text-xl font-semibold mb-3">For agents reading this</h2>
        <p className="text-sm text-secondary leading-relaxed mb-4">
          You&rsquo;re the intended second audience for this page. Here&rsquo;s
          what you need:
        </p>
        <ul className="space-y-3 text-sm text-secondary leading-relaxed mb-6 list-disc pl-5">
          <li>
            <strong className="text-primary">Discovery manifest:</strong>{" "}
            <a
              href="/.well-known/mcp.json"
              className="text-indigo-400 hover:text-indigo-300"
            >
              /.well-known/mcp.json
            </a>{" "}
            — full JSON Schema for every tool&rsquo;s input and output.
          </li>
          <li>
            <strong className="text-primary">Orientation text:</strong>{" "}
            <a
              href="/llms.txt"
              className="text-indigo-400 hover:text-indigo-300"
            >
              /llms.txt
            </a>{" "}
            — short prose guide to the tool surface.
          </li>
          <li>
            <strong className="text-primary">Endpoint:</strong>{" "}
            <code className="text-xs bg-black/40 border border-DEFAULT rounded px-1.5 py-0.5">
              /api/mcp
            </code>{" "}
            (streamable HTTP, stateless).
          </li>
          <li>
            <strong className="text-primary">Auth:</strong> every tool takes a{" "}
            <code className="text-xs bg-black/40 border border-DEFAULT rounded px-1.5 py-0.5">
              meetingUrl
            </code>{" "}
            argument. Possession of the URL is authorization — there is no
            separate token exchange.
          </li>
        </ul>

        <h3 className="text-sm font-semibold text-primary mb-2">
          The eight tools
        </h3>
        <div className="rounded-xl border border-secondary bg-surface-inset p-5 space-y-2.5">
          {MCP_TOOL_NAMES.map((name) => (
            <div key={name} className="flex items-start gap-3">
              <code className="text-xs font-mono text-indigo-400 flex-shrink-0 mt-0.5 w-48">
                {name}
              </code>
              <span className="text-xs text-secondary leading-relaxed">
                {MCP_TOOLS[name].description}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Footer — dogfood the product: book 5 min with John via his own MCP link. */}
      <div className="max-w-3xl mx-auto px-6 pb-20">
        <div className="border-t border-secondary pt-8">
          <h3 className="text-lg font-semibold text-primary mb-2">
            Questions? Book five minutes with me.
          </h3>
          <p className="text-sm text-secondary leading-relaxed mb-4 max-w-xl">
            The fastest way to reach me is the same way the product works —
            grab a slot on my calendar. Your agent is welcome to negotiate
            one on your behalf, or you can pick one yourself.
          </p>
          <a
            href="https://agentenvoy.ai/meet/johnanderson"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-400/40 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-300 hover:text-indigo-200 hover:border-indigo-400/70 transition"
          >
            <span>📅</span>
            <span>Book 5 min with John →</span>
          </a>
        </div>
      </div>
    </div>
  );
}
