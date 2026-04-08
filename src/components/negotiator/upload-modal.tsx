"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DocumentInfo {
  filename: string;
  charCount: number;
  truncated: boolean;
  preview: string; // first 200 chars
}

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onExtracted: (text: string, info: DocumentInfo) => void;
  disabled?: boolean;
}

const ACCEPT = ".pdf,.docx,.txt";
const MAX_SIZE = 5 * 1024 * 1024;

export function UploadModal({ open, onClose, onExtracted, disabled }: UploadModalProps) {
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const processFile = useCallback(
    async (file: File) => {
      setError(null);

      // Client-side size check
      if (file.size > MAX_SIZE) {
        setError("File exceeds the 5 MB limit.");
        return;
      }

      // Extension check
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (![".pdf", ".docx", ".txt"].includes(ext)) {
        setError(`Unsupported file type "${ext}". Use PDF, DOCX, or TXT.`);
        return;
      }

      setLoading(true);
      try {
        const form = new FormData();
        form.append("file", file);

        const res = await fetch("/api/negotiator/extract", {
          method: "POST",
          body: form,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? `Upload failed (${res.status}).`);
          return;
        }

        const data = await res.json();
        const info: DocumentInfo = {
          filename: data.filename,
          charCount: data.charCount,
          truncated: data.truncated,
          preview: data.text.slice(0, 200),
        };
        onExtracted(data.text, info);
      } catch {
        setError("Network error. Please try again.");
      } finally {
        setLoading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onExtracted]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-[var(--neg-text)]">
            Attach Reference Document
          </h3>
          <button
            onClick={onClose}
            disabled={loading}
            className="text-[var(--neg-text-muted)] hover:text-[var(--neg-text)] text-lg leading-none disabled:opacity-50"
          >
            &times;
          </button>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !loading && !disabled && inputRef.current?.click()}
          className={`
            border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition
            ${dragOver
              ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/5"
              : "border-[var(--neg-border)] hover:border-[var(--neg-accent)]/50"
            }
            ${loading || disabled ? "opacity-50 cursor-not-allowed" : ""}
          `}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            onChange={handleSelect}
            className="hidden"
            disabled={loading || disabled}
          />
          {loading ? (
            <p className="text-sm text-[var(--neg-text-muted)]">Extracting text...</p>
          ) : (
            <>
              <p className="text-sm text-[var(--neg-text)]">
                Drop a file here, or click to browse
              </p>
              <p className="text-xs text-[var(--neg-text-muted)] mt-2">
                PDF, DOCX, or TXT — max 5 MB
              </p>
            </>
          )}
        </div>

        <p className="text-xs text-[var(--neg-text-muted)] mt-3">
          Attach an RFP, proposal, brief, or any reference document. Agents will use it alongside your question.
        </p>

        {error && (
          <p className="text-xs text-red-600 mt-2">{error}</p>
        )}
      </div>
    </div>
  );
}
