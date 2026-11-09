/** Sending to Discord. Payload builders live in lib/discord.ts. */

import { DISCORD_API } from "./config";
import { fetchWithTimeout } from "./http";
import { clip } from "./lib/text";

export class DiscordError extends Error {
  /** status: the HTTP status Discord (or a proxy in front of it) answered with. */
  constructor(message: string, readonly retryAfterSec: number | null, readonly status: number) { super(message); }
  /** A 4xx means Discord refused the message; after a 5xx or a 408 timeout it may still have been posted. */
  get refused(): boolean { return this.status >= 400 && this.status < 500 && this.status !== 408; }
  /** The webhook no longer exists (deleted in the channel's settings) or its token is no longer valid. */
  get gone(): boolean { return this.status === 404 || this.status === 401; }
}

/**
 * Posts a webhook message. Waits out short rate limits inline (up to `inlineRetries` times); longer
 * ones throw with retryAfterSec.
 */
export async function postDiscord(url: string, body: unknown, inlineRetries = 2): Promise<void> {
  for (let attempt = 0; ; attempt++) {
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
      if (waitSec <= 5 && attempt < inlineRetries) {
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw new DiscordError(`Discord rate limited for ${waitSec}s`, Math.ceil(waitSec), 429);
    }
    throw new DiscordError(`Discord HTTP ${res.status}: ${clip(await res.text(), 300)}`, null, res.status);
  }
}

/** Deletes a webhook with its own token (no other credentials). True if it's gone now. */
export async function deleteWebhook(id: string, token: string): Promise<boolean> {
  const res = await fetchWithTimeout(`${DISCORD_API}/webhooks/${id}/${token}`, { method: "DELETE" });
  return res.ok || res.status === 404;
}

/**
 * Trades an OAuth code (scope webhook.incoming) for the webhook Discord created in the channel the
 * person chose. The access token that comes with it isn't needed and is dropped.
 */
export async function exchangeOAuthCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString()
  });
  if (!res.ok) throw new DiscordError(`Discord token exchange HTTP ${res.status}: ${clip(await res.text(), 200)}`, null, res.status);
  const json = (await res.json()) as any;
  return json?.webhook ?? null;
}
