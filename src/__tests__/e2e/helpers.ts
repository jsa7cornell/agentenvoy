const BASE = "http://localhost:3000";
const API_KEY = "ae_test_key_e2e";
const HOST_SLUG = "testhost";
const CTX_CODE = "test-ctx-001";

export { BASE, API_KEY, HOST_SLUG, CTX_CODE };

/** POST JSON to an endpoint, return parsed response + status */
export async function post(
  path: string,
  body: Record<string, unknown>,
  options?: { bearer?: string }
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.bearer) {
    headers["Authorization"] = `Bearer ${options.bearer}`;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

/** GET with optional bearer token */
export async function get(
  path: string,
  options?: { bearer?: string }
) {
  const headers: Record<string, string> = {};
  if (options?.bearer) {
    headers["Authorization"] = `Bearer ${options.bearer}`;
  }
  const res = await fetch(`${BASE}${path}`, { headers });
  const data = await res.json();
  return { status: res.status, data };
}

/** POST to message endpoint — returns raw response (streaming) as text */
export async function sendMessage(sessionId: string, content: string) {
  const res = await fetch(`${BASE}/api/negotiate/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, content }),
  });
  const text = await res.text();
  return { status: res.status, text };
}
