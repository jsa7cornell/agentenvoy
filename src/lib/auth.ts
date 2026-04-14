import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { Prisma } from "@prisma/client";
import { google } from "googleapis";
import { prisma } from "./prisma";

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
            "openid email profile https://www.googleapis.com/auth/calendar.events",
          access_type: "offline",
          prompt: "consent",
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
    async signIn() {
      // Timezone is seeded once in the `createUser` event below from the
      // user's Google Calendar setting, and from then on is owned by the
      // user's explicit preferences. We deliberately do NOT backfill from
      // Google on subsequent sign-ins — that used to silently overwrite
      // the value the user chose in onboarding or the account page.
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
      // Fetch timezone from Google Calendar settings
      let timezone: string | undefined;
      try {
        const account = await prisma.account.findFirst({
          where: { userId: user.id, provider: "google" },
        });
        if (account?.access_token) {
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
          );
          oauth2Client.setCredentials({
            access_token: account.access_token,
            refresh_token: account.refresh_token,
          });
          const calendar = google.calendar({ version: "v3", auth: oauth2Client });
          const res = await calendar.settings.get({ setting: "timezone" });
          if (res.data.value) {
            timezone = res.data.value;
          }
        }
      } catch (e) {
        console.error("Failed to fetch timezone from Google Calendar:", e);
      }

      const preferences: Record<string, unknown> = {};
      if (timezone) {
        preferences.explicit = { timezone };
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          meetSlug: slug,
          preferences: preferences as Prisma.InputJsonValue,
          persistentKnowledge: [
            "- This host has not been calibrated yet. Run the onboarding calibration exercise to learn their scheduling preferences.",
            "- Default posture: balanced — offer open slots, flag flexible blocks, ask before moving anything.",
            "- Default to 30-minute meetings unless context suggests otherwise.",
            "- Prefer consolidating meetings on fewer days over spreading them out.",
          ].join("\n"),
        },
      });
    },
  },
};
