import "server-only";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_CHARS = 20_000;

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx", ".txt"]);

export interface ExtractResult {
  text: string;
  filename: string;
  charCount: number;
  truncated: boolean;
}

export type ExtractErrorCode =
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "SCANNED_PDF"
  | "PASSWORD_PROTECTED"
  | "CORRUPTED"
  | "EMPTY";

type ExtractSuccess = { ok: true; result: ExtractResult };
type ExtractFailure = { ok: false; error: { code: ExtractErrorCode; message: string } };
export type ExtractOutcome = ExtractSuccess | ExtractFailure;

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export async function extractDocument(file: File): Promise<ExtractOutcome> {
  const ext = getExtension(file.name);

  // Extension check first (MIME can be empty on drag-drop)
  if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_MIMES.has(file.type)) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_TYPE",
        message: `Unsupported file type "${ext || file.type}". Use PDF, DOCX, or TXT.`,
      },
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: {
        code: "FILE_TOO_LARGE",
        message: "File exceeds the 5 MB limit.",
      },
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let rawText = "";

  try {
    if (ext === ".pdf" || file.type === "application/pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      rawText = result.text;
      await parser.destroy();
    } else if (
      ext === ".docx" ||
      file.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      rawText = result.value;
    } else {
      rawText = buffer.toString("utf-8");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (msg.includes("password") || msg.includes("encrypted")) {
      return {
        ok: false,
        error: {
          code: "PASSWORD_PROTECTED",
          message: "This PDF is password-protected. Please remove the password and try again.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "CORRUPTED",
        message: "Could not read this file. It may be corrupted.",
      },
    };
  }

  // Strip pdf-parse v2 page markers ("-- 1 of 5 --") before checking for content
  const trimmed = rawText.replace(/--\s*\d+\s+of\s+\d+\s*--/g, "").trim();
  if (!trimmed) {
    const isPdf = ext === ".pdf" || file.type === "application/pdf";
    return {
      ok: false,
      error: {
        code: isPdf ? "SCANNED_PDF" : "EMPTY",
        message: isPdf
          ? "This PDF appears to be scanned (image-only). Text-based PDFs are required."
          : "The file contains no readable text.",
      },
    };
  }

  const truncated = trimmed.length > MAX_CHARS;
  const text = truncated ? trimmed.slice(0, MAX_CHARS) : trimmed;

  return {
    ok: true,
    result: {
      text,
      filename: file.name,
      charCount: text.length,
      truncated,
    },
  };
}
