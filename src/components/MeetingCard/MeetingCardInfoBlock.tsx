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
 * Design X: phone copy composed from role-agnostic signals.
 * Visual spec: previews/event-card-FINAL-portfolio.html
 */

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

function AgendaTip({ text }: { text: string }) {
  return (
    <p className="pl-3 border-l-2 border-stone-200 italic text-[12.5px] text-zinc-500 leading-[1.55] mt-3 mb-0">
      {text}
    </p>
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
        {tip && tip.text && <AgendaTip text={tip.text} />}
      </div>
    </div>
  );
}
