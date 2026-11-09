/**
 * The public "Add to Discord" pages: anyone can add an alert channel in their own server.
 *
 *   /                  what the bot posts, and the Add to Discord button
 *   /discord/install   sets a state cookie and sends the person to Discord (OAuth scope webhook.incoming)
 *   /discord/callback  Discord sends them back with a code; it's traded for the webhook Discord
 *                      created in the channel they chose, which is stored in `webhooks`
 *   /discord/manage    that channel's settings (role to ping, remove), behind a secret key in its link
 *
 * On only when DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are set; otherwise these paths answer as before.
 */

import { DIGEST_HOUR, DIGEST_TIME_ZONE, MAX_SUBSCRIBERS, OAUTH_STATE_MAX_AGE_SEC } from "./config";
import { deleteWebhook, exchangeOAuthCode, postDiscord } from "./discord";
import { errMessage } from "./http";
import { parseRoleInput, readOAuthWebhook, roleNoticePayload, webhookUrl, welcomePayload } from "./lib/discord";
import { landingPage, managePage, messagePage } from "./lib/pages";
import { sha256Hex } from "./lib/text";
import type { Env } from "./types";

const STATE_COOKIE = "__Host-fu_oauth_state";
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

const HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // A manage link holds its key: never send it on as a Referer.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

export function publicPagesEnabled(env: Env): boolean {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}

/** Answers the public routes; null for anything else (the admin routes). */
export async function handlePublic(request: Request, env: Env): Promise<Response | null> {
  if (!publicPagesEnabled(env)) return null;
  const url = new URL(request.url);
  const get = request.method === "GET" || request.method === "HEAD";
  switch (url.pathname) {
    case "/":
      return get ? html(landingPage({ full: await isFull(env.DB), digestTime: digestTimeText() })) : notAllowed();
    case "/discord/install":
      return get ? install(env, url) : notAllowed();
    case "/discord/callback":
      return get ? callback(request, env, url) : notAllowed();
    case "/discord/manage":
      if (get) return manageGet(env, url);
      return request.method === "POST" ? managePost(request, env) : notAllowed();
  }
  return null;
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...HEADERS, ...headers } });
}

function notAllowed(): Response {
  return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
}

function redirect(location: string, status = 303, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...HEADERS, ...headers, Location: location } });
}

function digestTimeText(): string {
  const h = `${DIGEST_HOUR % 12 || 12} ${DIGEST_HOUR < 12 ? "AM" : "PM"}`;
  return DIGEST_TIME_ZONE === "America/Los_Angeles" ? `${h} Pacific` : `${h} (${DIGEST_TIME_ZONE})`;
}

async function isFull(db: D1Database): Promise<boolean> {
  return (await subscriberCount(db)) >= MAX_SUBSCRIBERS;
}

async function subscriberCount(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM webhooks").first<{ n: number }>())?.n ?? 0;
}

function randomKey(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The redirect URI registered in the Discord application: this Worker's own address. */
const redirectUri = (url: URL) => `${url.origin}/discord/callback`;
const clearState = { "Set-Cookie": `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
const startOver = { href: "/", label: "Start again" };

async function install(env: Env, url: URL): Promise<Response> {
  if (await isFull(env.DB)) return html(landingPage({ full: true, digestTime: digestTimeText() }), 503);
  const state = randomKey(18);
  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID!, response_type: "code", scope: "webhook.incoming",
    redirect_uri: redirectUri(url), state
  }).toString();
  // SameSite=Lax: the cookie comes back on Discord's top-level redirect to the callback.
  return redirect(authorize.toString(), 302, {
    "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; Max-Age=${OAUTH_STATE_MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Lax`
  });
}

async function callback(request: Request, env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const expected = readCookie(request, STATE_COOKIE);
  if (!state || !expected || !sameString(state, expected)) {
    return html(messagePage("That link has expired", "Nothing was added. Start again from the ForeverUpdates page, in the same browser.", startOver), 400, clearState);
  }
  if (url.searchParams.has("error")) {
    return html(messagePage("Nothing was added", "The request was cancelled on Discord's page, so no channel was set up.", startOver), 200, clearState);
  }
  const code = url.searchParams.get("code");
  if (!code) return html(messagePage("Nothing was added", "Discord didn't send a code back.", startOver), 400, clearState);

  let hook;
  try {
    hook = readOAuthWebhook(await exchangeOAuthCode(env.DISCORD_CLIENT_ID!, env.DISCORD_CLIENT_SECRET!, code, redirectUri(url)));
  } catch (err) {
    console.warn("Discord OAuth exchange failed:", errMessage(err));
  }
  if (!hook) return html(messagePage("Discord didn't confirm the channel", "Nothing was added. Try again in a minute.", startOver), 502, clearState);

  const db = env.DB;
  // The same channel added again replaces its earlier webhook (and keeps its role), so it never
  // gets every message twice. This is also how a lost manage link is replaced.
  const { results } = await db.prepare("SELECT id, token, role_id FROM webhooks WHERE channel_id = ?")
    .bind(hook.channelId).all<{ id: string; token: string; role_id: string | null }>();
  const old = (results ?? []).filter(o => o.id !== hook.id);
  if ((await subscriberCount(db)) - old.length >= MAX_SUBSCRIBERS) {
    await deleteWebhook(hook.id, hook.token).catch(err => console.warn("Could not delete the new webhook:", errMessage(err)));
    return html(landingPage({ full: true, digestTime: digestTimeText() }), 503, clearState);
  }

  const key = randomKey(32);
  const roleId = old.find(o => o.role_id)?.role_id ?? null;
  await db.batch([
    ...old.flatMap(o => [
      db.prepare("DELETE FROM deliveries WHERE webhook_id = ?").bind(o.id),
      db.prepare("DELETE FROM webhooks WHERE id = ?").bind(o.id)
    ]),
    db.prepare(
      `INSERT INTO webhooks (id, token, guild_id, channel_id, role_id, manage_hash) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET token = excluded.token, manage_hash = excluded.manage_hash`
    ).bind(hook.id, hook.token, hook.guildId, hook.channelId, roleId, await sha256Hex(key))
  ]);
  for (const o of old) {
    await deleteWebhook(o.id, o.token).catch(err => console.warn(`Could not delete replaced webhook ${o.id}:`, errMessage(err)));
  }
  try { await postDiscord(webhookUrl(hook.id, hook.token), welcomePayload(digestTimeText()), 0); }
  catch (err) { console.warn(`Welcome message to webhook ${hook.id} failed:`, errMessage(err)); }
  console.log(JSON.stringify({ event: "subscribed", webhook: hook.id, guild: hook.guildId, channel: hook.channelId, replaced: old.length }));
  return redirect(manageLink(hook.id, key, "new"), 303, clearState);
}

function manageLink(id: string, key: string, notice?: "new" | "saved"): string {
  const q = new URLSearchParams({ id, key });
  if (notice) q.set(notice, "1");
  return `/discord/manage?${q}`;
}

interface WebhookRow {
  id: string; token: string; guild_id: string | null; channel_id: string; role_id: string | null;
  manage_hash: string; last_ok_at: string | null; last_error: string | null;
}

/** The channel this manage link is for, or null if the link is wrong (or the channel was removed). */
async function authorizedWebhook(db: D1Database, id: string, key: string): Promise<WebhookRow | null> {
  if (!/^\d{17,20}$/.test(id) || !key || key.length > 100) return null;
  const row = await db.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first<WebhookRow>();
  return row && sameString(await sha256Hex(key), row.manage_hash) ? row : null;
}

const badLink = () => html(messagePage(
  "This link doesn't work",
  "It may be mistyped, or ForeverUpdates was removed from the channel (deleting its webhook in Discord removes it here too). To set it up again, add it to the channel from the start page.",
  { href: "/", label: "Go to the start page" }
), 404);

function renderManage(row: WebhookRow, key: string, extra: Partial<Parameters<typeof managePage>[0]> = {}): string {
  return managePage({
    id: row.id, key, guildId: row.guild_id, channelId: row.channel_id, roleId: row.role_id,
    lastOkAt: row.last_ok_at, lastError: row.last_error, ...extra
  });
}

async function manageGet(env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("key") ?? "";
  const row = await authorizedWebhook(env.DB, url.searchParams.get("id") ?? "", key);
  if (!row) return badLink();
  const notice = url.searchParams.has("new") ? "new" : url.searchParams.has("saved") ? "saved" : undefined;
  return html(renderManage(row, key, { notice }));
}

async function managePost(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return badLink(); }
  const field = (name: string) => { const v = form.get(name); return typeof v === "string" ? v : ""; };
  const key = field("key");
  const row = await authorizedWebhook(env.DB, field("id"), key);
  if (!row) return badLink();

  if (field("action") === "remove") {
    let deleted = false;
    try { deleted = await deleteWebhook(row.id, row.token); }
    catch (err) { console.warn(`Could not delete webhook ${row.id}:`, errMessage(err)); }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deliveries WHERE webhook_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(row.id)
    ]);
    console.log(JSON.stringify({ event: "unsubscribed", webhook: row.id, guild: row.guild_id, channel: row.channel_id, deleted }));
    return html(messagePage(
      "Removed",
      deleted
        ? "ForeverUpdates won't post in that channel any more, and its webhook was deleted."
        : "ForeverUpdates won't post in that channel any more. Its webhook couldn't be deleted just now: you can delete it in the channel's settings (Integrations → Webhooks).",
      { href: "/", label: "Back to the start page" }
    ));
  }

  if (field("action") !== "role") return html(renderManage(row, key), 400);
  const role = field("role").slice(0, 100);
  const parsed = parseRoleInput(role, row.guild_id);
  if (!parsed.ok) return html(renderManage(row, key, { notice: "bad-role", roleInput: role }), 400);
  if (parsed.roleId !== row.role_id) {
    await env.DB.prepare("UPDATE webhooks SET role_id = ? WHERE id = ?").bind(parsed.roleId, row.id).run();
    // Shows the role by name in the channel (a wrong ID shows as an unknown role), without a ping.
    try { await postDiscord(webhookUrl(row.id, row.token), roleNoticePayload(parsed.roleId), 0); }
    catch (err) { console.warn(`Role notice to webhook ${row.id} failed:`, errMessage(err)); }
  }
  return redirect(manageLink(row.id, key, "saved"));
}
