"use client";

import { useSession, signOut } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { TIMEZONE_TABLE, shortTimezoneLabel, getTimezoneEntry } from "@/lib/timezone";
import { useOAuthSignIn } from "@/components/oauth/use-oauth-signin";

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

export default function AccountPage() {
  const { data: session, status } = useSession();

  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState("");
  const [videoProvider, setVideoProvider] = useState<"google-meet" | "zoom">("google-meet");
  const [savedVideoProvider, setSavedVideoProvider] = useState<"google-meet" | "zoom">("google-meet");
  const [zoomLink, setZoomLink] = useState("");
  const [savedZoomLink, setSavedZoomLink] = useState("");
  const [defaultDuration, setDefaultDuration] = useState(30);
  const [savedDefaultDuration, setSavedDefaultDuration] = useState(30);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  // Timezone + location (edits go to /api/tuner/preferences).
  // Start as null so we render a loading state instead of flickering
  // from the hardcoded LA default to the user's real value.
  const [timezone, setTimezone] = useState<string | null>(null);
  const [savedTimezone, setSavedTimezone] = useState<string | null>(null);
  const [defaultLocation, setDefaultLocation] = useState("");
  const [savedDefaultLocation, setSavedDefaultLocation] = useState("");

  // Admin gate for the DevTools section. Fetched from /api/me/ui-prefs;
  // null while loading so we don't flash DevTools for non-admins.
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  // Privacy — F4 debugConsent toggle (beta-cohort access gate).
  const [debugConsent, setDebugConsent] = useState<boolean | null>(null);
  const [debugConsentAt, setDebugConsentAt] = useState<string | null>(null);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [privacyError, setPrivacyError] = useState("");

  // Calendar modals
  const [calendarModal, setCalendarModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [calendarFilterModal, setCalendarFilterModal] = useState(false);
  const [googleCalendars, setGoogleCalendars] = useState<Array<{ id: string; name: string; primary: boolean; backgroundColor: string | null }>>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([]);
  const [modalSelectedIds, setModalSelectedIds] = useState<string[]>([]);
  const [savingCalendarFilter, setSavingCalendarFilter] = useState(false);

  const calendarConnected = connStatus?.google?.calendar ?? false;
  const calendarReconnect = useOAuthSignIn({
    mode: "reconnect",
    callbackUrl: "/dashboard/account",
  });

  const fetchData = useCallback(() => {
    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setConnStatus(data); })
      .catch(() => {});

    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          if (data.phone) { setPhone(data.phone); setSavedPhone(data.phone); }
          if (data.videoProvider) { setVideoProvider(data.videoProvider); setSavedVideoProvider(data.videoProvider); }
          if (data.zoomLink) { setZoomLink(data.zoomLink); setSavedZoomLink(data.zoomLink); }
          if (data.defaultDuration) { setDefaultDuration(data.defaultDuration); setSavedDefaultDuration(data.defaultDuration); }
          if (data.activeCalendarIds) setActiveCalendarIds(data.activeCalendarIds);
        }
      })
      .catch(() => {});

    fetch("/api/tuner/preferences")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setTimezone(data.timezone); setSavedTimezone(data.timezone);
          const loc = typeof data.defaultLocation === "string" ? data.defaultLocation : "";
          setDefaultLocation(loc); setSavedDefaultLocation(loc);
        }
      })
      .catch(() => {});

    fetch("/api/account/privacy")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.ok) {
          setDebugConsent(Boolean(data.debugConsent));
          setDebugConsentAt(data.debugConsentAt ?? null);
        }
      })
      .catch(() => {});

    fetch("/api/me/ui-prefs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setIsAdmin(Boolean(data.isAdmin));
      })
      .catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetchData();
  }, [status, fetchData]);

  const tzLoaded = timezone !== null && savedTimezone !== null;
  const isDirty = phone !== savedPhone ||
    videoProvider !== savedVideoProvider ||
    zoomLink !== savedZoomLink ||
    defaultDuration !== savedDefaultDuration ||
    (tzLoaded && timezone !== savedTimezone) ||
    defaultLocation !== savedDefaultLocation;

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveMessage("");
    try {
      // Save meeting prefs
      const meetingRes = await fetch("/api/agent/knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(phone !== savedPhone ? { phone } : {}),
          ...(videoProvider !== savedVideoProvider ? { videoProvider } : {}),
          ...(zoomLink !== savedZoomLink ? { zoomLink } : {}),
          ...(defaultDuration !== savedDefaultDuration ? { defaultDuration } : {}),
        }),
      });

      // Save timezone + location if changed (and timezone is loaded)
      const tzChanged = tzLoaded && timezone !== savedTimezone;
      const locChanged = defaultLocation !== savedDefaultLocation;
      if (tzChanged || locChanged) {
        await fetch("/api/tuner/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(tzChanged ? { timezone } : {}),
            ...(locChanged ? { defaultLocation } : {}),
          }),
        });
        if (tzChanged) setSavedTimezone(timezone);
        if (locChanged) setSavedDefaultLocation(defaultLocation);
      }

      if (meetingRes.ok) {
        setSaveMessage("Saved");
        setSavedPhone(phone);
        setSavedVideoProvider(videoProvider);
        setSavedZoomLink(zoomLink);
        setSavedDefaultDuration(defaultDuration);
        setTimeout(() => setSaveMessage(""), 2000);
      } else {
        setSaveMessage("Failed to save");
      }
    } catch {
      setSaveMessage("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePrivacy(next: boolean) {
    if (savingPrivacy) return;
    setSavingPrivacy(true);
    setPrivacyError("");
    try {
      const res = await fetch("/api/account/privacy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debugConsent: next }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        debugConsent?: boolean;
        debugConsentAt?: string | null;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setDebugConsent(Boolean(json.debugConsent));
      setDebugConsentAt(json.debugConsentAt ?? null);
    } catch (err) {
      setPrivacyError(err instanceof Error ? err.message : "Could not update");
    } finally {
      setSavingPrivacy(false);
    }
  }

  async function handleDisconnectCalendar() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/connections/disconnect-calendar", { method: "POST" });
      if (res.ok) {
        setConnStatus((prev) =>
          prev ? { ...prev, google: { ...prev.google, calendar: false, scopes: [] } } : prev
        );
        setCalendarModal(false);
      }
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  }

  if (status === "loading" || !session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/*
        Phase 2 PR 4 — Preferences (full page).
        Section order matches the v2 mobile drawer body field-for-field
        (`src/components/mobile/preferences-drawer.tsx`) so a host sees the
        same shape on both surfaces. Mockup canon: `mockups/desktop-v2.html` §6.
        Vocabulary: lowercase "Location preferences" / "Meeting preferences",
        page title is "Preferences" (not "Account"); the route stays
        /dashboard/account until a Phase 6 rename.
      */}
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Mobile-only back chip. Desktop has the sticky header with Logo +
            avatar that always lets you escape the page; on mobile no such
            chrome is exposed at this route, so direct visitors (deep links,
            help-bubble CTAs that bypass the drawer, shared URLs) need an
            explicit way out. Returns to the dashboard rather than calling
            router.back() — back history isn't guaranteed. */}
        <Link
          href="/dashboard"
          className="md:hidden inline-flex items-center gap-1.5 text-xs text-muted hover:text-primary transition -mt-2"
          data-testid="account-mobile-back"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back to dashboard
        </Link>

        {/* Page heading — explicit "Preferences" title, distinct from the
            identity row beneath it. Mockup §6 implies the identity card carries
            the title role; we promote it for clarity at desktop widths. */}
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Preferences</h1>

        {/* Identity row — avatar, name, email, sign out. Matches mobile drawer
            "Identity" block in `preferences-drawer.tsx`. */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {session.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" className="w-14 h-14 rounded-full" />
            ) : (
              <div className="w-14 h-14 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                <span className="text-lg font-bold text-white">
                  {session.user?.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            <div>
              <h2 className="text-lg font-semibold text-primary leading-tight">
                {session.user?.name}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-sm text-muted">{session.user?.email}</p>
                <span className="text-muted">&middot;</span>
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="text-xs text-muted hover:text-secondary transition underline-offset-2 hover:underline"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Google Calendar */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Google Calendar
          </h2>
          <div className={`rounded-xl border transition ${
            calendarConnected
              ? "bg-emerald-50 dark:bg-emerald-900/10 border-emerald-300/60 dark:border-emerald-700/30"
              : "bg-surface-inset/50 border-secondary"
          }`}>
            <button
              onClick={() => {
                if (calendarConnected) {
                  setCalendarModal(true);
                } else {
                  calendarReconnect.trigger();
                }
              }}
              className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-black/5 dark:hover:bg-white/5 transition rounded-xl"
            >
              <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" className="w-5 h-5">
                  <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                  <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                  <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                  <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                  <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                  <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-primary">
                  {calendarConnected ? "Connected" : "Connect Google Calendar"}
                </div>
                <div className={`text-xs ${calendarConnected ? "text-emerald-700 dark:text-emerald-400" : "text-muted"}`}>
                  {calendarConnected ? session.user?.email : "Read events and create meetings on your behalf"}
                </div>
              </div>
              {calendarConnected && (
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex-shrink-0" />
              )}
            </button>
            {calendarConnected && (
              <button
                onClick={() => {
                  if (googleCalendars.length === 0) {
                    fetch("/api/connections/google-calendars")
                      .then((r) => r.json())
                      .then((d) => {
                        if (d.calendars) {
                          setGoogleCalendars(d.calendars);
                          const ids = d.calendars.map((c: { id: string }) => c.id);
                          setModalSelectedIds(activeCalendarIds.length > 0 ? activeCalendarIds : ids);
                        }
                      })
                      .catch(() => {});
                  } else {
                    setModalSelectedIds(activeCalendarIds.length > 0 ? activeCalendarIds : googleCalendars.map((c) => c.id));
                  }
                  setCalendarFilterModal(true);
                }}
                className="w-full px-4 py-2 text-xs text-muted hover:text-secondary border-t border-emerald-300/60 dark:border-emerald-800/30 text-left transition hover:bg-black/5 dark:hover:bg-white/5"
              >
                Manage calendars
              </button>
            )}
          </div>
        </section>

        {/* Connectors — PAT management for letting an AI (Claude, ChatGPT, etc.)
            act on your behalf via the host-MCP surface. Lives on its own page;
            this is just the entry point. */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Connectors
          </h2>
          <Link
            href="/dashboard/account/connectors"
            className="block bg-surface-inset/50 border border-secondary rounded-xl p-4 hover:border-indigo-500/50 transition group"
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm text-primary font-medium">Connect Claude Code, Cursor, or another AI</p>
                <p className="text-[11px] text-muted mt-1 leading-relaxed">
                  Mint access tokens that let an AI act as you on AgentEnvoy —
                  read your calendar, mint links, reschedule meetings.
                </p>
              </div>
              <span className="text-muted group-hover:text-primary transition text-lg">→</span>
            </div>
          </Link>
        </section>

        {/* Location preferences */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Location preferences
          </h2>
          <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4 space-y-4">
            {/* Default Time Zone */}
            <div>
              <label className="text-[11px] text-muted font-medium block mb-1">Default time zone</label>
              {timezone === null ? (
                <div className="w-full max-w-sm h-[38px] rounded-lg bg-surface-secondary/40 border border-surface-tertiary/50 animate-pulse" />
              ) : (
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full max-w-sm bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
                >
                  {TIMEZONE_TABLE.map((entry) => (
                    <option key={entry.iana} value={entry.iana}>
                      {entry.long} · {shortTimezoneLabel(entry.iana)} ({entry.iana})
                    </option>
                  ))}
                  {!getTimezoneEntry(timezone) && (
                    <option value={timezone}>
                      {timezone} (custom)
                    </option>
                  )}
                </select>
              )}
            </div>

            {/* Default Location */}
            <div>
              <label className="text-[11px] text-muted font-medium block mb-1">Default location</label>
              <input
                type="text"
                value={defaultLocation}
                onChange={(e) => setDefaultLocation(e.target.value)}
                placeholder="e.g. San Francisco, Lisbon"
                className="w-full max-w-sm bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition"
              />
              <p className="text-[10px] text-muted mt-1">Your home base. For temporary travel, add a Location rule on the <a href="/dashboard/availability" className="underline hover:text-secondary">Availability</a> page.</p>
            </div>
          </div>
        </section>

        {/* Meeting preferences */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Meeting preferences
          </h2>
          <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4 space-y-4">
            {/* Default meeting length */}
            <div>
              <label className="text-[11px] text-muted font-medium block mb-1.5">Default meeting length</label>
              <div className="flex gap-2">
                {([15, 30, 45, 60, 90] as const).map((mins) => {
                  const label = mins < 60 ? `${mins}m` : mins === 60 ? "1h" : "1.5h";
                  return (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => setDefaultDuration(mins)}
                      className={`px-3 py-2 rounded-lg border text-sm transition ${
                        defaultDuration === mins
                          ? "border-purple-500 bg-purple-500/10 text-primary"
                          : "border-surface-tertiary/50 bg-surface-secondary/40 text-muted hover:border-secondary"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted mt-1">Used when creating new meeting threads unless overridden.</p>
            </div>

            {/* Phone */}
            <div>
              <label className="text-[11px] text-muted font-medium block mb-1">Phone number</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (555) 123-4567"
                className="w-full max-w-xs bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-purple-500/50 transition"
              />
              <p className="text-[10px] text-muted mt-1">Include country code. Used as default for phone call meetings.</p>
            </div>

            {/* Video provider */}
            <div>
              <label className="text-[11px] text-muted font-medium block mb-1.5">Video conferencing</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setVideoProvider("google-meet")}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition ${
                    videoProvider === "google-meet"
                      ? "border-purple-500 bg-purple-500/10 text-primary"
                      : "border-surface-tertiary/50 bg-surface-secondary/40 text-muted hover:border-secondary"
                  }`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 8l5-3.5v15L15 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><rect x="3" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/></svg>
                  Google Meet
                </button>
                <button
                  type="button"
                  onClick={() => setVideoProvider("zoom")}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition ${
                    videoProvider === "zoom"
                      ? "border-purple-500 bg-purple-500/10 text-primary"
                      : "border-surface-tertiary/50 bg-surface-secondary/40 text-muted hover:border-secondary"
                  }`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="6" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M16 10l4-2.5v9L16 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Zoom
                </button>
              </div>
            </div>

            {/* Zoom link */}
            {videoProvider === "zoom" && (
              <div>
                <label className="text-[11px] text-muted font-medium block mb-1">Zoom meeting link</label>
                <input
                  type="url"
                  value={zoomLink}
                  onChange={(e) => setZoomLink(e.target.value)}
                  placeholder="https://zoom.us/j/1234567890"
                  className="w-full max-w-md bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-purple-500/50 transition"
                />
                <p className="text-[10px] text-muted mt-1">Your personal meeting room link. Added to calendar events instead of Google Meet.</p>
              </div>
            )}
          </div>
        </section>

        {/* Appearance */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Appearance
          </h2>
          <div className="bg-surface-inset/50 border border-secondary rounded-xl px-4 py-3">
            <ThemeToggle />
          </div>
        </section>

        {/* Privacy — F4 debugConsent */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Privacy
          </h2>
          <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <p className="text-sm text-primary font-medium">Friends of AgentEnvoy</p>
                <p className="text-[11px] text-muted mt-1 leading-relaxed">
                  AgentEnvoy is still a small beta. If you&apos;re helping us test, opt in to
                  let our team see your thread and calendar when you report a bug or ask for help.
                  Off by default. Every admin read is logged and you can change this any time.
                </p>
                {debugConsent && debugConsentAt ? (
                  <p className="text-[10px] text-emerald-500 mt-2">
                    Opted in {new Date(debugConsentAt).toLocaleDateString()}.
                  </p>
                ) : null}
                {privacyError ? (
                  <p className="text-[10px] text-red-600 dark:text-red-400 mt-2">{privacyError}</p>
                ) : null}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={debugConsent === true}
                aria-label="Toggle Friends of AgentEnvoy access"
                disabled={savingPrivacy || debugConsent === null}
                onClick={() => handleTogglePrivacy(!debugConsent)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition disabled:opacity-40 ${
                  debugConsent
                    ? "bg-purple-600 border-purple-500"
                    : "bg-surface-secondary/60 border-surface-tertiary/60"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                    debugConsent ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* Dev Tools — admin-only. The underlying /api/debug/onboarding-reset
            endpoint also enforces NODE_ENV !== "production", so hiding this UI
            for non-admins is the primary gate; the server-side NODE_ENV check
            remains defense-in-depth for any non-admin who guesses the URL. */}
        {isAdmin === true && <DevTools />}

        {/* Danger zone — section heading uses the same uppercase tracking-widest
            style as every other Preferences section (and matches the mobile
            drawer body) so the page reads as a single rhythm. */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Danger zone
          </h2>
          <div className="border border-red-500/40 bg-red-500/5 rounded-xl px-4 py-4 flex items-center justify-between gap-4">
            <div className="text-sm">
              <div className="text-primary font-medium">Delete your account</div>
              <div className="text-secondary text-xs mt-1 leading-relaxed">
                Permanently deletes your AgentEnvoy account, links, sessions, messages, calendar cache,
                preferences, and API keys. Meetings already on your Google Calendar will stay there.
                This cannot be undone.
              </div>
            </div>
            <button
              onClick={() => { setDeleteConfirmEmail(""); setDeleteError(""); setDeleteModal(true); }}
              className="shrink-0 px-3 py-2 text-xs rounded-lg border border-red-500/60 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition"
            >
              Delete Account
            </button>
          </div>
        </section>

        {/* Save button */}
        <div className={`flex items-center justify-end gap-2 transition-opacity duration-200 ${isDirty ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
          {saveMessage && (
            <span className={`text-xs ${saveMessage === "Saved" ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
              {saveMessage}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-30 text-white text-sm rounded-lg font-medium transition"
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>

      {/* Google Calendar Modal */}
      {calendarModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCalendarModal(false)}>
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-6 h-6">
                  <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                  <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                  <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                  <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                  <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                  <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-primary">Google Calendar</h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">Connected</span>
                </div>
              </div>
            </div>
            <div className="space-y-2 mb-5">
              <div className="bg-surface-secondary/60 rounded-lg px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Access</div>
                <p className="text-xs text-primary">Read calendar events and create meetings on your behalf</p>
              </div>
              <div className="bg-surface-secondary/60 rounded-lg px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Account</div>
                <p className="text-xs text-primary">{session.user?.email}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setCalendarModal(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition"
              >
                Close
              </button>
              <button
                onClick={handleDisconnectCalendar}
                disabled={disconnecting}
                className="flex-1 px-3 py-2 text-xs font-medium text-red-600 dark:text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition disabled:opacity-50"
              >
                {disconnecting ? "Disconnecting..." : "Disconnect Calendar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calendar Filter Modal */}
      {calendarFilterModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCalendarFilterModal(false)}>
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-primary mb-1">Which calendars affect your availability?</h3>
            <p className="text-xs text-muted mb-4">Only checked calendars will be used when scheduling.</p>
            {googleCalendars.length === 0 ? (
              <div className="text-xs text-muted py-4 text-center">Loading calendars...</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Calendars</span>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setModalSelectedIds(googleCalendars.map((c) => c.id))}
                      className="text-[10px] text-muted hover:text-primary transition"
                    >
                      Select all
                    </button>
                    <button
                      onClick={() => setModalSelectedIds([])}
                      className="text-[10px] text-muted hover:text-primary transition"
                    >
                      Select none
                    </button>
                  </div>
                </div>
                <ul className="space-y-2 mb-5 max-h-64 overflow-y-auto">
                  {googleCalendars.map((cal) => (
                    <li key={cal.id}>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={modalSelectedIds.includes(cal.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setModalSelectedIds((prev) => [...prev, cal.id]);
                            } else {
                              setModalSelectedIds((prev) => prev.filter((id) => id !== cal.id));
                            }
                          }}
                          className="w-4 h-4 rounded accent-purple-500"
                        />
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: cal.backgroundColor || "#6366f1" }}
                        />
                        <span className="text-sm text-primary truncate">
                          {cal.name}
                          {cal.primary && <span className="ml-1.5 text-[10px] text-muted">(primary)</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setCalendarFilterModal(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setSavingCalendarFilter(true);
                  try {
                    const toSave = modalSelectedIds.length === googleCalendars.length ? [] : modalSelectedIds;
                    await fetch("/api/connections/calendar-filter", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ activeCalendarIds: toSave }),
                    });
                    setActiveCalendarIds(toSave);
                    setCalendarFilterModal(false);
                  } catch {
                    // ignore
                  } finally {
                    setSavingCalendarFilter(false);
                  }
                }}
                disabled={savingCalendarFilter || googleCalendars.length === 0}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-lg transition disabled:opacity-40"
              >
                {savingCalendarFilter ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Account Modal */}
      {deleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => { if (!deleting) setDeleteModal(false); }}
        >
          <div
            className="bg-surface-inset border border-red-500/50 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-2">Delete your account?</h3>
            <p className="text-sm text-secondary mb-3">
              This permanently deletes your AgentEnvoy account and everything tied to it:
              profile and preferences, links, events and messages, calendar cache,
              and API keys.
            </p>
            <p className="text-sm text-secondary mb-3">
              Your Google authorization will be revoked, so AgentEnvoy can no longer read or write your calendar.
            </p>
            <p className="text-sm text-secondary mb-4">
              <strong className="text-primary">Meetings already on your Google Calendar will stay there.</strong>{" "}
              If you want guests notified, cancel them before deleting.
            </p>

            <label className="block text-xs text-secondary mb-2">
              Type your email to confirm:{" "}
              <span
                className="text-primary font-mono cursor-pointer hover:opacity-70 transition-opacity"
                title="Click to copy"
                onClick={() => navigator.clipboard.writeText(session?.user?.email ?? "")}
              >{session?.user?.email ?? ""}</span>
            </label>
            <input
              type="email"
              autoFocus
              autoComplete="off"
              value={deleteConfirmEmail}
              onChange={(e) => { setDeleteConfirmEmail(e.target.value); setDeleteError(""); }}
              disabled={deleting}
              placeholder="you@example.com"
              className="w-full px-3 py-2 text-sm bg-surface border border-DEFAULT rounded-lg text-primary placeholder:text-secondary/50 focus:outline-none focus:border-red-500/60 mb-3"
            />

            {deleteError && (
              <div className="text-xs text-red-600 dark:text-red-400 mb-3">{deleteError}</div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setDeleteModal(false)}
                disabled={deleting}
                className="flex-1 px-3 py-2 text-sm font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const sessionEmail = (session?.user?.email ?? "").trim().toLowerCase();
                  if (deleteConfirmEmail.trim().toLowerCase() !== sessionEmail) return;
                  setDeleting(true);
                  setDeleteError("");
                  try {
                    const res = await fetch("/api/account/delete", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ confirmEmail: deleteConfirmEmail.trim() }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.ok) {
                      setDeleteError(data.error || "Deletion failed. Please try again.");
                      setDeleting(false);
                      return;
                    }
                    // Scrub all browser state tied to the deleted account so residue
                    // doesn't follow the next sign-in on this browser. Server cascade
                    // already wiped the DB; this is the client-side half.
                    //
                    // NOTE: if you add a new cookie or localStorage key keyed on
                    // user/session identifiers anywhere in the app, add it here too.
                    // See CLAUDE.md / delete-account scrubber contract.
                    document.cookie = "ae_returning=; Path=/; Max-Age=0; SameSite=Lax";
                    document.cookie = "oauth_entry_point=; Path=/; Max-Age=0; SameSite=Lax";
                    try {
                      localStorage.removeItem("theme");
                      for (const key of Object.keys(localStorage)) {
                        if (
                          key.startsWith("seen-primer:") ||
                          key.startsWith("tz-banner-dismissed:")
                        ) {
                          localStorage.removeItem(key);
                        }
                      }
                    } catch {
                      // localStorage can throw in private-mode Safari and similar.
                      // Non-fatal — server state is already gone.
                    }
                    await signOut({ callbackUrl: "/" });
                  } catch {
                    setDeleteError("Network error. Please try again.");
                    setDeleting(false);
                  }
                }}
                disabled={
                  deleting ||
                  deleteConfirmEmail.trim().toLowerCase() !==
                    (session?.user?.email ?? "").trim().toLowerCase() ||
                  !session?.user?.email
                }
                className="flex-1 px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
      {calendarReconnect.modal}
      <footer className="mt-8 pb-6 text-center text-xs text-muted space-x-4">
        <a href="/privacy" className="hover:text-secondary transition">Privacy</a>
        <span>&middot;</span>
        <a href="/terms" className="hover:text-secondary transition">Terms</a>
        <span>&middot;</span>
        <a href="/faq" className="hover:text-secondary transition">How It Works</a>
      </footer>
    </div>
  );
}

/** Dev-only tools for testing onboarding and other flows */
function DevTools() {
  const [resetting, setResetting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [devMessage, setDevMessage] = useState("");

  async function handleResetAndGo() {
    setResetting(true);
    setDevMessage("");
    try {
      const res = await fetch("/api/debug/onboarding-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "reset" }),
      });
      const data = await res.json();
      if (res.ok) {
        window.location.href = "/dashboard";
      } else {
        // Surface the real server error so we can see what's failing.
        const detail = data.message || data.error || `HTTP ${res.status}`;
        setDevMessage(`Reset failed: ${detail}`);
        console.error("[dev-tools] reset failed:", data);
        setResetting(false);
      }
    } catch (err) {
      setDevMessage(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
      setResetting(false);
    }
  }

  async function handleCreateTestAccount() {
    setCreating(true);
    setDevMessage("");
    try {
      const res = await fetch("/api/debug/onboarding-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "create" }),
      });
      const data = await res.json();
      if (data.email) {
        setDevMessage(`Created: ${data.email} (copied to clipboard)`);
        navigator.clipboard.writeText(data.email);
      } else {
        const detail = data.message || data.error || `HTTP ${res.status}`;
        setDevMessage(`Create failed: ${detail}`);
        console.error("[dev-tools] create failed:", data);
      }
    } catch (err) {
      setDevMessage(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section>
      <h2 className="text-[10px] font-bold uppercase tracking-widest text-amber-400 mb-3">
        🛠 Dev Tools
      </h2>
      <div className="bg-amber-50 border border-amber-200 dark:bg-amber-500/5 dark:border-amber-500/20 rounded-xl p-4 space-y-3">
        <button
          onClick={handleResetAndGo}
          disabled={resetting}
          className="w-full px-4 py-3 text-sm font-medium text-amber-800 bg-amber-100 border border-amber-300 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/30 rounded-lg hover:bg-amber-200 dark:hover:bg-amber-500/20 transition disabled:opacity-40"
        >
          {resetting ? "Resetting..." : "Reset & Test Onboarding →"}
        </button>
        <button
          onClick={handleCreateTestAccount}
          disabled={creating}
          className="w-full px-3 py-2 text-xs font-medium text-amber-700 border border-amber-300 dark:text-amber-400/70 dark:border-amber-500/20 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-500/10 transition disabled:opacity-40"
        >
          {creating ? "Creating..." : "Create Throwaway Test Account"}
        </button>
        {devMessage && (
          <p className="text-xs text-amber-700 dark:text-amber-300">{devMessage}</p>
        )}
        <p className="text-[10px] text-muted">
          Reset clears your onboarding state. Reload the dashboard to restart onboarding.
        </p>
      </div>
    </section>
  );
}
