"use client";

/**
 * Unified link-edit modal — PR-D of proposal
 * 2026-05-06_link-config-canonical-model-and-unified-edit, extended
 * 2026-05-10 with bookable-rule mode (Option C — the deferred-migration
 * follow-up at proposal 2026-05-10_bookable-links-migrate-to-negotiationlink-table
 * is the long-term consolidation; this is the visible-fix UI adapter).
 *
 * Handles editing for:
 *  - Primary link (`mode: "primary"`) — writes via POST /api/me/scheduling-defaults
 *  - Bookable/personalized links (`mode: "link"`) — writes via
 *    PATCH /api/me/links/[id]/posture (NegotiationLink.parameters)
 *  - Bookable rule (`mode: "bookable-rule"`) — writes via
 *    POST /api/availability-rules/edit. Bookable links today are stored as
 *    rules in `User.preferences.explicit.structuredRules[]`, not on
 *    NegotiationLink.parameters; this mode reuses `<RuleFormFields>` to
 *    keep the form identical to the legacy dialog while sharing chrome
 *    with the rest of the modal so the user sees one consistent edit UX.
 *
 * Availability section (primary/link only) has two modes:
 *  - Simple (default): one window shared across chosen days
 *  - Advanced (toggle): raw AvailabilityWindow[] JSON textarea
 *
 * Styling matches availability-rules.tsx conventions.
 */

import { useState, useEffect, useCallback } from "react";
import { X, Check, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import type { AvailabilityWindow } from "@/lib/link-parameters";
import type { ResolvedPosture } from "@/lib/links/posture";
import { DEFAULT_TIP } from "@/lib/meeting-tip/default-tip";
import { RuleFormFields, type BookableLinkProposal } from "@/components/onboarding/rule-form-fields";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkEditMode = "primary" | "link" | "bookable-rule";

export interface LinkEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** "primary" to edit the primary link;
   *  "link" to edit a posture-backed variance link;
   *  "bookable-rule" to edit a rule-backed bookable (Office Hours / etc.). */
  mode: LinkEditMode;
  /** Required when mode === "link". The NegotiationLink row ID. */
  linkId?: string;
  /** Required when mode === "bookable-rule". The structuredRules entry id (`rule_*`). */
  ruleId?: string;
  /** Pre-populate fields. When absent the modal fetches from the API.
   *  Only used in primary/link modes. */
  initial?: Partial<ResolvedPosture>;
  /** Pre-populate fields for bookable-rule mode. Required when
   *  mode === "bookable-rule"; matches the shape of
   *  ReusableLinkRow.recurringWindowConfig (plus an originalText for the
   *  rule's audit trail). */
  bookableInitial?: BookableLinkProposal;
  /** Called after a successful save, before the modal closes. */
  onSaved?: () => void;
}

type FormatValue = "video" | "phone" | "in-person";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DURATION_OPTIONS = [15, 25, 30, 45, 60, 90];
const BUFFER_OPTIONS = [0, 5, 10, 15, 30];
const FORMAT_OPTIONS: Array<{ value: FormatValue; label: string }> = [
  { value: "video", label: "Video" },
  { value: "phone", label: "Phone" },
  { value: "in-person", label: "In-person" },
];

// 30-minute increments from 0 (midnight) to 1440 (midnight next day).
const MINUTE_OPTIONS: number[] = [];
for (let m = 0; m <= 23 * 60; m += 30) {
  MINUTE_OPTIONS.push(m);
}
// Add 1440 (midnight end)
MINUTE_OPTIONS.push(1440);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesToLabel(min: number): string {
  if (min === 1440) return "12:00 AM (midnight)";
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Derive a simple-mode representation from an AvailabilityWindow[]. */
function windowsToSimple(windows: AvailabilityWindow[]): {
  days: number[];
  startMinutes: number;
  endMinutes: number;
} {
  if (windows.length === 0) {
    return { days: [1, 2, 3, 4, 5], startMinutes: 540, endMinutes: 1080 };
  }
  // Use first window's hours; union all days.
  const allDays = [...new Set(windows.flatMap((w) => w.days))].sort((a, b) => a - b);
  return {
    days: allDays,
    startMinutes: windows[0].startMinutes,
    endMinutes: windows[0].endMinutes,
  };
}

/** Build an AvailabilityWindow[] from simple-mode inputs. */
function simpleToWindows(days: number[], startMinutes: number, endMinutes: number): AvailabilityWindow[] {
  if (days.length === 0) return [];
  return [{ days, startMinutes, endMinutes }];
}

function validateSimple(days: number[], startMinutes: number, endMinutes: number): string | null {
  if (days.length === 0) return "Choose at least one day.";
  if (endMinutes <= startMinutes) return "End time must be after start time.";
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LinkEditModal({
  isOpen,
  onClose,
  mode,
  linkId,
  ruleId,
  initial,
  bookableInitial,
  onSaved,
}: LinkEditModalProps) {
  // ---- Loading state ----
  // bookable-rule mode never fetches (parent passes bookableInitial) — start non-loading.
  const [isLoading, setIsLoading] = useState(
    mode === "bookable-rule" ? false : !initial,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // ---- Form fields (primary / link modes) ----
  // Simple availability mode
  const [simpleDays, setSimpleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [simpleStart, setSimpleStart] = useState(540);
  const [simpleEnd, setSimpleEnd] = useState(1080);

  // Advanced availability mode
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedJson, setAdvancedJson] = useState("");
  const [advancedJsonError, setAdvancedJsonError] = useState<string | null>(null);

  const [duration, setDuration] = useState(30);
  const [bufferMinutes, setBufferMinutes] = useState(0);
  const [format, setFormat] = useState<FormatValue>("video");
  const [tip, setTip] = useState<string>(DEFAULT_TIP);

  // ---- Form fields (bookable-rule mode) ----
  // Single mutable proposal object; RuleFormFields renders and edits it.
  // Seeded from `bookableInitial` on open; isDirty flips on any change.
  const [ruleProposal, setRuleProposal] = useState<BookableLinkProposal | null>(null);

  // ---- Seed form from initial prop or API ----
  const seedForm = useCallback((posture: Partial<ResolvedPosture>) => {
    const windows: AvailabilityWindow[] =
      Array.isArray(posture.availability) && posture.availability.length > 0
        ? posture.availability
        : [{ days: [1, 2, 3, 4, 5], startMinutes: 540, endMinutes: 1080 }];

    const simple = windowsToSimple(windows);
    setSimpleDays(simple.days);
    setSimpleStart(simple.startMinutes);
    setSimpleEnd(simple.endMinutes);
    // Compact JSON: one window per line (not fully-exploded pretty-print).
    setAdvancedJson("[\n" + windows.map((w) => "  " + JSON.stringify(w)).join(",\n") + "\n]");

    if (typeof posture.defaultDuration === "number") setDuration(posture.defaultDuration);
    if (typeof posture.bufferMinutes === "number") setBufferMinutes(posture.bufferMinutes);
    if (posture.format) setFormat(posture.format);
    // Tip: use host-authored value if present, otherwise fall back to DEFAULT_TIP.
    setTip(typeof posture.tip === "string" && posture.tip.length > 0 ? posture.tip : DEFAULT_TIP);
    setIsDirty(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    // Bookable-rule mode: hydrate from caller-supplied proposal; no fetch.
    if (mode === "bookable-rule") {
      if (bookableInitial) {
        // Clone so RuleFormFields's onChange doesn't mutate the parent's row.
        const seeded: BookableLinkProposal = {
          ...bookableInitial,
          daysOfWeek: [...bookableInitial.daysOfWeek],
          ...(bookableInitial.guestPicks ? { guestPicks: { ...bookableInitial.guestPicks } } : {}),
        };
        setRuleProposal(seeded);
        setIsDirty(false);
        setSaveError(null);
      }
      setIsLoading(false);
      return;
    }

    if (initial) {
      seedForm(initial);
      setIsLoading(false);
      return;
    }

    // Fetch current values from the appropriate API.
    setIsLoading(true);

    const fetchPromise = mode === "primary"
      ? fetch("/api/me/scheduling-defaults").then((r) => r.ok ? r.json() : null).then((data) => {
          if (!data) return;
          const startMin = data.businessHoursStartMinutes ?? (data.businessHoursStart ?? 9) * 60;
          const endMin = data.businessHoursEndMinutes ?? (data.businessHoursEnd ?? 18) * 60;
          seedForm({
            availability: [{ days: [1, 2, 3, 4, 5], startMinutes: startMin, endMinutes: endMin }],
            defaultDuration: data.defaultDuration,
            bufferMinutes: data.bufferMinutes,
            format: data.defaultFormat,
            // 2026-05-10 punch-list #16: GET now returns tip; pass it through
            // so the modal pre-populates the host's saved tip rather than
            // always showing DEFAULT_TIP.
            tip: typeof data.tip === "string" ? data.tip : undefined,
          });
        })
      : linkId
        ? fetch(`/api/me/links/${linkId}/posture`).then((r) => r.ok ? r.json() : null).then((data) => {
            if (!data) return;
            // GET posture returns a ResolvedPosture — seed directly.
            seedForm(data);
          })
        : Promise.resolve();

    fetchPromise.catch(() => {}).finally(() => setIsLoading(false));
  }, [isOpen, mode, linkId, initial, bookableInitial, seedForm]);

  // ---- Dirty-aware change wrappers ----
  function changeDays(next: number[]) { setSimpleDays(next); setIsDirty(true); }
  function changeStart(v: number) { setSimpleStart(v); setIsDirty(true); }
  function changeEnd(v: number) { setSimpleEnd(v); setIsDirty(true); }
  function changeDuration(v: number) { setDuration(v); setIsDirty(true); }
  function changeBuffer(v: number) { setBufferMinutes(v); setIsDirty(true); }
  function changeFormat(v: FormatValue) { setFormat(v); setIsDirty(true); }
  function changeTip(v: string) { setTip(v); setIsDirty(true); }

  // ---- Advanced JSON sync ----
  function handleAdvancedJsonChange(val: string) {
    setIsDirty(true);
    setAdvancedJson(val);
    try {
      const parsed: unknown = JSON.parse(val);
      if (!Array.isArray(parsed)) {
        setAdvancedJsonError("Must be a JSON array.");
        return;
      }
      // Validate each window entry
      for (const w of parsed as unknown[]) {
        if (
          !w || typeof w !== "object" ||
          !Array.isArray((w as AvailabilityWindow).days) ||
          typeof (w as AvailabilityWindow).startMinutes !== "number" ||
          typeof (w as AvailabilityWindow).endMinutes !== "number"
        ) {
          setAdvancedJsonError("Each entry needs: days (array), startMinutes, endMinutes.");
          return;
        }
      }
      setAdvancedJsonError(null);
    } catch {
      setAdvancedJsonError("Invalid JSON.");
    }
  }

  // ---- Validation ----
  const simpleError = !advancedMode ? validateSimple(simpleDays, simpleStart, simpleEnd) : null;

  // Rule-mode validation: title non-empty AND at least one day selected.
  // Matches the legacy dialog's `canSave` gate at event-links-edit-dialog.tsx:120.
  const ruleError =
    mode === "bookable-rule" && ruleProposal
      ? ruleProposal.title.trim().length === 0
        ? "Title is required."
        : ruleProposal.daysOfWeek.length === 0
          ? "Choose at least one day."
          : null
      : null;

  const canSave =
    !isSaving &&
    isDirty &&
    (mode === "bookable-rule"
      ? !ruleError && ruleProposal != null
      : advancedMode
        ? !advancedJsonError
        : !simpleError);

  // ---- Rule-mode change wrapper ----
  function changeRuleProposal(next: BookableLinkProposal) {
    setRuleProposal(next);
    setIsDirty(true);
  }

  // ---- Save ----
  async function handleSave() {
    if (!canSave) return;
    setSaveError(null);
    setIsSaving(true);

    // Bookable-rule branch — route to the rule-edit endpoint that
    // EventLinksEditDialog used. Same payload shape; same backend.
    if (mode === "bookable-rule") {
      if (!ruleId || !ruleProposal) {
        setSaveError("Missing rule id.");
        setIsSaving(false);
        return;
      }
      try {
        const res = await fetch("/api/availability-rules/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ruleId,
            proposal: {
              title: ruleProposal.title,
              format: ruleProposal.format,
              durationMinutes: ruleProposal.durationMinutes,
              daysOfWeek: ruleProposal.daysOfWeek,
              timeStart: ruleProposal.timeStart,
              timeEnd: ruleProposal.timeEnd,
              effectiveDate: ruleProposal.effectiveDate,
              expiryDate: ruleProposal.expiryDate,
              ...(ruleProposal.guestPicks ? { guestPicks: ruleProposal.guestPicks } : {}),
            },
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? "Save failed");
        }
        onSaved?.();
        onClose();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : "Save failed");
      } finally {
        setIsSaving(false);
      }
      return;
    }

    let availability: AvailabilityWindow[];
    if (advancedMode) {
      try {
        availability = JSON.parse(advancedJson) as AvailabilityWindow[];
      } catch {
        setSaveError("Invalid JSON in availability.");
        setIsSaving(false);
        return;
      }
    } else {
      availability = simpleToWindows(simpleDays, simpleStart, simpleEnd);
    }

    try {
      if (mode === "primary") {
        // Primary writes to /api/me/scheduling-defaults using flat fields
        // (the canonical hour fields + duration/buffer/format).
        const startMin = Math.min(...availability.map((w) => w.startMinutes));
        const endMin = Math.max(...availability.map((w) => w.endMinutes));
        const res = await fetch("/api/me/scheduling-defaults", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessHoursStartMinutes: startMin,
            businessHoursEndMinutes: endMin,
            defaultDuration: duration,
            bufferMinutes,
            defaultFormat: format,
            tip: tip.trim() || null,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? "Save failed");
        }
      } else {
        // Variance link writes to PATCH /api/me/links/[id]/posture
        if (!linkId) throw new Error("linkId is required for link mode");
        const res = await fetch(`/api/me/links/${linkId}/posture`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ availability, duration, bufferMinutes, format, tip: tip.trim() || null }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? "Save failed");
        }
      }

      onSaved?.();
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-secondary border border-DEFAULT rounded-xl max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-DEFAULT">
          <h3 className="text-sm font-semibold text-primary">
            {mode === "primary"
              ? "Edit Primary Link"
              : mode === "bookable-rule"
                ? "Edit Bookable Link"
                : "Edit Link"}
          </h3>
          <button onClick={onClose} className="text-muted hover:text-secondary transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading…
          </div>
        ) : mode === "bookable-rule" ? (
          /* Bookable-rule body — reuses RuleFormFields so the editable fields
             are identical to what EventLinksEditDialog rendered (title, format,
             duration, days, time, effective/expiry dates, guestPicks). Save
             routes to POST /api/availability-rules/edit. */
          <div className="p-4 space-y-5">
            {ruleProposal ? (
              <RuleFormFields
                value={ruleProposal}
                onChange={changeRuleProposal}
                disabled={isSaving}
              />
            ) : (
              <p className="text-xs text-muted">No rule data provided.</p>
            )}

            {ruleError && (
              <p className="text-xs text-amber-400">{ruleError}</p>
            )}
            {saveError && (
              <p className="text-xs text-red-400">{saveError}</p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Save
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-muted hover:text-secondary border border-DEFAULT rounded-lg transition"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-5">
            {/* ---- Availability section ---- */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-primary uppercase tracking-wide">
                  Availability
                </label>
                <button
                  type="button"
                  onClick={() => setAdvancedMode((v) => !v)}
                  className="flex items-center gap-1 text-[10px] text-accent hover:underline"
                >
                  {advancedMode ? (
                    <><ChevronUp className="w-3 h-3" /> Simple</>
                  ) : (
                    <><ChevronDown className="w-3 h-3" /> Advanced</>
                  )}
                </button>
              </div>

              {advancedMode ? (
                /* Advanced: raw JSON */
                <div className="space-y-1">
                  <p className="text-[10px] text-muted">
                    Array of{" "}
                    <code className="bg-surface border border-DEFAULT rounded px-1 py-0.5">
                      {"{days, startMinutes, endMinutes}"}
                    </code>{" "}
                    objects. Days: 0=Sun … 6=Sat. Minutes: 0–1440.
                  </p>
                  <textarea
                    rows={6}
                    value={advancedJson}
                    onChange={(e) => handleAdvancedJsonChange(e.target.value)}
                    spellCheck={false}
                    className="w-full bg-surface border border-DEFAULT rounded-lg px-3 py-2 text-xs font-mono text-primary focus:outline-none focus:border-indigo-500 transition resize-y"
                  />
                  {advancedJsonError && (
                    <p className="text-xs text-amber-400">{advancedJsonError}</p>
                  )}
                </div>
              ) : (
                /* Simple: day chips + shared window */
                <div className="space-y-3">
                  {/* Day chips */}
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted">Days</span>
                    <div className="flex flex-wrap gap-1">
                      {DAY_NAMES_SHORT.map((name, i) => {
                        const active = simpleDays.includes(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              const next = active
                                ? simpleDays.filter((d) => d !== i)
                                : [...simpleDays, i].sort((a, b) => a - b);
                              changeDays(next);
                            }}
                            className={`px-2 py-1 rounded text-[11px] font-medium transition ${
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
                  {/* Time window */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-muted">Start time</label>
                      <select
                        value={simpleStart}
                        onChange={(e) => changeStart(Number(e.target.value))}
                        className="w-full bg-surface border border-DEFAULT rounded-lg px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-indigo-500 transition"
                      >
                        {MINUTE_OPTIONS.filter((m) => m < 1440).map((m) => (
                          <option key={m} value={m}>
                            {minutesToLabel(m)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted">End time</label>
                      <select
                        value={simpleEnd}
                        onChange={(e) => changeEnd(Number(e.target.value))}
                        className="w-full bg-surface border border-DEFAULT rounded-lg px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-indigo-500 transition"
                      >
                        {MINUTE_OPTIONS.filter((m) => m > 0).map((m) => (
                          <option key={m} value={m}>
                            {minutesToLabel(m)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {simpleError && (
                    <p className="text-xs text-amber-400">{simpleError}</p>
                  )}
                </div>
              )}
            </div>

            {/* ---- Duration ---- */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-primary uppercase tracking-wide">
                Duration
              </label>
              <select
                value={duration}
                onChange={(e) => changeDuration(Number(e.target.value))}
                className="w-full bg-surface border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
              >
                {DURATION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </select>
            </div>

            {/* ---- Buffer ---- */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-primary uppercase tracking-wide">
                Buffer
              </label>
              <select
                value={bufferMinutes}
                onChange={(e) => changeBuffer(Number(e.target.value))}
                className="w-full bg-surface border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition"
              >
                {BUFFER_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b === 0 ? "No buffer" : `${b} min`}
                  </option>
                ))}
              </select>
            </div>

            {/* ---- Format ---- */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-primary uppercase tracking-wide">
                Format
              </label>
              <div className="flex gap-2">
                {FORMAT_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => changeFormat(value)}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium border transition ${
                      format === value
                        ? "bg-accent text-white border-accent"
                        : "bg-surface border-DEFAULT text-muted hover:text-secondary"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ---- Welcome message / Tip ---- */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-primary uppercase tracking-wide">
                Welcome message
              </label>
              <textarea
                rows={3}
                value={tip}
                onChange={(e) => changeTip(e.target.value)}
                maxLength={280}
                placeholder={DEFAULT_TIP}
                className="w-full bg-surface border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-indigo-500 transition resize-y"
              />
              <div className="flex justify-between items-center">
                <p className="text-[10px] text-muted">
                  A short sentence guests see when they land on the page. Edit anytime.
                </p>
                <span
                  className={`text-[10px] tabular-nums ${
                    tip.length > 250 ? "text-amber-400" : "text-muted"
                  }`}
                >
                  {tip.length}/280
                </span>
              </div>
            </div>

            {/* ---- Error ---- */}
            {saveError && (
              <p className="text-xs text-red-400">{saveError}</p>
            )}

            {/* ---- Actions ---- */}
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Save
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-muted hover:text-secondary border border-DEFAULT rounded-lg transition"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
