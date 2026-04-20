"use client";

import { useState, type ReactNode } from "react";
import { signIn } from "next-auth/react";
import { PreConsentExplainer, type PreConsentMode } from "./pre-consent-explainer";

interface Options {
  mode: PreConsentMode;
  callbackUrl?: string;
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
export function useOAuthSignIn({ mode, callbackUrl, signInParams }: Options): Result {
  const [open, setOpen] = useState(false);
  const trigger = () => setOpen(true);
  const onCancel = () => setOpen(false);
  const onConfirm = () => {
    setOpen(false);
    signIn("google", { callbackUrl, ...signInParams });
  };
  const modal = (
    <PreConsentExplainer open={open} mode={mode} onConfirm={onConfirm} onCancel={onCancel} />
  );
  return { trigger, modal };
}
