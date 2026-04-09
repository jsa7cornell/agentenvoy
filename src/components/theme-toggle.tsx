"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const isDark = theme === "dark";

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-secondary">Theme</span>
      <button
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className="relative inline-flex h-6 w-11 items-center rounded-full transition bg-surface-tertiary"
        role="switch"
        aria-checked={isDark}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
            isDark ? "translate-x-6" : "translate-x-1"
          }`}
        />
        <span className="absolute left-1 text-[9px]">{isDark ? "" : "☀️"}</span>
        <span className="absolute right-1 text-[9px]">{isDark ? "🌙" : ""}</span>
      </button>
    </div>
  );
}
