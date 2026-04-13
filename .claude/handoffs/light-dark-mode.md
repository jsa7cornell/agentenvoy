# Light/Dark Mode Implementation — Agent Handoff

## Goal

Add a light/dark mode toggle to AgentEnvoy. The app is currently hardcoded to a dark theme (`bg-[#0a0a0f]`, zinc-700/800/900 surfaces, zinc-100/200/300 text). Users should be able to switch to a light theme from their profile page. The preference should persist across sessions.

## Current State

- **No theme infrastructure exists.** No ThemeProvider, no `darkMode` config in Tailwind, no CSS custom properties in use.
- **`globals.css`** has unused CSS variables (`--background: #0a0a0f`, `--foreground: #e8e8f0`) — these can be repurposed as the semantic token foundation.
- **`providers.tsx`** (`src/components/providers.tsx`) only wraps `SessionProvider`. This is where the ThemeProvider should be added.
- **`tailwind.config.ts`** has no `darkMode` setting.
- **21 files** contain hardcoded dark-specific color classes. 612+ individual class instances.

## Architecture

### Strategy: CSS custom properties + Tailwind `dark:` variant

1. **Tailwind config**: Set `darkMode: "class"` in `tailwind.config.ts`
2. **CSS variables**: Define semantic color tokens in `globals.css` under `:root` (light) and `.dark` (dark)
3. **ThemeProvider**: Use `next-themes` (standard for Next.js App Router) — it handles the `<html class="dark">` toggle, localStorage persistence, and SSR flash prevention
4. **Migration**: Replace hardcoded color classes with semantic tokens, prioritizing the most impactful files first

### Why `next-themes` + CSS variables (not just `dark:` prefix on every class)

With 612+ color instances across 21 files, doubling every class with a `dark:` variant would be unmaintainable. Instead:
- Define ~15-20 semantic tokens (surface, surface-secondary, text-primary, text-muted, border, accent, etc.)
- Map them to CSS variables that flip between light/dark
- Replace hardcoded Tailwind classes with the semantic equivalents
- Components that need score-based or status-based colors (availability calendar, tuner) keep their explicit classes — those are semantic already (emerald = open, red = protected)

## Semantic Color Tokens

Define these in `globals.css`:

```css
:root {
  /* Surfaces */
  --surface: #ffffff;
  --surface-secondary: #f4f4f5;    /* zinc-100 */
  --surface-tertiary: #e4e4e7;     /* zinc-200 */
  --surface-inset: #fafafa;        /* zinc-50 */
  
  /* Text */
  --text-primary: #18181b;         /* zinc-900 */
  --text-secondary: #52525b;       /* zinc-600 */
  --text-muted: #a1a1aa;           /* zinc-400 */
  --text-inverted: #fafafa;        /* zinc-50 */
  
  /* Borders */
  --border: #e4e4e7;               /* zinc-200 */
  --border-secondary: #d4d4d8;     /* zinc-300 */
  
  /* Accents */
  --accent: #4f46e5;               /* indigo-600 */
  --accent-hover: #4338ca;         /* indigo-700 */
  --accent-surface: #eef2ff;       /* indigo-50 */
  
  /* Status (same in both themes — these are semantic) */
  --success: #059669;
  --warning: #d97706;
  --danger: #dc2626;
}

.dark {
  --surface: #0a0a0f;
  --surface-secondary: #27272a;    /* zinc-800 */
  --surface-tertiary: #3f3f46;     /* zinc-700 */
  --surface-inset: #18181b;        /* zinc-900 */
  
  --text-primary: #f4f4f5;         /* zinc-100 */
  --text-secondary: #a1a1aa;       /* zinc-400 */
  --text-muted: #71717a;           /* zinc-500 */
  --text-inverted: #18181b;        /* zinc-900 */
  
  --border: #3f3f46;               /* zinc-700 */
  --border-secondary: #27272a;     /* zinc-800 */
  
  --accent: #6366f1;               /* indigo-500 */
  --accent-hover: #818cf8;         /* indigo-400 */
  --accent-surface: rgba(99, 102, 241, 0.15);
}
```

Then extend `tailwind.config.ts` to map these:

```typescript
theme: {
  extend: {
    colors: {
      surface: {
        DEFAULT: 'var(--surface)',
        secondary: 'var(--surface-secondary)',
        tertiary: 'var(--surface-tertiary)',
        inset: 'var(--surface-inset)',
      },
      // ... etc for text, border, accent
    }
  }
}
```

## Implementation Steps

### Step 1: Install and wire up next-themes

```bash
npm install next-themes
```

**`src/components/providers.tsx`** — wrap with ThemeProvider:
```tsx
import { ThemeProvider } from "next-themes";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
        {children}
      </ThemeProvider>
    </SessionProvider>
  );
}
```

Default to `"dark"` so nothing changes visually until the user flips the toggle. `enableSystem: false` because we want explicit user choice, not OS preference.

**`src/app/layout.tsx`** — add `suppressHydrationWarning` to `<html>` tag (required by next-themes to avoid hydration mismatch from the injected script):
```tsx
<html lang="en" suppressHydrationWarning>
```

### Step 2: Define CSS variables in globals.css

Replace the existing unused `--background`/`--foreground` with the full semantic token set above.

### Step 3: Extend Tailwind config

Add the semantic color mappings to `tailwind.config.ts` so you can write `bg-surface` instead of `bg-[var(--surface)]`.

### Step 4: Add theme toggle to profile page

**`src/app/dashboard/profile/page.tsx`** — add a toggle in the settings section. Simple segmented control or switch:
```tsx
"use client";
import { useTheme } from "next-themes";

// Inside the component:
const { theme, setTheme } = useTheme();

// Render a toggle:
<div className="flex items-center gap-3">
  <span>Theme</span>
  <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
    {theme === "dark" ? "🌙 Dark" : "☀️ Light"}
  </button>
</div>
```

Style it to match the existing profile page controls. Place it near the top of the settings/preferences area.

### Step 5: Migrate files — Priority Order

Migrate in this order (highest-impact and most-visible first):

| Priority | File | Hardcoded colors | Notes |
|----------|------|-----------------|-------|
| 1 | `src/app/layout.tsx` | 3 | Root `bg-[#0a0a0f]` and body classes |
| 2 | `src/app/globals.css` | ~10 | Base styles, selection colors |
| 3 | `src/components/dashboard-header.tsx` | 35 | Visible on every page |
| 4 | `src/components/dashboard-sidebar.tsx` | 35 | Visible on every page |
| 5 | `src/app/dashboard/page.tsx` | 30 | Main dashboard |
| 6 | `src/app/dashboard/tuner/page.tsx` | 25 | **Tuner — visibility was the trigger for this work** |
| 7 | `src/components/weekly-calendar.tsx` | 45 | Tuner calendar grid |
| 8 | `src/app/dashboard/profile/page.tsx` | 95 | Heaviest file — profile page |
| 9 | `src/components/feed.tsx` | 30 | Dashboard feed |
| 10 | `src/components/chat.tsx` | 20 | Chat bubbles |
| 11 | `src/components/deal-room.tsx` | 71 | Deal room (second heaviest) |
| 12 | `src/app/page.tsx` | 15 | Landing/login page |
| 13 | `src/app/meet/[slug]/[code]/page.tsx` | 40 | Guest-facing booking page |
| 14 | `src/components/availability-calendar.tsx` | 20 | Monthly calendar widget |
| 15 | `src/components/negotiator/*.tsx` | ~30 each | Negotiator components (5 files) |

### Migration pattern for each file

For each file, replace hardcoded dark colors with semantic tokens:

| Dark class | Semantic replacement |
|------------|---------------------|
| `bg-[#0a0a0f]` | `bg-surface` |
| `bg-zinc-900` | `bg-surface-inset` |
| `bg-zinc-800` | `bg-surface-secondary` |
| `bg-zinc-800/50` | `bg-surface-secondary/50` |
| `bg-zinc-700` | `bg-surface-tertiary` |
| `text-zinc-100`, `text-zinc-200` | `text-primary` |
| `text-zinc-300` | `text-primary` or `text-secondary` (contextual) |
| `text-zinc-400` | `text-secondary` |
| `text-zinc-500` | `text-muted` |
| `text-zinc-600` | `text-muted` |
| `text-white` | `text-primary` (unless truly inverted) |
| `border-zinc-700` | `border` |
| `border-zinc-800` | `border-secondary` |
| `bg-indigo-600` | `bg-accent` |
| `hover:bg-indigo-500` | `hover:bg-accent-hover` |

**DO NOT migrate these** — they are semantic/score-based and should stay hardcoded:
- Score colors in `weekly-calendar.tsx`: `bg-emerald-*`, `bg-amber-*`, `bg-orange-*`, `bg-red-*` (these represent data, not theme)
- Score colors in `availability-calendar.tsx`: same reason
- Event accent colors: `border-l-indigo-500`, `border-l-amber-500`, `border-l-zinc-600`
- Status indicators: `text-emerald-400` (online), `text-red-*` (error), `text-amber-*` (warning)

### Step 6: Light mode for score/status colors

The score colors (emerald/amber/orange/red) work on dark backgrounds but need light-mode variants. Add these with `dark:` prefixes only where needed:

```tsx
// In weekly-calendar.tsx, update score background functions:
// Dark: bg-emerald-600/60 → Light: bg-emerald-100 dark:bg-emerald-600/60
// Dark: bg-amber-600/50 → Light: bg-amber-100 dark:bg-amber-600/50
// etc.
```

Similarly for event blocks:
```tsx
// Dark: bg-indigo-900/80 → Light: bg-indigo-50 dark:bg-indigo-900/80
```

These are the ~20 classes that legitimately need `dark:` variants because they represent data colors, not theme surfaces.

### Step 7: Test

1. Default should be dark mode (no visual change from current state)
2. Toggle to light on profile page → all surfaces flip, text readable, borders visible
3. Refresh page → preference persists (localStorage)
4. Check tuner specifically — score colors visible in both modes
5. Check deal room, feed, chat bubbles, landing page
6. No flash of wrong theme on load (next-themes handles this)

## Files You'll Need to Read

Before starting, read these to understand existing patterns:
- `src/app/globals.css` — current CSS variables
- `src/components/providers.tsx` — current provider setup
- `tailwind.config.ts` — current Tailwind config
- `src/app/layout.tsx` — root layout
- `src/app/dashboard/profile/page.tsx` — where toggle goes (heaviest file)
- `src/components/weekly-calendar.tsx` — score color functions to understand what NOT to migrate

## Constraints

- **Do not modify scoring logic** — colors represent data, not theme
- **Do not touch `src/lib/`, `src/agent/`, or API routes** — backend is unaffected
- **Do not change the negotiator components** (`src/components/negotiator/`) — those are owned by another workstream. Leave them hardcoded for now; they can be migrated in a follow-up.
- **Default to dark mode** — existing users should see no change until they explicitly toggle
- **Use `next-themes`** — don't roll a custom solution
- **Keep the toggle simple** — a switch on the profile page, not a dropdown with "system" option
- **Test in both modes** before committing each file migration batch
