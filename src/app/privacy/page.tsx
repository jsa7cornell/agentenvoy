import { PublicHeader } from "@/components/public-header";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-surface text-primary">
      <PublicHeader />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy at AgentEnvoy</h1>
        <p className="text-sm text-muted mb-12">Last updated: April 2, 2026</p>

        <div className="prose prose-invert prose-zinc max-w-none space-y-10 text-sm leading-relaxed text-secondary dark:text-zinc-300">

          {/* --- CONSTITUTION --- */}
          <section className="border border-secondary rounded-2xl p-8 bg-surface-inset/50">
            <h2 className="text-xl font-bold text-primary mb-6">Our Principles</h2>
            <p className="text-secondary mb-6">
              These principles govern every decision we make about your data. They are not
              aspirational &mdash; they are operational. Our systems are built to enforce them.
            </p>

            <div className="space-y-6">
              <div>
                <h3 className="text-base font-semibold text-primary">
                  I. We treat your information as if it were our own.
                </h3>
                <p className="mt-1">
                  This is our foundational commitment. We hold and process your data with the same
                  care and discretion we would expect for ourselves. If we wouldn&apos;t be comfortable
                  with how a piece of information is handled, we don&apos;t handle it that way.
                </p>
              </div>

              <div>
                <h3 className="text-base font-semibold text-primary">
                  II. We learn only what the negotiation requires.
                </h3>
                <p className="mt-1">
                  The minimum knowledge principle. AgentEnvoy accesses only the data necessary to
                  facilitate the specific negotiation at hand &mdash; nothing more. We don&apos;t build
                  profiles, mine patterns across negotiations, or retain information beyond its purpose.
                </p>
              </div>

              <div>
                <h3 className="text-base font-semibold text-primary">
                  III. We never advantage one party using the other&apos;s private data.
                </h3>
                <p className="mt-1">
                  AgentEnvoy is a neutral administrator. Information shared by one party is used solely
                  to find mutual ground &mdash; never to give the other party a negotiating edge. Each
                  party sees only the gist of what was shared, not the other&apos;s explicit details.
                </p>
              </div>
            </div>
          </section>

          {/* --- WHAT WE ACCESS --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">What We Access</h2>

            <h3 className="text-base font-semibold text-primary mt-6">Your Google account</h3>
            <p>
              When you sign in, we receive your name, email address, and profile picture from Google.
              We store a refresh token to maintain your connection.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Your calendar (hosts)</h3>
            <p>
              By default, we read only <strong>free/busy time blocks</strong> from your Google Calendar &mdash;
              not event titles, attendees, descriptions, or any other details. We see &ldquo;busy 9&ndash;10am,&rdquo;
              not &ldquo;Doctor appointment with Dr. Smith.&rdquo;
            </p>
            <p className="mt-2">
              You may choose to grant Envoy access to full event details (titles, locations, durations)
              so it can better reason about your flexibility and context &mdash; for example, understanding
              that a nearby lunch could make an in-person meeting convenient. When you do:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>Envoy uses those details to make better scheduling decisions</li>
              <li>Envoy will <strong>never share</strong> your event details with the other party</li>
              <li>Envoy actively avoids leaking private information in its proposals or language</li>
            </ul>
            <p className="mt-2">
              We also create calendar events when a meeting is confirmed &mdash; only with details both
              parties have agreed to.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Your calendar (guests)</h3>
            <p>
              When a guest connects their calendar, we request <strong>read-only</strong> access.
              We read your free/busy availability to find mutual times. We cannot create, modify,
              or delete any events on your calendar.
            </p>
          </section>

          {/* --- AI AND YOUR DATA --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">AI and Your Data</h2>
            <p>
              AgentEnvoy uses an AI scheduling agent (&ldquo;Envoy&rdquo;) powered by Anthropic&apos;s Claude.
              Here is exactly what the AI sees:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li><strong>Default:</strong> Free/busy time blocks only &mdash; no event content</li>
              <li><strong>With your permission:</strong> Event titles, locations, and durations &mdash; used
                for reasoning, never disclosed to other parties</li>
              <li><strong>Always:</strong> Messages exchanged in the negotiation session</li>
              <li><strong>Never:</strong> Data from other negotiation sessions, your broader calendar
                history, or any cross-session profile</li>
            </ul>
            <p className="mt-2">
              The AI processes your data to generate scheduling proposals. It does not learn from
              your data across sessions, and your information is not used to train AI models.
            </p>
          </section>

          {/* --- DATA RETENTION --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Data Retention</h2>
            <p>
              We keep data only as long as it serves a purpose.
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>
                <strong>Negotiation sessions</strong> (messages, proposals, outcomes) are retained for
                <strong> 30 days</strong> after completion, accessible to both parties. Each party sees
                the session from their perspective &mdash; the gist of what was shared, not the other
                party&apos;s private inputs. After 30 days, session data is permanently deleted.
              </li>
              <li>
                <strong>Guest calendar data</strong> (availability from connected calendars) is retained
                for <strong>30 days</strong>, then permanently deleted. Guest calendar credentials are
                never stored long-term.
              </li>
              <li>
                <strong>Host account data</strong> (profile, preferences, calendar connection) persists
                for the life of your account. You can delete your account and all associated data at
                any time from <strong>Dashboard → Account → Danger Zone</strong>. Deletion also revokes
                AgentEnvoy&apos;s access to your Google Calendar. Meetings already written to your calendar
                will remain there &mdash; cancel them first if you&apos;d like guests notified.
              </li>
            </ul>
          </section>

          {/* --- WHAT WE NEVER DO --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">What We Never Do</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>Sell, share, or transfer your data to third parties for advertising or marketing</li>
              <li>Share one party&apos;s event details, calendar content, or private context with the other party</li>
              <li>Build cross-session profiles or behavioral models of users</li>
              <li>Use your data to train AI models</li>
              <li>Access more calendar data than the specific negotiation requires</li>
              <li>Retain data beyond the stated retention periods</li>
            </ul>
          </section>

          {/* --- THIRD PARTIES --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Services We Use</h2>
            <p>We rely on a small number of infrastructure providers to operate:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li><strong>Google APIs</strong> &mdash; Authentication and calendar access</li>
              <li><strong>Anthropic (Claude)</strong> &mdash; AI agent. Receives free/busy times (or event
                details with your permission) and negotiation messages. Does not retain your data.</li>
              <li><strong>Resend</strong> &mdash; Confirmation emails</li>
              <li><strong>Vercel</strong> &mdash; Application hosting</li>
              <li><strong>Supabase</strong> &mdash; Database hosting (PostgreSQL, encrypted at rest)</li>
            </ul>
            <p className="mt-2">
              We do not use analytics trackers, advertising pixels, or data brokers.
            </p>
          </section>

          {/* --- YOUR RIGHTS --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Your Rights</h2>
            <ul className="list-disc pl-6 space-y-1">
              <li>
                <strong>Revoke access</strong> at any time via{" "}
                <a href="https://myaccount.google.com/permissions" className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">
                  Google Account Permissions
                </a>
              </li>
              <li><strong>Request a copy</strong> of all data we hold about you</li>
              <li>
                <strong>Delete your account</strong> and all associated data at any time from{" "}
                <strong>Dashboard → Account → Danger Zone</strong>. Guest-calendar-only users
                (no AgentEnvoy account) can email <a href="mailto:privacy@agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">privacy@agentenvoy.ai</a>.
              </li>
              <li><strong>Opt out</strong> of enhanced calendar access at any time (revert to free/busy only)</li>
            </ul>
          </section>

          {/* --- GOOGLE API COMPLIANCE --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Google API Services User Data Policy</h2>
            <p>
              AgentEnvoy&apos;s use and transfer of information received from Google APIs adheres to the{" "}
              <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          {/* --- CONTACT --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Contact</h2>
            <p>
              Questions about this policy or your data:{" "}
              <a href="mailto:privacy@agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">
                privacy@agentenvoy.ai
              </a>
            </p>
          </section>
        </div>

      </div>
    </div>
  );
}
