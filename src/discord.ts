/** Sending to Discord. Payload builders live in lib/discord.ts. */

import { fetchWithTimeout } from "./http";
import { clip } from "./lib/text";

export class DiscordError extends Error {
  /** status: the HTTP status Discord (or a proxy in front of it) answered with. */
  constructor(message: string, readonly retryAfterSec: number | null, readonly status: number) { super(message); }
  /** A 4xx means Discord refused the message; after a 5xx or a 408 timeout it may still have been posted. */
  get refused(): boolean { return this.status >= 400 && this.status < 500 && this.status !== 408; }
}

/** Posts a webhook message. Waits out short rate limits inline; longer ones throw with retryAfterSec. */
export async function postDiscord(url: string, body: unknown, attempt = 0): Promise<void> {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (res.ok) return;

  if (res.status === 429) {
    let waitSec = Number(res.headers.get("Retry-After"));
    try {
      const j = (await res.json()) as any;
      if (typeof j?.retry_after === "number") waitSec = j.retry_after;
    } catch { /* header value is fine */ }
    if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = 1;
    if (waitSec <= 5 && attempt < 2) {
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return postDiscord(url, body, attempt + 1);
    }
    throw new DiscordError(`Discord rate limited for ${waitSec}s`, Math.ceil(waitSec), 429);
  }
  throw new DiscordError(`Discord HTTP ${res.status}: ${clip(await res.text(), 300)}`, null, res.status);
}
