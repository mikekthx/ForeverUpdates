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

export async function getHtml(url: string, hops = 2): Promise<string> {
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
  if (res.ok) return res.text();
  // Blizzard's news site (Next.js) answers a renamed article's old URL (its title, so its slug,
  // changed) with a 307 that has no Location header: the new path is only in the page, as
  // NEXT_REDIRECT;replace;<path>;307, which a browser follows in JavaScript. Followed here, same site only.
  if (res.status >= 300 && res.status < 400 && !res.headers.get("location") && hops > 0) {
    const path = (await res.text()).match(/NEXT_REDIRECT;(?:replace|push);((?:https:\/\/[^/;"\\\s]+)?\/[^;"\\\s]+);30[1278]/)?.[1];
    let next: URL | null = null;
    try { next = path ? new URL(path, url) : null; } catch { /* malformed: not followed */ }
    if (next && next.origin === new URL(url).origin && next.href !== url) return getHtml(next.href, hops - 1);
  }
  throw new Error(`HTTP ${res.status} from ${url}`);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
