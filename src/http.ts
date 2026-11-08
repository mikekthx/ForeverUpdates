import { FETCH_TIMEOUT_MS, USER_AGENT } from "./config";

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function getJson(url: string): Promise<any> {
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const type = res.headers.get("content-type") ?? "";
  // A bot-challenge page comes back as HTML with 200; report it instead of crashing on JSON.parse.
  if (!type.includes("json")) throw new Error(`Expected JSON from ${url}, got "${type}"`);
  return res.json();
}

export async function getHtml(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
