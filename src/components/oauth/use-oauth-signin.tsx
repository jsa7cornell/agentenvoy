"use client";

import { useState, type ReactNode } from "react";
import { signIn } from "next-auth/react";
import { PreConsentExplainer, type PreConsentMode } from "./pre-consent-explainer";
import {
  ENTRY_POINT_COOKIE,
  HOST_REQUIRED_FRONT_DOOR,
  HOST_REQUIRED_FROM_DEAL_ROOM,
  HOST_REQUIRED_FROM_UPSELL,
  type HostEntryPoint,
} from "@/lib/oauth/required-scopes";

interface Options {
  mode: PreConsentMode;
  callbackUrl?: string;
  /**
   * Where the user is signing in *from*. Determines the scope set requested
   * and which audit set the signIn callback checks against:
   *   - "front-door"       (default) → read + write upfront
   *   - "deal-room"                  → read only
   *   - "deal-room-upsell"           → read only (post-booking signup)
   */
  entryPoint?: HostEntryPoint;
  /**
   * Extra params forwarded to NextAuth signIn. Leave empty unless a CTA has
   * a reason to override `promptForMode` (effectively never — the mode
   * already encodes the right prompt choice).
   */
  signInParams?: Record<string, string>;
}

interface Result {
  /** Click handler — opens the explainer modal, or short-circuits to signIn
   *  for a returning user on `mode: "login"`. */
  trigger: () => void;
  /** Mount once in the same component scope; renders the modal when open. */
  modal: ReactNode;
}

/** Cookie set on onboarding completion. Presence = "this is a returning user,
 *  skip the first-connect modal and use prompt=select_account." Absence on
 *  `mode: "login"` implies first-time-visitor and shows the trust modal. */
const RETURNING_COOKIE = "ae_returning";

/**
 * Google's `prompt` parameter, chosen per mode.
 *
 *   "consent"        → re-show the consent screen, re-issue a refresh_token.
 *                      Used when we genuinely need a fresh grant: first
 *                      connect, reconnect (tokens expired), scope upgrade.
 *   "select_account" → let user pick an account; do NOT force consent, do
 *                      NOT re-issue a refresh_token. Used for returning
 *                      users signing in on a surface that already has their
 *                      consent.
 *
 * Forcing "consent" on every sign-in was bug 1i — it invalidated the
 * previous refresh_token on every login. The guard
 * `account.refresh_token ?? undefined` in the signIn callback makes
 * "select_account" safe (we don't overwrite an existing refresh_token with
 * undefined).
 */
function promptForMode(mode: PreConsentMode, isReturning: boolean): string {
  if (mode === "login" && isReturning) return "select_account";
  return "consent";
}

export function hasReturningCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) => {
    const [name, value] = c.trim().split("=");
    return name === RETURNING_COOKIE && value === "1";
  });
}

function scopeFor(entryPoint: HostEntryPoint): string {
  const set =
    entryPoint === "deal-room"
      ? HOST_REQUIRED_FROM_DEAL_ROOM
      : entryPoint === "deal-room-upsell"
        ? HOST_REQUIRED_FROM_UPSELL
        : HOST_REQUIRED_FRONT_DOOR;
  return set.join(" ");
}

/**
 * Wraps Google signIn with a pre-consent explainer step.
 *
 * Returning-user shortcut: when `mode: "login"` and the `ae_returning`
 * cookie is present, `trigger` skips the modal and goes straight to Google
 * with `prompt: "select_account"`. First-timers (cookie absent) still see
 * the first-connect trust modal.
 */
export function useOAuthSignIn({
  mode,
  callbackUrl,
  entryPoint = "front-door",
  signInParams,
}: Options): Result {
  const [open, setOpen] = useState(false);

  const doSignIn = () => {
    const isReturning = hasReturningCookie();
    // Tell the signIn server callback how this user entered, so it audits
    // the granted scopes against the right expected set. 5-min Max-Age so
    // a stale value can't poison a later sign-in. SameSite=Lax so it
    // survives the Google OAuth redirect round-trip.
    if (typeof document !== "undefined") {
      document.cookie = `${ENTRY_POINT_COOKIE}=${entryPoint}; Path=/; Max-Age=300; SameSite=Lax`;
    }
    const prompt = promptForMode(mode, isReturning);
    // NextAuth v4: 2nd arg is signIn options (callbackUrl, redirect…); the
    // 3rd arg is `authorizationParams`, forwarded to Google's authorize URL.
    signIn(
      "google",
      { callbackUrl },
      { scope: scopeFor(entryPoint), prompt, access_type: "offline", ...signInParams },
    );
  };

  const trigger = () => {
    // Returning-user shortcut: skip the pre-consent modal entirely. The
    // first-connect trust copy isn't useful on their second visit.
    if (mode === "login" && hasReturningCookie()) {
      doSignIn();
      return;
    }
    setOpen(true);
  };
  const onCancel = () => setOpen(false);
  const onConfirm = () => {
    setOpen(false);
    doSignIn();
  };
  // Login mode: sign-in view primary action — select_account, no forced consent.
  const onSignIn = mode === "login" ? () => {
    setOpen(false);
    if (typeof document !== "undefined") {
      document.cookie = `${ENTRY_POINT_COOKIE}=${entryPoint}; Path=/; Max-Age=300; SameSite=Lax`;
    }
    signIn("google", { callbackUrl }, { scope: scopeFor(entryPoint), prompt: "select_account", access_type: "offline", ...signInParams });
  } : undefined;
  const modal = (
    <PreConsentExplainer open={open} mode={mode} onConfirm={onConfirm} onCancel={onCancel} onSignIn={onSignIn} />
  );
  return { trigger, modal };
}
