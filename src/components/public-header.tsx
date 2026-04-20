import Link from "next/link";
import { LogoFull } from "./logo";

/**
 * Minimal header for public pages (FAQ, Terms, Privacy).
 * Matches the dashboard header's visual style but without auth/session features.
 */
export function PublicHeader() {
  return (
    <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="text-indigo-400 hover:text-indigo-300 transition">
          <LogoFull height={28} />
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/faq"
            className="text-xs text-secondary hover:text-primary transition"
          >
            How It Works
          </Link>
          <Link
            href="/agents"
            className="text-xs text-secondary hover:text-primary transition"
          >
            For Agents
          </Link>
          <Link
            href="/"
            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md transition font-medium"
          >
            Sign In
          </Link>
        </div>
      </div>
    </header>
  );
}
