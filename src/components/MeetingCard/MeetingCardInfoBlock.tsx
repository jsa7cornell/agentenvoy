"use client";

/**
 * MeetingCardInfoBlock — title, who-row, channel-line, agenda/tip, series row, GCal row.
 *
 * R5 changes:
 *  - Tip slot: italic line with left-rule (pl-3 border-l-2 border-stone-200 italic).
 *    No green box. No source label in Phase 1 per B1.
 *  - Channel URL: always visible (no "See call info" toggle for video).
 *    Inline indigo URL link.
 *  - Series row: Google-style indigo text link + sub-line "Next session is..."
 *  - MeetingCardCalendarRow renders below channel/series rows.
 *
 * PR2 SEED: host pencil-edit affordance on tip block. See onEditTip in types.ts.
 *
 * Design X: phone copy composed from role-agnostic signals.
 * Visual spec: previews/event-card-FINAL-portfolio.html
 */

import { useState } from "react";
import type {
  MeetingCardProps,
  ChannelInfo,
  ViewerRole,
  Participant,
  SeriesInfo,
} from "./types";
import { MeetingCardCalendarRow } from "./MeetingCardCalendarRow";

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({
  participant,
  role,
  overlap = false,
}: {
  participant: Participant;
  role: "host" | "guest";
  overlap?: boolean;
}) {
  const initial = participant.firstName[0].toUpperCase();
  const gradient =
    role === "host"
      ? "linear-gradient(135deg, #a78bfa, #6366f1)"
      : "linear-gradient(135deg, #fbbf24, #f43f5e)";

  return (
    <div
      className="w-[26px] h-[26px] rounded-full border-2 border-white flex items-center justify-center text-[10.5px] font-semibold text-white flex-shrink-0"
      style={{
        background: gradient,
        boxShadow: "0 1px 2px rgba(24,24,27,.04)",
        marginLeft: overlap ? "-9px" : undefined,
      }}
      title={`${participant.firstName}${participant.lastName ? " " + participant.lastName : ""}`}
    >
      {initial}
    </div>
  );
}

// ── Channel line (R5: URL always visible, no toggle) ──────────────────────────

function ChannelLine({
  channel,
  viewerRole,
  host,
  guest,
}: {
  channel: ChannelInfo;
  viewerRole: ViewerRole;
  host: Participant;
  guest: Participant;
}) {
  if (channel.kind === "in-person") {
    const parts = channel.location.split("·");
    const name = parts[0].trim();
    const address = parts.slice(1).join("·").trim();
    return (
      <div className="flex items-start gap-[9px] text-[13px] text-zinc-600 pt-2">
        <span className="text-[14px] w-5 text-center flex-shrink-0 text-zinc-400 leading-[1.45]">
          📍
        </span>
        <div className="flex-1 min-w-0 leading-[1.45]">
          {name && <b className="text-zinc-700 font-semibold">{name}</b>}
          {address && ` · ${address}`}
        </div>
      </div>
    );
  }

  if (channel.kind === "phone") {
    const { phoneNumber } = channel;
    let copy: React.ReactNode;
    if (viewerRole === "guest") {
      copy = (
        <>
          <b className="text-zinc-700 font-semibold">{host.firstName}</b> will
          call you at {phoneNumber}
        </>
      );
    } else {
      copy = (
        <>
          Call{" "}
          <b className="text-zinc-700 font-semibold">{guest.firstName}</b> at{" "}
          {phoneNumber}
        </>
      );
    }
    return (
      <div className="flex items-start gap-[9px] text-[13px] text-zinc-600 pt-2">
        <span className="text-[14px] w-5 text-center flex-shrink-0 text-zinc-400 leading-[1.45]">
          📞
        </span>
        <div className="flex-1 min-w-0 leading-[1.45]">{copy}</div>
      </div>
    );
  }

  // video — R5: URL always visible (no toggle)
  return (
    <div className="flex items-start gap-[9px] text-[13px] text-zinc-600 pt-2">
      <span className="text-[14px] w-5 text-center flex-shrink-0 text-zinc-400 leading-[1.45]">
        🎥
      </span>
      <div className="flex-1 min-w-0 leading-[1.45]">
        <b className="text-zinc-700 font-semibold">{channel.platform}</b>
        {channel.joinUrl && (
          <>
            {" · "}
            <a
              href={channel.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium"
              style={{ color: "#4f46e5" }}
            >
              {channel.joinUrl}
            </a>
          </>
        )}
        {!channel.joinUrl && (
          <span className="text-zinc-400"> — link in your calendar invite</span>
        )}
      </div>
    </div>
  );
}

// ── Series row (R5: Google-style text link + sub-line) ────────────────────────

function SeriesRow({ series }: { series: SeriesInfo }) {
  const nextDate = series.nextSessionDate
    ? new Date(series.nextSessionDate).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div className="flex items-start gap-[9px] text-[13px] text-zinc-600 pt-2">
      <span className="text-[14px] w-5 text-center flex-shrink-0 text-zinc-400 leading-[1.45]">
        🔁
      </span>
      <div className="flex-1 min-w-0 leading-[1.45]">
        <a
          href={series.seriesUrl ?? "#"}
          className="font-medium"
          style={{ color: "#4f46e5" }}
        >
          {series.cadence}
        </a>
        {nextDate && (
          <div className="text-[11.5px] text-zinc-400 mt-[1px]">
            Next session is {nextDate}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tip / agenda (R5: italic left-rule, no green box) ────────────────────────

/**
 * AgendaTip — renders the tip text with an optional host-edit pencil affordance.
 *
 * PR2 SEED: when viewerRole === "host" AND onEditTip is provided, a pencil
 * icon renders at right edge. Clicking enters edit mode (textarea + Save/Cancel).
 * When tip is absent and onEditTip is provided, shows an "Add a tip…" affordance.
 *
 * AP5b: data-testid="meeting-card-tip-edit" for E2E discoverability.
 */
function AgendaTip({
  text,
  viewerRole,
  onEditTip,
}: {
  text?: string;
  viewerRole: ViewerRole;
  onEditTip?: (newText: string) => Promise<void> | void;
}) {
  type EditState = "read" | "edit" | "saving";
  const [editState, setEditState] = useState<EditState>("read");
  const [draftText, setDraftText] = useState(text ?? "");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const isHost = viewerRole === "host";
  const showEdit = isHost && !!onEditTip;

  // If nothing to show and not a host with edit permissions, render nothing
  if (!text && !showEdit) return null;

  const handleSave = async () => {
    if (!onEditTip) return;
    setEditState("saving");
    setErrorMsg(null);
    try {
      await onEditTip(draftText);
      setEditState("read");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch {
      setEditState("edit");
      setErrorMsg("Couldn't save — try again.");
    }
  };

  const handleCancel = () => {
    setDraftText(text ?? "");
    setEditState("read");
    setErrorMsg(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSave();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  if (editState === "edit" || editState === "saving") {
    return (
      <div
        className="pl-3 border-l-2 border-indigo-300 mt-3"
        data-testid="meeting-card-tip-edit"
      >
        <textarea
          className="w-full text-[12.5px] text-zinc-600 italic resize-none border border-zinc-200 rounded px-2 py-1 focus:outline-none focus:border-indigo-400 leading-[1.55] bg-white"
          rows={3}
          maxLength={1000}
          value={draftText}
          disabled={editState === "saving"}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          placeholder="Add a tip for your guest…"
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            className="text-[11px] font-medium text-white bg-indigo-500 hover:bg-indigo-600 px-2.5 py-0.5 rounded disabled:opacity-50"
            onClick={void handleSave}
            disabled={editState === "saving"}
          >
            {editState === "saving" ? "Saving…" : "Save"}
          </button>
          <button
            className="text-[11px] font-medium text-zinc-500 hover:text-zinc-700"
            onClick={handleCancel}
            disabled={editState === "saving"}
          >
            Cancel
          </button>
          <span className="text-[10.5px] text-zinc-400 ml-1">⌘+Enter to save · Esc to cancel</span>
        </div>
        {errorMsg && (
          <p className="text-[11px] text-red-500 mt-1">{errorMsg}</p>
        )}
      </div>
    );
  }

  // Read mode
  if (!text) {
    // Host with no tip yet — "Add a tip…" affordance
    return (
      <div
        className="pl-3 border-l-2 border-stone-200 mt-3 cursor-pointer"
        data-testid="meeting-card-tip-edit"
        onClick={() => {
          setDraftText("");
          setEditState("edit");
        }}
      >
        <span className="text-[12.5px] text-zinc-400 italic">Add a tip for your guest…</span>
      </div>
    );
  }

  return (
    <div
      className="pl-3 border-l-2 border-stone-200 mt-3 group relative"
      data-testid={showEdit ? "meeting-card-tip-edit" : undefined}
    >
      <p className="italic text-[12.5px] text-zinc-500 leading-[1.55] mb-0 m-0 pr-6">
        {text}
        {savedFlash && <span className="ml-1.5 text-emerald-500 not-italic">✓</span>}
      </p>
      {showEdit && (
        <button
          className="absolute right-0 top-0 opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer text-indigo-500 text-[14px]"
          title="Edit tip"
          onClick={() => {
            setDraftText(text);
            setEditState("edit");
          }}
          aria-label="Edit tip"
        >
          ✏️
        </button>
      )}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MeetingCardInfoBlock(props: MeetingCardProps) {
  const {
    host,
    guest,
    title,
    channel,
    tip,
    viewerRole,
    series,
    googleCalendar,
    onNudgeOther,
    onEditTip,
  } = props;

  const hostFullName = [host.firstName, host.lastName].filter(Boolean).join(" ");
  const guestFullName = [guest.firstName, guest.lastName].filter(Boolean).join(" ");

  // SeriesInfo now includes optional nextSessionDate + seriesUrl (added for R5 series row).
  // Both fields are optional — existing fixtures without them render gracefully.
  const seriesForRow = series;

  return (
    <div data-testid="meeting-card-info">
      <div className="px-[22px] pt-[18px] pb-3">
        {/* Who row */}
        <div className="flex items-center gap-[10px] mb-2" data-testid="meeting-participants">
          <div className="flex items-center">
            <Avatar participant={host} role="host" />
            <Avatar participant={guest} role="guest" overlap />
          </div>
          <div className="text-[12px] text-zinc-400 font-medium">
            <b className="text-zinc-600 font-semibold" data-meeting-host>{hostFullName}</b>
            {" & "}
            <b className="text-zinc-600 font-semibold" data-meeting-guest>{guestFullName}</b>
          </div>
        </div>

        {/* Title — semantic h3 so screen readers + agents identify the meeting subject */}
        <h3 className="text-[18px] font-semibold text-zinc-900 tracking-[-0.008em] leading-[1.3] mb-2 m-0" data-meeting-title>
          {title}
        </h3>

        {/* Channel line */}
        <ChannelLine
          channel={channel}
          viewerRole={viewerRole}
          host={host}
          guest={guest}
        />

        {/* Series row — recurring only */}
        {seriesForRow && (
          <SeriesRow series={seriesForRow} />
        )}

        {/* GCal row — registered viewers only (anonymous → null) */}
        <MeetingCardCalendarRow
          googleCalendar={googleCalendar}
          viewerRole={viewerRole}
          guest={guest}
          onNudgeOther={onNudgeOther}
        />

        {/* Agenda / tip — italic left-rule per R5 (no green box) */}
        {/* PR2 SEED: host sees pencil affordance; guest sees read-only or nothing */}
        {(tip?.text || (viewerRole === "host" && onEditTip)) && (
          <AgendaTip
            text={tip?.text}
            viewerRole={viewerRole}
            onEditTip={onEditTip}
          />
        )}
      </div>
    </div>
  );
}
