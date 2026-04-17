import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/providers";
import { ConditionalFooter } from "@/components/conditional-footer";

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
  title: "AgentEnvoy — Every meeting deserves its own scheduler",
  description:
    "Personal AI scheduling for every meeting. Lock the slots, set the format, add context — and let your AI agent negotiate the rest. Not a generic calendar link.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased h-dvh flex flex-col overflow-hidden`}
      >
        <Providers>
          <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700/40 px-4 py-1.5 text-center flex-shrink-0">
            <span className="text-xs text-amber-700 dark:text-amber-300">
              Prototype — email and other features still in development
            </span>
          </div>
          <div className="flex-1 min-h-0 flex flex-col overflow-auto">
            {children}
            <ConditionalFooter />
          </div>
        </Providers>
      </body>
    </html>
  );
}
