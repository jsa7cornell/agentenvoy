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
  eventFilter: string;
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

function formatHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

export function AvailabilityRules({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<PreferenceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [showRawEdit, setShowRawEdit] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [editingBusinessHours, setEditingBusinessHours] = useState(false);

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

  async function handleAddRule() {
    if (!data || !newRule.trim()) return;
    // Determine if the rule is temporary (mentions dates) or permanent
    const hasDate = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|next week|this week|tomorrow|today)\b/i.test(newRule);
    if (hasDate) {
      const updated = data.upcomingSchedulePreferences
        ? `${data.upcomingSchedulePreferences}\n${newRule.trim()}`
        : newRule.trim();
      update("upcomingSchedulePreferences", updated);
    } else {
      const updated = data.persistentKnowledge
        ? `${data.persistentKnowledge}\n${newRule.trim()}`
        : newRule.trim();
      update("persistentKnowledge", updated);
    }
    setNewRule("");
  }

  function removeBlockedWindow(index: number) {
    if (!data) return;
    const bw = data.blockedWindows[index];
    const newWindows = data.blockedWindows.filter((_, i) => i !== index);
    const label = bw.label || "";
    let newPersistent = data.persistentKnowledge;
    let newSituational = data.upcomingSchedulePreferences;
    if (label) {
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
      <div className="flex items-center justify-center h-32 text-muted text-sm">
        Loading...
      </div>
    );
  }

  const compiled = data.compiledRules;
  const allBlockedWindows = [
    ...data.blockedWindows.map((bw, i) => ({ ...bw, source: "explicit" as const, index: i })),
    ...(compiled?.blockedWindows || []).map((bw, i) => ({ ...bw, source: "compiled" as const, index: i })),
  ];
  const hasAnyRules = allBlockedWindows.length > 0 ||
    (compiled?.buffers?.length ?? 0) > 0 ||
    (compiled?.priorityBuckets?.length ?? 0) > 0 ||
    data.blackoutDays.length > 0 ||
    (compiled?.blackoutDays?.length ?? 0) > 0;

  return (
    <div className="flex flex-col">
      <div className="p-4 space-y-4">
        {/* Add rule input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAddRule();
              }
            }}
            placeholder="Add a rule... e.g. &quot;Block Friday afternoons&quot;"
            className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition"
          />
          <button
            onClick={handleAddRule}
            disabled={!newRule.trim()}
            className="px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {/* Business Hours card */}
        <section className="bg-surface-secondary/50 border border-DEFAULT rounded-xl p-3">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted">
              Business Hours
            </div>
            <button
              onClick={() => setEditingBusinessHours(!editingBusinessHours)}
              className="text-[10px] text-muted hover:text-secondary transition"
            >
              {editingBusinessHours ? "Done" : "Edit"}
            </button>
          </div>
          {editingBusinessHours ? (
            <div className="flex items-center gap-2 mt-2">
              <select
                value={data.businessHoursStart}
                onChange={(e) => update("businessHoursStart", Number(e.target.value))}
                className="flex-1 bg-surface border border-DEFAULT rounded-lg px-2 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{formatHour(i)}</option>
                ))}
              </select>
              <span className="text-muted text-xs">to</span>
              <select
                value={data.businessHoursEnd}
                onChange={(e) => update("businessHoursEnd", Number(e.target.value))}
                className="flex-1 bg-surface border border-DEFAULT rounded-lg px-2 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{formatHour(i)}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="text-sm text-primary mt-1">
              {formatHour(data.businessHoursStart)} &ndash; {formatHour(data.businessHoursEnd)}
            </div>
          )}
        </section>

        {/* Ambiguities */}
        {compiled?.ambiguities && compiled.ambiguities.length > 0 && (
          <section className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1.5">
              Needs Clarification ({compiled.ambiguities.length})
            </div>
            {compiled.ambiguities.map((a, i) => (
              <p key={i} className="text-xs text-amber-700 dark:text-amber-300/80 leading-relaxed">{a}</p>
            ))}
            <p className="text-[10px] text-amber-600/60 dark:text-amber-400/60 mt-2">
              Update your rules to clarify these items, then save again.
            </p>
          </section>
        )}

        {/* Blocked Windows */}
        {allBlockedWindows.length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
              Blocked Windows ({allBlockedWindows.length})
            </div>
            <div className="space-y-1">
              {allBlockedWindows.map((bw) => (
                <div
                  key={`${bw.source}-${bw.index}`}
                  className={`flex items-center gap-2 border border-DEFAULT rounded-lg px-3 py-2 group ${
                    bw.source === "explicit"
                      ? "bg-surface-secondary"
                      : "bg-surface-secondary/50"
                  }`}
                >
                  <div className="flex-1 text-sm text-primary">
                    <span className="font-medium">{bw.label || "Block"}</span>
                    <span className="text-secondary ml-1.5">{bw.start}&ndash;{bw.end}</span>
                    {bw.days && bw.days.length > 0 && (
                      <span className="text-muted ml-1.5">{bw.days.join(", ")}</span>
                    )}
                    {bw.expires && (
                      <span className="text-muted ml-1.5">until {bw.expires}</span>
                    )}
                    {!bw.expires && bw.source === "explicit" && (
                      <span className="text-emerald-500/60 ml-1.5">permanent</span>
                    )}
                  </div>
                  {bw.source === "explicit" && (
                    <button
                      onClick={() => removeBlockedWindow(bw.index)}
                      className="text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition text-xs"
                      title="Remove"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Buffers */}
        {compiled?.buffers && compiled.buffers.length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
              Buffers
            </div>
            <div className="space-y-1">
              {compiled.buffers.map((b, i) => (
                <div key={i} className="bg-surface-secondary/50 border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary">
                  {b.beforeMinutes} min before / {b.afterMinutes} min after
                  <span className="text-muted ml-1.5">{b.eventFilter} meetings</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Priority Buckets */}
        {compiled?.priorityBuckets && compiled.priorityBuckets.length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-1.5">
              Priority Lists
            </div>
            <div className="space-y-1">
              {compiled.priorityBuckets.map((b, i) => (
                <div key={i} className="bg-surface-secondary/50 border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary">
                  <span className={`font-medium ${b.level === "high" ? "text-red-400" : "text-emerald-400"}`}>
                    {b.level === "high" ? "High" : "Low"} priority:
                  </span>
                  <span className="ml-1.5">{b.keywords.join(", ")}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Blackout Days */}
        {data.blackoutDays.length > 0 && (
          <section>
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
          </section>
        )}

        {/* Empty state */}
        {!hasAnyRules && (
          <div className="text-sm text-muted text-center py-8">
            No availability rules yet. Add a rule above to get started.
          </div>
        )}

        {/* Compiled timestamp */}
        {compiled?.compiledAt && (
          <div className="text-[10px] text-muted text-center">
            Last compiled {new Date(compiled.compiledAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </div>
        )}

        {/* Raw edit toggle */}
        <section className="pt-2 border-t border-secondary">
          <button
            onClick={() => setShowRawEdit(!showRawEdit)}
            className="text-xs text-muted hover:text-secondary transition flex items-center gap-1.5"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showRawEdit ? "rotate-90" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Edit raw preferences
          </button>
          {showRawEdit && (
            <div className="mt-3 space-y-4">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
                  General Preferences
                </label>
                <textarea
                  value={data.persistentKnowledge}
                  onChange={(e) => update("persistentKnowledge", e.target.value)}
                  rows={6}
                  placeholder={`Block Friday afternoons 12-6 PM\nBuffer 45 min before/after in-person meetings\nHigh priority: investor meetings, board prep`}
                  className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition resize-y font-mono leading-relaxed"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
                  Calendar Preferences
                </label>
                <textarea
                  value={data.upcomingSchedulePreferences}
                  onChange={(e) => update("upcomingSchedulePreferences", e.target.value)}
                  rows={4}
                  placeholder={`Traveling to NYC Apr 14-18\nYoga Wed morning 7-9 AM this week\nBlackout Apr 20 — family event`}
                  className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition resize-y font-mono leading-relaxed"
                />
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Save bar */}
      <div className="p-3 border-t border-secondary sticky bottom-0 bg-surface">
        <button
          onClick={handleSave}
          disabled={!dirty || isSaving}
          className={`w-full px-4 py-2.5 rounded-xl text-sm font-medium transition ${
            dirty
              ? "bg-accent hover:bg-accent-hover text-white"
              : saveStatus === "saved"
                ? "bg-emerald-900/40 text-emerald-300 border border-emerald-500/20"
                : "bg-surface-secondary text-muted border border-DEFAULT cursor-not-allowed"
          } disabled:opacity-60`}
        >
          {isSaving
            ? "Compiling & saving..."
            : saveStatus === "saved"
              ? "Saved \u2014 Calendar Updated"
              : "Save & Update Calendar"}
        </button>
        {saveStatus === "error" && (
          <p className="text-xs text-red-400 text-center mt-1">Failed to save. Try again.</p>
        )}
      </div>
    </div>
  );
}
