"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Clock, ChevronDown, ChevronRight,
  Plus, Check, X, Pencil, Trash2, Loader2, ToggleLeft, ToggleRight,
  Ban, Lock, Timer, CheckCircle2, Star, MapPin, Megaphone, Copy,
} from "lucide-react";
import type { AvailabilityRule } from "@/lib/availability-rules";

// --- Types ---

interface ParsedRule {
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "allow" | "buffer" | "prefer" | "limit" | "business_hours" | "location" | "office_hours";
  timeStart?: string;
  timeEnd?: string;
  allDay?: boolean;
  daysOfWeek?: number[];
  effectiveDate?: string;
  expiryDate?: string;
  bufferMinutesBefore?: number;
  bufferMinutesAfter?: number;
  bufferAppliesTo?: string;
  businessHoursStart?: number;
  businessHoursEnd?: number;
  locationLabel?: string;
  officeHoursTitle?: string;
  officeHoursFormat?: "video" | "phone" | "in-person";
  officeHoursDurationMinutes?: number;
  priority: number;
  ambiguous?: boolean;
  interpretations?: string[];
  summary: string;
}

interface PreferenceData {
  timezone: string;
  businessHoursStart: number;
  businessHoursEnd: number;
  structuredRules: AvailabilityRule[];
  defaultLocation?: string;
  // Legacy fields (read-only, kept for backwards compat)
  blockedWindows: unknown[];
  blackoutDays: string[];
  persistentKnowledge: string;
  upcomingSchedulePreferences: string;
  compiledRules: unknown;
}

// --- Helpers ---

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function formatTime24to12(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function daysLabel(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return "Weekdays";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "Weekends";
  return days.map(d => DAY_NAMES_SHORT[d]).join(", ");
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function daysUntil(iso: string): number {
  const target = new Date(iso + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / 86400000);
}

function uuid(): string {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}


const ACTION_LABELS: Record<string, string> = {
  block: "Block",
  allow: "Allow",
  buffer: "Buffer",
  prefer: "Prefer",
  limit: "Limit",
  business_hours: "Business Hours",
  location: "Location",
  office_hours: "Office Hours",
};

const ACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  block: Ban,
  allow: CheckCircle2,
  buffer: Timer,
  prefer: Star,
  limit: Lock,
  location: MapPin,
  office_hours: Megaphone,
};

// --- Component ---

export function AvailabilityRules({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<PreferenceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pendingRule, setPendingRule] = useState<ParsedRule | null>(null);
  const [selectedInterpretation, setSelectedInterpretation] = useState<number>(0);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);

  const [showExpired, setShowExpired] = useState(false);
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Partial<ParsedRule>>({});
  const [bizExpanded, setBizExpanded] = useState(false);
  const [bizEditing, setBizEditing] = useState(false);
  const [bizEditStart, setBizEditStart] = useState<number | null>(null);
  const [bizEditEnd, setBizEditEnd] = useState<number | null>(null);

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

  // --- Save (auto-save on rule changes) ---

  async function saveRules(rules: AvailabilityRule[]) {
    if (!data) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/tuner/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          structuredRules: rules,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      const result = await res.json();
      setData((prev) =>
        prev ? { ...prev, structuredRules: rules, compiledRules: result.compiledRules } : prev
      );
      onSaved();
    } catch (e) {
      console.error("Save failed:", e);
    } finally {
      setIsSaving(false);
    }
  }

  // --- Parse free text ---

  async function handleParseRule() {
    if (!data || !inputText.trim()) return;
    setIsParsing(true);
    try {
      const res = await fetch("/api/tuner/parse-rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: inputText.trim(),
          timezone: data.timezone,
          businessHoursStart: data.businessHoursStart,
          businessHoursEnd: data.businessHoursEnd,
        }),
      });
      if (!res.ok) throw new Error("Parse failed");
      const parsed: ParsedRule = await res.json();

      // Detect nonsensical input — LLM flags it as ambiguous with no real rule
      if (parsed.ambiguous && parsed.interpretations?.some(
        i => /not a scheduling|unrelated|no.*rule.*extracted|noise|test input/i.test(i)
      )) {
        setParseError("That doesn't look like a scheduling rule. Try something like:");
        return;
      }

      setParseError(null);
      setPendingRule(parsed);
      setSelectedInterpretation(0);
    } catch (e) {
      console.error("Parse failed:", e);
      setParseError("Something went wrong. Please try again.");
    } finally {
      setIsParsing(false);
    }
  }

  // --- Confirm rule ---

  function confirmRule() {
    if (!data || !pendingRule) return;

    // Business hours: update the setting directly instead of creating a rule
    if (pendingRule.action === "business_hours" && pendingRule.businessHoursStart != null && pendingRule.businessHoursEnd != null) {
      setPendingRule(null);
      setInputText("");
      saveBusinessHours(pendingRule.businessHoursStart, pendingRule.businessHoursEnd);
      return;
    }

    const rule: AvailabilityRule = {
      id: uuid(),
      originalText: pendingRule.originalText,
      type: pendingRule.type,
      action: pendingRule.action as AvailabilityRule["action"],
      timeStart: pendingRule.timeStart,
      timeEnd: pendingRule.timeEnd,
      allDay: pendingRule.allDay,
      daysOfWeek: pendingRule.daysOfWeek,
      effectiveDate: pendingRule.effectiveDate,
      expiryDate: pendingRule.expiryDate,
      bufferMinutesBefore: pendingRule.bufferMinutesBefore,
      bufferMinutesAfter: pendingRule.bufferMinutesAfter,
      bufferAppliesTo: pendingRule.bufferAppliesTo,
      locationLabel: pendingRule.locationLabel,
      officeHours: pendingRule.action === "office_hours" ? {
        title: pendingRule.officeHoursTitle?.trim() || "Office Hours",
        format: pendingRule.officeHoursFormat || "video",
        durationMinutes: pendingRule.officeHoursDurationMinutes || 30,
        linkSlug: "", // server hydrates from user.meetSlug
        linkCode: "", // server hydrates via generateOfficeHoursLinkCode
      } : undefined,
      status: "active",
      priority: pendingRule.priority,
      createdAt: new Date().toISOString(),
    };
    const newRules = [...data.structuredRules, rule];
    setPendingRule(null);
    setInputText("");
    saveRules(newRules);
  }

  // --- Toggle rule ---

  function toggleRule(id: string) {
    if (!data) return;
    const newRules = data.structuredRules.map((r) =>
      r.id === id ? { ...r, status: (r.status === "active" ? "paused" : "active") as AvailabilityRule["status"] } : r
    );
    saveRules(newRules);
  }

  // --- Remove rule ---

  function removeRule(id: string) {
    if (!data) return;
    const newRules = data.structuredRules.filter((r) => r.id !== id);
    saveRules(newRules);
  }

  // --- Save edited rule ---

  function saveEditedRule(id: string) {
    if (!data) return;
    const newRules = data.structuredRules.map((r) => {
      if (r.id !== id) return r;
      return {
        ...r,
        timeStart: editFields.timeStart ?? r.timeStart,
        timeEnd: editFields.timeEnd ?? r.timeEnd,
        allDay: editFields.allDay ?? r.allDay,
        daysOfWeek: editFields.daysOfWeek ?? r.daysOfWeek,
        effectiveDate: editFields.effectiveDate ?? r.effectiveDate,
        expiryDate: editFields.expiryDate ?? r.expiryDate,
        bufferMinutesBefore: editFields.bufferMinutesBefore ?? r.bufferMinutesBefore,
        bufferMinutesAfter: editFields.bufferMinutesAfter ?? r.bufferMinutesAfter,
        locationLabel: editFields.locationLabel ?? r.locationLabel,
        type: editFields.type ?? r.type,
      } as AvailabilityRule;
    });
    setEditingRule(null);
    setEditFields({});
    saveRules(newRules);
  }

  // --- Business hours save ---

  function saveBusinessHours(start: number, end: number) {
    if (!data) return;
    setData({ ...data, businessHoursStart: start, businessHoursEnd: end });
    // Save to backend
    fetch("/api/tuner/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...data,
        businessHoursStart: start,
        businessHoursEnd: end,
      }),
    }).then(() => onSaved());
  }

  // --- Render ---

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-32 text-muted text-sm">
        Loading...
      </div>
    );
  }

  const rules = data.structuredRules || [];
  const activeRules = rules.filter((r) => r.status === "active" || r.status === "paused");
  const expiredRules = rules.filter((r) => r.status === "expired");

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-primary">Schedule Rules</h2>
            <div className="flex items-center gap-2">
              {isSaving && (
                <span className="flex items-center gap-1 text-[10px] text-muted">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Saving
                </span>
              )}
              <span className="text-[10px] text-muted">
                {activeRules.filter(r => r.status === "active").length} active
              </span>
            </div>
          </div>

          {/* Free text input */}
          {!pendingRule && (
            <>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => { setInputText(e.target.value); setParseError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && inputText.trim()) {
                    e.preventDefault();
                    handleParseRule();
                  }
                }}
                placeholder="Tell me what to block or allow..."
                disabled={isParsing}
                className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2.5 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition disabled:opacity-60"
              />
              <button
                onClick={handleParseRule}
                disabled={!inputText.trim() || isParsing}
                className="px-3 py-2.5 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition disabled:opacity-40 flex items-center gap-1.5"
              >
                {isParsing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
              </button>
            </div>
            {parseError ? (
              <div className="mt-2 text-xs space-y-1">
                <p className="text-amber-400">{parseError}</p>
                <ul className="text-muted space-y-0.5 pl-3">
                  <li>&ldquo;Available 9am to 5pm&rdquo;</li>
                  <li>&ldquo;Block Friday afternoons&rdquo;</li>
                  <li>&ldquo;Buffer 30min after in-person meetings&rdquo;</li>
                  <li>&ldquo;Allow calls Saturday before noon&rdquo;</li>
                </ul>
              </div>
            ) : (
              <p className="text-[10px] text-muted mt-1.5">
                Set business hours &middot; Block or protect time &middot; Limit days &middot; Set buffers &middot; Allow exceptions
              </p>
            )}
            </>
          )}

          {/* Confirmation card */}
          {pendingRule && (
            <ConfirmationCard
              rule={pendingRule}
              selectedInterpretation={selectedInterpretation}
              onSelectInterpretation={setSelectedInterpretation}
              onConfirm={confirmRule}
              onCancel={() => { setPendingRule(null); setInputText(""); }}
              onUpdateRule={(updates) => setPendingRule({ ...pendingRule, ...updates })}
            />
          )}

          {/* Business hours card */}
          {data.businessHoursStart != null && data.businessHoursEnd != null && (
            <div className="bg-surface-secondary border border-DEFAULT rounded-xl">
              <div
                className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
                onClick={() => { setBizExpanded(!bizExpanded); setBizEditing(false); }}
              >
                <Clock className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary">
                    Business hours: {formatHour(data.businessHoursStart)} &ndash; {formatHour(data.businessHoursEnd)}
                  </div>
                </div>
              </div>
              {bizExpanded && (
                <div className="px-3 pb-3 pt-0 border-t border-DEFAULT space-y-2">
                  {bizEditing ? (
                    <div className="space-y-2 pt-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted w-12">From</span>
                        <select
                          value={bizEditStart ?? data.businessHoursStart}
                          onChange={(e) => setBizEditStart(Number(e.target.value))}
                          className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                        >
                          {Array.from({ length: 24 }, (_, i) => (
                            <option key={i} value={i}>{formatHour(i)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted w-12">To</span>
                        <select
                          value={bizEditEnd ?? data.businessHoursEnd}
                          onChange={(e) => setBizEditEnd(Number(e.target.value))}
                          className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                        >
                          {Array.from({ length: 24 }, (_, i) => (
                            <option key={i} value={i}>{formatHour(i)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          onClick={() => {
                            const start = bizEditStart ?? data.businessHoursStart;
                            const end = bizEditEnd ?? data.businessHoursEnd;
                            saveBusinessHours(start, end);
                            setBizEditing(false);
                            setBizEditStart(null);
                            setBizEditEnd(null);
                          }}
                          className="flex items-center gap-1 px-2.5 py-1 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg transition"
                        >
                          <Check className="w-3 h-3" /> Save
                        </button>
                        <button
                          onClick={() => { setBizEditing(false); setBizEditStart(null); setBizEditEnd(null); }}
                          className="px-2.5 py-1 text-xs text-muted hover:text-secondary transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        onClick={() => setBizEditing(true)}
                        className="flex items-center gap-1 text-xs text-muted hover:text-secondary transition"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* All active rules */}
          {activeRules.length > 0 && (
            <div className="space-y-1.5">
              {activeRules.map((rule) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  expanded={expandedRuleId === rule.id}
                  editing={editingRule === rule.id}
                  editFields={editingRule === rule.id ? editFields : {}}
                  onToggleExpand={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
                  onToggle={() => toggleRule(rule.id)}
                  onRemove={() => removeRule(rule.id)}
                  onStartEdit={() => { setEditingRule(rule.id); setEditFields({}); }}
                  onEditField={(f) => setEditFields({ ...editFields, ...f })}
                  onSaveEdit={() => saveEditedRule(rule.id)}
                  onCancelEdit={() => { setEditingRule(null); setEditFields({}); }}
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {activeRules.length === 0 && !pendingRule && (
            <div className="text-sm text-muted text-center py-8 space-y-1">
              <p>No rules yet.</p>
              <p className="text-xs">Try: &ldquo;Block Friday afternoons&rdquo; or &ldquo;Buffer 30min after calls&rdquo;</p>
            </div>
          )}

          {/* EXPIRED */}
          {expiredRules.length > 0 && (
            <section>
              <button
                onClick={() => setShowExpired(!showExpired)}
                className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted hover:text-secondary transition"
              >
                {showExpired ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Expired ({expiredRules.length})
              </button>
              {showExpired && (
                <div className="mt-2 space-y-1.5">
                  {expiredRules.map((rule) => (
                    <RuleCard
                      key={rule.id}
                      rule={rule}
                      expanded={expandedRuleId === rule.id}
                      editing={false}
                      editFields={{}}
                      onToggleExpand={() => setExpandedRuleId(expandedRuleId === rule.id ? null : rule.id)}
                      onToggle={() => toggleRule(rule.id)}
                      onRemove={() => removeRule(rule.id)}
                      onStartEdit={() => {}}
                      onEditField={() => {}}
                      onSaveEdit={() => {}}
                      onCancelEdit={() => {}}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

// --- Confirmation Card ---

function ConfirmationCard({
  rule,
  selectedInterpretation,
  onSelectInterpretation,
  onConfirm,
  onCancel,
  onUpdateRule,
}: {
  rule: ParsedRule;
  selectedInterpretation: number;
  onSelectInterpretation: (i: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onUpdateRule: (updates: Partial<ParsedRule>) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="bg-surface-secondary border border-indigo-500/30 rounded-xl p-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="flex items-start justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
          New Rule
        </div>
        <button onClick={onCancel} className="text-muted hover:text-secondary transition">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Original text */}
      <p className="text-sm text-secondary italic">&ldquo;{rule.originalText}&rdquo;</p>

      {/* Ambiguity picker */}
      {rule.ambiguous && rule.interpretations && rule.interpretations.length > 1 ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-400 font-medium">Did you mean:</p>
          {rule.interpretations.map((interp, i) => (
            <label
              key={i}
              className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition ${
                selectedInterpretation === i
                  ? "border-indigo-500/50 bg-indigo-500/5"
                  : "border-DEFAULT hover:border-surface-tertiary"
              }`}
            >
              <input
                type="radio"
                name="interpretation"
                checked={selectedInterpretation === i}
                onChange={() => onSelectInterpretation(i)}
                className="mt-0.5 accent-indigo-500"
              />
              <span className="text-xs text-primary leading-relaxed">{interp}</span>
            </label>
          ))}
        </div>
      ) : (
        /* Structured preview / edit */
        <div className="space-y-2">
          <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
            {/* Type (action) */}
            <span className="text-muted">Type</span>
            <span className="text-primary font-medium">{ACTION_LABELS[rule.action]}</span>
            {/* Location label */}
            {rule.action === "location" && (
              isEditing ? (
                <>
                  <span className="text-muted">Place</span>
                  <input
                    type="text"
                    defaultValue={rule.locationLabel ?? ""}
                    onChange={(e) => onUpdateRule({ locationLabel: e.target.value })}
                    placeholder="e.g. Baja"
                    className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                  />
                </>
              ) : rule.locationLabel ? (
                <>
                  <span className="text-muted">Place</span>
                  <span className="text-primary">{rule.locationLabel}</span>
                </>
              ) : null
            )}
            {/* Office hours — title / format / duration */}
            {rule.action === "office_hours" && (
              <>
                <span className="text-muted">Title</span>
                {isEditing ? (
                  <input
                    type="text"
                    defaultValue={rule.officeHoursTitle ?? "Office Hours"}
                    onChange={(e) => onUpdateRule({ officeHoursTitle: e.target.value })}
                    placeholder="Office Hours"
                    className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                  />
                ) : (
                  <span className="text-primary">{rule.officeHoursTitle?.trim() || "Office Hours"}</span>
                )}
                <span className="text-muted">Format</span>
                {isEditing || !rule.officeHoursFormat ? (
                  <select
                    value={rule.officeHoursFormat ?? ""}
                    onChange={(e) => onUpdateRule({ officeHoursFormat: (e.target.value || undefined) as ParsedRule["officeHoursFormat"] })}
                    className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                  >
                    <option value="">Choose…</option>
                    <option value="video">Video</option>
                    <option value="phone">Phone</option>
                    <option value="in-person">In-person</option>
                  </select>
                ) : (
                  <span className="text-primary">
                    {rule.officeHoursFormat === "video" ? "Video" : rule.officeHoursFormat === "phone" ? "Phone" : "In-person"}
                  </span>
                )}
                <span className="text-muted">Duration</span>
                {isEditing || !rule.officeHoursDurationMinutes ? (
                  <select
                    value={rule.officeHoursDurationMinutes ?? ""}
                    onChange={(e) => onUpdateRule({ officeHoursDurationMinutes: e.target.value ? Number(e.target.value) : undefined })}
                    className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                  >
                    <option value="">Choose…</option>
                    <option value="15">15 min</option>
                    <option value="20">20 min</option>
                    <option value="30">30 min</option>
                    <option value="45">45 min</option>
                    <option value="60">60 min</option>
                  </select>
                ) : (
                  <span className="text-primary">{rule.officeHoursDurationMinutes} min</span>
                )}
              </>
            )}
            {/* Business hours */}
            {rule.action === "business_hours" && rule.businessHoursStart != null && rule.businessHoursEnd != null && (
              isEditing ? (
                <>
                  <span className="text-muted">Hours</span>
                  <div className="flex items-center gap-1">
                    <select
                      defaultValue={rule.businessHoursStart}
                      onChange={(e) => onUpdateRule({ businessHoursStart: Number(e.target.value) })}
                      className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>{formatHour(i)}</option>
                      ))}
                    </select>
                    <span className="text-muted">to</span>
                    <select
                      defaultValue={rule.businessHoursEnd}
                      onChange={(e) => onUpdateRule({ businessHoursEnd: Number(e.target.value) })}
                      className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>{formatHour(i)}</option>
                      ))}
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-muted">Hours</span>
                  <span className="text-primary font-medium">
                    {formatHour(rule.businessHoursStart)} &ndash; {formatHour(rule.businessHoursEnd)}
                  </span>
                </>
              )
            )}
            {/* When — days of week */}
            {rule.daysOfWeek && (
              isEditing ? (
                <>
                  <span className="text-muted">When</span>
                  <div className="flex flex-wrap gap-1">
                    {DAY_NAMES_SHORT.map((name, i) => {
                      const active = rule.daysOfWeek!.includes(i);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            const newDays = active
                              ? rule.daysOfWeek!.filter(d => d !== i)
                              : [...rule.daysOfWeek!, i].sort();
                            onUpdateRule({ daysOfWeek: newDays });
                          }}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                            active
                              ? "bg-accent text-white"
                              : "bg-surface border border-DEFAULT text-muted hover:text-secondary"
                          }`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <span className="text-muted">When</span>
                  <span className="text-primary">
                    {rule.type === "recurring" ? "Every " : ""}{daysLabel(rule.daysOfWeek)}
                  </span>
                </>
              )
            )}
            {rule.effectiveDate && (
              isEditing ? (
                <>
                  <span className="text-muted">{rule.expiryDate ? "From" : "Date"}</span>
                  <input
                    type="date"
                    defaultValue={rule.effectiveDate}
                    onChange={(e) => onUpdateRule({ effectiveDate: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                  />
                </>
              ) : (
                <>
                  <span className="text-muted">{rule.expiryDate ? "From" : "Date"}</span>
                  <span className="text-primary">{formatDate(rule.effectiveDate)}</span>
                </>
              )
            )}
            {rule.expiryDate && (
              isEditing ? (
                <>
                  <span className="text-muted">Until</span>
                  <input
                    type="date"
                    defaultValue={rule.expiryDate}
                    onChange={(e) => onUpdateRule({ expiryDate: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                  />
                </>
              ) : (
                <>
                  <span className="text-muted">Until</span>
                  <span className="text-primary">{formatDate(rule.expiryDate)}</span>
                </>
              )
            )}

            {/* Time */}
            {rule.allDay ? (
              isEditing ? (
                <>
                  <span className="text-muted">Time</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onUpdateRule({ allDay: false, timeStart: "09:00", timeEnd: "17:00" })}
                      className="text-[10px] text-accent hover:underline"
                    >
                      Set specific times
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-muted">Time</span>
                  <span className="text-primary">All day</span>
                </>
              )
            ) : rule.timeStart && rule.timeEnd ? (
              isEditing ? (
                <>
                  <span className="text-muted">Time</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="time"
                      defaultValue={rule.timeStart}
                      onChange={(e) => onUpdateRule({ timeStart: e.target.value })}
                      className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                    />
                    <span className="text-muted">to</span>
                    <input
                      type="time"
                      defaultValue={rule.timeEnd}
                      onChange={(e) => onUpdateRule({ timeEnd: e.target.value })}
                      className="bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                    />
                  </div>
                </>
              ) : (
                <>
                  <span className="text-muted">Time</span>
                  <span className="text-primary">
                    {formatTime24to12(rule.timeStart)} &ndash; {formatTime24to12(rule.timeEnd)}
                  </span>
                </>
              )
            ) : null}

            {/* Buffer */}
            {rule.action === "buffer" && (
              isEditing ? (
                <>
                  <span className="text-muted">Buffer</span>
                  <div className="flex items-center gap-1">
                    {rule.bufferMinutesBefore != null && (
                      <>
                        <input
                          type="number"
                          defaultValue={rule.bufferMinutesBefore}
                          min={0}
                          onChange={(e) => onUpdateRule({ bufferMinutesBefore: Number(e.target.value) })}
                          className="w-12 bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                        />
                        <span className="text-muted">min before</span>
                      </>
                    )}
                    {rule.bufferMinutesAfter != null && (
                      <>
                        <input
                          type="number"
                          defaultValue={rule.bufferMinutesAfter}
                          min={0}
                          onChange={(e) => onUpdateRule({ bufferMinutesAfter: Number(e.target.value) })}
                          className="w-12 bg-surface border border-DEFAULT rounded px-1.5 py-0.5 text-primary text-xs"
                        />
                        <span className="text-muted">min after</span>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <span className="text-muted">Buffer</span>
                  <span className="text-primary">
                    {rule.bufferMinutesBefore ? `${rule.bufferMinutesBefore}min before` : ""}
                    {rule.bufferMinutesBefore && rule.bufferMinutesAfter ? " & " : ""}
                    {rule.bufferMinutesAfter ? `${rule.bufferMinutesAfter}min after` : ""}
                  </span>
                </>
              )
            )}
            {rule.bufferAppliesTo && (
              <>
                <span className="text-muted">Applies to</span>
                <span className="text-primary">{rule.bufferAppliesTo} meetings</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Office-hours override warning */}
      {rule.action === "office_hours" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-[11px] text-amber-300 leading-relaxed">
          Office hours override other soft blocks. Envoy will offer these slots even if your schedule shows them protected — real calendar events and blackout days stay blocked.
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onConfirm}
          disabled={rule.action === "office_hours" && (!rule.officeHoursFormat || !rule.officeHoursDurationMinutes)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check className="w-4 h-4" />
          Looks good
        </button>
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="px-3 py-2 text-sm text-muted hover:text-secondary border border-DEFAULT rounded-lg transition"
        >
          {isEditing ? "Done editing" : "Edit"}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-2 text-sm text-muted hover:text-secondary border border-DEFAULT rounded-lg transition"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// --- Rule Card ---

function RuleCard({
  rule,
  expanded,
  editing,
  editFields,
  onToggleExpand,
  onToggle,
  onRemove,
  onStartEdit,
  onEditField,
  onSaveEdit,
  onCancelEdit,
}: {
  rule: AvailabilityRule;
  expanded: boolean;
  editing: boolean;
  editFields: Partial<ParsedRule>;
  onToggleExpand: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onStartEdit: () => void;
  onEditField: (fields: Partial<ParsedRule>) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}) {
  const isExpired = rule.status === "expired";
  const isPaused = rule.status === "paused";

  // Expiry badge
  let expiryBadge: string | null = null;
  if (rule.expiryDate && rule.status === "active") {
    const days = daysUntil(rule.expiryDate);
    if (days === 0) expiryBadge = "Expires today";
    else if (days === 1) expiryBadge = "Expires tomorrow";
    else if (days > 0 && days <= 7) expiryBadge = `Expires in ${days}d`;
  }

  // Summary line
  let summary: string;
  if (rule.action === "buffer") {
    const parts: string[] = [];
    if (rule.bufferMinutesBefore) parts.push(`${rule.bufferMinutesBefore}min before`);
    if (rule.bufferMinutesAfter) parts.push(`${rule.bufferMinutesAfter}min after`);
    summary = `Buffer ${parts.join(" & ")}`;
    if (rule.bufferAppliesTo) summary += ` ${rule.bufferAppliesTo}`;
  } else if (rule.action === "location" && rule.locationLabel) {
    summary = `Currently in ${rule.locationLabel}`;
    if (rule.expiryDate) summary += ` until ${formatDate(rule.expiryDate)}`;
  } else if (rule.action === "office_hours" && rule.officeHours) {
    const days = rule.daysOfWeek && rule.daysOfWeek.length > 0 ? daysLabel(rule.daysOfWeek) : "Every day";
    const window = rule.timeStart && rule.timeEnd
      ? `${formatTime24to12(rule.timeStart)}\u2013${formatTime24to12(rule.timeEnd)}`
      : "";
    summary = `${rule.officeHours.title} · ${days} ${window} · ${rule.officeHours.durationMinutes}-min ${rule.officeHours.format}`.trim();
  } else {
    summary = rule.originalText;
  }

  const ActionIcon = ACTION_ICONS[rule.action];

  return (
    <div
      className={`border rounded-xl transition ${
        isExpired
          ? "bg-surface-secondary/30 border-DEFAULT opacity-40"
          : isPaused
            ? "bg-surface-secondary/30 border-DEFAULT opacity-50"
            : "bg-surface-secondary border-DEFAULT"
      }`}
    >
      {/* Collapsed view */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer"
        onClick={onToggleExpand}
      >
        {ActionIcon && (
          <ActionIcon className={`w-3.5 h-3.5 flex-shrink-0 ${isPaused || isExpired ? "text-muted" : "text-secondary"}`} />
        )}
        <div className="flex-1 min-w-0">
          <div className={`text-sm truncate ${isPaused || isExpired ? "text-muted" : "text-primary"}`}>
            {summary}
          </div>
        </div>
        {expiryBadge && (
          <span className="text-[10px] text-amber-400 flex-shrink-0 whitespace-nowrap">{expiryBadge}</span>
        )}
        {!isExpired && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="flex-shrink-0 transition"
            title={isPaused ? "Enable" : "Pause"}
          >
            {isPaused ? (
              <ToggleLeft className="w-5 h-5 text-muted" />
            ) : (
              <ToggleRight className="w-5 h-5 text-accent" />
            )}
          </button>
        )}
      </div>

      {/* Expanded view */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-DEFAULT space-y-2">
          {editing ? (
            /* Edit mode */
            <div className="space-y-2 pt-2">
              {/* Location label (for location rules) */}
              {rule.action === "location" && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">Place</span>
                  <input
                    type="text"
                    value={(editFields.locationLabel as string | undefined) ?? rule.locationLabel ?? ""}
                    onChange={(e) => onEditField({ locationLabel: e.target.value })}
                    placeholder="e.g. Baja, NYC"
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs flex-1 max-w-[160px]"
                  />
                </div>
              )}
              {/* Days of week */}
              {rule.daysOfWeek && rule.daysOfWeek.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">When</span>
                  <div className="flex flex-wrap gap-1">
                    {DAY_NAMES_SHORT.map((name, i) => {
                      const currentDays = (editFields.daysOfWeek as number[] | undefined) ?? rule.daysOfWeek!;
                      const active = currentDays.includes(i);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            const newDays = active
                              ? currentDays.filter(d => d !== i)
                              : [...currentDays, i].sort();
                            onEditField({ daysOfWeek: newDays });
                          }}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition ${
                            active
                              ? "bg-accent text-white"
                              : "bg-surface border border-DEFAULT text-muted hover:text-secondary"
                          }`}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Time — show for non-allDay rules, or offer to set times for allDay */}
              {rule.allDay ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">Time</span>
                  <span className="text-secondary">All day</span>
                  <button
                    type="button"
                    onClick={() => onEditField({ allDay: false, timeStart: "09:00", timeEnd: "17:00" })}
                    className="text-[10px] text-accent hover:underline ml-1"
                  >
                    Set specific times
                  </button>
                </div>
              ) : (rule.timeStart || editFields.timeStart) ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">Time</span>
                  <input
                    type="time"
                    value={(editFields.timeStart as string | undefined) ?? rule.timeStart ?? "09:00"}
                    onChange={(e) => onEditField({ timeStart: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                  />
                  <span className="text-muted">to</span>
                  <input
                    type="time"
                    value={(editFields.timeEnd as string | undefined) ?? rule.timeEnd ?? "17:00"}
                    onChange={(e) => onEditField({ timeEnd: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                  />
                </div>
              ) : null}
              {/* Buffer amounts */}
              {rule.action === "buffer" && (
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <span className="text-muted w-12">Buffer</span>
                  {(rule.bufferMinutesBefore != null || editFields.bufferMinutesBefore != null) && (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        value={(editFields.bufferMinutesBefore as number | undefined) ?? rule.bufferMinutesBefore ?? 0}
                        onChange={(e) => onEditField({ bufferMinutesBefore: Number(e.target.value) })}
                        className="w-14 bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                      />
                      <span className="text-muted">min before</span>
                    </div>
                  )}
                  {(rule.bufferMinutesAfter != null || editFields.bufferMinutesAfter != null) && (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        value={(editFields.bufferMinutesAfter as number | undefined) ?? rule.bufferMinutesAfter ?? 0}
                        onChange={(e) => onEditField({ bufferMinutesAfter: Number(e.target.value) })}
                        className="w-14 bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                      />
                      <span className="text-muted">min after</span>
                    </div>
                  )}
                </div>
              )}
              {/* Effective date */}
              {rule.effectiveDate && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">From</span>
                  <input
                    type="date"
                    value={(editFields.effectiveDate as string | undefined) ?? rule.effectiveDate}
                    onChange={(e) => onEditField({ effectiveDate: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                  />
                </div>
              )}
              {/* Expiry date */}
              {(rule.expiryDate || editFields.expiryDate) && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">Expires</span>
                  <input
                    type="date"
                    value={(editFields.expiryDate as string | undefined) ?? rule.expiryDate ?? ""}
                    onChange={(e) => onEditField({ expiryDate: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                  />
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={onSaveEdit}
                  className="flex items-center gap-1 px-2.5 py-1 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg transition"
                >
                  <Check className="w-3 h-3" /> Save
                </button>
                <button
                  onClick={onCancelEdit}
                  className="px-2.5 py-1 text-xs text-muted hover:text-secondary transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            /* Detail view */
            <div className="space-y-2 pt-2">
              <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                {/* Type */}
                <span className="text-muted">Type</span>
                <span className="text-primary font-medium">{ACTION_LABELS[rule.action]}</span>
                {/* Location */}
                {rule.action === "location" && rule.locationLabel && (
                  <>
                    <span className="text-muted">Place</span>
                    <span className="text-primary">{rule.locationLabel}</span>
                  </>
                )}
                {/* When — days */}
                {rule.daysOfWeek && rule.daysOfWeek.length > 0 && (
                  <>
                    <span className="text-muted">When</span>
                    <span className="text-primary">{daysLabel(rule.daysOfWeek)}</span>
                  </>
                )}
                {/* Time */}
                {rule.allDay ? (
                  <>
                    <span className="text-muted">Time</span>
                    <span className="text-primary">All day</span>
                  </>
                ) : rule.timeStart && rule.timeEnd ? (
                  <>
                    <span className="text-muted">Time</span>
                    <span className="text-primary">
                      {formatTime24to12(rule.timeStart)} &ndash; {formatTime24to12(rule.timeEnd)}
                    </span>
                  </>
                ) : null}
                {/* Buffer specifics */}
                {rule.action === "buffer" && (rule.bufferMinutesBefore || rule.bufferMinutesAfter) && (
                  <>
                    <span className="text-muted">Buffer</span>
                    <span className="text-primary">
                      {rule.bufferMinutesBefore ? `${rule.bufferMinutesBefore}min before` : ""}
                      {rule.bufferMinutesBefore && rule.bufferMinutesAfter ? " & " : ""}
                      {rule.bufferMinutesAfter ? `${rule.bufferMinutesAfter}min after` : ""}
                      {rule.bufferAppliesTo ? ` ${rule.bufferAppliesTo}` : ""}
                    </span>
                  </>
                )}
                {/* From */}
                {rule.effectiveDate && (
                  <>
                    <span className="text-muted">From</span>
                    <span className="text-primary">{formatDate(rule.effectiveDate)}</span>
                  </>
                )}
                {/* Until */}
                {rule.expiryDate && (
                  <>
                    <span className="text-muted">Until</span>
                    <span className="text-primary">{formatDate(rule.expiryDate)}</span>
                  </>
                )}
                {/* Office hours fields */}
                {rule.action === "office_hours" && rule.officeHours && (
                  <>
                    <span className="text-muted">Title</span>
                    <span className="text-primary">{rule.officeHours.title}</span>
                    <span className="text-muted">Format</span>
                    <span className="text-primary">
                      {rule.officeHours.format === "video" ? "Video" : rule.officeHours.format === "phone" ? "Phone" : "In-person"}
                    </span>
                    <span className="text-muted">Duration</span>
                    <span className="text-primary">{rule.officeHours.durationMinutes} min</span>
                  </>
                )}
                {/* Added */}
                <span className="text-muted">Added</span>
                <span className="text-primary">
                  {new Date(rule.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>

              {/* Office hours link */}
              {rule.action === "office_hours" && rule.officeHours && rule.officeHours.linkSlug && rule.officeHours.linkCode && (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <code className="flex-1 min-w-0 truncate bg-surface border border-DEFAULT rounded px-2 py-1 text-secondary">
                    {`/meet/${rule.officeHours.linkSlug}/${rule.officeHours.linkCode}`}
                  </code>
                  <button
                    onClick={() => {
                      const url = `${window.location.origin}/meet/${rule.officeHours!.linkSlug}/${rule.officeHours!.linkCode}`;
                      navigator.clipboard.writeText(url);
                    }}
                    className="flex items-center gap-1 px-2 py-1 text-muted hover:text-secondary border border-DEFAULT rounded transition"
                    title="Copy link"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                </div>
              )}

              {!isExpired && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={onStartEdit}
                    className="flex items-center gap-1 text-xs text-muted hover:text-secondary transition"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button
                    onClick={onRemove}
                    className="flex items-center gap-1 text-xs text-muted hover:text-red-400 transition"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>
              )}
              {isExpired && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={onToggle}
                    className="text-xs text-muted hover:text-secondary transition"
                  >
                    Reactivate
                  </button>
                  <button
                    onClick={onRemove}
                    className="flex items-center gap-1 text-xs text-muted hover:text-red-400 transition"
                  >
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
