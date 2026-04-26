import { PublicHeader } from "@/components/public-header";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-surface text-primary">
      <PublicHeader />
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy at AgentEnvoy</h1>
        <p className="text-sm text-muted mb-12">Last updated: April 20, 2026</p>

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
                  II. We learn only what the coordination requires.
                </h3>
                <p className="mt-1">
                  The minimum knowledge principle. AgentEnvoy accesses only the data necessary to
                  facilitate the specific coordination at hand &mdash; nothing more. We don&apos;t build
                  profiles, mine patterns across coordinations, or retain information beyond its purpose.
                </p>
              </div>

              <div>
                <h3 className="text-base font-semibold text-primary">
                  III. We never advantage one party using the other&apos;s private data.
                </h3>
                <p className="mt-1">
                  AgentEnvoy is a neutral coordinator. Information shared by one party is used solely
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
                tentative holds during an active coordination, and to delete or adjust those events
                when you cancel or reschedule through AgentEnvoy.
              </li>
            </ul>
            <p className="mt-2">
              Which scopes we ask for depends on how you sign in. If you sign up through our front
              door &mdash; the header, homepage, or <code className="text-xs">/login</code> page
              &mdash; we request read and write together, since you&apos;re signing up to host
              meetings. If you connect a calendar from within a meeting link someone shared with
              you, we request read-only; you&apos;ll only be asked for write later if you become a
              host yourself. The goal is to ask for the narrowest access that fits what you&apos;re
              actually doing.
            </p>
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
              calendar. We read only the free/busy windows needed for the coordination you&apos;re in.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Data you provide directly</h3>
            <p>
              Messages you send to Envoy during a coordination, preferences you set (meeting
              duration, phone number, video provider, scheduling rules), and any knowledge you
              explicitly teach Envoy about how you prefer to work.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Patterns Envoy learns about you</h3>
            <p>
              As you use AgentEnvoy, Envoy derives a set of scheduling preferences from how your
              calendar actually looks &mdash; the hours you tend to be working, buffers around
              focus time, and which people you make time for most easily. These derived patterns
              are stored against your account so Envoy can make smarter proposals on your behalf.
              They&apos;re available for you to review and edit on your dashboard, and they&apos;re
              deleted when you delete your account.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">Product-usage events</h3>
            <p>
              We record a small set of product-usage events (for example, &ldquo;you finished
              onboarding,&rdquo; &ldquo;you confirmed a meeting&rdquo;) on our own database so we
              can see which parts of the product work and which don&apos;t. Event names are
              enumerated in our source code under an allowlist, and event properties are limited
              to short primitive values (strings, numbers, booleans). Calendar content, message
              text, and free-text input are never captured through this channel. We do not
              currently send these events to any third-party analytics vendor; if that ever
              changes, we&apos;ll update this policy and list the vendor here before any data
              leaves our infrastructure.
            </p>

            <h3 className="text-base font-semibold text-primary mt-6">When you send us feedback</h3>
            <p>
              There&apos;s a &ldquo;Send feedback&rdquo; link in the product. When you use it, you
              can optionally include recent activity (your latest messages, active sessions, and
              any route errors from the last day) so we can see what you were seeing. Calendar
              event contents are redacted before anything is stored &mdash; we keep times, titles,
              status, and participant counts; we strip descriptions, attachments, non-participant
              emails, and URL-shaped locations. If you opt to share, we gather only what you
              chose to share. Feedback is a gift &mdash; thank you for taking the time. 💜
            </p>
          </section>

          {/* --- HOW WE USE IT --- (Google: Data Usage) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">How We Use It</h2>
            <p>Your data is used for one purpose: facilitating the meeting coordination in front of you.</p>
            <ul className="list-disc pl-6 space-y-1 mt-2">
              <li>
                <strong>Scheduling.</strong> Calendar data is used to compute availability, propose
                times, and place or confirm events.
              </li>
              <li>
                <strong>Envoy&apos;s reasoning.</strong> Messages and (optionally) event titles are
                passed to our AI model so it can respond in the coordination. Nothing is retained by
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
              <li>Access more calendar data than the specific coordination requires</li>
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
                coordination messages and the specific calendar context relevant to the current
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
                we persist about your account and coordinations is stored here, encrypted at rest.
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
                <strong>Access within AgentEnvoy:</strong> see &ldquo;Internal access audit&rdquo;
                below &mdash; every internal read of user-specific data is logged, and
                team access to your thread or calendar requires your explicit opt-in.
              </li>
              <li>
                <strong>Scope minimization:</strong> we request the narrowest Google OAuth scopes that
                allow the product to function &mdash; read events, read timezone, create/modify our
                own booked events. Nothing broader.
              </li>
            </ul>
          </section>

          {/* --- INTERNAL ACCESS AUDIT --- */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Internal Access Audit</h2>
            <p>
              Every internal admin read of user-specific data &mdash; feedback reports, user
              drawers, event streams &mdash; writes a row to an internal audit log
              (<code className="text-xs">AdminAccessLog</code>). The log records which admin,
              which route, and when. This is a structural control: the audit exists by
              construction, not by policy. If you&apos;d like a copy of your own log entries,
              email{" "}
              <a href="mailto:privacy@agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">
                privacy@agentenvoy.ai
              </a>
              .
            </p>
            <p className="mt-2">
              When our team needs to read your specific thread or calendar to help you with a
              bug, we ask for your explicit opt-in via the Privacy section of your{" "}
              <a href="/dashboard/account" className="text-indigo-400 hover:text-indigo-300">
                Account page
              </a>
              . The consent is revocable at any time, and every access is still logged.
            </p>
          </section>

          {/* --- RETENTION AND DELETION --- (Google: Data Retention & Deletion) */}
          <section>
            <h2 className="text-lg font-semibold text-primary">Retention and Deletion</h2>
            <p>We keep data only as long as it serves a purpose.</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>
                <strong>Coordination sessions</strong> (messages, proposals, outcomes) are retained
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
