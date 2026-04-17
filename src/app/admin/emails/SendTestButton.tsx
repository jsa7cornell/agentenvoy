"use client";

import { useState } from "react";

export function SendTestButton({ templateId }: { templateId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [detail, setDetail] = useState("");

  async function send() {
    setState("sending");
    try {
      const res = await fetch("/api/admin/send-test-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState("error");
        setDetail(data.error || "Request failed");
      } else {
        setState("sent");
        setDetail(`status: ${data.status} → ${data.to}`);
      }
    } catch (e) {
      setState("error");
      setDetail(e instanceof Error ? e.message : "Unknown error");
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <button
        onClick={send}
        disabled={state === "sending"}
        style={{
          padding: "6px 14px",
          background: state === "sent" ? "#00b894" : state === "error" ? "#d63031" : "#6c5ce7",
          color: "#fff",
          border: "none",
          borderRadius: "6px",
          fontSize: "12px",
          fontWeight: 600,
          cursor: state === "sending" ? "wait" : "pointer",
          opacity: state === "sending" ? 0.7 : 1,
        }}
      >
        {state === "sending" ? "Sending…" : state === "sent" ? "Sent ✓" : state === "error" ? "Error ✗" : "Send test email"}
      </button>
      {detail && (
        <span style={{ fontSize: "11px", color: state === "error" ? "#d63031" : "#666" }}>
          {detail}
        </span>
      )}
    </div>
  );
}
