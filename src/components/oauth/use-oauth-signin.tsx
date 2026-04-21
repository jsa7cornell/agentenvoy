"use client";

import { useState, type ReactNode } from "react";
import { signIn } from "next-auth/react";
import { PreConsentExplainer, type PreConsentMode } from "./pre-consent-explainer";
import {
  ENTRY_POINT_COOKIE,
  HOST_REQUIRED_FRONT_DOOR,
  HOST_REQUIRED_FROM_DEAL_ROOM,
  type HostEntryPoint,
} from "@/lib/oauth/required-scopes";

interface Options {
  mode: PreConsentMode;
  callbackUrl?: string;
  /**
   * Where the user is signing in *from*. Determines the scope set requested:
   *   - "front-door" (default) → read + write upfront
   *   - "deal-room"            → read only
   * The signIn callback reads a short-lived cookie set here to audit grants
   * against the right expected set.
   */
  entryPoint?: HostEntryPoint;
  /**
   * Extra params forwarded to NextAuth signIn (e.g. `prompt: "consent"` for
   * scope upgrades that need to force the consent screen).
   */
  signInParams?: Record<string, string>;
}

interface Result {
  /** Click handler — opens the explainer modal. */
  trigger: () => void;
  /** Mount once in the same component scope; renders the modal when open. */
  modal: ReactNode;
}

/**
 * Wraps Google signIn with a pre-consent explainer step.
 *
 * Usage:
 *   const { trigger, modal } = useOAuthSignIn({ mode: "first-connect", callbackUrl: "/dashboard" });
 *   return <>
 *     <button onClick={trigger}>Sign in with Google</button>
 *     {modal}
 *   </>;
 *
 * The modal handles its own open/close state. `trigger` is what the visible
 * CTA wires up. Cancel closes the modal without calling signIn.
 */
export function useOAuthSignIn({
  mode,
  callbackUrl,
  entryPoint = "front-door",
  signInParams,
}: Options): Result {
  const [open, setOpen] = useState(false);
  const trigger = () => setOpen(true);
  const onCancel = () => setOpen(false);
  const onConfirm = () => {
    setOpen(false);
    // Tell the signIn server callback how this user entered, so it audits
    // the granted scopes against the right expected set. 5-min Max-Age so
    // a stale value can't poison a later sign-in. SameSite=Lax so it
    // survives the Google OAuth redirect round-trip.
    if (typeof document !== "undefined") {
      document.cookie = `${ENTRY_POINT_COOKIE}=${entryPoint}; Path=/; Max-Age=300; SameSite=Lax`;
    }
    const scope = (
      entryPoint === "deal-room"
        ? HOST_REQUIRED_FROM_DEAL_ROOM
        : HOST_REQUIRED_FRONT_DOOR
    ).join(" ");
    signIn("google", { callbackUrl, ...signInParams, scope });
  };
  const modal = (
    <PreConsentExplainer open={open} mode={mode} onConfirm={onConfirm} onCancel={onCancel} />
  );
  return { trigger, modal };
}
