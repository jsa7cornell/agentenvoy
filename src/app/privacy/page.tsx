export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-zinc-500 mb-10">Last updated: April 2, 2026</p>

        <div className="prose prose-invert prose-zinc max-w-none space-y-8 text-sm leading-relaxed text-zinc-300">
          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Overview</h2>
            <p>
              AgentEnvoy (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates the agentenvoy.ai website
              and platform. This policy describes how we collect, use, and protect your information
              when you use our service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Information We Collect</h2>
            <p>When you sign in with Google, we receive:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Your name, email address, and profile picture (from your Google account)</li>
              <li>A refresh token to maintain your connection (stored securely in our database)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Google Calendar Data</h2>
            <p>
              AgentEnvoy accesses your Google Calendar data to coordinate meetings on your behalf.
              Here is exactly what we access and why:
            </p>

            <h3 className="text-base font-semibold text-zinc-200 mt-4">For hosts (account holders):</h3>
            <p>
              We request <strong>calendar.events</strong> scope, which allows us to:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Read your calendar&apos;s free/busy information to determine your availability</li>
              <li>Create calendar events when a meeting is confirmed by both parties</li>
              <li>Attach Google Meet links to confirmed meetings</li>
            </ul>
            <p>
              We do <strong>not</strong> read the content of your existing calendar events — only
              free/busy time blocks. We only create new events when you or your guest explicitly
              confirm a meeting time.
            </p>

            <h3 className="text-base font-semibold text-zinc-200 mt-4">For guests (calendar connect):</h3>
            <p>
              We request <strong>calendar.readonly</strong> scope, which allows us to:
            </p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Read your calendar&apos;s free/busy information to find mutual availability</li>
            </ul>
            <p>
              Guest calendar access is <strong>one-time and temporary</strong>. We do not store
              your calendar credentials. We read your availability once to help find a time that
              works, and that&apos;s it.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">How We Use Your Data</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>To coordinate and schedule meetings between you and other parties</li>
              <li>To display your availability to our AI scheduling agent (not to other users directly)</li>
              <li>To create calendar events and send confirmation emails when meetings are confirmed</li>
              <li>To improve our scheduling algorithms and service quality</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Data Storage &amp; Security</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Your data is stored in a secured PostgreSQL database hosted on Supabase</li>
              <li>OAuth tokens are encrypted at rest</li>
              <li>We use HTTPS for all data transmission</li>
              <li>We do not sell, share, or transfer your data to third parties for advertising</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Third-Party Services</h2>
            <p>We use the following services to operate AgentEnvoy:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li><strong>Google APIs</strong> — for authentication and calendar access</li>
              <li><strong>Anthropic (Claude AI)</strong> — to power our scheduling agent. Calendar availability
                (free/busy times only) is shared with the AI to generate scheduling proposals.
                No event details or personal calendar content is shared.</li>
              <li><strong>Resend</strong> — for sending confirmation emails</li>
              <li><strong>Vercel</strong> — for hosting</li>
              <li><strong>Supabase</strong> — for database hosting</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Data Retention</h2>
            <p>
              We retain your account data for as long as your account is active. You can request
              deletion of your account and all associated data by contacting us. Negotiation
              session data (messages, proposals) is retained for service improvement and may be
              deleted upon request.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Your Rights</h2>
            <p>You can:</p>
            <ul className="list-disc pl-6 space-y-1">
              <li>Revoke AgentEnvoy&apos;s access to your Google account at any time via{" "}
                <a href="https://myaccount.google.com/permissions" className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">
                  Google Account Permissions
                </a>
              </li>
              <li>Request a copy of your data</li>
              <li>Request deletion of your account and data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Google API Services User Data Policy</h2>
            <p>
              AgentEnvoy&apos;s use and transfer of information received from Google APIs adheres to the{" "}
              <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-zinc-100">Contact</h2>
            <p>
              For questions about this privacy policy or to exercise your data rights, contact us
              at <a href="mailto:privacy@agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">privacy@agentenvoy.ai</a>.
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
