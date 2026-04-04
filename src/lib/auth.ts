import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
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
            select: { meetSlug: true, preferences: true },
          });
          session.user.meetSlug = dbUser?.meetSlug ?? null;
          session.user.preferences = (dbUser?.preferences as Record<string, unknown>) ?? null;
        }
      }
      return session;
    },
    async signIn() {
      // Account tokens are saved automatically by PrismaAdapter
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
      await prisma.user.update({
        where: { id: user.id },
        data: {
          meetSlug: slug,
          persistentKnowledge: [
            "- Be warm but efficient. Don't over-apologize.",
            "- When in doubt, propose fewer options, not more.",
            "- Never suggest meetings before 7am or after 9pm unless I explicitly allow it.",
            "- Avoid weekends unless I or the guest specifically requests it.",
            "- Default to 30-minute meetings unless context suggests otherwise.",
            "- Prefer consolidating meetings on fewer days over spreading them out.",
          ].join("\n"),
        },
      });
    },
  },
};
