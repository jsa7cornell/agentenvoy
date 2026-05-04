import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { dispatchWelcomeEmailOnce } from "@/lib/emails/welcome";
import { registerEventsWatch, registerCalendarListWatch } from "@/lib/google-watch";
import { cookies } from "next/headers";
import {
  ENTRY_POINT_COOKIE,
  HOST_WRITE_SCOPE,
  auditScopes,
  hostRequiredFor,
  type HostEntryPoint,
} from "@/lib/oauth/required-scopes";
import { buildSeededExplicit } from "@/lib/onboarding/seed-defaults";
import { logCalibrationWrite } from "@/lib/calibration-audit";
import { fetchGoogleOnboardingSeed } from "@/lib/google-onboarding-seed";

// Dev-only credentials provider — NEVER available in production
const devProvider =
  process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_SECRET
    ? [
        CredentialsProvider({
          id: "dev-credentials",
          name: "Dev Login",
          credentials: {
            email: { label: "Email", type: "email" },
            secret: { label: "Dev Secret", type: "password" },
          },
          async authorize(credentials) {
            if (!credentials || credentials.secret !== process.env.DEV_AUTH_SECRET) {
              return null;
            }
            const user = await prisma.user.findUnique({
              where: { email: credentials.email },
            });
            if (!user) return null;
            return { id: user.id, email: user.email, name: user.name };
          },
        }),
      ]
    : [];

if (devProvider.length > 0) {
  console.warn(
    "⚠️  Dev auth provider is ENABLED. This must NEVER run in production."
  );
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as NextAuthOptions["adapter"],
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
          access_type: "offline",
          // `prompt` is NOT hardcoded here. Per-call overrides from
          // `useOAuthSignIn` (`promptForMode`) pick the right value:
          // "consent" for first-connect / upgrade-scope / reconnect,
          // "select_account" for `mode: "login"` (returning users). Setting
          // it at the provider level would force consent for every sign-in
          // and re-issue a refresh_token every time — the 1i bug. See
          // proposals/2026-04-21_lean-first-run-onboarding-and-returnto.
          // The refresh-token preservation guard below (`account.refresh_token
          // ?? undefined` in the account update) makes this removal safe.
        },
      },
    }),
    ...devProvider,
  ],
  callbacks: {
    async session({ session, user, token }) {
      if (session.user) {
        // Database sessions pass `user`, JWT sessions pass `token`
        const userId = user?.id ?? token?.sub;
        if (userId) {
          session.user.id = userId;
          const dbUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { meetSlug: true, preferences: true, lastCalibratedAt: true },
          });
          session.user.meetSlug = dbUser?.meetSlug ?? null;
          session.user.preferences = (dbUser?.preferences as Record<string, unknown>) ?? null;
          session.user.onboardingComplete = !!dbUser?.lastCalibratedAt;
        }
      }
      return session;
    },
    async signIn({ account }) {
      // Timezone is seeded once in the `createUser` event below from the
      // user's Google Calendar setting, and from then on is owned by the
      // user's explicit preferences. We deliberately do NOT backfill from
      // Google on subsequent sign-ins — that used to silently overwrite
      // the value the user chose in onboarding or the account page.

      // NextAuth's PrismaAdapter only writes tokens on first linkAccount.
      // On subsequent sign-ins with the same provider, the new tokens from
      // Google are silently discarded — leaving stale access_tokens,
      // expired refresh_tokens, and outdated scopes in the DB. This block
      // fixes that by updating the Account record with fresh credentials
      // every time the user signs in via Google.
      // Entry point — determines which scope set we *expected* the user to
      // grant. Set client-side just before signIn() by useOAuthSignIn. Default
      // is front-door (read+write); deal-room is read-only.
      let entryPoint: HostEntryPoint = "front-door";
      try {
        const ep = cookies().get(ENTRY_POINT_COOKIE)?.value;
        if (ep === "deal-room") entryPoint = "deal-room";
      } catch {
        // cookies() throws if called outside a request scope — fall back to
        // front-door, which is the safer default (audits against the full set).
      }

      if (account?.provider === "google" && account.providerAccountId) {
        // Scope audit (T3a): log partial-permission grants so we have a
        // single signal for telemetry and the dashboard interstitial can
        // surface a reconnect prompt. We never reject the sign-in — half
        // permissions are still useful; the host just won't be able to
        // write events until they upgrade. (Q5 / T3c — degrade not block.)
        const audit = auditScopes(account.scope, hostRequiredFor(entryPoint));
        if (!audit.satisfied) {
          console.warn(
            `[signIn] host scope audit (entry=${entryPoint}): missing ${audit.missingRequired.join(",")} for ${account.providerAccountId}`,
          );
        }

        try {
          await prisma.account.updateMany({
            where: {
              provider: "google",
              providerAccountId: account.providerAccountId,
            },
            data: {
              access_token: account.access_token ?? undefined,
              refresh_token: account.refresh_token ?? undefined,
              expires_at: account.expires_at ?? undefined,
              scope: account.scope ?? undefined,
              id_token: account.id_token ?? undefined,
              token_type: account.token_type ?? undefined,
            },
          });
        } catch (e) {
          console.error("[signIn] Failed to update Google account tokens:", e);
          // Don't block sign-in — stale tokens are better than no sign-in
        }

        // Stamp the recognition cookie. Doing this on every sign-in (not just
        // first signup) covers (a) new users post-PR #138 whose
        // completeOnboarding path is bypassed by seed-everything, and
        // (b) returning users on a fresh browser whose previous-browser cookie
        // doesn't help them. The cookie is a UX hint only — it has zero
        // authority over identity, which is established server-side by the
        // OAuth round-trip itself. Both client and server scrub on account
        // delete (delete/route.ts:165 + dashboard delete UI document.cookie
        // reset). See SPEC §3.3.5 and proposals/2026-04-28_signin-recognition.
        try {
          cookies().set("ae_returning", "1", {
            path: "/",
            maxAge: 60 * 60 * 24 * 365,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            httpOnly: false,
          });
        } catch {
          // cookies().set throws outside request scope. The signIn callback
          // runs inside one for OAuth flows; defensive against a future
          // NextAuth refactor that calls it from a non-request context.
        }
      }

      // T3b: when a *front-door* host granted partial permissions (write scope
      // missing), route them to the dashboard with `?scopeMissing=calendar.events`
      // so the interstitial surfaces a reconnect action immediately. Returning
      // a URL string from `signIn` overrides callbackUrl per NextAuth v4.
      //
      // Deal-room entry skips this — we never asked for write, so its absence
      // isn't a partial grant; it's the intended state. The user upgrades
      // later via the upgrade-scope modal when they confirm their first meeting.
      if (
        entryPoint === "front-door" &&
        account?.provider === "google" &&
        account.scope &&
        !account.scope.includes(HOST_WRITE_SCOPE)
      ) {
        return "/dashboard?scopeMissing=calendar.events";
      }

      return true;
    },
    // JWT callback needed for credentials provider
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
  },
  session: {
    // Use JWT when dev credentials provider is active (credentials doesn't support database sessions)
    strategy: devProvider.length > 0 ? "jwt" : "database",
    maxAge: 7 * 24 * 60 * 60, // 7 days
    updateAge: 24 * 60 * 60,  // refresh session token every 24 hours
  },
  pages: {
    signIn: "/",
    error: "/",
  },
  events: {
    // Guest-flow → host upgrade detection. When a user who originally signed
    // up via the read-only guest-calendar flow signs in via host signin
    // (full calendar.events scope), clear lastCalibratedAt so onboarding
    // fires, and leave a permanent breadcrumb of the upgrade.
    async signIn({ user, account, isNewUser }) {
      if (account?.provider !== "google" || isNewUser) return;
      const scopes = (account.scope ?? "").split(" ");
      if (!scopes.includes("https://www.googleapis.com/auth/calendar.events")) return;

      // Register watch channels for returning Google users (fire-and-forget).
      // registerEventsWatch / registerCalendarListWatch are idempotent — they
      // early-return if an active channel already exists, so calling this on
      // every sign-in is safe and handles the case where a channel expired
      // between the daily renewal cron and the user's next sign-in.
      void (async () => {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { preferences: true },
          });
          const prefs = (dbUser?.preferences as Record<string, unknown> | null) ?? {};
          const explicit = (prefs.explicit as Record<string, unknown> | undefined) ?? {};
          const activeCalendarIds = (explicit.activeCalendarIds as string[] | undefined) ?? [];

          await registerCalendarListWatch(user.id).catch((e) =>
            console.error("[events.signIn] registerCalendarListWatch failed:", e),
          );
          for (const calId of activeCalendarIds) {
            await registerEventsWatch(user.id, calId).catch((e) =>
              console.error("[events.signIn] registerEventsWatch failed:", { calId, e }),
            );
          }
        } catch (e) {
          console.error("[events.signIn] watch registration failed:", e);
        }
      })();

      try {
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { preferences: true },
        });
        const prefs = (dbUser?.preferences as Record<string, unknown> | null) ?? {};
        const explicit = (prefs.explicit as Record<string, unknown> | undefined) ?? {};
        const source = explicit.signupSource;
        if (source !== "guest_flow" && source !== "guest_flow_upgrading") return;
        const nextExplicit: Record<string, unknown> = { ...explicit };
        delete nextExplicit.signupSource;
        nextExplicit.signupSourceUpgradedFrom = "guest_flow";
        nextExplicit.signupSourceUpgradedAt = new Date().toISOString();
        await prisma.user.update({
          where: { id: user.id },
          data: {
            lastCalibratedAt: null,
            preferences: { ...prefs, explicit: nextExplicit } as Prisma.InputJsonValue,
          },
        });
      } catch (e) {
        console.error("[events.signIn] guest_flow upgrade hook failed:", e);
      }
    },
    async createUser({ user }) {
      // Generate a default meetSlug from the user's name or email
      const base = user.name
        ? user.name.toLowerCase().replace(/[^a-z0-9]/g, "")
        : user.email?.split("@")[0] ?? "user";
      let slug = base;
      let counter = 1;
      while (await prisma.user.findUnique({ where: { meetSlug: slug } })) {
        slug = `${base}${counter}`;
        counter++;
      }
      // Pull whatever Google will give us — timezone, locale, weekStart,
      // 12/24h preference, default meeting length, Meet auto-add. One
      // round-trip via `settings.list()`. Defensive: returns {} on any
      // failure, never blocks signup. See `google-onboarding-seed.ts`.
      const googleSeed = await fetchGoogleOnboardingSeed(user.id);

      // Seed-and-show defaults. Hardcoded floor (9am–5pm, Google Meet,
      // 30min, no buffer) gets overlaid by anything Google gave us.
      const preferences: Record<string, unknown> = {
        explicit: buildSeededExplicit({ googleSeed }),
      };

      // 2026-04-26: with seed-everything (PR #138), calibration is done
      // at signup — there's no scalar left to ask. We mark the user
      // calibrated immediately so the legacy onboarding-machine
      // (intro→complete with demo-draft auto-fire) is skipped, and the
      // first-run greeting is owned by `<FirstRunWelcome>` in feed.tsx.
      // The onboarding-machine code stays in place as a legacy fallback
      // for any in-flight users whose `lastCalibratedAt` is still null
      // when this lands; their next /api/onboarding/chat GET sees the
      // calibrated bounce path and redirects to /dashboard.
      const calibratedAt = new Date();
      logCalibrationWrite({
        userId: user.id,
        value: calibratedAt,
        source: "createUser-seed-everything",
      });

      await prisma.user.update({
        where: { id: user.id },
        data: {
          meetSlug: slug,
          preferences: preferences as Prisma.InputJsonValue,
          lastCalibratedAt: calibratedAt,
          persistentKnowledge: [
            "- This host's scheduling posture was seeded from their Google Calendar at signup (timezone, locale, week-start, default meeting length, video-call autoadd preference). Hardcoded floor: 9am–5pm, 30-min Google Meet, no buffer, primary-calendar-only read.",
            "- Default posture: balanced — offer open slots, flag flexible blocks, ask before moving anything.",
            "- Default to 30-minute meetings unless context suggests otherwise.",
            "- Prefer consolidating meetings on fewer days over spreading them out.",
          ].join("\n"),
        },
      });

      // Welcome email — gated + dispatched + stamped inside the helper.
      // An email failure never blocks user creation (same pattern as confirm).
      try {
        await dispatchWelcomeEmailOnce(user.id);
      } catch (e) {
        console.error("[createUser] welcome email dispatch failed:", e);
      }

      // Register Google Calendar push-notification channels for new users.
      // Fire-and-forget: failures are logged but never block account creation.
      // registerEventsWatch is called once per active calendar; the seeded
      // activeCalendarIds from buildSeededExplicit drive which calendars we
      // watch. Idempotent if called again on a later sign-in.
      void (async () => {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { preferences: true },
          });
          const prefs = (dbUser?.preferences as Record<string, unknown> | null) ?? {};
          const explicit = (prefs.explicit as Record<string, unknown> | undefined) ?? {};
          const activeCalendarIds = (explicit.activeCalendarIds as string[] | undefined) ?? [];

          await registerCalendarListWatch(user.id).catch((e) =>
            console.error("[createUser] registerCalendarListWatch failed:", e),
          );
          for (const calId of activeCalendarIds) {
            await registerEventsWatch(user.id, calId).catch((e) =>
              console.error("[createUser] registerEventsWatch failed:", { calId, e }),
            );
          }
        } catch (e) {
          console.error("[createUser] watch registration failed:", e);
        }
      })();

      // Insurance write of the recognition cookie alongside the primary
      // write in the signIn callback above. Reviewer N1 (proposal 2026-04-28
      // §9): cookies().set() from inside NextAuth's signIn callback is
      // unverified for write-propagation in NextAuth v4 + Next.js 14 App
      // Router. If the primary silently no-ops, this insurance covers new
      // users via a different code path. Once §7.0 pre-flight confirms the
      // primary works, this becomes redundant but harmless.
      try {
        cookies().set("ae_returning", "1", {
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          httpOnly: false,
        });
      } catch {
        // cookies().set throws outside request scope; harmless if it does.
      }
    },
  },
};
