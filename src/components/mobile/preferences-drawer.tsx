"use client";

/**
 * Mobile Preferences drawer — slide-down from the topbar avatar.
 *
 * Body matches the current `/dashboard/account` page order field-for-field:
 *
 *   Identity → Google Calendar → Other Agents → Location preferences
 *   → Meeting preferences → Appearance → Privacy → Delete account
 *
 * Per `refactor-package-2026-04-25/PROJECT-PLAN.md` Phase 1 PR 6 and
 * `mockups/mobile-v2.html` §5, the mobile drawer hosts the same fields,
 * vocabulary, and validation as the desktop Account page — only the chrome
 * differs. State hooks and fetch endpoints are intentional copies of
 * `src/app/dashboard/account/page.tsx` so the desktop page stays untouched
 * (Phase 2 will consume an extracted shared component once both surfaces
 * have stabilized).
 *
 * The open/close primitive (CSS-driven slide) is unchanged from PR #146 —
 * see the `mounted` gate that defers the panel until the first open and the
 * `top-2`/`bottom-2`/`translate-y-0` chrome that produces the slide-down.
 *
 * Manage-calendars and Delete-account use the same modal copy as desktop;
 * they render *inside* the drawer so the body lock stays consistent.
 */

import { useEffect, useState, useCallback } from "react";
import { signOut } from "next-auth/react";
import type { Session } from "next-auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { TIMEZONE_TABLE, shortTimezoneLabel, getTimezoneEntry } from "@/lib/timezone";
import { useOAuthSignIn } from "@/components/oauth/use-oauth-signin";

interface PreferencesDrawerProps {
  open: boolean;
  onClose: () => void;
  session: Session;
}

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

export function PreferencesDrawer({ open, onClose, session }: PreferencesDrawerProps) {
  // Defer rendering the panel until first open so an unopened drawer doesn't
  // ship empty markup into the DOM. Once mounted, it stays — animation is
  // CSS-driven on `open`. (Same primitive as PR #146.)
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // ─── Connection + meeting prefs (mirrors account/page.tsx) ──────────────
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

  // ─── Timezone + location (/api/tuner/preferences) ───────────────────────
  // Start as null so the dropdown shows a loading state instead of flickering
  // from the hardcoded LA default to the user's real value.
  const [timezone, setTimezone] = useState<string | null>(null);
  const [savedTimezone, setSavedTimezone] = useState<string | null>(null);
  const [defaultLocation, setDefaultLocation] = useState("");
  const [savedDefaultLocation, setSavedDefaultLocation] = useState("");

  // ─── Privacy (debugConsent) ─────────────────────────────────────────────
  const [debugConsent, setDebugConsent] = useState<boolean | null>(null);
  const [debugConsentAt, setDebugConsentAt] = useState<string | null>(null);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const [privacyError, setPrivacyError] = useState("");

  // ─── Calendar modals + filter state ─────────────────────────────────────
  const [calendarModal, setCalendarModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [calendarFilterModal, setCalendarFilterModal] = useState(false);
  const [googleCalendars, setGoogleCalendars] = useState<
    Array<{ id: string; name: string; primary: boolean; backgroundColor: string | null }>
  >([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([]);
  const [modalSelectedIds, setModalSelectedIds] = useState<string[]>([]);
  const [savingCalendarFilter, setSavingCalendarFilter] = useState(false);

  const calendarConnected = connStatus?.google?.calendar ?? false;
  const calendarReconnect = useOAuthSignIn({
    mode: "reconnect",
    callbackUrl: "/dashboard",
  });

  const fetchData = useCallback(() => {
    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setConnStatus(data);
      })
      .catch(() => {});

    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          if (data.phone) {
            setPhone(data.phone);
            setSavedPhone(data.phone);
          }
          if (data.videoProvider) {
            setVideoProvider(data.videoProvider);
            setSavedVideoProvider(data.videoProvider);
          }
          if (data.zoomLink) {
            setZoomLink(data.zoomLink);
            setSavedZoomLink(data.zoomLink);
          }
          if (data.defaultDuration) {
            setDefaultDuration(data.defaultDuration);
            setSavedDefaultDuration(data.defaultDuration);
          }
          if (data.activeCalendarIds) setActiveCalendarIds(data.activeCalendarIds);
        }
      })
      .catch(() => {});

    fetch("/api/tuner/preferences")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setTimezone(data.timezone);
          setSavedTimezone(data.timezone);
          const loc = typeof data.defaultLocation === "string" ? data.defaultLocation : "";
          setDefaultLocation(loc);
          setSavedDefaultLocation(loc);
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
  }, []);

  // Fetch on first open. Re-fetch on each subsequent open is wasteful for
  // values that rarely change; we trust the desktop save-then-navigate flow
  // to keep things consistent across surfaces. If this becomes a problem,
  // bump on every `open` transition.
  useEffect(() => {
    if (mounted) fetchData();
  }, [mounted, fetchData]);

  const tzLoaded = timezone !== null && savedTimezone !== null;
  const isDirty =
    phone !== savedPhone ||
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
          prev ? { ...prev, google: { ...prev.google, calendar: false, scopes: [] } } : prev,
        );
        setCalendarModal(false);
      }
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  }

  if (!mounted) return null;

  const initial =
    session.user?.name?.charAt(0)?.toUpperCase() ||
    session.user?.email?.charAt(0)?.toUpperCase() ||
    "?";

  return (
    <div
      className={`fixed inset-0 z-[60] md:hidden transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
      data-testid="mobile-preferences-drawer"
    >
      {/* Overlay — tap to close */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
        aria-label="Close Preferences"
        tabIndex={open ? 0 : -1}
      />

      {/* Drawer panel — slides down from the top. `top-2` matches the mobile
          mockup's 8px margin so the user still sees a sliver of the topbar. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-prefs-title"
        className={`absolute top-2 left-2 right-2 bottom-2 bg-surface border border-secondary rounded-[18px] overflow-y-auto shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "-translate-y-4"
        }`}
      >
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-secondary flex items-center justify-between">
          <h3 id="mobile-prefs-title" className="text-lg font-semibold text-primary tracking-tight">
            Preferences
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-surface-secondary/80 flex items-center justify-center text-secondary hover:text-primary"
            aria-label="Close"
            data-testid="mobile-prefs-close"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Identity row — avatar + name + email + Sign out */}
        <div className="px-4 py-4 border-b border-secondary/60 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center flex-shrink-0">
            {session.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" className="w-12 h-12 rounded-full" />
            ) : (
              <span className="text-sm font-semibold text-white">{initial}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-primary truncate">
              {session.user?.name || "Signed in"}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[11px] text-muted truncate">{session.user?.email}</span>
              <span aria-hidden className="text-muted text-[11px]">·</span>
              <button
                type="button"
                onClick={() => signOut({ callbackUrl: "/" })}
                className="text-[11px] text-muted hover:text-secondary transition flex-shrink-0"
                data-testid="mobile-prefs-signout"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>

        {/* Sections — in the order the brief specifies. Each section uses the
            same vocabulary, fetch paths, and validation as the desktop page. */}
        <div className="px-4 py-4 space-y-6">
          {/* Google Calendar */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
              Google Calendar
            </h4>
            <div
              className={`rounded-xl border transition ${
                calendarConnected
                  ? "bg-emerald-900/10 border-emerald-700/30"
                  : "bg-surface-inset/50 border-secondary"
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  if (calendarConnected) {
                    setCalendarModal(true);
                  } else {
                    calendarReconnect.trigger();
                  }
                }}
                className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-black/5 dark:hover:bg-white/5 transition rounded-xl"
                data-testid="mobile-prefs-gcal-card"
              >
                <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" className="w-5 h-5">
                    <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                    <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                    <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                    <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                    <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                    <path
                      d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z"
                      fill="#1967D2"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-primary">
                    {calendarConnected ? "Connected" : "Connect Google Calendar"}
                  </div>
                  <div className={`text-xs ${calendarConnected ? "text-emerald-400" : "text-muted"}`}>
                    {calendarConnected ? session.user?.email : "Read events and create meetings on your behalf"}
                  </div>
                </div>
                {calendarConnected && (
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex-shrink-0" />
                )}
              </button>
              {calendarConnected && (
                <button
                  type="button"
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
                      setModalSelectedIds(
                        activeCalendarIds.length > 0 ? activeCalendarIds : googleCalendars.map((c) => c.id),
                      );
                    }
                    setCalendarFilterModal(true);
                  }}
                  className="w-full px-4 py-2 text-xs text-muted hover:text-secondary border-t border-emerald-800/30 text-left transition hover:bg-black/5 dark:hover:bg-white/5"
                  data-testid="mobile-prefs-manage-calendars"
                >
                  Manage calendars
                </button>
              )}
            </div>
          </section>

          {/* Other Agents */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
              Other Agents
            </h4>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-surface-inset/50 border border-secondary opacity-50 flex-shrink-0 w-36"
                >
                  <div className="w-7 h-7 rounded-lg bg-surface-tertiary flex items-center justify-center flex-shrink-0">
                    <svg
                      className="w-3.5 h-3.5 text-secondary"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082"
                      />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-secondary">Agent {n}</div>
                    <div className="text-[10px] text-muted">Coming soon</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Location preferences */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
              Location preferences
            </h4>
            <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4 space-y-4">
              <div>
                <label className="text-[11px] text-muted font-medium block mb-1">Default time zone</label>
                {timezone === null ? (
                  <div className="w-full h-[38px] rounded-lg bg-surface-secondary/40 border border-surface-tertiary/50 animate-pulse" />
                ) : (
                  <select
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    className="w-full bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
                    data-testid="mobile-prefs-timezone"
                  >
                    {TIMEZONE_TABLE.map((entry) => (
                      <option key={entry.iana} value={entry.iana}>
                        {entry.long} · {shortTimezoneLabel(entry.iana)} ({entry.iana})
                      </option>
                    ))}
                    {!getTimezoneEntry(timezone) && (
                      <option value={timezone}>{timezone} (custom)</option>
                    )}
                  </select>
                )}
              </div>

              <div>
                <label className="text-[11px] text-muted font-medium block mb-1">Default location</label>
                <input
                  type="text"
                  value={defaultLocation}
                  onChange={(e) => setDefaultLocation(e.target.value)}
                  placeholder="e.g. San Francisco, Lisbon"
                  className="w-full bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition"
                  data-testid="mobile-prefs-location"
                />
                <p className="text-[10px] text-muted mt-1">
                  Your home base. For temporary travel, add a Location rule on the{" "}
                  <a
                    href="/dashboard/availability"
                    className="underline hover:text-secondary"
                    onClick={onClose}
                  >
                    Availability
                  </a>{" "}
                  page.
                </p>
              </div>
            </div>
          </section>

          {/* Meeting preferences */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
              Meeting preferences
            </h4>
            <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4 space-y-4">
              <div>
                <label className="text-[11px] text-muted font-medium block mb-1.5">Default meeting length</label>
                <div className="flex flex-wrap gap-2">
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
                        data-testid={`mobile-prefs-duration-${mins}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted mt-1">
                  Used when creating new meeting threads unless overridden.
                </p>
              </div>

              <div>
                <label className="text-[11px] text-muted font-medium block mb-1">Phone number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 123-4567"
                  className="w-full bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-purple-500/50 transition"
                  data-testid="mobile-prefs-phone"
                />
                <p className="text-[10px] text-muted mt-1">
                  Include country code. Used as default for phone call meetings.
                </p>
              </div>

              <div>
                <label className="text-[11px] text-muted font-medium block mb-1.5">Video conferencing</label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setVideoProvider("google-meet")}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition ${
                      videoProvider === "google-meet"
                        ? "border-purple-500 bg-purple-500/10 text-primary"
                        : "border-surface-tertiary/50 bg-surface-secondary/40 text-muted hover:border-secondary"
                    }`}
                    data-testid="mobile-prefs-video-meet"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M15 8l5-3.5v15L15 16"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <rect x="3" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
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
                    data-testid="mobile-prefs-video-zoom"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <rect x="2" y="6" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      <path
                        d="M16 10l4-2.5v9L16 14"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    Zoom
                  </button>
                </div>
              </div>

              {videoProvider === "zoom" && (
                <div>
                  <label className="text-[11px] text-muted font-medium block mb-1">Zoom meeting link</label>
                  <input
                    type="url"
                    value={zoomLink}
                    onChange={(e) => setZoomLink(e.target.value)}
                    placeholder="https://zoom.us/j/1234567890"
                    className="w-full bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-purple-500/50 transition"
                    data-testid="mobile-prefs-zoom-link"
                  />
                  <p className="text-[10px] text-muted mt-1">
                    Your personal meeting room link. Added to calendar events instead of Google Meet.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Appearance */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
              Appearance
            </h4>
            <div className="bg-surface-inset/50 border border-secondary rounded-xl px-4 py-3">
              <ThemeToggle />
            </div>
          </section>

          {/* Privacy — debugConsent toggle */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">Privacy</h4>
            <div className="bg-surface-inset/50 border border-secondary rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-primary font-medium">Friends of AgentEnvoy</p>
                  <p className="text-[11px] text-muted mt-1 leading-relaxed">
                    AgentEnvoy is still a small beta. If you&apos;re helping us test, opt in to let our team see
                    your thread and calendar when you report a bug or ask for help. Off by default. Every admin
                    read is logged and you can change this any time.
                  </p>
                  {debugConsent && debugConsentAt ? (
                    <p className="text-[10px] text-emerald-500 mt-2">
                      Opted in {new Date(debugConsentAt).toLocaleDateString()}.
                    </p>
                  ) : null}
                  {privacyError ? <p className="text-[10px] text-red-400 mt-2">{privacyError}</p> : null}
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
                  data-testid="mobile-prefs-debug-consent"
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

          {/* Delete account */}
          <section>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
              Danger zone
            </h4>
            <div className="border border-red-500/40 bg-red-500/5 rounded-xl p-4 space-y-3">
              <div>
                <div className="text-sm text-primary font-medium">Delete your account</div>
                <div className="text-secondary text-xs mt-1 leading-relaxed">
                  Permanently deletes your AgentEnvoy account, links, sessions, messages, calendar cache,
                  preferences, and API keys. Meetings already on your Google Calendar will stay there. This
                  cannot be undone.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setDeleteConfirmEmail("");
                  setDeleteError("");
                  setDeleteModal(true);
                }}
                className="w-full px-3 py-2 text-xs rounded-lg border border-red-500/60 text-red-400 hover:bg-red-500/10 transition"
                data-testid="mobile-prefs-delete-button"
              >
                Delete Account
              </button>
            </div>
          </section>
        </div>

        {/* Sticky save bar — fades in when dirty. Same UX as the desktop page,
            adapted to a sticky bottom strip so it's always reachable in a
            scrolling drawer. */}
        <div
          className={`sticky bottom-0 left-0 right-0 px-4 py-3 bg-surface/95 backdrop-blur-sm border-t border-secondary flex items-center justify-end gap-2 transition-opacity duration-200 ${
            isDirty ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          aria-hidden={!isDirty}
        >
          {saveMessage && (
            <span
              className={`text-xs ${
                saveMessage === "Saved" ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {saveMessage}
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:opacity-30 text-white text-sm rounded-lg font-medium transition"
            data-testid="mobile-prefs-save"
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>

      {/* Google Calendar disconnect modal */}
      {calendarModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
          onClick={() => setCalendarModal(false)}
        >
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
                  <path
                    d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z"
                    fill="#1967D2"
                  />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-primary">Google Calendar</h3>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-xs text-emerald-400">Connected</span>
                </div>
              </div>
            </div>
            <div className="space-y-2 mb-5">
              <div className="bg-surface-secondary/60 rounded-lg px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">
                  Access
                </div>
                <p className="text-xs text-primary">
                  Read calendar events and create meetings on your behalf
                </p>
              </div>
              <div className="bg-surface-secondary/60 rounded-lg px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">
                  Account
                </div>
                <p className="text-xs text-primary">{session.user?.email}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setCalendarModal(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleDisconnectCalendar}
                disabled={disconnecting}
                className="flex-1 px-3 py-2 text-xs font-medium text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition disabled:opacity-50"
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calendar filter modal */}
      {calendarFilterModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
          onClick={() => setCalendarFilterModal(false)}
        >
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-primary mb-1">
              Which calendars affect your availability?
            </h3>
            <p className="text-xs text-muted mb-4">Only checked calendars will be used when scheduling.</p>
            {googleCalendars.length === 0 ? (
              <div className="text-xs text-muted py-4 text-center">Loading calendars...</div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                    Calendars
                  </span>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setModalSelectedIds(googleCalendars.map((c) => c.id))}
                      className="text-[10px] text-muted hover:text-primary transition"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
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
                type="button"
                onClick={() => setCalendarFilterModal(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setSavingCalendarFilter(true);
                  try {
                    const toSave =
                      modalSelectedIds.length === googleCalendars.length ? [] : modalSelectedIds;
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

      {/* Delete account modal */}
      {deleteModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
          onClick={() => {
            if (!deleting) setDeleteModal(false);
          }}
        >
          <div
            className="bg-surface-inset border border-red-500/50 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-primary mb-2">Delete your account?</h3>
            <p className="text-sm text-secondary mb-3">
              This permanently deletes your AgentEnvoy account and everything tied to it: profile and
              preferences, links, events and messages, calendar cache, and API keys.
            </p>
            <p className="text-sm text-secondary mb-3">
              Your Google authorization will be revoked, so AgentEnvoy can no longer read or write your
              calendar.
            </p>
            <p className="text-sm text-secondary mb-4">
              <strong className="text-primary">
                Meetings already on your Google Calendar will stay there.
              </strong>{" "}
              If you want guests notified, cancel them before deleting.
            </p>

            <label className="block text-xs text-secondary mb-2">
              Type your email to confirm:{" "}
              <span className="text-primary font-mono">{session?.user?.email ?? ""}</span>
            </label>
            <input
              type="email"
              autoFocus
              autoComplete="off"
              value={deleteConfirmEmail}
              onChange={(e) => {
                setDeleteConfirmEmail(e.target.value);
                setDeleteError("");
              }}
              disabled={deleting}
              placeholder="you@example.com"
              className="w-full px-3 py-2 text-sm bg-surface border border-DEFAULT rounded-lg text-primary placeholder:text-secondary/50 focus:outline-none focus:border-red-500/60 mb-3"
            />

            {deleteError && <div className="text-xs text-red-400 mb-3">{deleteError}</div>}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setDeleteModal(false)}
                disabled={deleting}
                className="flex-1 px-3 py-2 text-sm font-medium text-secondary border border-DEFAULT rounded-lg hover:border-surface-tertiary transition disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
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
                    // doesn't follow the next sign-in. Keep this list in sync with
                    // the desktop page's /dashboard/account scrubber.
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
    </div>
  );
}
