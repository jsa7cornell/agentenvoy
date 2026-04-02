export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-zinc-500 mb-10">Last updated: April 2, 2026</p>

        <div className="prose prose-invert prose-zinc max-w-none space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="text-lg font-semibold text-zinc-100">1. Acceptance of Terms</h2>
            <p>
              By using AgentEnvoy (&quot;the Service&quot;), operated at agentenvoy.ai, you agree to
              these Terms of Service. If you do not agree, do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">2. Description of Service</h2>
            <p>
              AgentEnvoy is an AI-powered scheduling and negotiation platform. The Service uses
              artificial intelligence to coordinate meetings and negotiations between parties.
              AgentEnvoy acts as a neutral administrator — it does not represent either party
              in a negotiation.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">3. Accounts</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>You must sign in with a valid Google account to create an AgentEnvoy account</li>
              <li>You are responsible for maintaining the security of your account</li>
              <li>You must provide accurate information when using the Service</li>
              <li>One person or entity may not maintain more than one account</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">4. Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Use the Service for any unlawful purpose</li>
              <li>Abuse, harass, or send unsolicited meeting requests to others</li>
              <li>Attempt to gain unauthorized access to the Service or its systems</li>
              <li>Interfere with other users&apos; use of the Service</li>
              <li>Use the Service to send spam or bulk unsolicited communications</li>
              <li>Reverse engineer, decompile, or attempt to extract the source code of the Service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">5. AI Agent Behavior</h2>
            <p>
              The AgentEnvoy AI agent (&quot;Envoy&quot;) assists with scheduling and negotiations.
              While we strive for accuracy, the AI may occasionally make errors or
              misunderstand context. You are responsible for reviewing and confirming any
              proposed meetings or agreements before they are finalized. AgentEnvoy is not
              liable for scheduling conflicts, missed meetings, or miscommunications arising
              from AI-generated proposals.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">6. Calendar Access</h2>
            <p>
              By connecting your Google Calendar, you grant AgentEnvoy permission to read your
              availability and, for account holders, to create calendar events on your behalf
              when meetings are confirmed. You can revoke this access at any time through your
              Google Account settings. See our{" "}
              <a href="/privacy" className="text-indigo-400 hover:text-indigo-300">
                Privacy Policy
              </a>{" "}
              for details on how we handle your calendar data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">7. API Access</h2>
            <p>
              API keys grant programmatic access to AgentEnvoy. You are responsible for
              keeping your API keys secure. Do not share API keys publicly or embed them in
              client-side code. We reserve the right to revoke API keys that are misused.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">8. Intellectual Property</h2>
            <p>
              The Service, including its design, code, and AI models, is owned by AgentEnvoy.
              Your data remains yours — we do not claim ownership of your calendar data,
              messages, or other content you provide through the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">9. Limitation of Liability</h2>
            <p>
              The Service is provided &quot;as is&quot; without warranty of any kind. AgentEnvoy is not
              liable for any indirect, incidental, special, consequential, or punitive damages
              resulting from your use of or inability to use the Service, including but not
              limited to missed meetings, scheduling errors, or data loss.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">10. Termination</h2>
            <p>
              We may suspend or terminate your access to the Service at any time for violation
              of these terms. You may delete your account at any time by contacting us. Upon
              termination, your data will be deleted in accordance with our Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">11. Changes to Terms</h2>
            <p>
              We may update these terms from time to time. Continued use of the Service after
              changes constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">12. Contact</h2>
            <p>
              For questions about these terms, contact us at{" "}
              <a href="mailto:support@agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">
                support@agentenvoy.ai
              </a>.
            </p>
          </section>
        </div>

        <div className="mt-16 border-t border-zinc-800 pt-6">
          <a href="/" className="text-sm text-indigo-400 hover:text-indigo-300">
            &larr; Back to AgentEnvoy
          </a>
        </div>
      </div>
    </div>
  );
}
