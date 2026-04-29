"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "next-themes";
import { ThemePreferenceSync } from "@/components/theme-preference-sync";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="light"
        enableSystem={false}
        disableTransitionOnChange
      >
        <ThemePreferenceSync />
        {children}
      </ThemeProvider>
    </SessionProvider>
  );
}
