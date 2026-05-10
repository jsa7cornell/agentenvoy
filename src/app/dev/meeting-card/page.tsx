/**
 * /dev/meeting-card — MeetingCard component dev harness · R5+ visual spec
 *
 * Renders all MeetingCard sub-components against fixtures.ts.
 * Groups by state. Phone fixtures shown guest/host side-by-side
 * to demonstrate Design X asymmetry in one glance.
 * Desktop frame at the end shows chat-LEFT / card-RIGHT split layout.
 * GCal status states section at the end exercises § 3.14 CalendarRow variants.
 *
 * 404s in production. Server component — no "use client".
 * Pattern mirrors /dev/emails/page.tsx.
 *
 * 2026-05-09: Updated to R5+ lock spec. CalendarBlock → PickerHost.
 *             Added GCal status section. Header shows R5 logged-out/logged-in variants.
 */

import { notFound } from "next/navigation";
import { MeetingCard } from "@/components/MeetingCard/MeetingCard";
import { MeetingCardPickerHost } from "@/components/MeetingCard/MeetingCardPickerHost";
import { EnvoyDock } from "@/components/EnvoyDock/EnvoyDock";
import { SeriesPage } from "@/components/SeriesPage/SeriesPage";
import type { MeetingCardProps } from "@/components/MeetingCard/types";
import type { Message } from "@/components/MeetingCard/types";
import {
  singlePhoneGuest,
  singlePhoneHost,
  singleInPersonGuest,
  singleVideoGuest,
  singleVideoMatched,
  recurringConfirmedGuest,
  recurringSkippedGuest,
  anonymousProposal,
  proposalDisconnected,
  proposalConnected,
  desktopExample,
  singleGuestNoGCal,
  singleGuestPending,
  singleGuestAccepted,
  singleGuestTentative,
  singleGuestDeclined,
  singleHostView,
  seriesPageExample,
} from "./fixtures";

export default function MeetingCardDevPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const SAMPLE_MESSAGES: Message[] = [
    { id: "1", role: "agent", text: "You're set, Sarah. I'll be here if anything changes.", timestamp: "11:54 AM" },
    { id: "2", role: "guest", text: "Quick q — does John have a coffee preference if I'm getting there first?", timestamp: "12:01 PM" },
    { id: "3", role: "agent", text: "John usually does a cortado. I'll let him know to find you inside if you grab a table.", timestamp: "just now" },
  ];

  return (
    <div style={{ background: "#f6f3ec", minHeight: "100vh", padding: "48px 36px", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: "#1a1a2e" }}>

      {/* Page header */}
      <div style={{ marginBottom: "48px", maxWidth: "960px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 8px 0" }}>
          MeetingCard · dev harness — R5+ lock spec
        </h1>
        <p style={{ margin: "0 0 4px 0", color: "#6b6458", fontSize: "14px" }}>
          Visual spec:{" "}
          <code style={{ background: "#e8e3d8", padding: "2px 6px", borderRadius: "4px", fontSize: "12px" }}>
            previews/event-card-FINAL-portfolio.html
          </code>
          {" "}(canonical reference) ·{" "}
          <code style={{ background: "#e8e3d8", padding: "2px 6px", borderRadius: "4px", fontSize: "12px" }}>
            previews/gcal-integration-states.html
          </code>
          {" "}(§ 12 GCal states)
        </p>
        <p style={{ margin: 0, color: "#9b9480", fontSize: "12px" }}>
          PR1 lock alignment · R5+ · Rule 7 (text links) · § 3.14 (GCal row) · MeetingCardCalendarBlock → PickerHost rename
        </p>
      </div>

      {/* ── Section: Header variants ──────────────────────────────────────── */}
      <Section title="Header variants" description="R5 header — logged-out (brand + Log in) and logged-in (← Back + meeting label + user chip).">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", maxWidth: "960px" }}>
          {/* Logged out */}
          <div style={{ flex: "0 0 390px" }}>
            <FrameLabel label="Logged out" desc="Brand mark + Log in link" />
            <div style={{
              width: "390px",
              background: "#ffffff",
              border: "1px solid #e7e2d5",
              borderRadius: "10px",
              overflow: "hidden",
            }}>
              <LoggedOutHeader />
            </div>
          </div>
          {/* Logged in */}
          <div style={{ flex: "0 0 390px" }}>
            <FrameLabel label="Logged in" desc="← Back + meeting label + user chip" />
            <div style={{
              width: "390px",
              background: "#ffffff",
              border: "1px solid #e7e2d5",
              borderRadius: "10px",
              overflow: "hidden",
            }}>
              <LoggedInHeader meetingLabel="Intro Call with John" userFirstName="Sarah" />
            </div>
          </div>
        </div>
      </Section>

      {/* ── Section: Confirmed (single) ───────────────────────────────────── */}
      <Section title="Confirmed (single)" description="Single-session confirmed card. Guest + Host side-by-side to demonstrate Design X asymmetric phone copy. Rule 7: actions as indigo text links.">
        <div style={{ marginBottom: "16px" }}>
          <SectionNote>
            Phone · guest vs host · same ChannelInfo, different viewer-composed copy — Design X
          </SectionNote>
          <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
            <PhoneFrame label="Phone · Guest · Confirmed" desc="'John will call you at…' · text-link actions" props={singlePhoneGuest} dockMessages={SAMPLE_MESSAGES} dockState="resting" hostFirstName="John" />
            <PhoneFrame label="Phone · Host · Confirmed" desc="'Call Sarah at…' · host action set" props={singlePhoneHost} dockMessages={[]} dockState="resting" hostFirstName="John" />
          </div>
        </div>
      </Section>

      {/* ── Section: GCal status states ───────────────────────────────────── */}
      <Section title="GCal status states (§ 3.14 / § 12)" description="Six CalendarRow states + host view. Each shows the status row + correct calendar-action slot 1. Anti-pattern guard: ≤1 GCal CTA per card.">
        <div style={{ marginBottom: "8px" }}>
          <SectionNote>
            Guest states: No GCal → Add to calendar · Pending → Accept · Accepted → Open · Tentative → Confirm · Declined → Re-accept
          </SectionNote>
        </div>
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <PhoneFrame label="No GCal (Connect prompt)" desc="CalendarRow: 'Calendar not connected · Connect →'" props={singleGuestNoGCal} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Pending (needsAction)" desc="CalendarRow: amber pill · Slot 1: Accept in Google Calendar" props={singleGuestPending} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Accepted" desc="CalendarRow: emerald pill · Slot 1: Open in Google Calendar" props={singleGuestAccepted} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Tentative" desc="CalendarRow: amber pill · Slot 1: Confirm in Google Calendar" props={singleGuestTentative} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Declined" desc="CalendarRow: rose pill · Slot 1: Re-accept in Google Calendar" props={singleGuestDeclined} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Host view — guest pending (stale)" desc="CalendarRow: 'Sarah's RSVP · Awaiting response' + Nudge" props={singleHostView} dockMessages={[]} dockState="resting" hostFirstName="John" />
        </div>
      </Section>

      {/* ── Section: Confirmed (recurring) ───────────────────────────────── */}
      <Section title="Confirmed (recurring)" description="Recurring confirmed — session 11/24 · emerald accent · series text link + tip. Actions: Reschedule this · Skip this.">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <PhoneFrame label="Recurring · Video · Confirmed" desc="Session 11 of 24 — series text link · R5 actions" props={recurringConfirmedGuest} dockMessages={[]} dockState="resting" hostFirstName="John" />
        </div>
      </Section>

      {/* ── Section: Skipped ──────────────────────────────────────────────── */}
      <Section title="Skipped" description="Recurring session skipped — amber accent · 'Undo skip' as text link.">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <PhoneFrame label="Recurring · Skipped" desc="Amber accent · 'Undo skip' text link" props={recurringSkippedGuest} dockMessages={[]} dockState="resting" hostFirstName="John" />
        </div>
      </Section>

      {/* ── Section: Proposal ─────────────────────────────────────────────── */}
      <Section title="Proposal" description="No slot selected. PickerHost (renamed from CalendarBlock) shows disconnected and connected states.">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <PhoneFrame label="In-person · Calendar disconnected" desc="Connect bar" props={proposalDisconnected} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="In-person · Calendar connected" desc="Emerald bar" props={proposalConnected} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Video · Proposal + Tip" desc="Italic left-rule tip" props={singleVideoGuest} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="Anonymous · Video · Proposal" desc="No guest name" props={anonymousProposal} dockMessages={[]} dockState="resting" hostFirstName="John" />
          <PhoneFrame label="In-person · Proposal (no calendar)" desc="Baseline" props={singleInPersonGuest} dockMessages={[]} dockState="resting" hostFirstName="John" />
        </div>
      </Section>

      {/* ── Section: Matched ──────────────────────────────────────────────── */}
      <Section title="Matched" description="Calendar overlap found. Sky→indigo accent.">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <PhoneFrame label="Video · Matched" desc="Overlap found state" props={singleVideoMatched} dockMessages={[]} dockState="resting" hostFirstName="John" />
        </div>
      </Section>

      {/* ── Section: EnvoyDock states ─────────────────────────────────────── */}
      <Section title="EnvoyDock states" description="Dock isolated — resting (throb animation) and thread-expanded (340px) with sample messages.">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <PhoneFrame
            label="Dock · Resting · Confirmed"
            desc="42px avatar · throb · nudge copy"
            props={singlePhoneGuest}
            dockMessages={[]}
            dockState="resting"
            hostFirstName="John"
          />
          <PhoneFrame
            label="Dock · Thread expanded"
            desc="340px · message history · reply input"
            props={singlePhoneGuest}
            dockMessages={SAMPLE_MESSAGES}
            dockState="thread"
            hostFirstName="John"
          />
          <PhoneFrame
            label="Dock · Resting · Proposal"
            desc="'What time works best?' copy"
            props={singleInPersonGuest}
            dockMessages={[]}
            dockState="resting"
            hostFirstName="John"
          />
          <PhoneFrame
            label="Dock · Resting · Skipped"
            desc="'Session skipped' copy"
            props={recurringSkippedGuest}
            dockMessages={[]}
            dockState="resting"
            hostFirstName="John"
          />
        </div>
      </Section>

      {/* ── Section: MeetingCardPickerHost isolated ────────────────────────── */}
      <Section title="MeetingCardPickerHost · isolated" description="Calendar bar only — disconnected and connected states. Returns null for non-proposal states. (Renamed from MeetingCardCalendarBlock 2026-05-09.)">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", maxWidth: "960px" }}>
          <div style={{ flex: "0 0 340px" }}>
            <FrameLabel label="Disconnected" desc="Dashed style · 'Connect →'" />
            <div style={{ background: "#f6f3ec", padding: "12px 0", borderRadius: "10px", border: "1px solid #dbd5c4" }}>
              <MeetingCardPickerHost {...proposalDisconnected} />
            </div>
          </div>
          <div style={{ flex: "0 0 340px" }}>
            <FrameLabel label="Connected" desc="Emerald · email · checkmark" />
            <div style={{ background: "#f6f3ec", padding: "12px 0", borderRadius: "10px", border: "1px solid #dbd5c4" }}>
              <MeetingCardPickerHost {...proposalConnected} />
            </div>
          </div>
          <div style={{ flex: "0 0 340px" }}>
            <FrameLabel label="Confirmed state" desc="Returns null — not shown" />
            <div style={{ background: "#f6f3ec", padding: "12px", borderRadius: "10px", border: "1px solid #dbd5c4", minHeight: "60px", display: "flex", alignItems: "center" }}>
              <span style={{ color: "#9b9480", fontSize: "12px" }}>MeetingCardPickerHost returns null for confirmed state (correct)</span>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Section: Series page ──────────────────────────────────────────── */}
      <Section title="Series page" description="PR4 · Series page route · 390×820 mobile frame · header (eyebrow + title + cadence + 2 actions) + scrollable session list · all 4 status badges.">
        <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
          <SeriesPageFrame props={seriesPageExample} />
        </div>
      </Section>

      {/* ── Section: Desktop split layout ─────────────────────────────────── */}
      <Section title="Desktop · chat-LEFT / card-RIGHT split" description="1fr / 1.2fr grid · ~1100px wide. Agent panel left (persistent, no 'open chat' gesture). Card right. Per R4 desktop spec.">
        <DesktopFrame props={desktopExample} messages={SAMPLE_MESSAGES} hostFirstName="John" />
      </Section>

      <p style={{ marginTop: "64px", fontSize: "12px", color: "#c9c2ae", textAlign: "center" }}>
        /dev/meeting-card · R5+ lock spec · not available in production
      </p>
    </div>
  );
}

// ── Header variants ───────────────────────────────────────────────────────────

function LoggedOutHeader() {
  return (
    <div style={{
      height: "48px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 18px",
      borderBottom: "1px solid #e7e2d5",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        <div style={{ width: "22px", height: "22px", borderRadius: "6px", background: "linear-gradient(135deg,#6366f1,#a855f7)" }} />
        <span style={{ fontSize: "14px", fontWeight: 600, color: "#1a1a2e" }}>AgentEnvoy</span>
      </div>
      <a style={{ fontSize: "13px", fontWeight: 500, color: "#4f46e5", textDecoration: "none" }}>
        Log in
      </a>
    </div>
  );
}

function LoggedInHeader({ meetingLabel, userFirstName }: { meetingLabel: string; userFirstName: string }) {
  return (
    <div style={{
      height: "48px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 18px",
      borderBottom: "1px solid #e7e2d5",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <a style={{ fontSize: "13px", color: "#4f46e5", textDecoration: "none", fontWeight: 500 }}>← Back</a>
        <span style={{ color: "#c9c2ae" }}>·</span>
        <span style={{ fontSize: "13px", color: "#6b6458" }}>{meetingLabel}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        <div style={{
          width: "24px",
          height: "24px",
          borderRadius: "50%",
          background: "linear-gradient(135deg,#fbbf24,#f43f5e)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: "10px",
          fontWeight: 700,
        }}>
          {userFirstName[0].toUpperCase()}
        </div>
        <span style={{ fontSize: "13px", color: "#3f3f46", fontWeight: 500 }}>{userFirstName}</span>
      </div>
    </div>
  );
}

// ── Layout components ─────────────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "64px" }}>
      <h2 style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#059669", margin: "0 0 4px 0", borderTop: "1px solid #c9c2ae", paddingTop: "20px" }}>
        {title}
      </h2>
      <p style={{ margin: "0 0 20px 0", color: "#6b6458", fontSize: "13px" }}>{description}</p>
      {children}
    </div>
  );
}

function SectionNote({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: "0 0 12px 0", fontSize: "12px", color: "#9b9480", fontStyle: "italic" }}>{children}</p>
  );
}

function FrameLabel({ label, desc }: { label: string; desc?: string }) {
  return (
    <div style={{ marginBottom: "8px" }}>
      <div style={{ fontSize: "11px", fontWeight: 600, color: "#6b5fa0", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      {desc && <div style={{ fontSize: "11px", color: "#9b9480", marginTop: "2px" }}>{desc}</div>}
    </div>
  );
}

/**
 * PhoneFrame — 390×820 device shell with notch.
 * Shows R5 header (logged-in variant by default).
 * Renders MeetingCard + EnvoyDock stacked inside.
 */
function PhoneFrame({
  label,
  desc,
  props,
  dockMessages,
  dockState,
  hostFirstName,
}: {
  label: string;
  desc?: string;
  props: MeetingCardProps;
  dockMessages: Message[];
  dockState: "resting" | "thread";
  hostFirstName?: string;
}) {
  return (
    <div style={{ flexShrink: 0 }}>
      <FrameLabel label={label} desc={desc} />
      {/* Device shell */}
      <div style={{
        width: "390px",
        height: "820px",
        background: "#faf8f3",
        border: "1px solid #c9c2ae",
        borderRadius: "40px",
        overflow: "hidden",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,.18), 0 4px 16px rgba(0,0,0,.10)",
      }}>
        {/* Notch */}
        <div style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: "120px",
          height: "28px",
          background: "#0a0a0b",
          borderRadius: "0 0 18px 18px",
          zIndex: 5,
        }} />

        {/* Header — R5 logged-in variant */}
        <div style={{
          background: "#ffffff",
          borderBottom: "1px solid #e7e2d5",
          flexShrink: 0,
          paddingTop: "12px",
        }}>
          <div style={{
            height: "44px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "12px", color: "#4f46e5", fontWeight: 500 }}>← Back</span>
              <span style={{ color: "#c9c2ae", fontSize: "11px" }}>·</span>
              <span style={{ fontSize: "12px", color: "#6b6458" }}>{props.title}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div style={{
                width: "22px", height: "22px", borderRadius: "50%",
                background: "linear-gradient(135deg,#fbbf24,#f43f5e)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: "9px", fontWeight: 700,
              }}>
                {props.guest.firstName[0]}
              </div>
              <span style={{ fontSize: "11px", color: "#3f3f46", fontWeight: 500 }}>
                {props.guest.firstName}
              </span>
            </div>
          </div>
        </div>

        {/* Card area — scrollable, padded */}
        <div style={{ flex: 1, overflow: "hidden", padding: "0 18px 14px", position: "relative" }}>
          {/* Inner scroll area leaves room for dock */}
          <div style={{ paddingBottom: dockState === "thread" ? "340px" : "120px", overflowY: "auto", height: "100%" }}>
            <div style={{ paddingTop: "14px" }}>
              <MeetingCard {...props} />
            </div>
          </div>

          {/* Dock — absolute to device */}
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
            <EnvoyDock
              state={dockState}
              cardState={props.state === "confirming" ? "confirming" : props.state}
              contextHostFirstName={hostFirstName}
              messages={dockMessages}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * DesktopFrame — ~1100px × 780px browser-chrome shell.
 * chat-LEFT (agent panel) / card-RIGHT (MeetingCard).
 * Grid: 1fr / 1.2fr per R4 dt-body spec.
 */
function DesktopFrame({
  props,
  messages,
  hostFirstName,
}: {
  props: MeetingCardProps;
  messages: Message[];
  hostFirstName?: string;
}) {
  return (
    <div>
      <FrameLabel label="Desktop · 1fr / 1.2fr · chat-LEFT / card-RIGHT" desc="Agent panel always visible — no 'open chat' gesture" />
      {/* Browser shell */}
      <div style={{
        width: "1100px",
        height: "780px",
        background: "#faf8f3",
        border: "1px solid #c9c2ae",
        borderRadius: "14px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,.18), 0 4px 16px rgba(0,0,0,.10)",
      }}>
        {/* Browser chrome */}
        <div style={{
          height: "32px",
          background: "#ffffff",
          borderBottom: "1px solid #e7e2d5",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "0 14px",
          flexShrink: 0,
        }}>
          <div style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#d4d4d8" }} />
          <div style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#d4d4d8" }} />
          <div style={{ width: "11px", height: "11px", borderRadius: "50%", background: "#d4d4d8" }} />
          <div style={{ marginLeft: "18px", background: "#faf8f3", border: "1px solid #e7e2d5", borderRadius: "6px", padding: "4px 12px", fontSize: "11.5px", color: "#9b9480", flex: 1, maxWidth: "480px" }}>
            agentenvoy.ai/meet/john/intro-call
          </div>
        </div>

        {/* Body — grid: agent-left | card-right */}
        <div style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 1.2fr",
          gridTemplateAreas: '"agent card"',
          overflow: "hidden",
        }}>
          {/* LEFT — agent chat panel */}
          <div style={{
            gridArea: "agent",
            background: "linear-gradient(180deg,#f6f3ec 0%,#efebdf 100%)",
            borderRight: "1px solid #dbd5c4",
            display: "flex",
            flexDirection: "column",
            padding: "24px 24px 0",
            overflow: "hidden",
            position: "relative",
          }}>
            {/* Agent header */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
              <div style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                background: "linear-gradient(135deg,#6366f1,#a855f7)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontSize: "15px",
                fontWeight: 700,
                boxShadow: "0 4px 12px rgba(99,102,241,.35), 0 0 0 3px rgba(99,102,241,.14)",
                flexShrink: 0,
              }}>A</div>
              <div>
                <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.06em", color: "#6366f1", textTransform: "uppercase", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
                  AgentEnvoy
                </div>
                <div style={{ fontSize: "11px", color: "#9b9480", marginTop: "2px" }}>
                  Online · scheduling for {hostFirstName ?? "host"}
                </div>
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px", paddingBottom: "16px" }}>
              {messages.map((msg) => {
                const isGuest = msg.role === "guest";
                return (
                  <div key={msg.id} style={{ display: "flex", gap: "8px", alignItems: "flex-start", flexDirection: isGuest ? "row-reverse" : "row" }}>
                    <div style={{
                      width: "22px",
                      height: "22px",
                      borderRadius: "50%",
                      background: isGuest ? "linear-gradient(135deg,#fbbf24,#f43f5e)" : "linear-gradient(135deg,#6366f1,#a855f7)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#fff",
                      fontSize: "9.5px",
                      fontWeight: 700,
                      flexShrink: 0,
                      marginTop: "2px",
                    }}>
                      {isGuest ? "S" : "A"}
                    </div>
                    <div>
                      <div style={{
                        background: isGuest ? "#eef2ff" : "#faf8f3",
                        border: `1px solid ${isGuest ? "#c7d2fe" : "#e7e2d5"}`,
                        borderRadius: "13px",
                        padding: "8px 11px",
                        fontSize: "12.5px",
                        lineHeight: "1.45",
                        color: "#1a1a2e",
                        maxWidth: "240px",
                      }}>
                        {msg.text}
                      </div>
                      <div style={{ fontSize: "10px", color: "#c9c2ae", marginTop: "2px", padding: "0 4px", textAlign: isGuest ? "right" : "left" }}>
                        {msg.timestamp}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Input row */}
            <div style={{ borderTop: "1px solid #e7e2d5", padding: "10px 0 16px", display: "flex", gap: "8px", alignItems: "center" }}>
              <div style={{ flex: 1, background: "#faf8f3", border: "1px solid #e7e2d5", borderRadius: "18px", padding: "9px 13px", fontSize: "12.5px", color: "#9b9480" }}>
                Ask AgentEnvoy…
              </div>
              <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: "linear-gradient(180deg,#6366f1,#4f46e5)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", flexShrink: 0 }}>
                ↑
              </div>
            </div>
          </div>

          {/* RIGHT — MeetingCard */}
          <div style={{
            gridArea: "card",
            background: "linear-gradient(180deg,#f6f3ec 0%,#efebdf 100%)",
            padding: "36px 40px",
            overflow: "auto",
          }}>
            <MeetingCard {...props} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SeriesPage frame ──────────────────────────────────────────────────────────

import type { SeriesPageProps } from "@/components/MeetingCard/types";

/**
 * SeriesPageFrame — 390×820 mobile device shell rendering the SeriesPage.
 * No card chrome — the SeriesPage is its own dedicated surface.
 */
function SeriesPageFrame({ props }: { props: SeriesPageProps }) {
  return (
    <div style={{ flexShrink: 0 }}>
      <FrameLabel label="Series page · mobile frame" desc="390×820 · header + scrollable session list · all 4 statuses" />
      {/* Device shell */}
      <div style={{
        width: "390px",
        height: "820px",
        background: "#f6f3ec",
        border: "1px solid #c9c2ae",
        borderRadius: "40px",
        overflow: "hidden",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,.18), 0 4px 16px rgba(0,0,0,.10)",
      }}>
        {/* Notch */}
        <div style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          width: "120px",
          height: "28px",
          background: "#0a0a0b",
          borderRadius: "0 0 18px 18px",
          zIndex: 5,
        }} />

        {/* Header bar — logged-in with "← Back to event" */}
        <div style={{
          background: "#ffffff",
          borderBottom: "1px solid #e7e2d5",
          flexShrink: 0,
          paddingTop: "12px",
          zIndex: 4,
        }}>
          <div style={{
            height: "44px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "12px", color: "#4f46e5", fontWeight: 500 }}>← Back to event</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div style={{
                width: "22px", height: "22px", borderRadius: "50%",
                background: "linear-gradient(135deg,#fbbf24,#f43f5e)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: "9px", fontWeight: 700,
              }}>
                {props.guest.firstName[0]}
              </div>
              <span style={{ fontSize: "11px", color: "#3f3f46", fontWeight: 500 }}>
                {props.guest.firstName}
              </span>
            </div>
          </div>
        </div>

        {/* SeriesPage content — fills the rest of the shell */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <SeriesPage {...props} />
        </div>
      </div>
    </div>
  );
}
