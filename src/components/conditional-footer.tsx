"use client";

import { usePathname } from "next/navigation";

export function ConditionalFooter() {
  const pathname = usePathname();

  // Hide footer on dashboard and onboarding routes
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding")) return null;

  return (
    <footer className="relative z-10 py-4 text-center text-xs text-muted space-x-4 flex-shrink-0">
      <a href="/privacy" className="hover:text-secondary transition">Privacy</a>
      <span>&middot;</span>
      <a href="/terms" className="hover:text-secondary transition">Terms</a>
      <span>&middot;</span>
      <a href="/faq" className="hover:text-secondary transition">How It Works</a>
    </footer>
  );
}
