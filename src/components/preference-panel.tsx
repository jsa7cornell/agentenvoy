"use client";

import { useState, useEffect, useCallback } from "react";

interface BlockedWindow {
  start: string;
  end: string;
  days?: string[];
  label?: string;
  expires?: string;
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
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

  // New blocked window form
  const [newBw, setNewBw] = useState<BlockedWindow>({
    start: "09:00",
    end: "10:00",
    days: [],
    label: "",
    expires: "",
  });

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

  function addBlockedWindow() {
    if (!data || !newBw.start || !newBw.end) return;
    const bw: BlockedWindow = {
      start: newBw.start,
      end: newBw.end,
    };
    if (newBw.days && newBw.days.length > 0) bw.days = newBw.days;
    if (newBw.label?.trim()) bw.label = newBw.label.trim();
    if (newBw.expires?.trim()) bw.expires = newBw.expires.trim();

    update("blockedWindows", [...data.blockedWindows, bw]);
    setNewBw({ start: "09:00", end: "10:00", days: [], label: "", expires: "" });
  }

  function removeBlockedWindow(index: number) {
    if (!data) return;
    update("blockedWindows", data.blockedWindows.filter((_, i) => i !== index));
  }

  function toggleNewBwDay(day: string) {
    const days = newBw.days || [];
    setNewBw({
      ...newBw,
      days: days.includes(day) ? days.filter((d) => d !== day) : [...days, day],
    });
  }

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading...
      </div>
    );
  }

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

        {/* Blocked windows */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Blocked Windows
          </label>
          {data.blockedWindows.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {data.blockedWindows.map((bw, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 group"
                >
                  <div className="flex-1 text-sm text-primary">
                    <span className="font-medium">{bw.label || "Block"}</span>
                    <span className="text-secondary ml-1.5">
                      {bw.start}&ndash;{bw.end}
                    </span>
                    {bw.days && bw.days.length > 0 && (
                      <span className="text-muted ml-1.5">{bw.days.join(", ")}</span>
                    )}
                    {bw.expires && (
                      <span className="text-muted ml-1.5">exp {bw.expires}</span>
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
          )}

          {/* Add new blocked window */}
          <div className="space-y-2 p-3 bg-surface-secondary/50 border border-DEFAULT rounded-lg">
            <input
              type="text"
              value={newBw.label || ""}
              onChange={(e) => setNewBw({ ...newBw, label: e.target.value })}
              placeholder="Label (e.g. Surfing, Lunch)"
              className="w-full bg-surface border border-DEFAULT rounded-lg px-3 py-1.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition"
            />
            <div className="flex gap-2">
              <input
                type="time"
                value={newBw.start}
                onChange={(e) => setNewBw({ ...newBw, start: e.target.value })}
                className="flex-1 bg-surface border border-DEFAULT rounded-lg px-3 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
              />
              <span className="text-muted text-xs self-center">to</span>
              <input
                type="time"
                value={newBw.end}
                onChange={(e) => setNewBw({ ...newBw, end: e.target.value })}
                className="flex-1 bg-surface border border-DEFAULT rounded-lg px-3 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((day) => (
                <button
                  key={day}
                  onClick={() => toggleNewBwDay(day)}
                  className={`px-2 py-1 text-[10px] font-medium rounded-md border transition ${
                    (newBw.days || []).includes(day)
                      ? "bg-indigo-600 border-indigo-500 text-white"
                      : "bg-surface border-DEFAULT text-muted hover:text-primary hover:border-secondary"
                  }`}
                >
                  {day}
                </button>
              ))}
              <span className="text-[10px] text-muted self-center ml-1">
                {(newBw.days || []).length === 0 ? "All days" : ""}
              </span>
            </div>
            <input
              type="date"
              value={newBw.expires || ""}
              onChange={(e) => setNewBw({ ...newBw, expires: e.target.value })}
              placeholder="Expires (optional)"
              className="w-full bg-surface border border-DEFAULT rounded-lg px-3 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
            />
            <button
              onClick={addBlockedWindow}
              className="w-full px-3 py-1.5 text-xs font-medium bg-surface border border-DEFAULT rounded-lg text-secondary hover:text-primary hover:border-secondary transition"
            >
              + Add Block
            </button>
          </div>
        </section>

        {/* Blackout days */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Blackout Days
          </label>
          <div className="space-y-1.5 mb-2">
            {data.blackoutDays.map((day, i) => (
              <div
                key={i}
                className="flex items-center gap-2 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 group"
              >
                <span className="flex-1 text-sm text-primary">{day}</span>
                <button
                  onClick={() => update("blackoutDays", data.blackoutDays.filter((_, j) => j !== i))}
                  className="text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition text-xs"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="date"
              id="newBlackoutDay"
              className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
            />
            <button
              onClick={() => {
                const input = document.getElementById("newBlackoutDay") as HTMLInputElement;
                if (input?.value && !data.blackoutDays.includes(input.value)) {
                  update("blackoutDays", [...data.blackoutDays, input.value].sort());
                  input.value = "";
                }
              }}
              className="px-3 py-1.5 text-xs font-medium bg-surface-secondary border border-DEFAULT rounded-lg text-secondary hover:text-primary hover:border-secondary transition"
            >
              Add
            </button>
          </div>
        </section>

        {/* Persistent knowledge */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            General Preferences
          </label>
          <textarea
            value={data.persistentKnowledge}
            onChange={(e) => update("persistentKnowledge", e.target.value)}
            rows={4}
            placeholder="Durable patterns about how you work — e.g. 'Prefers mornings for deep work, afternoons for meetings'"
            className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition resize-none"
          />
        </section>

        {/* Situational context */}
        <section>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted block mb-1.5">
            Situational Context
          </label>
          <textarea
            value={data.upcomingSchedulePreferences}
            onChange={(e) => update("upcomingSchedulePreferences", e.target.value)}
            rows={3}
            placeholder="Near-term schedule notes — e.g. 'Traveling next week, only available mornings PT'"
            className="w-full bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition resize-none"
          />
        </section>
      </div>

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
          {isSaving ? "Saving..." : saveStatus === "saved" ? "Saved — Calendar Updated" : "Save & Update Calendar"}
        </button>
        {saveStatus === "error" && (
          <p className="text-xs text-red-400 text-center mt-1">Failed to save. Try again.</p>
        )}
      </div>
    </div>
  );
}
