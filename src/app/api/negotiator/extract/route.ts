import { NextRequest } from "next/server";
import { extractDocument } from "@/lib/negotiator/document-extract";

export const maxDuration = 30;

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const STATUS_MAP: Record<string, number> = {
  UNSUPPORTED_TYPE: 415,
  FILE_TOO_LARGE: 413,
  SCANNED_PDF: 422,
  PASSWORD_PROTECTED: 422,
  CORRUPTED: 422,
  EMPTY: 422,
};

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Expected multipart form data." } },
      { status: 400 }
    );
  }

  const entry = formData.get("file");
  if (!entry || typeof entry === "string") {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "No file provided." } },
      { status: 400 }
    );
  }

  const file = entry as File;

  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: { code: "FILE_TOO_LARGE", message: "File exceeds the 5 MB limit." } },
      { status: 413 }
    );
  }

  const outcome = await extractDocument(file);

  if (!outcome.ok) {
    const status = STATUS_MAP[outcome.error.code] ?? 422;
    return Response.json({ error: outcome.error }, { status });
  }

  return Response.json(outcome.result);
}
