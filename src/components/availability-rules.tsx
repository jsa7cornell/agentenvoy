"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Clock, Shield, Timer, CalendarOff, ChevronDown, ChevronRight,
  Plus, Check, X, Pencil, Trash2, Loader2, ToggleLeft, ToggleRight,
} from "lucide-react";
import type { AvailabilityRule } from "@/lib/availability-rules";

// --- Types ---

interface ParsedRule {
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "allow" | "buffer" | "prefer";
  timeStart?: string;
  timeEnd?: string;
  allDay?: boolean;
  daysOfWeek?: number[];
  effectiveDate?: string;
  expiryDate?: string;
  bufferMinutesBefore?: number;
  bufferMinutesAfter?: number;
  bufferAppliesTo?: string;
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
  // Legacy fields (read-only, kept for backwards compat)
  blockedWindows: unknown[];
  currentLocation: { label: string; until?: string } | null;
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

// --- Rule type config ---

const TYPE_CONFIG = {
  ongoing: { label: "Ongoing", color: "text-violet-400", bgColor: "bg-violet-500/10", icon: Shield },
  recurring: { label: "Recurring", color: "text-blue-400", bgColor: "bg-blue-500/10", icon: Clock },
  temporary: { label: "Temporary", color: "text-amber-400", bgColor: "bg-amber-500/10", icon: Timer },
  "one-time": { label: "One-time", color: "text-orange-400", bgColor: "bg-orange-500/10", icon: CalendarOff },
};

const ACTION_LABELS: Record<string, string> = {
  block: "Block",
  allow: "Allow",
  buffer: "Buffer",
  prefer: "Prefer",
};

// --- Component ---

export function AvailabilityRules({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<PreferenceData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [inputText, setInputText] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [pendingRule, setPendingRule] = useState<ParsedRule | null>(null);
  const [selectedInterpretation, setSelectedInterpretation] = useState<number>(0);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [editingBusinessHours, setEditingBusinessHours] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const [editingRule, setEditingRule] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<Partial<ParsedRule>>({});

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
      setPendingRule(parsed);
      setSelectedInterpretation(0);
    } catch (e) {
      console.error("Parse failed:", e);
    } finally {
      setIsParsing(false);
    }
  }

  // --- Confirm rule ---

  function confirmRule() {
    if (!data || !pendingRule) return;
    const rule: AvailabilityRule = {
      id: uuid(),
      originalText: pendingRule.originalText,
      type: pendingRule.type,
      action: pendingRule.action,
      timeStart: pendingRule.timeStart,
      timeEnd: pendingRule.timeEnd,
      allDay: pendingRule.allDay,
      daysOfWeek: pendingRule.daysOfWeek,
      effectiveDate: pendingRule.effectiveDate,
      expiryDate: pendingRule.expiryDate,
      bufferMinutesBefore: pendingRule.bufferMinutesBefore,
      bufferMinutesAfter: pendingRule.bufferMinutesAfter,
      bufferAppliesTo: pendingRule.bufferAppliesTo,
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
        daysOfWeek: editFields.daysOfWeek ?? r.daysOfWeek,
        expiryDate: editFields.expiryDate ?? r.expiryDate,
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
    setEditingBusinessHours(false);
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

  // Categorize active rules
  const temporalRules = activeRules.filter((r) => r.type === "temporary" || r.type === "one-time");
  const permanentRules = activeRules.filter((r) => r.type === "ongoing" || r.type === "recurring");

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
            <div className="flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
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
          )}

          {/* Confirmation card */}
          {pendingRule && (
            <ConfirmationCard
              rule={pendingRule}
              selectedInterpretation={selectedInterpretation}
              onSelectInterpretation={setSelectedInterpretation}
              onConfirm={confirmRule}
              onCancel={() => { setPendingRule(null); setInputText(""); }}
            />
          )}

          {/* THIS WEEK — temporal rules */}
          {temporalRules.length > 0 && (
            <section>
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-2">
                This Week
              </div>
              <div className="space-y-1.5">
                {temporalRules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    expanded={expandedRuleId === rule.id}
                    editing={editingRule === rule.id}
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
            </section>
          )}

          {/* ALWAYS — permanent rules */}
          {permanentRules.length > 0 && (
            <section>
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted mb-2">
                Always
              </div>
              <div className="space-y-1.5">
                {permanentRules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    expanded={expandedRuleId === rule.id}
                    editing={editingRule === rule.id}
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
            </section>
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

          {/* Business Hours */}
          <section className="bg-surface-secondary/50 border border-DEFAULT rounded-xl p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-muted" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                  Business Hours
                </span>
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
                  onChange={(e) => saveBusinessHours(Number(e.target.value), data.businessHoursEnd)}
                  className="flex-1 bg-surface border border-DEFAULT rounded-lg px-2 py-1.5 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{formatHour(i)}</option>
                  ))}
                </select>
                <span className="text-muted text-xs">to</span>
                <select
                  value={data.businessHoursEnd}
                  onChange={(e) => saveBusinessHours(data.businessHoursStart, Number(e.target.value))}
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
}: {
  rule: ParsedRule;
  selectedInterpretation: number;
  onSelectInterpretation: (i: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const config = TYPE_CONFIG[rule.type];
  const Icon = config.icon;

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
        /* Structured preview */
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1 text-xs font-medium ${config.color}`}>
              <Icon className="w-3 h-3" />
              {config.label}
            </div>
            <span className="text-xs text-muted">{ACTION_LABELS[rule.action]}</span>
          </div>

          <div className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
            {/* When */}
            {rule.daysOfWeek && (
              <>
                <span className="text-muted">When</span>
                <span className="text-primary">
                  {rule.type === "recurring" ? "Every " : ""}{daysLabel(rule.daysOfWeek)}
                </span>
              </>
            )}
            {rule.effectiveDate && (
              <>
                <span className="text-muted">{rule.expiryDate ? "From" : "Date"}</span>
                <span className="text-primary">{formatDate(rule.effectiveDate)}</span>
              </>
            )}
            {rule.expiryDate && (
              <>
                <span className="text-muted">Until</span>
                <span className="text-primary">{formatDate(rule.expiryDate)}</span>
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

            {/* Buffer */}
            {rule.action === "buffer" && (
              <>
                <span className="text-muted">Buffer</span>
                <span className="text-primary">
                  {rule.bufferMinutesBefore ? `${rule.bufferMinutesBefore}min before` : ""}
                  {rule.bufferMinutesBefore && rule.bufferMinutesAfter ? " & " : ""}
                  {rule.bufferMinutesAfter ? `${rule.bufferMinutesAfter}min after` : ""}
                </span>
              </>
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

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onConfirm}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition"
        >
          <Check className="w-4 h-4" />
          Looks good
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
  onToggleExpand: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onStartEdit: () => void;
  onEditField: (fields: Partial<ParsedRule>) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}) {
  const config = TYPE_CONFIG[rule.type];
  const Icon = config.icon;
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
  } else {
    summary = rule.originalText;
  }

  return (
    <div
      className={`border rounded-xl transition ${
        isExpired
          ? "bg-surface-secondary/30 border-DEFAULT opacity-60"
          : isPaused
            ? "bg-surface-secondary/30 border-DEFAULT"
            : "bg-surface-secondary border-DEFAULT"
      }`}
    >
      {/* Collapsed view */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
        onClick={onToggleExpand}
      >
        <div className={`flex-shrink-0 ${config.color}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm truncate ${isPaused ? "text-muted line-through" : "text-primary"}`}>
            {summary}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[10px] ${config.color}`}>{config.label}</span>
            {expiryBadge && (
              <span className="text-[10px] text-amber-400">{expiryBadge}</span>
            )}
            {isExpired && rule.expiryDate && (
              <span className="text-[10px] text-muted">Expired {formatDate(rule.expiryDate)}</span>
            )}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="flex-shrink-0 text-muted hover:text-red-400 transition"
          title="Remove"
        >
          <X className="w-4 h-4" />
        </button>
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
              {rule.timeStart && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">Time</span>
                  <input
                    type="time"
                    defaultValue={rule.timeStart}
                    onChange={(e) => onEditField({ timeStart: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                  />
                  <span className="text-muted">to</span>
                  <input
                    type="time"
                    defaultValue={rule.timeEnd}
                    onChange={(e) => onEditField({ timeEnd: e.target.value })}
                    className="bg-surface border border-DEFAULT rounded px-2 py-1 text-primary text-xs"
                  />
                </div>
              )}
              {rule.expiryDate && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted w-12">Until</span>
                  <input
                    type="date"
                    defaultValue={rule.expiryDate}
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
                {rule.daysOfWeek && rule.daysOfWeek.length > 0 && (
                  <>
                    <span className="text-muted">When</span>
                    <span className="text-primary">{daysLabel(rule.daysOfWeek)}</span>
                  </>
                )}
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
                {rule.action === "buffer" && (
                  <>
                    <span className="text-muted">Buffer</span>
                    <span className="text-primary">
                      {rule.bufferMinutesBefore ? `${rule.bufferMinutesBefore}min before` : ""}
                      {rule.bufferMinutesBefore && rule.bufferMinutesAfter ? " & " : ""}
                      {rule.bufferMinutesAfter ? `${rule.bufferMinutesAfter}min after` : ""}
                    </span>
                  </>
                )}
                {rule.effectiveDate && (
                  <>
                    <span className="text-muted">From</span>
                    <span className="text-primary">{formatDate(rule.effectiveDate)}</span>
                  </>
                )}
                {rule.expiryDate && (
                  <>
                    <span className="text-muted">Until</span>
                    <span className="text-primary">{formatDate(rule.expiryDate)}</span>
                  </>
                )}
                <span className="text-muted">Added</span>
                <span className="text-primary">
                  {new Date(rule.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>

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
