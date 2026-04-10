"use client";

import { useState, useEffect, useCallback } from "react";

interface BlockedWindow {
  start: string;
  end: string;
  days?: string[];
  label?: string;
  expires?: string;
}

interface Buffer {
  beforeMinutes: number;
  afterMinutes: number;
  eventFilter: string; // "in-person", "all", keyword match
}

interface PriorityBucket {
  level: "high" | "low";
  keywords: string[];
}

interface CompiledRules {
  blockedWindows: BlockedWindow[];
  buffers: Buffer[];
  priorityBuckets: PriorityBucket[];
  businessHoursStart?: number;
  businessHoursEnd?: number;
  blackoutDays?: string[];
  ambiguities: string[];
  compiledAt: string;
}

interface PreferenceData {
  timezone: string;
  businessHoursStart: number;
  businessHoursEnd: number;
  blockedWindows: BlockedWindow[];
  currentLocation: { label: string; until?: string } | null;
  blackoutDays: string[];
  persistentKnowledge: string;
  upcomingSchedulePreferences: string;
  compiledRules: CompiledRules | null;
}

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
];

function formatHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

export function PreferencePanel({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<PreferenceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [showControlPanel, setShowControlPanel] = useState(false);

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await fetch("/api/tuner/preferences");
      if (!res.ok) return;
      const d = await res.json();
      setData(d);
    } catch (e) {
      console.error("Failed to fetch preferences:", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrefs();
  }, [fetchPrefs]);

  function update<K extends keyof PreferenceData>(key: K, value: PreferenceData[K]) {
    if (!data) return;
    setData({ ...data, [key]: value });
    setDirty(true);
    setSaveStatus("idle");
  }

  async function handleSave() {
    if (!data || isSaving) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/tuner/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Save failed");
      const result = await res.json();
      // Update compiled rules from server response
      if (result.compiledRules) {
        setData((prev) => prev ? { ...prev, compiledRules: result.compiledRules } : prev);
      }
      setDirty(false);
      setSaveStatus("saved");
      onSaved();
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  }

  // --- Control panel: remove a compiled rule and sync back to free text ---
  function removeBlockedWindow(index: number) {
    if (!data) return;
    const bw = data.blockedWindows[index];
    // Remove from explicit blocked windows
    const newWindows = data.blockedWindows.filter((_, i) => i !== index);
    // Also try to remove the matching line from preferences text
    const label = bw.label || "";
    let newPersistent = data.persistentKnowledge;
    let newSituational = data.upcomingSchedulePreferences;
    if (label) {
      // Remove any line containing the label (case-insensitive)
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const lineRegex = new RegExp(`^.*${escapedLabel}.*$`, "gmi");
      newPersistent = newPersistent.replace(lineRegex, "").replace(/\n{3,}/g, "\n\n").trim();
      newSituational = newSituational.replace(lineRegex, "").replace(/\n{3,}/g, "\n\n").trim();
    }
    setData({
      ...data,
      blockedWindows: newWindows,
      persistentKnowledge: newPersistent,
      upcomingSchedulePreferences: newSituational,
    });
    setDirty(true);
    setSaveStatus("idle");
  }

  function removeBlackoutDay(index: number) {
    if (!data) return;
    const day = data.blackoutDays[index];
    const newDays = data.blackoutDays.filter((_, i) => i !== index);
    // Remove matching line from text
    let newPersistent = data.persistentKnowledge;
    let newSituational = data.upcomingSchedulePreferences;
    const lineRegex = new RegExp(`^.*${day}.*$`, "gmi");
    newPersistent = newPersistent.replace(lineRegex, "").replace(/\n{3,}/g, "\n\n").trim();
    newSituational = newSituational.replace(lineRegex, "").replace(/\n{3,}/g, "\n\n").trim();
    setData({
      ...data,
      blackoutDays: newDays,
      persistentKnowledge: newPersistent,
      upcomingSchedulePreferences: newSituational,
    });
    setDirty(true);
    setSaveStatus("idle");
  }

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading...
      </div>
    );
  }

  const compiled = data.compiledRules;
  const hasCompiledRules = compiled && (
    compiled.blockedWindows.length > 0 ||
    (compiled.buffers?.length ?? 0) > 0 ||
    (compiled.priorityBuckets?.length ?? 0) > 0 ||
    (compiled.blackoutDays?.length ?? 0) > 0 ||
    (compiled.ambiguities?.length ?? 0) > 0
  );

  return (
    <div className="h-full flex flex-col">
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 min-h-0">
        {/* Timezone */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Timezone
          </label>
          <select
            value={data.timezone}
            onChange={(e) => update("timezone", e.target.value)}
            className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
            {!TIMEZONES.includes(data.timezone) && (
              <option value={data.timezone}>{data.timezone.replace(/_/g, " ")}</option>
            )}
          </select>
        </section>

        {/* Business hours */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Business Hours
          </label>
          <div className="flex items-center gap-2">
            <select
              value={data.businessHoursStart}
              onChange={(e) => update("businessHoursStart", Number(e.target.value))}
              className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{formatHour(i)}</option>
              ))}
            </select>
            <span className="text-muted text-xs">to</span>
            <select
              value={data.businessHoursEnd}
              onChange={(e) => update("businessHoursEnd", Number(e.target.value))}
              className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{formatHour(i)}</option>
              ))}
            </select>
          </div>
        </section>

        {/* Current location */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Current Location
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={data.currentLocation?.label ?? ""}
              onChange={(e) => {
                if (!e.target.value.trim()) {
                  update("currentLocation", null);
                } else {
                  update("currentLocation", {
                    label: e.target.value,
                    until: data.currentLocation?.until,
                  });
                }
              }}
              placeholder="e.g. Baja, NYC"
              className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition"
            />
            <input
              type="date"
              value={data.currentLocation?.until ?? ""}
              onChange={(e) => {
                if (data.currentLocation) {
                  update("currentLocation", {
                    ...data.currentLocation,
                    until: e.target.value || undefined,
                  });
                }
              }}
              className="w-36 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
            />
          </div>
          <p className="text-[10px] text-muted mt-1">Leave &ldquo;until&rdquo; blank for indefinite</p>
        </section>

        <hr className="border-secondary" />

        {/* General Preferences — primary free text */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            General Preferences
          </label>
          <p className="text-[10px] text-muted mb-2">
            Durable rules about how you schedule. One per line.
          </p>
          <textarea
            value={data.persistentKnowledge}
            onChange={(e) => update("persistentKnowledge", e.target.value)}
            rows={6}
            placeholder={`Block Friday afternoons 12-6 PM\nBuffer 45 min before/after in-person meetings\nHigh priority: investor meetings, board prep\nLow priority: coffee chats, networking intros\nNo calls before 10 AM`}
            className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition resize-y font-mono leading-relaxed"
          />
        </section>

        {/* Calendar Preferences — situational free text */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Calendar Preferences
          </label>
          <p className="text-[10px] text-muted mb-2">
            Near-term schedule context. Temporary items that expire.
          </p>
          <textarea
            value={data.upcomingSchedulePreferences}
            onChange={(e) => update("upcomingSchedulePreferences", e.target.value)}
            rows={4}
            placeholder={`Traveling to NYC Apr 14-18\nYoga Wed morning 7-9 AM this week\nBlackout Apr 20 — family event`}
            className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition resize-y font-mono leading-relaxed"
          />
        </section>

        {/* Control panel toggle */}
        {(hasCompiledRules || data.blockedWindows.length > 0 || data.blackoutDays.length > 0) && (
          <section>
            <button
              onClick={() => setShowControlPanel(!showControlPanel)}
              className="text-xs text-muted hover:text-secondary transition flex items-center gap-1.5"
            >
              <svg
                className={`w-3 h-3 transition-transform ${showControlPanel ? "rotate-90" : ""}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              View compiled rules
              {compiled?.compiledAt && (
                <span className="text-muted">
                  &middot; last compiled {new Date(compiled.compiledAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
            </button>
          </section>
        )}
      </div>

      {/* Control panel modal */}
      {showControlPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowControlPanel(false)}>
          <div
            className="bg-surface-inset border border-DEFAULT rounded-2xl w-full max-w-2xl mx-4 shadow-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-secondary flex items-center justify-between shrink-0">
              <h3 className="text-sm font-semibold text-primary">Compiled Rules</h3>
              <button
                onClick={() => setShowControlPanel(false)}
                className="text-muted hover:text-primary transition text-xs"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
              {/* Ambiguities */}
              {compiled?.ambiguities && compiled.ambiguities.length > 0 && (
                <div className="p-3 rounded-lg bg-surface-secondary border border-DEFAULT">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                    Needs Clarification ({compiled.ambiguities.length})
                  </div>
                  {compiled.ambiguities.map((a, i) => (
                    <p key={i} className="text-xs text-secondary leading-relaxed">{a}</p>
                  ))}
                  <p className="text-[10px] text-muted mt-2">
                    Update your preferences to clarify these items, then save again.
                  </p>
                </div>
              )}

              {/* Blocked windows */}
              {data.blockedWindows.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                    Blocked Windows ({data.blockedWindows.length})
                  </div>
                  <div className="space-y-1">
                    {data.blockedWindows.map((bw, i) => (
                      <div key={i} className="flex items-center gap-2 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 group">
                        <div className="flex-1 text-sm text-primary">
                          <span className="font-medium">{bw.label || "Block"}</span>
                          <span className="text-secondary ml-1.5">{bw.start}&ndash;{bw.end}</span>
                          {bw.days && bw.days.length > 0 && (
                            <span className="text-muted ml-1.5">{bw.days.join(", ")}</span>
                          )}
                          {bw.expires && (
                            <span className="text-muted ml-1.5">until {bw.expires}</span>
                          )}
                          {!bw.expires && (
                            <span className="text-emerald-500/60 ml-1.5">permanent</span>
                          )}
                        </div>
                        <button
                          onClick={() => removeBlockedWindow(i)}
                          className="text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition text-xs"
                          title="Remove"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Compiled blocked windows (from free text) */}
              {compiled && compiled.blockedWindows.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                    Compiled from Preferences ({compiled.blockedWindows.length})
                  </div>
                  <div className="space-y-1">
                    {compiled.blockedWindows.map((bw, i) => (
                      <div key={i} className="flex items-center gap-2 bg-surface-secondary/50 border border-DEFAULT rounded-lg px-3 py-2">
                        <div className="flex-1 text-sm text-secondary">
                          <span className="font-medium">{bw.label || "Block"}</span>
                          <span className="ml-1.5">{bw.start}&ndash;{bw.end}</span>
                          {bw.days && bw.days.length > 0 && (
                            <span className="text-muted ml-1.5">{bw.days.join(", ")}</span>
                          )}
                          {bw.expires && (
                            <span className="text-muted ml-1.5">until {bw.expires}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Buffers */}
              {compiled?.buffers && compiled.buffers.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                    Buffers
                  </div>
                  <div className="space-y-1">
                    {compiled.buffers.map((b, i) => (
                      <div key={i} className="bg-surface-secondary/50 border border-DEFAULT rounded-lg px-3 py-2 text-sm text-secondary">
                        {b.beforeMinutes} min before / {b.afterMinutes} min after
                        <span className="text-muted ml-1.5">{b.eventFilter} meetings</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Priority buckets */}
              {compiled?.priorityBuckets && compiled.priorityBuckets.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                    Priority Lists
                  </div>
                  <div className="space-y-1">
                    {compiled.priorityBuckets.map((b, i) => (
                      <div key={i} className="bg-surface-secondary/50 border border-DEFAULT rounded-lg px-3 py-2 text-sm text-secondary">
                        <span className={`font-medium ${b.level === "high" ? "text-red-400" : "text-emerald-400"}`}>
                          {b.level === "high" ? "High" : "Low"} priority:
                        </span>
                        <span className="ml-1.5">{b.keywords.join(", ")}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Blackout days */}
              {data.blackoutDays.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
                    Blackout Days ({data.blackoutDays.length})
                  </div>
                  <div className="space-y-1">
                    {data.blackoutDays.map((day, i) => (
                      <div key={i} className="flex items-center gap-2 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 group">
                        <span className="flex-1 text-sm text-primary">{day}</span>
                        <button
                          onClick={() => removeBlackoutDay(i)}
                          className="text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition text-xs"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state */}
              {!hasCompiledRules && data.blockedWindows.length === 0 && data.blackoutDays.length === 0 && (
                <p className="text-sm text-muted text-center py-4">
                  No compiled rules yet. Add preferences above and save to compile.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sticky save bar */}
      <div className="p-3 border-t border-secondary shrink-0">
        <button
          onClick={handleSave}
          disabled={!dirty || isSaving}
          className={`w-full px-4 py-2.5 rounded-xl text-sm font-medium transition ${
            dirty
              ? "bg-indigo-600 hover:bg-indigo-500 text-white"
              : saveStatus === "saved"
                ? "bg-emerald-900/40 text-emerald-300 border border-emerald-500/20"
                : "bg-surface-secondary text-muted border border-DEFAULT cursor-not-allowed"
          } disabled:opacity-60`}
        >
          {isSaving
            ? "Compiling & saving..."
            : saveStatus === "saved"
              ? "Saved — Calendar Updated"
              : "Save & Update Calendar"}
        </button>
        {saveStatus === "error" && (
          <p className="text-xs text-red-400 text-center mt-1">Failed to save. Try again.</p>
        )}
      </div>
    </div>
  );
}
