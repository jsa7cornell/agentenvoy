export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-zinc-500 mb-12">Last updated: April 2, 2026</p>

        <div className="prose prose-invert prose-zinc max-w-none space-y-8 text-sm leading-relaxed text-zinc-300">

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">1. What AgentEnvoy Is</h2>
            <p>
              AgentEnvoy is an AI-powered scheduling and negotiation platform. An AI agent
              (&ldquo;Envoy&rdquo;) acts as a neutral administrator &mdash; it coordinates between
              parties without representing either side. By using AgentEnvoy, you agree to these terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">2. Our Commitments</h2>
            <p>
              AgentEnvoy operates under the principles described in our{" "}
              <a href="/privacy" className="text-indigo-400 hover:text-indigo-300">Privacy Policy</a>.
              In particular:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>We treat your information as if it were our own</li>
              <li>We learn only what the negotiation requires</li>
              <li>We never advantage one party using the other&apos;s private data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">3. Accounts</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Sign in with a valid Google account to create an AgentEnvoy account</li>
              <li>You are responsible for maintaining the security of your account and API keys</li>
              <li>Provide accurate information when using the service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">4. Calendar Access</h2>
            <p>
              By connecting your Google Calendar, you grant AgentEnvoy permission to:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li><strong>Hosts:</strong> Read your availability and create calendar events when
                meetings are confirmed by both parties</li>
              <li><strong>Guests:</strong> Read your availability (read-only, one-time) to find
                mutual times</li>
            </ul>
            <p className="mt-2">
              You can revoke calendar access at any time via your{" "}
              <a href="https://myaccount.google.com/permissions" className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">
                Google Account settings
              </a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">5. AI Agent Behavior</h2>
            <p>
              Envoy assists with scheduling and negotiations. While we build for accuracy, the AI
              may occasionally misunderstand context. You are responsible for reviewing and confirming
              any proposed meeting before it is finalized. AgentEnvoy is not liable for scheduling
              conflicts or miscommunications arising from AI-generated proposals.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">6. Acceptable Use</h2>
            <p>Do not:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>Use the service for unlawful purposes</li>
              <li>Send unsolicited or abusive meeting requests</li>
              <li>Attempt unauthorized access to the service or its systems</li>
              <li>Share API keys publicly or embed them in client-side code</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">7. Data Retention</h2>
            <p>
              Negotiation session data is retained for 30 days after completion, then permanently
              deleted. Account data persists for the life of your account. Full details in our{" "}
              <a href="/privacy" className="text-indigo-400 hover:text-indigo-300">Privacy Policy</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">8. Intellectual Property</h2>
            <p>
              The service is owned by AgentEnvoy. Your data remains yours &mdash; we do not claim
              ownership of your calendar data, messages, or other content.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">9. Limitation of Liability</h2>
            <p>
              The service is provided &ldquo;as is.&rdquo; AgentEnvoy is not liable for indirect,
              incidental, or consequential damages resulting from your use of the service, including
              missed meetings, scheduling errors, or data loss.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">10. Termination</h2>
            <p>
              We may suspend access for violation of these terms. You may delete your account at
              any time by contacting us. Upon termination, your data is deleted per our retention policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">11. Changes</h2>
            <p>
              We may update these terms. Continued use after changes constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">12. Contact</h2>
            <p>
              Questions:{" "}
              <a href="mailto:support@agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">
                support@agentenvoy.ai
              </a>
            </p>
          </section>
        </div>

      </div>
    </div>
  );
}
