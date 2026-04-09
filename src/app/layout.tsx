import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "AgentEnvoy — Your AI Negotiates So You Don't Have To",
  description:
    "AI agent negotiation platform. Meetings, RFPs, dinner plans — your AI handles the back-and-forth.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Providers>
          <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700/40 px-4 py-1.5 text-center flex-shrink-0">
            <span className="text-xs text-amber-700 dark:text-amber-300">
              Prototype — email and other features still in development
            </span>
          </div>
          {children}
          <footer className="relative z-10 py-4 text-center text-xs text-muted space-x-4">
            <a href="/privacy" className="hover:text-secondary transition">Privacy</a>
            <span>&middot;</span>
            <a href="/terms" className="hover:text-secondary transition">Terms</a>
            <span>&middot;</span>
            <a href="/faq" className="hover:text-secondary transition">How It Works</a>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
