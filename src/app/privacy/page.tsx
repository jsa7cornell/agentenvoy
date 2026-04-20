import { PublicHeader } from "@/components/public-header";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-surface text-primary">
      <PublicHeader />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy at AgentEnvoy</h1>
        <p className="text-sm text-muted mb-12">Last updated: April 19, 2026</p>

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

          {/* --- WHAT WE ACCESS --- (Google: Data Accessed) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">What We Access</h2>

            <h3 className="text-base font-semibold text-primary mt-6">Your Google account</h3>
            <p>
              When you sign in with Google, we receive your name, email address, and profile picture
              (<code className="text-xs">openid</code>, <code className="text-xs">email</code>,{" "}
              <code className="text-xs">profile</code>). We also store a Google-issued refresh token
              so we can maintain your connection without asking you to sign in again.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Your Google Calendar (hosts)</h3>
            <p>
              When you grant calendar access, AgentEnvoy requests two Google API scopes:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>
                <code className="text-xs">https://www.googleapis.com/auth/calendar.readonly</code>{" "}
                &mdash; to read your calendars, events, working-location and out-of-office entries,
                and your timezone setting. Envoy uses this to know when you&apos;re free.
              </li>
              <li>
                <code className="text-xs">https://www.googleapis.com/auth/calendar.events</code>{" "}
                &mdash; to create a calendar event when both parties agree on a time, to place short
                tentative holds during an active negotiation, and to delete or adjust those events
                when you cancel or reschedule through AgentEnvoy.
              </li>
            </ul>
            <p className="mt-2">
              By default Envoy reasons only about <strong>when</strong> you are busy &mdash; not{" "}
              <strong>why</strong>. We see &ldquo;busy 9&ndash;10am,&rdquo; not &ldquo;Doctor
              appointment with Dr. Smith.&rdquo; You may choose to let Envoy also consider event
              titles and locations so it can reason about your flexibility (for example, noticing
              that a nearby lunch makes an in-person meeting convenient). When you do, Envoy uses
              those details internally and <strong>never shares</strong> them with the other party.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Your Google Calendar (guests)</h3>
            <p>
              If you&apos;re a guest invited to a meeting, you can optionally connect your calendar
              so AgentEnvoy can find a mutual time. This uses{" "}
              <code className="text-xs">https://www.googleapis.com/auth/calendar.readonly</code>{" "}
              &mdash; read-only. We can never create, modify, or delete anything on a guest&apos;s
              calendar. We read only the free/busy windows needed for the negotiation you&apos;re in.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Data you provide directly</h3>
            <p>
              Messages you send to Envoy during a negotiation, preferences you set (meeting
              duration, phone number, video provider, scheduling rules), and any knowledge you
              explicitly teach Envoy about how you prefer to work.
            </p>
          </section>

          {/* --- HOW WE USE IT --- (Google: Data Usage) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">How We Use It</h2>
            <p>Your data is used for one purpose: facilitating the meeting negotiation in front of you.</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>
                <strong>Scheduling.</strong> Calendar data is used to compute availability, propose
                times, and place or confirm events.
              </li>
              <li>
                <strong>Envoy&apos;s reasoning.</strong> Messages and (optionally) event titles are
                passed to our AI model so it can respond in the negotiation. Nothing is retained by
                the AI provider beyond the single request that generates each reply.
              </li>
              <li>
                <strong>Account operation.</strong> Your Google identity is used to authenticate you
                and keep you signed in. Your email address is used for transactional notifications
                (meeting confirmations, cancellations, a welcome message).
              </li>
            </ul>
            <p className="mt-2">We do not:</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>Sell, rent, or share your data for advertising or marketing</li>
              <li>
                Use your data or any data received through Google APIs to{" "}
                <strong>train, fine-tune, or improve AI or machine-learning models</strong>
              </li>
              <li>Build cross-session profiles or behavioral models</li>
              <li>Share one party&apos;s event details or private context with the other party</li>
              <li>Access more calendar data than the specific negotiation requires</li>
            </ul>
            <p className="mt-2">
              AgentEnvoy&apos;s use and transfer of information received from Google APIs adheres to
              the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="text-indigo-400 hover:text-indigo-300"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          {/* --- SERVICES WE USE --- (Google: Data Sharing) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Services We Use</h2>
            <p>
              We rely on a small number of infrastructure providers to operate. Each is a data
              processor acting under our instructions, bound by their own published terms:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>
                <strong>Google APIs</strong> &mdash; authentication and Google Calendar access. Data
                shared: OAuth tokens and API requests on your behalf.
              </li>
              <li>
                <strong>Anthropic (Claude)</strong> &mdash; AI model that powers Envoy. Data shared:
                negotiation messages and the specific calendar context relevant to the current
                conversation (times; titles only if you&apos;ve enabled enhanced access). Anthropic
                does not retain this data beyond the individual request and does not use it to train
                models.
              </li>
              <li>
                <strong>Amazon Web Services (SES)</strong> &mdash; sends our transactional emails
                (meeting confirmations, cancellation notices, occasional account notices). Data
                shared: recipient email addresses and the email content itself.
              </li>
              <li>
                <strong>Vercel</strong> &mdash; application hosting and serverless execution. Data
                shared: every request you make to AgentEnvoy passes through Vercel&apos;s infrastructure.
              </li>
              <li>
                <strong>Supabase</strong> &mdash; managed PostgreSQL database. Data shared: everything
                we persist about your account and negotiations is stored here, encrypted at rest.
              </li>
              <li>
                <strong>Cloudflare</strong> &mdash; DNS for agentenvoy.ai.
              </li>
            </ul>
            <p className="mt-2">
              We do not share your data with any third party for advertising, analytics, profiling,
              or any purpose unrelated to operating AgentEnvoy. We do not use advertising trackers,
              analytics pixels, or data brokers.
            </p>
          </section>

          {/* --- HOW WE PROTECT IT --- (Google: Data Storage & Protection) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">How We Protect It</h2>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>
                <strong>In transit:</strong> all traffic between your browser, AgentEnvoy, and every
                service we use is encrypted with TLS (HTTPS).
              </li>
              <li>
                <strong>At rest:</strong> the database is encrypted at rest by Supabase. OAuth
                refresh tokens are stored in the same encrypted database; they are never logged or
                exposed to the client.
              </li>
              <li>
                <strong>Access control:</strong> no advertising identifiers, tracking cookies, or
                cross-site trackers are set. Session cookies are HTTP-only and scoped to
                agentenvoy.ai.
              </li>
              <li>
                <strong>Access within AgentEnvoy:</strong> only the small set of maintainers operating
                the service can access production systems, and only for diagnostic or support purposes.
                We do not browse your calendar or messages as a matter of course.
              </li>
              <li>
                <strong>Scope minimization:</strong> we request the narrowest Google OAuth scopes that
                allow the product to function &mdash; read events, read timezone, create/modify our
                own booked events. Nothing broader.
              </li>
            </ul>
          </section>

          {/* --- RETENTION AND DELETION --- (Google: Data Retention & Deletion) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Retention and Deletion</h2>
            <p>We keep data only as long as it serves a purpose.</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>
                <strong>Negotiation sessions</strong> (messages, proposals, outcomes) are retained
                for <strong>30 days</strong> after completion, accessible to both parties. After
                30 days, session data is permanently deleted.
              </li>
              <li>
                <strong>Guest calendar data</strong> (availability from a guest&apos;s connected
                calendar) is retained for <strong>30 days</strong>, then permanently deleted. Guest
                OAuth credentials are revoked and deleted at the same time.
              </li>
              <li>
                <strong>Host calendar cache</strong> (the scored availability view Envoy uses) is
                refreshed continuously and discarded whenever you revoke access or delete your account.
              </li>
              <li>
                <strong>Host account data</strong> (profile, preferences, calendar connection) persists
                for the life of your account.
              </li>
            </ul>

            <h3 className="text-base font-semibold text-primary mt-6">Deleting your account and data</h3>
            <p>
              You can permanently delete your AgentEnvoy account at any time from the{" "}
              <a
                href="/dashboard/account"
                className="text-indigo-400 hover:text-indigo-300"
              >
                Account page
              </a>{" "}
              under <em>Delete account</em>. When you do:
            </p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>All your profile, preference, and session data is deleted from our database</li>
              <li>All cached calendar data is deleted</li>
              <li>Your Google OAuth authorization is revoked with Google on our side</li>
              <li>Confirmed calendar events AgentEnvoy previously created are left in place &mdash; those are yours</li>
            </ul>
            <p className="mt-2">
              You can also revoke AgentEnvoy&apos;s access to your Google data at any time from{" "}
              <a
                href="https://myaccount.google.com/permissions"
                className="text-indigo-400 hover:text-indigo-300"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google Account Permissions
              </a>
              . Once revoked, we stop accessing any Google data immediately and delete any cached
              calendar data within 30 days.
            </p>
            <p className="mt-2">
              Questions, or need help with deletion or a data export? Email{" "}
              <a
                href="mailto:privacy@agentenvoy.ai"
                className="text-indigo-400 hover:text-indigo-300"
              >
                privacy@agentenvoy.ai
              </a>
              .
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
