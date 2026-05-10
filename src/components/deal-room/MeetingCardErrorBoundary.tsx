"use client";

/**
 * MeetingCardErrorBoundary — wraps MeetingCardConfirmedView so any client-side
 * exception in the new card surface falls back to the legacy event-card render
 * (passed in as `fallback`) instead of crashing the whole deal-room.
 *
 * Why this exists: 2026-05-10 production exception on agentenvoy.ai/meet/.../{code}
 * (the new MeetingCard render path threw client-side after a guest confirmed a
 * booking). Adding the boundary as belt-and-braces while we diagnose; it also
 * future-proofs against unexpected null shapes in confirmData/hostName/
 * googleCalendar etc.
 *
 * Logs the error to console so it's visible in browser devtools and any
 * connected error-tracking. No silent failures.
 */

import { Component, type ReactNode } from "react";

interface Props {
  /** Called once when an error is caught — parent should flip a state flag
   *  so subsequent renders fall through to the legacy path. */
  onError?: (error: Error) => void;
  /** Rendered while in the error state (before the parent unmounts the boundary). */
  fallback?: ReactNode;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class MeetingCardErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack?: string }) {
    // Log to browser console for diagnosis. The structured log makes it
    // easy to see the actual error message + component stack in devtools.
    console.error(
      "[MeetingCardErrorBoundary] crash in new card surface — falling back to legacy render",
      {
        error: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      }
    );
    this.props.onError?.(error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
