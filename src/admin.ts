/** Admin HTTP endpoints (all require `Authorization: Bearer <ADMIN_TOKEN>`). */

import { REGIONS } from "./config";
import { kvGetMany } from "./db";
import { maybeSendDigest } from "./digest";
import { backlog } from "./health";
import { errMessage, getHtml, getJson } from "./http";
import { postText } from "./lib/forum";
import { geminiModels, geminiPauseKey } from "./llm/chain";
import { articleProbe, extractArticleFullText, extractArticleTitle } from "./lib/news";
import { postIdFromKey, runPoll, seededKey } from "./poller";
import { collectSources, forumRegions, resolveAllCategories } from "./sources";
import { publicPagesEnabled } from "./subscribe";
import type { Env } from "./types";

const ROUTES = ["/status", "/debug", "/seed", "/run-poll", "/run-digest"];

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!ROUTES.includes(pathname)) return new Response("ForeverUpdates is running.", { status: 200 });
  if (!(await authorized(request, env))) return new Response("Unauthorized", { status: 401 });

  switch (pathname) {
    case "/status": return json(await status(env));
    case "/debug": return json(await debug(env));
    case "/seed": return json(await runPoll(env, { seedOnly: true }));
    case "/run-poll": return json(await runPoll(env));
    // Sends today's digest now; it is that day's one digest (the 5 PM run then skips, and items
    // that arrive later wait for the next day's).
    case "/run-digest": return json((await maybeSendDigest(env, new Date(), { anyTime: true })) ?? { sent: 0, alreadySentToday: true });
  }
  return new Response("Not found", { status: 404 });
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const enc = new TextEncoder();
  const a = enc.encode(request.headers.get("Authorization") ?? "");
  const b = enc.encode(`Bearer ${env.ADMIN_TOKEN}`);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json" } });
}

async function status(env: Env) {
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const [health, counters, watched, recent, subscribers, channels] = await db.batch<any>([
    db.prepare("SELECT * FROM source_health ORDER BY source"),
    db.prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key").bind(`count:${today}:%`),
    db.prepare(`SELECT key, watch_tier, title, checked_at, watch_until FROM documents WHERE watch_tier > 0 AND watch_until > datetime('now')
                ORDER BY watch_tier DESC, checked_at ASC LIMIT 50`),
    db.prepare(`SELECT id, title, kind, state, classified_by, relevant, critical, alert_state, digest_state, summary, rationale, created_at
                FROM events ORDER BY created_at DESC LIMIT 20`),
    db.prepare(`SELECT (SELECT COUNT(*) FROM webhooks) AS channels,
                       (SELECT COUNT(*) FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.state = 'pending') AS pendingDeliveries,
                       (SELECT COUNT(*) FROM deliveries WHERE state = 'failed' AND created_at > datetime('now', '-1 day')) AS failedLastDay`),
    // Never the tokens or manage keys.
    db.prepare(`SELECT id, guild_id, channel_id, role_id, last_ok_at, last_error, created_at FROM webhooks ORDER BY created_at DESC LIMIT 50`)
  ]);
  const gemini = geminiModels(env);
  const seedFlag = seededKey(forumRegions(env));
  const kv = await kvGetMany(db, [seedFlag, "digest:last", "digest:inflight", ...gemini.map(m => geminiPauseKey(m.model)), "pause:workers-ai"]);
  const pausedUntil = (k: string) => { const v = kv.get(k)?.value; return v && Date.parse(v) > Date.now() ? v : null; };
  return {
    seeded: kv.get(seedFlag)?.value ?? null,
    lastDigest: kv.get("digest:last")?.value ?? null,
    // A digest run in progress (or one that stopped; the next digest run settles it).
    digestInFlight: (() => {
      const row = kv.get("digest:inflight");
      if (!row) return null;
      try { const v = JSON.parse(row.value); return { name: v.name, state: v.state, items: v.ids?.length ?? 0, since: row.updated_at }; }
      catch { return { name: null, state: "unreadable", items: 0, since: row.updated_at }; }
    })(),
    models: {
      gemini: gemini.map(m => ({ role: m.provider === "gemini" ? "main" : "backup", model: m.model, thinking: m.thinking, pausedUntil: pausedUntil(geminiPauseKey(m.model)) })),
      workersAiPausedUntil: pausedUntil("pause:workers-ai"), workersAiBound: !!env.AI },
    today: Object.fromEntries((counters.results ?? []).map((r: any) => [r.key.split(":").slice(2).join(":"), Number(r.value)])),
    stuck: await backlog(db),
    // Other servers' channels (the public "Add to Discord" page).
    subscribers: { publicPage: publicPagesEnabled(env), ...(subscribers.results?.[0] ?? {}), recent: channels.results },
    sources: health.results,
    watching: watched.results,
    recentEvents: recent.results
  };
}

/** Live check of every source, plus what the bot extracts from one real article and one post. */
async function debug(env: Env) {
  const regions = forumRegions(env);
  const kv = await kvGetMany(env.DB, regions.map(r => `cats:${r}`));
  const categories = await resolveAllCategories(env.DB, regions, kv);
  const sources = await collectSources(categories);
  const all = sources.flatMap(s => s.hits);

  const lines = (text: string) => { const l = text.split("\n"); return { chars: text.length, lines: l.length, firstLines: l.slice(0, 12), lastLines: l.slice(-5) }; };
  let articleProbeResult: unknown = null;
  const news = all.find(h => h.kind === "news");
  if (news) {
    try {
      const html = await getHtml(news.url);
      articleProbeResult = { url: news.url, htmlKB: Math.round(html.length / 1024), title: extractArticleTitle(html), probe: (await articleProbe(html)).slice(0, 12), ...lines(extractArticleFullText(html)) };
    } catch (err) { articleProbeResult = { url: news.url, error: errMessage(err) }; }
  }
  let postProbeResult: unknown = null;
  const post = all.find(h => h.kind === "post");
  const pid = post && postIdFromKey(post.key);
  if (post && pid) {
    try {
      const p = await getJson(`${REGIONS[pid.region].base}/en/wow/posts/${pid.id}.json`);
      postProbeResult = { url: post.url, fields: Object.keys(p ?? {}), ...lines(postText(String(p?.cooked ?? ""))) };
    } catch (err) { postProbeResult = { url: post.url, error: errMessage(err) }; }
  }

  return {
    categories,
    sources: sources.map(s => ({
      key: s.key, ok: s.ok, error: s.error, rawCount: s.rawCount, matched: s.hits.length, sampleKeys: s.sampleKeys,
      sample: s.hits.slice(0, 3).map(h => ({ key: h.key, title: h.title, url: h.url, author: h.author, postedAt: h.postedAt, postNumber: h.postNumber }))
    })),
    articleProbe: articleProbeResult,
    postProbe: postProbeResult
  };
}
