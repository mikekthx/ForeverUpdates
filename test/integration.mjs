// End-to-end tests in the real Workers runtime (Miniflare + local D1).
// Blizzard, Gemini and Discord are mocked at the network layer; the two queues and Workers AI are
// fake bindings that record messages, so this harness can deliver them deterministically.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const HOUR = 3_600_000;
const iso = msAgo => new Date(Date.now() - msAgo).toISOString();

// ───────────── Mock world ─────────────
const world = {
  usTracker: [], euTracker: [],
  // Search results always include a beta-forum post (filtered out), so the sources are never "empty".
  usSearch: { posts: [{ id: 1, created_at: new Date().toISOString(), username: "Kaivax", blurb: "beta", post_number: 1, topic_id: 1 }], topics: [{ id: 1, title: "Beta", slug: "b", category_id: 349 }] },
  euSearch: { posts: [{ id: 1, created_at: new Date().toISOString(), username: "Linxy", blurb: "beta", post_number: 1, topic_id: 1 }], topics: [{ id: 1, title: "Beta", slug: "b", category_id: 999 }] },
  newsHtml: "<html><body></body></html>", articles: {}, posts: {},
  articleFail: {}, postFail: {}, fetches: {},
  geminiMode: "ok", // ok | daily | rate | error | overloaded (every Gemini model)
  geminiModelMode: {}, // model id → mode, overrides geminiMode for that model
  geminiModels: [],    // model id of each Gemini call
  // Eval, 2026-10-28: Flash-Lite needs "high" thinking to match Flash; the Flash backup uses "low".
  expectedThinking: { "gemini-3.5-flash-lite": "high", "gemini-3.6-flash": "low" },
  discordFailNext: 0, discordFailStatus: 500, discordDropReplyNext: 0, discord: [], geminiCalls: [],
  // Other servers' webhooks: the id each message went to (parallel to discord), OAuth codes, deletes.
  discordTo: [], oauthCodes: {}, oauthExchanges: 0, deletedWebhooks: [], goneWebhooks: new Set(), webhookFail: {},
  webhook429: {}, onWebhookPost: null // onWebhookPost(id): runs while a post is in flight, before Discord answers
};

const siteJson = region => ({
  categories: region === "us"
    ? [
        { id: 2, slug: "general-discussion", name: "General Discussion", parent_category_id: null },
        { id: 347, slug: "wow-forever", name: "WoW: Forever", parent_category_id: null },
        { id: 348, slug: "wow-forever-general-discussion", name: "WoW: Forever General Discussion", parent_category_id: 347 },
        { id: 349, slug: "wow-forever-beta-discussion", name: "WoW: Forever Beta Discussion", parent_category_id: 347 }
      ]
    : [
        { id: 359, slug: "wow-forever", name: "WoW: Forever", parent_category_id: null },
        { id: 360, slug: "wow-forever-general-discussion", name: "WoW: Forever General Discussion", parent_category_id: 359 }
      ]
});
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const count = k => { world.fetches[k] = (world.fetches[k] ?? 0) + 1; };

/** Mock classifier shared by "Gemini" and "Workers AI": relevance/criticality from keywords. */
function judge(title, content, verified) {
  const lines = content.split("\n");
  const isEdit = content.includes("[NEW]");
  const judged = isEdit ? lines.flatMap((l, i) => (l.startsWith("[NEW]") ? [lines[i - 1] ?? "", l] : [])).join(" ") : `${title} ${content}`;
  const relevant = verified || /forever/i.test(judged);
  const critical = relevant && /queue|offline|emergency|realm/i.test(isEdit ? lines.filter(l => l.startsWith("[NEW]")).join(" ") : `${title} ${content}`);
  return {
    is_forever_relevant: relevant, is_critical: critical,
    category: critical ? "Server Status" : "Developer Blue Post",
    summary: `Summary of: ${title}`.slice(0, 200), urgency_rationale: critical ? "Outage/queue" : "Routine"
  };
}

async function outbound(request) {
  const url = new URL(request.url);
  const host = url.hostname;
  if (host.endsWith("forums.blizzard.com")) {
    const region = host.startsWith("us") ? "us" : "eu";
    if (url.pathname.endsWith("/site.json")) return jsonRes(siteJson(region));
    if (url.pathname.endsWith("/groups/blizzard-tracker/posts.json")) return jsonRes(region === "us" ? world.usTracker : world.euTracker);
    if (url.pathname.endsWith("/search.json")) {
      assert.match(url.searchParams.get("q"), /group:blizzard-tracker #wow-forever order:latest/);
      return jsonRes(region === "us" ? world.usSearch : world.euSearch);
    }
    const m = url.pathname.match(/\/posts\/(\d+)\.json$/);
    if (m) {
      const key = `${region}:${m[1]}`;
      count(`post:${key}`);
      if (world.postFail[key] > 0) { world.postFail[key]--; return jsonRes({ error: "unavailable" }, 503); }
      const p = world.posts[key];
      return p ? jsonRes(p) : jsonRes({ error: "nf" }, 404);
    }
    return new Response("nf", { status: 404 });
  }
  if (host === "news.blizzard.com") {
    if (url.pathname === "/en-us/feed/world-of-warcraft") return new Response(world.newsHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    const m = url.pathname.match(/\/article\/(\d+)/);
    if (m) {
      count(`news:${m[1]}`);
      if (world.articleFail[m[1]] > 0) { world.articleFail[m[1]]--; return new Response("unavailable", { status: 503 }); }
      if (world.articles[m[1]]) return new Response(world.articles[m[1]], { headers: { "content-type": "text/html" } });
    }
    return new Response("nf", { status: 404 });
  }
  if (host === "generativelanguage.googleapis.com") {
    const body = await request.json();
    assert.equal(request.headers.get("x-goog-api-key"), "test-gemini-key");
    assert.equal(body.generationConfig.temperature, undefined, "temperature must not be sent");
    const prompt = body.contents[0].parts[0].text;
    const model = url.pathname.match(/models\/([^:]+):/)[1];
    world.geminiCalls.push(prompt);
    world.geminiModels.push(model);
    assert.ok(model in world.expectedThinking, `unexpected Gemini model ${model}`);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, world.expectedThinking[model], `thinking level for ${model}`);
    const mode = world.geminiModelMode[model] ?? world.geminiMode;
    if (mode === "overloaded") return jsonRes({ error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } }, 503);
    if (mode === "daily") return jsonRes({ error: { code: 429, message: "Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel" } }, 429);
    if (mode === "rate") return jsonRes({ error: { code: 429, message: "Quota exceeded for metric: GenerateRequestsPerMinutePerProjectPerModel" } }, 429);
    if (mode === "error") return jsonRes({ error: { code: 500, message: "internal" } }, 500);
    const items = [...prompt.matchAll(/<item ref="(\d+)"[^>]*forum_verified="(true|false)"[^>]*>\n<title>([^<]*)<\/title>\n<content>\n([\s\S]*?)\n<\/content>/g)];
    const results = items.map(([, ref, verified, title, content]) => ({ ref, ...judge(title, content, verified === "true") }));
    return jsonRes({ candidates: [{ content: { parts: [{ text: JSON.stringify({ results }) }] }, finishReason: "STOP" }] });
  }
  if (host === "discord.com") {
    if (url.pathname === "/api/v10/oauth2/token") {
      world.oauthExchanges++;
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), `Basic ${btoa("test-client-id:test-client-secret")}`);
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("redirect_uri"), "http://localhost/discord/callback");
      const webhook = world.oauthCodes[form.get("code")];
      delete world.oauthCodes[form.get("code")]; // a code works once
      return webhook ? jsonRes({ access_token: "at", token_type: "Bearer", scope: "webhook.incoming", webhook }) : jsonRes({ error: "invalid_grant" }, 400);
    }
    const del = url.pathname.match(/^\/api\/v10\/webhooks\/(\d+)\/([\w-]+)$/);
    if (del && request.method === "DELETE") { world.deletedWebhooks.push(del[1]); return new Response(null, { status: 204 }); }
    const hookId = url.pathname.match(/^\/api\/webhooks\/(\d+)\//)?.[1];
    const body = await request.json();
    if (world.goneWebhooks.has(hookId)) return jsonRes({ message: "Unknown Webhook", code: 10015 }, 404);
    if (world.webhookFail[hookId] > 0) { world.webhookFail[hookId]--; return new Response("bad gateway", { status: 502 }); }
    if (world.webhook429[hookId] > 0) { world.webhook429[hookId]--; return jsonRes({ message: "You are being rate limited.", retry_after: 2, global: false }, 429); }
    if (world.onWebhookPost) await world.onWebhookPost(hookId);
    if (world.discordFailNext > 0) { world.discordFailNext--; return new Response("boom", { status: world.discordFailStatus }); }
    world.discord.push(body);
    world.discordTo.push(hookId);
    // Discord took the message, but no answer arrives before the bot's 10 s timeout.
    if (world.discordDropReplyNext > 0) { world.discordDropReplyNext--; await new Promise(r => setTimeout(r, 11_000)); }
    return new Response(null, { status: 204 });
  }
  throw new Error(`Unexpected outbound fetch: ${request.url}`);
}

// Fake bindings: queues record messages; "AI" classifies with the same keyword judge.
const FAKES = `
import { WorkerEntrypoint } from "cloudflare:workers";
const store = { work: [], classify: [], aiCalls: 0, aiMode: "ok", failSend: 0 };
${judge.toString()}
class Q extends WorkerEntrypoint {
  async send(body, opts) {
    if (this.name === "classify" && store.failSend > 0) { store.failSend--; throw new Error("queue unavailable"); }
    store[this.name].push({ body, delaySeconds: opts?.delaySeconds });
  }
  async sendBatch(msgs) { for (const m of msgs) store[this.name].push({ body: m.body, delaySeconds: m.delaySeconds }); }
}
export class WorkQueue extends Q { get name() { return "work"; } }
export class ClassifyQueue extends Q { get name() { return "classify"; } }
export class AI extends WorkerEntrypoint {
  async run(model, inputs) {
    store.aiCalls++;
    if (store.aiMode === "quota") throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
    const text = inputs.messages[1].content;
    const m = text.match(/forum_verified="(true|false)"[^>]*>\\n<title>([^<]*)<\\/title>\\n<content>\\n([\\s\\S]*?)\\n<\\/content>/);
    return { response: judge(m[2], m[3], m[1] === "true") };
  }
}
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/drain") return Response.json({ work: store.work.splice(0), classify: store.classify.splice(0) });
    if (u.pathname === "/failsend") { store.failSend = Number(u.searchParams.get("n") ?? 1); return new Response("ok"); }
    if (u.pathname === "/ai") { if (u.searchParams.get("mode")) store.aiMode = u.searchParams.get("mode"); return Response.json({ calls: store.aiCalls, mode: store.aiMode }); }
    return new Response("fakes");
  }
};`;

// ───────────── Fixtures ─────────────
let nextPostId = 1000;
function forumPost({ region, categoryId, title, text, author = "Kaivax", ageMs = 10 * 60_000, topicId = 5000, postNumber = 1 }) {
  const id = nextPostId++;
  world.posts[`${region}:${id}`] = { id, cooked: text.split("\n").map(l => `<p>${l}</p>`).join(""), username: author };
  return {
    id, created_at: iso(ageMs), category_id: categoryId, topic_id: topicId, topic_slug: "t", post_number: postNumber,
    title, excerpt: text.slice(0, 40) + "&hellip;", username: author, url: `/en/wow/t/t/${topicId}/${postNumber}`
  };
}
const newsCard = (id, title, desc) => `<a href="/en-us/article/${id}/x"><h3>${title}</h3><span>World of Warcraft</span><p>${desc}</p><span>News</span></a>`;
const articlePage = (paras, related = "Related: Skyborne story") =>
  `<html><body><nav>Menu</nav><article><h1>Article</h1>${paras.map(p => `<p>${p}</p>`).join("")}</article><aside><article><h3>${related}</h3></article></aside></body></html>`;

// ───────────── Harness ─────────────
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [
    {
      name: "triage",
      modules: true,
      scriptPath: "test/.build/worker.mjs",
      compatibilityDate: "2026-10-01",
      d1Databases: { DB: "test-db" },
      bindings: { GEMINI_API_KEY: "test-gemini-key", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc", ADMIN_TOKEN: "secret-token",
        DISCORD_CLIENT_ID: "test-client-id", DISCORD_CLIENT_SECRET: "test-client-secret",
        // EU is off by default; these scenarios use it to test US/EU crosspost collapsing.
        FORUM_REGIONS: "us,eu" },
      serviceBindings: {
        WORK: { name: "fakes", entrypoint: "WorkQueue" },
        CLASSIFY: { name: "fakes", entrypoint: "ClassifyQueue" },
        AI: { name: "fakes", entrypoint: "AI" }
      },
      outboundService: outbound
    },
    { name: "fakes", modules: true, script: FAKES, compatibilityDate: "2026-10-01" }
  ]
}));

const db = await mf.getD1Database("DB", "triage");
for (const stmt of readFileSync("schema.sql", "utf8").replace(/--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) {
  await db.prepare(stmt).run();
}
const worker = await mf.getWorker("triage");
const fakes = await mf.getWorker("fakes");
const today = new Date().toISOString().slice(0, 10);
const at = hhmm => new Date(`${today}T${hhmm}:00Z`);
// The digest is due at 17:00 Pacific and named by its Pacific date: pt("17:00") is that time today.
const digestToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const ptTime = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const pt = hhmm => [7, 8].map(h => new Date(Date.parse(`${digestToday}T${hhmm}:00Z`) + h * 3600e3)).find(d => ptTime.format(d) === hhmm);
const poll = async (hhmm = "12:00") => {
  try { return await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: hhmm instanceof Date ? hhmm : at(hhmm) }); }
  catch (err) { return { outcome: "exception", err }; }
};
const ai = async (mode) => (await fakes.fetch(`http://fakes/ai${mode ? `?mode=${mode}` : ""}`)).json();
const call = async (path, token = "secret-token") => {
  const res = await mf.dispatchFetch(`http://localhost${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
};

/** Delivers queued messages until both queues are empty. Retried messages are re-delivered (attempts+1)
 *  only if `retries` is true; otherwise they're returned so a test can inspect or re-deliver them. */
let msgSeq = 0;
const parked = [];
async function settle({ retries = true, maxRounds = 30 } = {}) {
  const stats = { work: 0, classify: 0, retried: 0 };
  for (let round = 0; round < maxRounds; round++) {
    const { work, classify } = await (await fakes.fetch("http://fakes/drain")).json();
    const pending = [
      ...work.map(m => ({ q: "forever-updates-work", body: m.body, attempts: 1 })),
      ...classify.map(m => ({ q: "forever-updates-classify", body: m.body, attempts: 1 })),
      ...(retries ? parked.splice(0) : [])
    ];
    if (!pending.length) return stats;
    const deliver = async (q, msgs) => {
      const batch = msgs.map(m => ({ id: `m${++msgSeq}`, timestamp: new Date(), body: m.body, attempts: m.attempts }));
      const r = await worker.queue(q, batch);
      assert.equal(r.outcome, "ok", `queue handler outcome ${r.outcome}`);
      const retryIds = new Set((r.retryMessages ?? []).map(x => x.msgId));
      if (r.retryBatch?.retry) batch.forEach(b => retryIds.add(b.id));
      batch.forEach((b, i) => { if (retryIds.has(b.id)) { parked.push({ q, body: msgs[i].body, attempts: msgs[i].attempts + 1 }); stats.retried++; } });
    };
    for (const m of pending.filter(p => p.q === "forever-updates-work")) { await deliver(m.q, [m]); stats.work++; }
    const cls = pending.filter(p => p.q === "forever-updates-classify");
    for (let i = 0; i < cls.length; i += 10) { await deliver("forever-updates-classify", cls.slice(i, i + 10)); stats.classify += Math.min(10, cls.length - i); }
  }
  return stats;
}
const events = async (where = "1=1") => (await db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY created_at, id`).all()).results;
const doc = async key => db.prepare("SELECT * FROM documents WHERE key = ?").bind(key).first();
const alerts = () => world.discord.filter(m => m.embeds?.[0]?.title?.startsWith("🚨"));
const makeDue = (where = "watch_tier > 0") => db.prepare(`UPDATE documents SET checked_at = datetime('now', '-3 hours') WHERE ${where}`).run();
let passed = 0; const ok = s => { passed++; console.log("  ✓", s); };

try {
  // 0. Auth
  assert.equal((await call("/status", null)).status, 401);
  assert.equal((await call("/status", "wrong")).status, 401);
  assert.equal((await call("/")).status, 200);
  ok("admin routes reject missing/wrong token");

  // 0b. (audit #1) A first run whose news page shows no articles (bot check, outage) doesn't count
  //     as seeded: scenario 1 below then seeds instead of alerting on the whole news listing.
  await poll(); await settle();
  assert.equal(await db.prepare("SELECT 1 FROM kv WHERE key LIKE 'seeded%'").first(), null);
  ok("a first run with an empty news page doesn't mark the bot seeded");

  // 1. First run seeds: nothing alerts, no model calls; only watch-worthy items get a baseline fetch.
  const oldKi = forumPost({ region: "us", categoryId: 348, title: "WoW: Forever Known Issues", text: "We are tracking the following issues.\nSome quest givers are missing.", topicId: 4000 });
  const oldChat = forumPost({ region: "us", categoryId: 348, title: "Skyborne feedback", text: "Thanks everyone!", topicId: 4001 });
  world.usTracker = [oldKi, oldChat];
  world.newsHtml = newsCard(1, "WoW: Forever Raid Overview", "Barrow Deeps, Hyjal Summit") +
    newsCard(7, "Hotfixes: October 28, 2026", "Hotfixes for all versions");
  world.articles["7"] = articlePage(["October 28, 2026", "WoW: Forever", "Fixed an issue with Skyborne gliding."]);
  world.articleFail["7"] = 4; // Blizzard's site is down for the whole first retry cycle
  await poll();
  let s = await settle();
  assert.equal(world.fetches["news:1"], undefined, "non-watched items are not fetched while seeding");
  assert.equal(world.discord.length, 0);
  assert.equal(world.geminiCalls.length, 0);
  assert.equal((await events()).length, 0);
  assert.equal((await doc(`post:us:${oldKi.id}`)).status, "ok");
  assert.ok((await doc(`post:us:${oldKi.id}`)).body.includes("quest givers"));
  assert.equal((await doc(`post:us:${oldChat.id}`)).status, "seeded");
  const h7 = await doc("news:7");
  assert.deepEqual([h7.status, h7.watch_tier, h7.fetch_attempts], ["seeded", 3, 4], "failed baseline keeps watching (v4 review #3)");
  ok("first run seeds: no events or alerts; watch-worthy threads get a baseline; a failed baseline isn't abandoned");

  // 2. Launch batch
  const usCritical = forumPost({ region: "us", categoryId: 348, title: "Login queues on launch", text: "We are aware of long login queues and are adding capacity.", topicId: 6001, postNumber: 4 });
  const euCrosspost = forumPost({ region: "eu", categoryId: 360, title: "Login queues on launch", text: "We are aware of long login queues and are adding capacity.", author: "Linxy", topicId: 7001, postNumber: 2 });
  const usRoutine = forumPost({ region: "us", categoryId: 348, title: "Thanks for the feedback on Skyborne", text: "Appreciate the thoughtful posts!", author: "Aggrend", topicId: 6002, postNumber: 7 });
  const retail = forumPost({ region: "us", categoryId: 2, title: "Midnight tuning", text: "Retail changes" });
  world.usTracker = [...world.usTracker, usCritical, usRoutine, retail];
  world.euTracker = [euCrosspost];
  world.usSearch = {
    posts: [
      ...world.usSearch.posts,
      { id: 9999, created_at: iso(5 * 60_000), username: "Kaivax", blurb: "Beta wrap-up", post_number: 1, topic_id: 8001 },
      { id: 9998, created_at: iso(72 * HOUR), username: "Kaivax", blurb: "Old news", post_number: 1, topic_id: 8002 }
    ],
    topics: [...world.usSearch.topics, { id: 8001, title: "Beta is over", slug: "b", category_id: 349 }, { id: 8002, title: "Ancient", slug: "a", category_id: 348 }]
  };
  world.newsHtml +=
    newsCard(2, "Hotfixes: November 4, 2026", "Midnight, Classic Era and Hardcore") +
    newsCard(3, "Skyborne cinematic premieres", "A new short story for WoW: Forever fans") +
    newsCard(4, "Get 50% off transmogs", "Store sale") +
    newsCard(6, "BCCA: The Gods of Zul'Aman Now Live", "Burning Crusade Classic Anniversary");
  world.articles["2"] = articlePage(["November 4, 2026", "World of Warcraft: Midnight", "Fixed an issue with Delves for Midnight players only."]);
  world.articles["3"] = articlePage(["Watch the new WoW: Forever Skyborne story now, starring Cormack the fallen crusader."]);

  await poll();
  s = await settle();
  assert.equal(world.geminiCalls.length, 1, "one batched Gemini call");
  const prompt = world.geminiCalls[0];
  assert.ok(prompt.includes("adding capacity"), "full post body sent");
  assert.ok(prompt.includes("Delves for Midnight"), "full article body sent");
  for (const bad of ["Midnight tuning", "Beta wrap-up", "Old news", "transmog", "Zul'Aman"]) assert.ok(!prompt.includes(bad), `${bad} filtered out`);
  assert.equal(world.fetches["news:2"], 1, "new hotfix post fetched once");
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].embeds[0].title, /Login queues on launch/);
  const a0 = alerts()[0].embeds[0];
  assert.equal(a0.url, `https://us.forums.blizzard.com/en/wow/t/t/6001/4`, "the title links to the post");
  assert.equal(a0.description, "> **TL;DR:** Summary of: Login queues on launch\n\nWe are aware of long login queues and are adding capacity.");
  assert.deepEqual([a0.fields, a0.footer, a0.color], [undefined, undefined, 0xdc2626], "red bar; no fields or footer");
  assert.deepEqual(alerts()[0].allowed_mentions, { parse: [] });
  const ev = Object.fromEntries((await events()).map(e => [e.doc_key, e]));
  assert.equal(ev[`post:eu:${euCrosspost.id}`].state, "duplicate", "EU crosspost by another CM collapsed");
  assert.equal(ev[`post:us:${usRoutine.id}`].digest_state, "queued");
  assert.equal(ev["news:2"].relevant, 0, "Midnight-only hotfix post irrelevant");
  assert.equal((await doc("news:2")).watch_tier, 3, "hotfix post watched regardless");
  assert.equal(ev["news:3"].digest_state, "queued");
  assert.equal((await doc("news:3")).watch_tier, 0, "story article not watched");
  ok("launch batch: 1 batched Gemini call, 1 alert, crosspost collapsed, filters applied, hotfix post watched");

  // 3. Unchanged feeds → no work at all.
  await poll();
  s = await settle();
  assert.deepEqual([s.work, s.classify], [0, 0]);
  assert.equal(world.geminiCalls.length, 1);
  ok("unchanged feeds queue nothing and call no model");

  // 3b. (review #3) The sweeper retries the failed seeded baseline later; watching resumes.
  await db.prepare("UPDATE documents SET nudged_at = datetime('now', '-1 hour') WHERE key = 'news:7'").run();
  await poll(); await settle();
  const h7b = await doc("news:7");
  assert.deepEqual([h7b.status, h7b.watch_tier], ["ok", 3]);
  assert.ok(h7b.body.includes("Skyborne gliding"));
  assert.equal((await events("doc_key = 'news:7'")).length, 0, "baselines never create events");
  ok("failed seeded baseline is retried by the sweeper and watching resumes");

  // 3c. (audit #1) A forum region added later is seeded, not alerted: its last 48 h of posts are old news.
  await db.prepare("UPDATE kv SET key = 'seeded:us' WHERE key = 'seeded:us,eu'").run();
  const euOld = forumPost({ region: "eu", categoryId: 360, title: "Realm queues tonight", text: "We are aware of realm queues.", author: "Linxy", ageMs: 20 * HOUR, topicId: 7100, postNumber: 3 });
  world.euTracker = [...world.euTracker, euOld];
  await poll(); await settle();
  assert.equal((await doc(`post:eu:${euOld.id}`)).status, "seeded");
  assert.equal((await events(`doc_key = 'post:eu:${euOld.id}'`)).length, 0);
  assert.ok(await db.prepare("SELECT 1 FROM kv WHERE key = 'seeded:us,eu'").first());
  assert.equal(await db.prepare("SELECT 1 FROM kv WHERE key = 'seeded:us'").first(), null, "switching back to us later must seed again");
  ok("changing the forum regions seeds once instead of alerting on the new region's posts");

  // 3d. (audit #2) A seeded post whose baseline never loads stops being watched but stays 'seeded',
  //     so it can never look like a teaser-only item waiting for its full text.
  const neverLoads = forumPost({ region: "us", categoryId: 348, title: "Maintenance", text: "x", topicId: 7200 });
  world.postFail[`us:${neverLoads.id}`] = 99;
  await db.prepare(`INSERT INTO documents (key, kind, source, url, title, author, status, watch_tier, watch_until, fetch_attempts)
    VALUES (?, 'post', 'Blue Post (US)', 'u', 'Maintenance', 'a', 'seeded', 2, datetime('now', '+1 day'), 11)`).bind(`post:us:${neverLoads.id}`).run();
  await poll(); await settle();
  const gaveUp = await doc(`post:us:${neverLoads.id}`);
  assert.deepEqual([gaveUp.status, gaveUp.watch_tier, gaveUp.body], ["seeded", 0, null]);
  world.postFail[`us:${neverLoads.id}`] = 0;
  ok("a baseline that never loads stops watching and stays 'seeded'");

  // 3c. (review #1) Page down for the whole retry cycle → classified from its teaser; when the page
  //     recovers, the full text is classified as its own event instead of being silently dropped.
  world.newsHtml += newsCard(8, "WoW: Forever Profession Changes", "Changes are coming");
  world.articles["8"] = articlePage(["WoW: Forever professions: login queues for crafting orders are fixed; realms restart tonight."]);
  world.articleFail["8"] = 4;
  await poll(); await settle();
  let e8 = await events("doc_key = 'news:8'");
  assert.deepEqual(e8.map(e => e.id), ["news:8@new"]);
  assert.ok(e8[0].content.includes("Changes are coming"), "teaser used as a last resort");
  await db.prepare("UPDATE documents SET nudged_at = datetime('now', '-1 hour') WHERE key = 'news:8'").run();
  let alertsBefore = alerts().length;
  await poll(); await settle();
  e8 = await events("doc_key = 'news:8'");
  assert.deepEqual(e8.map(e => e.id).sort(), ["news:8@full", "news:8@new"]);
  const full = e8.find(e => e.id === "news:8@full");
  assert.ok(full.content.includes("crafting orders"));
  assert.equal(full.critical, 1);
  assert.equal(alerts().length, alertsBefore + 1, "the full text's critical content alerts");
  assert.ok((await doc("news:8")).body.includes("crafting orders"));
  ok("teaser-only item gets its full text classified once the page recovers (review #1)");

  // 3d. A one-sentence article whose listing teaser is the whole article (real ones are a sentence
  //     and a video) is a normal fetch, not a failed one.
  const oneLine = "Witness the creation of WoW: Forever's first legendary staff, forged by Weta.";
  world.newsHtml += newsCard(9, "WoW: Forever: Watch Forging Forever", oneLine);
  world.articles["9"] = `<html><body><article><p>${oneLine}</p><aside><div class="video"><iframe src="https://www.youtube-nocookie.com/embed/mFOkBPMKJhc?si=x"></iframe></div></aside></article></body></html>`;
  await poll(); await settle();
  assert.equal(world.fetches["news:9"], 1, "fetched once, not retried");
  assert.equal((await doc("news:9")).body, `https://youtu.be/mFOkBPMKJhc\n${oneLine}`, "its text is the body, after its video's link");
  ok("a short article that is all teaser is fetched normally; its video is linked");

  // 3e. A page whose text is shorter than its teaser is a failed fetch, video or not (the link line
  //     doesn't count as text).
  const teaser10 = "A teaser that is clearly longer than the stub the article page returns.";
  world.newsHtml += newsCard(10, "WoW: Forever: Stub page", teaser10);
  world.articles["10"] = `<html><body><article><p>Loading the article, please wait a moment or two.</p><iframe src="https://www.youtube.com/embed/mFOkBPMKJhc"></iframe></article></body></html>`;
  await poll(); await settle();
  assert.ok(world.fetches["news:10"] > 1, "retried as a failed fetch");
  ok("a stub page with a video still counts as a failed fetch");

  // 3d. (review #2) US and EU copies processed by two consumers at the same moment → one duplicate.
  const raceUs = forumPost({ region: "us", categoryId: 348, title: "Realm restart schedule", text: "All Normal realms restart at 03:00 for maintenance.", topicId: 6300, postNumber: 2 });
  const raceEu = forumPost({ region: "eu", categoryId: 360, title: "Realm restart schedule", text: "All Normal realms restart at 03:00 for maintenance.", author: "Linxy", topicId: 7300, postNumber: 2 });
  world.usTracker = [...world.usTracker, raceUs];
  world.euTracker = [...world.euTracker, raceEu];
  await poll();
  const raced = (await (await fakes.fetch("http://fakes/drain")).json()).work;
  assert.equal(raced.length, 2);
  await Promise.all(raced.map(m => worker.queue("forever-updates-work", [{ id: `race-${m.body.key}`, timestamp: new Date(), body: m.body, attempts: 1 }])));
  const states = (await events(`doc_key IN ('post:us:${raceUs.id}', 'post:eu:${raceEu.id}')`)).map(e => e.state).sort();
  assert.deepEqual(states, ["duplicate", "pending"]);
  alertsBefore = alerts().length;
  await settle();
  assert.equal(alerts().length, alertsBefore + 1, "one alert for the pair");
  ok("concurrent US/EU processing still collapses the crosspost (review #2)");

  // 3e. (review #7) Queue send fails after the event is stored → no refetch; the sweeper recovers it.
  const sendFail = forumPost({ region: "us", categoryId: 348, title: "Server queue update", text: "Queues are dropping on Normal realms.", topicId: 6400, postNumber: 3 });
  world.usTracker = [...world.usTracker, sendFail];
  await fakes.fetch("http://fakes/failsend?n=1");
  await poll();
  s = await settle({ retries: false });
  assert.equal(s.retried, 0, "work message acked, not retried");
  assert.equal(world.fetches[`post:us:${sendFail.id}`], 1, "page not refetched");
  const sfId = `post:us:${sendFail.id}@new`;
  assert.equal((await events(`id = '${sfId}'`))[0].state, "pending");
  await db.prepare("UPDATE events SET nudged_at = datetime('now', '-1 hour') WHERE id = ?").bind(sfId).run();
  await poll(); await settle();
  assert.equal((await events(`id = '${sfId}'`))[0].state, "done");
  ok("failed classify enqueue doesn't refetch; the sweeper delivers it (review #7)");

  // 3f. (review #6) More text than one Gemini call allows: the rest waits for Gemini's next batch
  //     instead of going to Workers AI with a 6,000-character excerpt.
  const long = i => articlePage([`WoW: Forever patch notes part ${i}.`, ...Array.from({ length: 300 }, (_, j) => `Line ${j}: ${"x".repeat(95)}`)]);
  for (const id of [11, 12, 13, 14]) { world.articles[String(id)] = long(id); world.newsHtml += newsCard(id, `WoW: Forever Patch Notes ${id}`, "Long notes"); }
  const gem0 = world.geminiCalls.length;
  const ai0 = (await ai()).calls;
  await poll(); await settle();
  assert.equal((await ai()).calls, ai0, "Workers AI not used while Gemini is healthy");
  assert.equal(world.geminiCalls.length, gem0 + 2, "overflow classified by a second Gemini call");
  const by = (await events("doc_key IN ('news:11','news:12','news:13','news:14')")).map(e => e.classified_by);
  assert.deepEqual(by, ["gemini", "gemini", "gemini", "gemini"]);
  ok("batch overflow waits for Gemini instead of falling back to Workers AI (review #6)");

  // 3g. A Forever-forum copy of a news article (header image + "View Full Article") is not triaged
  //     itself: the article is, from the news feed. Its "realm queues" teaser would otherwise alert.
  const pointer = forumPost({ region: "us", categoryId: 348, title: "Choose Your Ruleset in WoW: Forever", text: "x", topicId: 6500 });
  world.posts[`us:${pointer.id}`].cooked =
    `<p><a href="https://bnetcmsus-a.akamaihd.net/cms/blog_header/qk/QK1.jpg"><img src="https://bnetcmsus-a.akamaihd.net/cms/blog_header/qk/QK1.jpg" alt="Choose Your Ruleset"></a></p>` +
    `<p>Pointer teaser: realm queues explained before launch.</p><p><a href="https://worldofwarcraft.com/en-us/news/21">View Full Article</a></p>`;
  world.usTracker = [...world.usTracker, pointer];
  world.newsHtml += newsCard(21, "Choose Your Ruleset in WoW: Forever", "Normal, PvP and Roleplaying");
  world.articles["21"] = articlePage(["WoW: Forever offers Normal, PvP and Roleplaying rulesets.", "Pick one when you create a character."]);
  const gem1 = world.geminiCalls.length;
  const alerts1 = alerts().length;
  await poll(); await settle();
  const [pe] = await events(`doc_key = 'post:us:${pointer.id}'`);
  assert.deepEqual([pe.state, pe.duplicate_of], ["duplicate", "news:21"], "the post defers to the article");
  assert.ok(!world.geminiCalls.slice(gem1).some(c => c.includes("Pointer teaser")), "the copy isn't sent to the model");
  assert.equal(alerts().length, alerts1, "the copy doesn't alert");
  assert.equal((await doc(`post:us:${pointer.id}`)).watch_tier, 0, "the copy isn't watched for edits");
  assert.equal((await events("doc_key = 'news:21'"))[0].digest_state, "queued", "the article is triaged as usual");
  assert.equal(pe.fingerprint, null, "an untriaged copy can't make a later event look like a crosspost");

  // The copy's own page stays down → its tracker excerpt ("[<title>] …") still identifies it.
  const copyHeader = title => `<a href="https://bnetcmsus-a.akamaihd.net/cms/blog_header/qk/QK2.jpg">[${title}]</a>`;
  const downCopy = forumPost({ region: "us", categoryId: 348, title: "Login Queue Changes for Launch", text: "x", topicId: 6501 });
  downCopy.excerpt = `${copyHeader(downCopy.title)} Excerpt teaser: realm queues at launch&hellip;`;
  world.postFail[`us:${downCopy.id}`] = 99;
  // A copy of an article the news title filter drops is triaged as a post (it's in the Forever forum).
  const storeCopy = forumPost({ region: "us", categoryId: 348, title: "Add the Skyborne Glider to your Collection", text: "x", topicId: 6502 });
  world.posts[`us:${storeCopy.id}`].cooked = world.posts[`us:${pointer.id}`].cooked
    .replace("Pointer teaser: realm queues explained before launch.", "Store copy teaser.").replace("/news/21", "/news/22");
  // Found only through search (e.g. the tracker request failed): the excerpt starts with the image URL.
  const searchCopy = { id: 9990, created_at: iso(5 * 60_000), username: "Kaivax", post_number: 1, topic_id: 6503,
    blurb: "https://bnetcmsus-a.akamaihd.net/cms/blog_header/qk/QK3.jpg Realm Layers Explained Search teaser: layers and queues" };
  world.usSearch = { posts: [...world.usSearch.posts, searchCopy], topics: [...world.usSearch.topics, { id: 6503, title: "Realm Layers Explained", slug: "r", category_id: 348 }] };
  world.postFail[`us:9990`] = 99;
  world.usTracker = [...world.usTracker, downCopy, storeCopy];
  await poll(); await settle();
  const [de] = await events(`doc_key = 'post:us:${downCopy.id}'`);
  assert.deepEqual([de.state, de.duplicate_of], ["duplicate", "news"], "excerpt-only copy still defers (article id unknown)");
  assert.ok(!world.geminiCalls.slice(gem1).some(c => /Excerpt teaser|Search teaser/.test(c)), "excerpts aren't sent to the model");
  const [sce] = await events("doc_key = 'post:us:9990'");
  assert.deepEqual([sce.state, sce.duplicate_of], ["duplicate", "news"], "a search-only copy defers too");
  assert.equal(alerts().length, alerts1, "no alert from either copy");
  const [se] = await events(`doc_key = 'post:us:${storeCopy.id}'`);
  assert.deepEqual([se.state, se.duplicate_of], ["done", null], "copy of a filtered-out article is triaged");
  assert.ok(world.geminiCalls.some(c => c.includes("Store copy teaser")));
  // The page comes back: the full text is another untriaged duplicate, now with the article id.
  world.postFail[`us:${downCopy.id}`] = 0;
  world.posts[`us:${downCopy.id}`].cooked = world.posts[`us:${pointer.id}`].cooked.replace("/news/21", "/news/23");
  await db.prepare("UPDATE documents SET nudged_at = datetime('now', '-1 hour') WHERE key = ?").bind(`post:us:${downCopy.id}`).run();
  const gem2 = world.geminiCalls.length;
  await poll(); await settle();
  const recovered = await events(`doc_key = 'post:us:${downCopy.id}'`);
  assert.deepEqual(recovered.map(e => [e.id.split("@")[1], e.state, e.duplicate_of]).sort(), [["full", "duplicate", "news:23"], ["new", "duplicate", "news"]]);
  assert.equal(world.geminiCalls.length, gem2, "recovery calls no model");
  assert.equal(alerts().length, alerts1, "and sends no alert");
  ok("a forum copy of a news article defers to the article: no model call, no alert, not watched");

  // 4. Article page fails once → retried (not classified from its teaser), then classified in full.
  world.newsHtml += newsCard(5, "Class Tuning Incoming", "Changes arrive next week");
  world.articles["5"] = articlePage(["WoW: Forever class tuning: Paladin Seal of Command damage increased by 10% on November 10."]);
  world.articleFail["5"] = 1;
  await poll();
  s = await settle({ retries: false });
  assert.equal(s.retried, 1);
  assert.equal((await events("doc_key = 'news:5'")).length, 0, "no event from the teaser");
  s = await settle();
  const tuning = (await events("doc_key = 'news:5'"))[0];
  assert.ok(tuning.content.includes("Seal of Command"));
  assert.equal(tuning.relevant, 1);
  assert.equal((await doc("news:5")).watch_tier, 1, "relevant operational article promoted to the watch list");
  ok("failed article fetch is retried, then classified from the full page; operational article watched");

  // 5. Discord down for a critical alert → retried via the work queue, delivered once.
  const outage = forumPost({ region: "us", categoryId: 348, title: "Realms offline", text: "Emergency maintenance in progress.", topicId: 6003, postNumber: 3 });
  world.usTracker = [...world.usTracker, outage];
  world.discordFailNext = 1;
  let before = alerts().length;
  await poll();
  await settle();
  assert.equal(alerts().length, before + 1);
  assert.equal((await events(`doc_key = 'post:us:${outage.id}'`))[0].alert_state, "sent");
  ok("Discord failure on a critical alert is retried and delivered exactly once");

  // 5b. Main Gemini model overloaded (503, seen for hours on 2026-10-28) → the backup Gemini model
  //     classifies the same full text at once, not Workers AI with an excerpt. The main model is
  //     paused briefly, so the next batches don't wait on it first.
  world.geminiModelMode["gemini-3.5-flash-lite"] = "overloaded";
  const busy1 = forumPost({ region: "us", categoryId: 348, title: "Realm restart tonight", text: `Normal realms restart at 03:00 for maintenance. ${"Details. ".repeat(900)}End of the long post.`, topicId: 6010, postNumber: 2 });
  world.usTracker = [...world.usTracker, busy1];
  let models0 = world.geminiModels.length;
  const ai0b = (await ai()).calls;
  await poll(); await settle();
  assert.deepEqual(world.geminiModels.slice(models0), ["gemini-3.5-flash-lite", "gemini-3.6-flash"], "main model first, then the backup");
  assert.ok(world.geminiCalls.at(-1).includes("End of the long post."), "the backup gets the full text (Workers AI would get 6,000 chars)");
  const b1 = (await events(`doc_key = 'post:us:${busy1.id}'`))[0];
  assert.deepEqual([b1.classified_by, b1.critical], ["gemini-backup", 1]);
  assert.equal((await ai()).calls, ai0b, "Workers AI not needed");
  const busy2 = forumPost({ region: "us", categoryId: 348, title: "Thanks for the patience", text: "Appreciate everyone!", topicId: 6011, postNumber: 3 });
  world.usTracker = [...world.usTracker, busy2];
  models0 = world.geminiModels.length;
  await poll(); await settle();
  assert.deepEqual(world.geminiModels.slice(models0), ["gemini-3.6-flash"], "paused main model is skipped");
  const gemini5b = (await call("/status")).body.models.gemini;
  assert.deepEqual(gemini5b.map(m => [m.role, m.model, m.thinking]), [["main", "gemini-3.5-flash-lite", "high"], ["backup", "gemini-3.6-flash", "low"]]);
  const pausedUntil = gemini5b[0].pausedUntil;
  assert.ok(pausedUntil && !gemini5b[1].pausedUntil, "/status shows the main model's pause");
  assert.ok(await db.prepare("SELECT 1 FROM kv WHERE key = 'pause:gemini:gemini-3.5-flash-lite'").first(), "the pause is stored for the model, not its role");
  assert.ok((await call("/status")).body.today["failed:gemini-3.5-flash-lite"] >= 1, "failed calls are counted (they use daily quota too)");
  // The polls above run back to back; in production they're 5 minutes apart (wrangler.toml cron).
  assert.ok(Date.parse(pausedUntil) - Date.now() > 5 * 60_000, "the pause outlasts the next 5-minute poll");
  delete world.geminiModelMode["gemini-3.5-flash-lite"];
  await db.prepare("DELETE FROM kv WHERE key LIKE 'pause:%'").run();
  ok("main Gemini model overloaded: the backup Gemini model classifies the full text; the main model is paused briefly");

  // 6. Both Gemini models out of daily quota → Workers AI takes over, and both are paused (not called again).
  world.geminiMode = "daily";
  const q1 = forumPost({ region: "us", categoryId: 348, title: "Layer update", text: "We added layers; queues should improve.", topicId: 6004, postNumber: 2 });
  world.usTracker = [...world.usTracker, q1];
  let gem = world.geminiModels.length;
  let aiCalls = (await ai()).calls;
  await poll(); await settle();
  assert.deepEqual(world.geminiModels.slice(gem), ["gemini-3.5-flash-lite", "gemini-3.6-flash"], "each Gemini model tried once");
  assert.equal((await ai()).calls, aiCalls + 1, "Workers AI used");
  assert.equal((await events(`doc_key = 'post:us:${q1.id}'`))[0].classified_by, "workers-ai");
  const q2 = forumPost({ region: "us", categoryId: 348, title: "Camping feedback", text: "Glad you like campfires!", author: "Aggrend", topicId: 6005, postNumber: 5 });
  world.usTracker = [...world.usTracker, q2];
  await poll(); await settle();
  assert.equal(world.geminiModels.length, gem + 2, "paused Gemini models not called again");
  assert.equal((await events(`doc_key = 'post:us:${q2.id}'`))[0].classified_by, "workers-ai");
  const models6 = (await call("/status")).body.models;
  assert.ok(models6.gemini.every(m => m.pausedUntil), "/status shows both pauses");
  ok("Gemini daily quota on both models: Workers AI classifies instead, both paused instead of retried every batch");

  // 7. Both models out of quota: urgent Blue Post alerts on keywords now; routine post waits, then falls back.
  await ai("quota");
  const urgent = forumPost({ region: "us", categoryId: 348, title: "Login queue status", text: "Queues are long on Normal realms; adding capacity.", topicId: 6006, postNumber: 2 });
  const routine = forumPost({ region: "us", categoryId: 348, title: "Love the Legacy system", text: "Thanks for the kind words!", author: "Aggrend", topicId: 6007, postNumber: 9 });
  world.usTracker = [...world.usTracker, urgent, routine];
  before = alerts().length;
  await poll();
  s = await settle({ retries: false });
  assert.equal((await events(`doc_key = 'post:us:${urgent.id}'`))[0].classified_by, "keywords");
  assert.equal(alerts().length, before + 1);
  assert.ok(!alerts().at(-1).embeds[0].description.includes("TL;DR"), "no TL;DR without a model");
  assert.match(alerts().at(-1).embeds[0].description, /Queues are long on Normal realms/, "the alert shows the post itself");
  assert.equal((await events(`doc_key = 'post:us:${routine.id}'`))[0].state, "pending", "routine post waits for a model");
  // (review #4) Age nudged_at, defer once more, and check the deferral refreshed it.
  await db.prepare("UPDATE events SET nudged_at = datetime('now', '-1 hour') WHERE doc_key = ?").bind(`post:us:${routine.id}`).run();
  await settle({ maxRounds: 1 });
  assert.equal((await db.prepare("SELECT nudged_at > datetime('now', '-1 minute') AS fresh FROM events WHERE doc_key = ?").bind(`post:us:${routine.id}`).first()).fresh, 1,
    "deferral refreshes nudged_at so the sweeper doesn't queue a duplicate (review #4)");
  for (let i = 0; i < 6; i++) await settle({ maxRounds: 1 });
  const r = (await events(`doc_key = 'post:us:${routine.id}'`))[0];
  assert.equal(r.state, "done");
  assert.equal(r.classified_by, "keywords");
  assert.equal(r.digest_state, "queued");
  await ai("ok");
  await db.prepare("DELETE FROM kv WHERE key LIKE 'pause:%'").run();
  world.geminiMode = "ok";
  ok("no model available: urgent Blue Post alerts on keywords at once; routine post retried, then classified");

  // 8. Hotfix post edited in place: only the new section is triaged, alerted once.
  world.articles["2"] = articlePage(["November 6, 2026", "WoW: Forever", "Fixed an issue causing realms to go offline during login queues.",
    "November 4, 2026", "World of Warcraft: Midnight", "Fixed an issue with Delves for Midnight players only."]);
  await makeDue("key = 'news:2'");
  before = alerts().length;
  await poll(); await settle();
  const p8 = world.geminiCalls.at(-1);
  assert.ok(p8.includes("[EDITED"));
  assert.ok(p8.includes("[NEW] Fixed an issue causing realms to go offline"));
  assert.ok(p8.includes("\nFixed an issue with Delves for Midnight players only."), "old text present unmarked as context");
  assert.equal(alerts().length, before + 1);
  assert.match(alerts().at(-1).embeds[0].title, /\(updated\)/);
  await makeDue("key = 'news:2'");
  gem = world.geminiCalls.length;
  await poll(); s = await settle();
  assert.equal(s.work, 0, "probe unchanged → nothing queued");
  assert.equal(world.geminiCalls.length, gem);
  ok("hotfix post edit: probe detects it, only [NEW] lines judged, alerted once");

  // 8b. An edit that only adds a video (its link line is shorter than the usual minimum) has no text
  //     to judge: no model call, never an alert; it goes to the digest, as the article is relevant.
  world.articles["2"] = world.articles["2"].replace("</article>", `<iframe src="https://www.youtube.com/embed/mFOkBPMKJhc"></iframe></article>`);
  await makeDue("key = 'news:2'");
  gem = world.geminiCalls.length;
  before = alerts().length;
  await poll(); await settle();
  const e8b = (await events("doc_key = 'news:2' AND kind = 'edit'")).filter(e => e.content.includes("[NEW] https://youtu.be/mFOkBPMKJhc"));
  assert.equal(e8b.length, 1, "an edit event for the added video");
  assert.deepEqual([e8b[0].state, e8b[0].classified_by, e8b[0].relevant, e8b[0].critical, e8b[0].digest_state], ["done", "video-edit", 1, 0, "queued"]);
  assert.equal(world.geminiCalls.length, gem, "no model call");
  assert.equal(alerts().length, before, "no alert");
  ok("an edit that only adds a video goes to the digest, without the model");

  // 9. Only the related-articles card changes → probe ignores it.
  world.articles["2"] = world.articles["2"].replace("Related: Skyborne story", "Related: Something completely different now");
  await makeDue("key = 'news:2'");
  await poll(); s = await settle();
  assert.equal(s.work, 0, "related-article changes don't trigger a fetch");
  ok("changes outside the article body are ignored by the probe");

  // 10. Known Issues threads (US + EU copy) edited the same way → one alert. A second, different edit
  //     to the US thread alerts again (v3.2 would have dropped it as a duplicate).
  const kiUs = forumPost({ region: "us", categoryId: 348, title: "WoW: Forever Launch Known Issues", text: "We are tracking the following issues.\nSome quest givers are missing.", topicId: 6100 });
  const kiEu = forumPost({ region: "eu", categoryId: 360, title: "WoW: Forever Launch Known Issues", text: "We are tracking the following issues.\nSome quest givers are missing.", author: "Linxy", topicId: 7100 });
  world.usTracker = [...world.usTracker, kiUs];
  world.euTracker = [...world.euTracker, kiEu];
  await poll(); await settle();
  assert.equal((await doc(`post:us:${kiUs.id}`)).watch_tier, 2);
  const edit = extra => ["We are tracking the following issues.", ...extra, "Some quest givers are missing."].map(l => `<p>${l}</p>`).join("");
  world.posts[`us:${kiUs.id}`].cooked = edit(["Players are stuck in login queues on Normal realms; we are adding capacity."]);
  world.posts[`eu:${kiEu.id}`].cooked = edit(["Players are stuck in login queues on Normal realms; we are adding capacity."]);
  await makeDue("key IN ('post:us:" + kiUs.id + "', 'post:eu:" + kiEu.id + "')");
  before = alerts().length;
  await poll(); await settle();
  assert.equal(alerts().length, before + 1, "one alert; EU copy collapsed");
  assert.match(alerts().at(-1).embeds[0].title, /Known Issues \(edited\)/);
  world.posts[`us:${kiUs.id}`].cooked = edit(["Players are stuck in login queues on Normal realms; we are adding capacity.", "Some realms are offline for an emergency restart."]);
  await makeDue("key = 'post:us:" + kiUs.id + "'");
  await poll(); await settle();
  assert.equal(alerts().length, before + 2, "second, different edit to the same thread alerts again");
  assert.ok(world.geminiCalls.at(-1).includes("[NEW] Some realms are offline"));
  ok("Blue Post thread edits: US/EU copies collapse; successive edits each alert");

  // 11. Self-healing: a lost classify message is re-queued by the sweeper.
  const lost = forumPost({ region: "us", categoryId: 348, title: "Realm restart tonight", text: "Normal realms restart at 2 a.m. for maintenance.", topicId: 6200, postNumber: 2 });
  world.usTracker = [...world.usTracker, lost];
  await poll();
  await settle({ maxRounds: 1 });                   // work runs; classify message is produced…
  await (await fakes.fetch("http://fakes/drain")).json(); // …and lost
  const lostId = `post:us:${lost.id}@new`;
  assert.equal((await events(`id = '${lostId}'`))[0].state, "pending");
  await db.prepare("UPDATE events SET nudged_at = datetime('now', '-1 hour') WHERE id = ?").bind(lostId).run();
  before = alerts().length;
  await poll(); await settle();
  assert.equal((await events(`id = '${lostId}'`))[0].state, "done");
  assert.equal(alerts().length, before + 1);
  ok("sweeper re-queues work whose queue message was lost");

  // 12. Digest: not before 5 PM Pacific; Discord fails at 5:00; retried at 5:05; sent once.
  const bulk = [];
  for (let i = 0; i < 40; i++) {
    const news = i % 4 === 0;
    bulk.push(db.prepare(`INSERT INTO events (id, doc_key, kind, source, title, url, author, content, state, relevant, critical, category, summary, digest_state)
      VALUES (?, 'x', 'new', ?, ?, ?, 'Kaivax', ?, 'done', 1, 0, 'Developer Blue Post', ?, 'queued')`)
      .bind(`bulk-${i}`, news ? "Blizzard News" : "Blue Post (US)", `Bulk item ${i}`, `https://us.forums.blizzard.com/en/wow/t/x/${i}/1`,
        `Bulk post ${i} body. ${"More text here. ".repeat(80)}`, `TL;DR for bulk item ${i}.`));
  }
  await db.batch(bulk);
  const queued = (await events("digest_state = 'queued'")).length;
  let d0 = world.discord.length;
  await poll(pt("16:00"));
  assert.equal(world.discord.length, d0, "no digest before 5 PM Pacific");
  world.discordFailNext = 1;
  world.discordFailStatus = 400; // Discord refused it: nothing was posted
  await poll(pt("17:00"));
  assert.equal(world.discord.length, d0);
  assert.equal((await events("digest_state = 'queued'")).length, queued);
  await poll(pt("17:05"));
  const digestMsgs = world.discord.slice(d0);
  assert.equal(digestMsgs.length, 1, "one digest message a day");
  const dm = digestMsgs[0];
  assert.equal(dm.content, `${queued} updates today`);
  assert.deepEqual(dm.allowed_mentions, { parse: [] });
  assert.deepEqual(dm.embeds.map(e => e.color), [0x00aeff, 0xf8b700], "Blue Posts in blue, news in gold");
  assert.ok(dm.embeds.reduce((n, e) => n + e.description.length, 0) <= 6000 && dm.embeds.every(e => e.description.length <= 4096 && !e.footer && !e.fields));
  assert.ok(dm.embeds[0].description.includes("**[Bulk item 1](https://us.forums.blizzard.com/en/wow/t/1/1)**\n> TL;DR for bulk item 1."));
  assert.equal((await events("digest_state = 'queued'")).length, 0, "every queued item went into the one message");
  d0 = world.discord.length;
  await poll(pt("17:10"));
  assert.equal(world.discord.length, d0, "once per day");
  world.discordFailStatus = 500;
  ok("digest: waits for 5 PM Pacific, retries after Discord refuses it, drains the queue, sends once");

  // 12b. A day with more items than the digest loads (DIGEST_MAX_ITEMS = 500) is still ONE message.
  const queueBulk = async (n, prefix) => {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      stmts.push(db.prepare(`INSERT INTO events (id, doc_key, kind, source, title, url, author, content, state, relevant, critical, category, summary, digest_state)
        VALUES (?, 'x', 'new', 'Blue Post (US)', ?, ?, 'Kaivax', ?, 'done', 1, 0, 'Developer Blue Post', '', 'queued')`)
        .bind(`${prefix}-${i}`, `${prefix} item ${i}`, `https://us.forums.blizzard.com/en/wow/t/${prefix}/${i}/1`, `Body ${i}. ${"Text. ".repeat(50)}`));
    }
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  };
  const nextDigestDay = async () => db.prepare("DELETE FROM kv WHERE key IN ('digest:last', 'digest:inflight')").run();
  // The one "digest in progress" row every run (scheduled or manual) must create before posting.
  const inFlight = (name, ids, state, ageMin) => db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('digest:inflight', ?, datetime('now', ?))`)
    .bind(JSON.stringify({ name, ids, state }), `-${ageMin} minutes`).run();
  const digestDay = async () => (await db.prepare("SELECT value FROM kv WHERE key = 'digest:last'").first())?.value ?? null;
  await nextDigestDay();
  await queueBulk(510, "big");
  d0 = world.discord.length;
  await poll(pt("17:00"));
  assert.equal(world.discord.length, d0 + 1, "one message");
  assert.equal(world.discord.at(-1).content, "510 updates today");
  assert.match(world.discord.at(-1).embeds.at(-1).description, /…and \d+ more updates$/);
  assert.equal((await events("digest_state = 'queued'")).length, 0, "everything counted is marked sent");
  await poll(pt("17:05"));
  assert.equal(world.discord.length, d0 + 1, "no second message that day");
  ok("digest: more items than it loads → still one message, the rest counted");

  // 12c. Discord takes the digest but the reply is lost → treated as sent, never posted twice.
  await nextDigestDay();
  await queueBulk(3, "lost");
  world.discordDropReplyNext = 1;
  d0 = world.discord.length;
  await poll(pt("17:00"));
  assert.equal(world.discord.length, d0 + 1);
  assert.equal((await events("digest_state = 'queued'")).length, 0, "an unanswered post counts as sent");
  await poll(pt("17:05"));
  assert.equal(world.discord.length, d0 + 1, "not posted again");
  // A 5xx is just as unclear (Discord may have taken it before the error): also counted as sent.
  await nextDigestDay();
  await queueBulk(2, "e503");
  world.discordFailNext = 1;
  world.discordFailStatus = 503;
  d0 = world.discord.length;
  await poll(pt("17:00"));
  world.discordFailStatus = 500;
  assert.equal((await events("digest_state = 'queued'")).length, 0, "a 5xx counts as sent");
  await poll(pt("17:05"));
  assert.equal(world.discord.length, d0, "and isn't retried");
  ok("digest: a lost reply or a 5xx from Discord doesn't make it post the digest twice");

  // 12d. A run posted the digest but stopped before marking its items → the next run marks them
  //      without posting again.
  await nextDigestDay();
  await queueBulk(2, "half");
  await inFlight(digestToday, ["half-0", "half-1"], "posting", 10);
  d0 = world.discord.length;
  await poll(pt("17:10"));
  assert.equal(world.discord.length, d0, "the earlier run's digest isn't posted again");
  assert.equal((await events("digest_state = 'queued'")).length, 0);
  assert.equal(await digestDay(), digestToday, "and the day is closed");
  ok("digest: a run that posted but didn't finish is completed without a second post");

  // 12e. A manual /run-digest is posting right now → the scheduled run leaves it alone.
  await nextDigestDay();
  await queueBulk(2, "busy");
  await inFlight("manual:2026-11-04T22:59:00.000Z", ["busy-0", "busy-1"], "posting", 0);
  d0 = world.discord.length;
  await poll(pt("17:10"));
  assert.equal(world.discord.length, d0, "no second post while another run is posting");
  assert.equal((await events("digest_state = 'queued'")).length, 2, "its items are left to that run");
  assert.notEqual(await digestDay(), digestToday, "the day isn't closed for it either");
  await db.prepare(`UPDATE kv SET updated_at = datetime('now', '-10 minutes') WHERE key = 'digest:inflight'`).run();
  await poll(pt("17:15"));
  assert.equal((await events("digest_state = 'queued'")).length, 0, "once that run is clearly over, its items are marked sent");
  assert.equal(world.discord.length, d0, "and not posted again by the scheduled run");
  ok("digest: a manual and a scheduled run can't both post the same items");

  // 12f. An unfinished claim from another day or a manual send is completed first; today's digest
  //      then covers only what's left.
  await nextDigestDay();
  await queueBulk(2, "old");
  await queueBulk(1, "new");
  await inFlight("manual:2026-11-01T10:00:00.000Z", ["old-0", "old-1"], "posting", 3 * 24 * 60);
  d0 = world.discord.length;
  await poll(pt("17:00"));
  assert.equal(world.discord.length, d0 + 1);
  assert.equal(world.discord.at(-1).content, "1 update today", "the older run's items aren't posted again");
  assert.equal((await events("digest_state = 'queued'")).length, 0);
  ok("digest: an older unfinished run is completed, whatever its day, without reposting its items");

  // 12g. A run stopped while still preparing (before it reached Discord) → nothing was posted, so
  //      the next run simply sends the digest.
  await nextDigestDay();
  await queueBulk(2, "prep");
  await inFlight(digestToday, [], "preparing", 10);
  d0 = world.discord.length;
  await poll(pt("17:20"));
  assert.equal(world.discord.length, d0 + 1, "the digest is sent");
  assert.equal(world.discord.at(-1).content, "2 updates today");
  assert.equal((await events("digest_state = 'queued'")).length, 0);
  ok("digest: a run that stopped before posting doesn't cost the day its digest");

  // 12h. /run-digest sends today's digest now, and it is the day's only one: the scheduled run then
  //      skips, and a second manual send does nothing.
  await nextDigestDay();
  await queueBulk(2, "manual");
  d0 = world.discord.length;
  const manual1 = await call("/run-digest");
  assert.equal(manual1.status, 200);
  assert.equal(world.discord.length, d0 + 1, "the manual send posts the digest");
  assert.equal(await digestDay(), digestToday, "and it counts as today's digest");
  await queueBulk(1, "after");
  await poll(pt("17:00"));
  assert.equal(world.discord.length, d0 + 1, "no second digest at 5 PM");
  const manual2 = await call("/run-digest");
  assert.equal(world.discord.length, d0 + 1, "nor from a second manual send");
  assert.equal(manual2.body.alreadySentToday, true);
  assert.equal((await events("digest_state = 'queued'")).length, 1, "the late item waits for tomorrow's digest");
  ok("digest: a manual send is the day's one digest");

  // 12i. "Digest sent" for a later day also closes every earlier one, and isn't moved back.
  await nextDigestDay();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('digest:last', '2099-01-01', datetime('now'))").run();
  await queueBulk(1, "later");
  d0 = world.discord.length;
  await poll(pt("17:10"));
  await call("/run-digest");
  assert.equal(world.discord.length, d0, "no digest for an earlier day, scheduled or manual");
  assert.equal(await digestDay(), "2099-01-01", "the later day stays recorded");
  // A run completing an older unfinished digest doesn't move the day back (here today's own send is
  // then refused, so only that older close is written).
  await db.prepare("UPDATE events SET digest_state = 'sent' WHERE digest_state = 'queued'").run();
  await nextDigestDay();
  await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('digest:last', '2026-11-03', datetime('now'))").run();
  await queueBulk(1, "older");
  await queueBulk(1, "today");
  await inFlight("2026-11-01", ["older-0"], "posting", 10);
  world.discordFailNext = 1;
  world.discordFailStatus = 400;
  await poll(pt("17:10"));
  world.discordFailStatus = 500;
  assert.equal(await digestDay(), "2026-11-03", "completing the 11-01 digest doesn't move the day back");
  ok("digest: the 'sent' day only moves forward");
  await db.prepare("UPDATE events SET digest_state = 'sent' WHERE digest_state = 'queued'").run();
  await nextDigestDay();

  // /status shows a digest in progress.
  await inFlight("manual:2026-11-04T23:30:00.000Z", [], "posting", 0);
  const inflightStatus = (await call("/status")).body.digestInFlight;
  assert.deepEqual([inflightStatus?.name, inflightStatus?.state], ["manual:2026-11-04T23:30:00.000Z", "posting"]);
  await nextDigestDay();

  // 13. Health: news parser returns nothing for 30 min → one warning; stuck work → queue warning.
  world.newsHtml = "<html><body>Loading…</body></html>";
  d0 = world.discord.length;
  for (let i = 0; i < 7; i++) { await poll(); await settle(); }
  let warnings = world.discord.slice(d0).filter(m => /health warning/.test(m.embeds?.[0]?.title ?? ""));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].embeds[0].description, /news/);
  await db.prepare(`INSERT INTO documents (key, kind, source, url, title, author, status, first_seen, nudged_at)
    VALUES ('post:us:1', 'post', 'Blue Post (US)', 'u', 't', 'a', 'new', datetime('now', '-2 hours'), datetime('now'))`).run();
  d0 = world.discord.length;
  await poll();
  warnings = world.discord.slice(d0).filter(m => /health warning/.test(m.embeds?.[0]?.title ?? ""));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].embeds[0].description, /queues/);
  await (await fakes.fetch("http://fakes/drain")).json();
  // (audit #3) A digest item still waiting after a day: Discord keeps refusing the digest.
  await db.prepare(`INSERT INTO events (id, doc_key, kind, source, title, url, author, content, state, digest_state, created_at)
    VALUES ('stuck-digest', 'news:x', 'new', 'Blizzard News', 't', 'u', 'a', 'c', 'done', 'queued', datetime('now', '-26 hours'))`).run();
  await db.prepare("DELETE FROM kv WHERE key = 'warn:backlog'").run();
  // Not stuck when the day's digest already went (e.g. sent early by hand): the item waits for the next one.
  await db.prepare("INSERT INTO kv (key, value) VALUES ('digest:last', '2099-01-01')").run();
  assert.equal((await call("/status")).body.stuck.digest, 0);
  await db.prepare("DELETE FROM kv WHERE key = 'digest:last'").run();
  d0 = world.discord.length;
  await poll();
  warnings = world.discord.slice(d0).filter(m => /health warning/.test(m.embeds?.[0]?.title ?? ""));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].embeds[0].description, /1 digest item\(s\) waiting: a digest was due/);
  assert.equal((await call("/status")).body.stuck.digest, 1);
  await db.prepare("DELETE FROM events WHERE id = 'stuck-digest'").run();
  await (await fakes.fetch("http://fakes/drain")).json();
  ok("health: broken source, stuck queue and stuck digest each produce one warning");

  // 14. /status and /debug
  const st = (await call("/status")).body;
  assert.ok(st.today["classified:gemini"] > 0 && st.today["classified:gemini-backup"] > 0 && st.today["classified:workers-ai"] > 0 && st.today["classified:keywords"] > 0);
  assert.ok(st.watching.some(w => w.key === "news:2" && w.watch_tier === 3));
  world.newsHtml = newsCard(2, "Hotfixes: November 4, 2026", "x");
  const dbg = (await call("/debug")).body;
  assert.deepEqual(dbg.categories.us.ids, [347, 348]);
  assert.deepEqual(dbg.categories.eu.ids, [359, 360]);
  // news:2 has had a video since 8b: its link comes first, then the body.
  assert.deepEqual(dbg.articleProbe.firstLines.slice(0, 2), ["https://youtu.be/mFOkBPMKJhc", "# Article"]);
  assert.ok(dbg.articleProbe.lines > 3);
  assert.ok(dbg.postProbe.fields.includes("cooked"));
  ok("/status shows counters, pauses and watch list; /debug shows categories and extraction samples");

  {
    // 15. Other servers: the public "Add to Discord" page (OAuth webhook.incoming), per-server roles, fan-out.
    const page = async (path, init = {}) => {
      const res = await mf.dispatchFetch(`http://localhost${path}`, { redirect: "manual", ...init });
      return { status: res.status, headers: res.headers, text: await res.text() };
    };
    const startInstall = async () => {
      const r = await page("/discord/install");
      assert.equal(r.status, 302);
      return { state: new URL(r.headers.get("location")).searchParams.get("state"), cookie: r.headers.get("set-cookie").split(";")[0], r };
    };
    const GUILD = "523456789012345678";
    const hookToken = id => `tok_${id}_${"x".repeat(40)}`;
    const connect = async ({ webhookId, channelId, guildId = GUILD, install }) => {
      const code = `code-${webhookId}`;
      world.oauthCodes[code] = { id: webhookId, token: hookToken(webhookId), channel_id: channelId, guild_id: guildId, type: 1, name: "ForeverUpdates" };
      const { state, cookie } = install ?? await startInstall();
      return page(`/discord/callback?code=${code}&state=${state}`, { headers: { Cookie: cookie } });
    };
    const form = (fields) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    const hookRow = id => db.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first();
    const sentTo = (id, from = 0) => world.discord.slice(from).filter((m, i) => world.discordTo[from + i] === id);

    {
      let r = await page("/");
      assert.equal(r.status, 200);
      assert.match(r.text, /href="\/discord\/install"/);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer");
      assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
      const { state, cookie, r: inst } = await startInstall();
      const loc = new URL(inst.headers.get("location"));
      assert.equal(`${loc.origin}${loc.pathname}`, "https://discord.com/oauth2/authorize");
      assert.deepEqual([loc.searchParams.get("client_id"), loc.searchParams.get("scope"), loc.searchParams.get("response_type"), loc.searchParams.get("redirect_uri")],
        ["test-client-id", "webhook.incoming", "code", "http://localhost/discord/callback"]);
      assert.match(inst.headers.get("set-cookie"), /^__Host-fu_oauth_state=[\w-]{20,}; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);

      // The state must match this browser's cookie (no login CSRF); the code isn't even tried otherwise.
      world.oauthCodes["code-x"] = { id: "300000000000000001", token: hookToken(1), channel_id: "400000000000000001", guild_id: GUILD };
      const exchanges = world.oauthExchanges;
      assert.equal((await page(`/discord/callback?code=code-x&state=${state}`)).status, 400, "no cookie");
      assert.equal((await page(`/discord/callback?code=code-x&state=wrong${state}`, { headers: { Cookie: cookie } })).status, 400, "wrong state");
      r = await page(`/discord/callback?error=access_denied&state=${state}`, { headers: { Cookie: cookie } });
      assert.deepEqual([r.status, /Nothing was added/.test(r.text)], [200, true], "cancelled on Discord's page");
      assert.equal(world.oauthExchanges, exchanges);
      assert.equal((await page(`/discord/callback?code=nope&state=${state}`, { headers: { Cookie: cookie } })).status, 502, "Discord refuses the code");
      assert.equal(await db.prepare("SELECT 1 FROM webhooks").first(), null);
    }
    ok("public page: Add to Discord asks for webhook.incoming; the callback needs the matching state cookie");

    // Two servers' channels; the first sets a role.
    const A1 = "310000000000000001", A_CH = "410000000000000001", B = "320000000000000002", B_CH = "420000000000000002", A2 = "330000000000000003";
    const ROLE = "623456789012345678";
    let d0 = world.discord.length;
    let r = await connect({ webhookId: A1, channelId: A_CH });
    assert.equal(r.status, 303);
    assert.match(r.headers.get("set-cookie"), /Max-Age=0/, "the state cookie is cleared");
    const manageA1 = r.headers.get("location");
    const keyA1 = new URL(manageA1, "http://localhost").searchParams.get("key");
    assert.match(manageA1, /^\/discord\/manage\?id=310000000000000001&key=[\w-]{40,}&new=1$/);
    const rowA1 = await hookRow(A1);
    assert.deepEqual([rowA1.token, rowA1.channel_id, rowA1.guild_id, rowA1.role_id], [hookToken(A1), A_CH, GUILD, null]);
    assert.ok(rowA1.manage_hash && !rowA1.manage_hash.includes(keyA1), "only the key's hash is stored");
    const welcome = sentTo(A1, d0);
    assert.equal(welcome.length, 1);
    assert.match(welcome[0].embeds[0].title, /set up in this channel/);
    assert.deepEqual(welcome[0].allowed_mentions, { parse: [] });
    r = await page(manageA1);
    assert.deepEqual([r.status, /This channel is set up/.test(r.text), r.text.includes(`discord.com/channels/${GUILD}/${A_CH}`)], [200, true, true]);
    assert.equal((await page(`/discord/manage?id=${A1}&key=wrong`)).status, 404);
    assert.equal((await page(`/discord/manage?id=${A1}`)).status, 404);

    d0 = world.discord.length;
    r = await page("/discord/manage", form({ id: A1, key: keyA1, action: "role", role: "Raiders" }));
    assert.deepEqual([r.status, /isn't a role ID/.test(r.text), world.discord.length], [400, true, d0], "a bad role is refused; nothing posted");
    r = await page("/discord/manage", form({ id: A1, key: "wrong", action: "role", role: ROLE }));
    assert.equal(r.status, 404, "the key is needed to change it");
    r = await page("/discord/manage", form({ id: A1, key: keyA1, action: "role", role: GUILD }));
    assert.equal(r.status, 400, "@everyone (the server's own ID) is refused");
    r = await page("/discord/manage", form({ id: A1, key: keyA1, action: "role", role: `<@&${ROLE}>` }));
    assert.equal(r.status, 303);
    assert.match(r.headers.get("location"), /&saved=1$/);
    assert.equal((await hookRow(A1)).role_id, ROLE);
    const notice = sentTo(A1, d0);
    assert.equal(notice.length, 1);
    assert.match(notice[0].content, new RegExp(`<@&${ROLE}>`));
    assert.deepEqual(notice[0].allowed_mentions, { parse: [] }, "showing the role doesn't ping it");
    assert.equal((await connect({ webhookId: B, channelId: B_CH, guildId: "723456789012345678" })).status, 303);

    // The same channel added again: its earlier webhook is deleted and replaced, keeping the role.
    // An alert still waiting for the old webhook moves to the new one; finished rows don't.
    await db.prepare(`INSERT INTO deliveries (broadcast_id, webhook_id, state) VALUES ('t-waiting', ?1, 'pending'), ('t-done', ?1, 'sent')`).bind(A1).run();
    r = await connect({ webhookId: A2, channelId: A_CH });
    assert.equal(r.status, 303);
    const keyA2 = new URL(r.headers.get("location"), "http://localhost").searchParams.get("key");
    assert.ok(world.deletedWebhooks.includes(A1));
    assert.equal(await hookRow(A1), null);
    assert.equal((await hookRow(A2)).role_id, ROLE);
    assert.equal((await page(manageA1)).status, 404, "the old manage link stops working");
    const moved = (await db.prepare("SELECT broadcast_id, webhook_id, state FROM deliveries WHERE broadcast_id LIKE 't-%'").all()).results;
    assert.deepEqual(moved, [{ broadcast_id: "t-waiting", webhook_id: A2, state: "pending" }]);
    await db.prepare("DELETE FROM deliveries WHERE broadcast_id LIKE 't-%'").run();
    let st = await call("/status");
    assert.equal(st.body.subscribers.channels, 2);
    assert.ok(!JSON.stringify(st.body).includes("tok_"), "/status never shows webhook tokens");
    ok("public page: a channel is added from Discord's answer, sets its own role, and re-adding it replaces it");

    // A critical alert reaches the owner and both servers, each with its own role (or none).
    world.geminiMode = "ok"; world.geminiModelMode = {}; await ai("ok");
    await db.prepare("DELETE FROM kv WHERE key LIKE 'pause:%'").run();
    d0 = world.discord.length;
    world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: "Emergency realm restarts", text: "Realms are offline for an emergency restart.", topicId: 9101 })];
    await poll(); await settle();
    const owner1 = sentTo("1", d0).filter(m => m.embeds?.[0]?.title?.includes("Emergency realm restarts"));
    const a1 = sentTo(A2, d0), b1 = sentTo(B, d0);
    assert.deepEqual([owner1.length, a1.length, b1.length], [1, 1, 1]);
    assert.deepEqual(a1[0].embeds, owner1[0].embeds, "the same alert");
    assert.deepEqual([a1[0].content, a1[0].allowed_mentions], [`<@&${ROLE}>`, { parse: [], roles: [ROLE] }], "server A pings its role");
    assert.deepEqual([b1[0].content, b1[0].allowed_mentions], [undefined, { parse: [] }], "server B has no role");
    assert.deepEqual([owner1[0].content, owner1[0].allowed_mentions], [undefined, { parse: [] }], "the owner's role setting is its own");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'sent'").first()).n, 2);
    await poll(); await settle();
    assert.equal(world.discord.length, d0 + 3, "nothing is sent twice");
    ok("fan-out: a critical alert goes to every server's channel, each with its own role");

    // Server B deleted the webhook (404): that channel is forgotten. Server A's Discord fails once: its
    // delivery stays pending and the sweeper restarts it once its claim has expired.
    world.goneWebhooks.add(B);
    world.webhookFail[A2] = 1;
    d0 = world.discord.length;
    world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: "Login queue update", text: "Login queues are back after the restart.", topicId: 9102 })];
    await poll(); await settle();
    assert.equal(await hookRow(B), null, "a deleted webhook removes the channel");
    assert.equal(sentTo(A2, d0).length, 0);
    const pendingA = await db.prepare("SELECT * FROM deliveries WHERE webhook_id = ?").bind(A2).all();
    assert.deepEqual(pendingA.results.map(x => [x.state, x.attempts]).filter(([s]) => s === "pending"), [["pending", 1]]);
    assert.match(pendingA.results.find(x => x.state === "pending").last_error, /502/);
    await poll(); await settle();
    assert.equal(sentTo(A2, d0).length, 0, "not again while its claim holds");
    await db.prepare("UPDATE deliveries SET claimed_at = datetime('now', '-10 minutes') WHERE state = 'pending'").run();
    await db.prepare("UPDATE broadcasts SET nudged_at = datetime('now', '-30 minutes')").run();
    await poll(); await settle();
    assert.equal(sentTo(A2, d0).length, 1, "the sweeper restarted it");
    assert.match(sentTo(A2, d0)[0].embeds[0].title, /Login queue update/);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'pending'").first()).n, 0);
    ok("fan-out: a removed webhook drops its channel; a failed post is retried after its claim expires");

    // The digest goes to every channel too, once a day, without pinging.
    await db.prepare("DELETE FROM kv WHERE key IN ('digest:last', 'digest:inflight')").run();
    world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: "Thanks for the Skyborne feedback", text: "We read every post. Thank you!", topicId: 9103 })];
    await poll(); await settle();
    d0 = world.discord.length;
    let stateDuringPost = null;
    world.onWebhookPost = async id => {
      if (id === A2) stateDuringPost = (await db.prepare("SELECT state FROM deliveries WHERE webhook_id = ? AND broadcast_id LIKE 'digest:%'").bind(A2).first())?.state;
    };
    await poll(pt("17:05")); await settle();
    world.onWebhookPost = null;
    assert.equal(stateDuringPost, "sent", "marked sent before the post: a run that stops mid-post never reposts it");
    const ownerDigest = sentTo("1", d0).filter(m => /updates? today$/.test(m.content ?? ""));
    const aDigest = sentTo(A2, d0);
    assert.deepEqual([ownerDigest.length, aDigest.length], [1, 1]);
    assert.deepEqual([aDigest[0].content, aDigest[0].embeds], [ownerDigest[0].content, ownerDigest[0].embeds]);
    assert.deepEqual(aDigest[0].allowed_mentions, { parse: [] }, "the digest never pings");
    assert.equal((await db.prepare("SELECT state FROM deliveries WHERE broadcast_id = ?").bind(`digest:${digestToday}`).first())?.state, "sent");
    await poll(pt("17:10")); await settle();
    assert.equal(sentTo(A2, d0).length, 1, "one digest a day");
    ok("fan-out: the daily digest goes to every channel once, without pings");

    // A digest Discord rate-limited (429) wasn't posted: it's retried. After a 5xx it may have been: never again.
    const digestAgain = async (topicId, fail) => {
      await db.prepare("DELETE FROM deliveries WHERE broadcast_id LIKE 'digest:%'").run();
      await db.prepare("DELETE FROM broadcasts WHERE id LIKE 'digest:%'").run();
      await db.prepare("DELETE FROM kv WHERE key IN ('digest:last', 'digest:inflight')").run();
      world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: `Skyborne notes ${topicId}`, text: "Some thoughts on Skyborne.", topicId })];
      await poll(); await settle();
      fail();
      const from = world.discord.length;
      await poll(pt("17:05")); await settle();
      assert.equal(sentTo(A2, from).length, 0);
      const row = await db.prepare("SELECT state, last_error FROM deliveries WHERE webhook_id = ? AND broadcast_id LIKE 'digest:%'").bind(A2).first();
      await db.prepare("UPDATE deliveries SET claimed_at = datetime('now', '-10 minutes') WHERE broadcast_id LIKE 'digest:%'").run();
      await db.prepare("UPDATE broadcasts SET nudged_at = datetime('now', '-30 minutes')").run();
      await poll(pt("17:10")); await settle();
      return { row, later: sentTo(A2, from).length };
    };
    let again = await digestAgain(9105, () => { world.webhook429[A2] = 1; });
    assert.equal(again.row.state, "pending");
    assert.match(again.row.last_error, /rate limited/);
    assert.equal(again.later, 1, "posted once the claim expired");
    again = await digestAgain(9106, () => { world.webhookFail[A2] = 1; });
    assert.equal(again.row.state, "sent");
    assert.match(again.row.last_error, /maybe posted: .*502/);
    assert.equal(again.later, 0, "never reposted");
    ok("fan-out: a rate-limited digest is retried; one that may have been posted is not");

    // Remove from the manage page: the webhook is deleted on Discord too.
    r = await page("/discord/manage", form({ id: A2, key: keyA2, action: "remove" }));
    assert.deepEqual([r.status, /Removed/.test(r.text)], [200, true]);
    assert.ok(world.deletedWebhooks.includes(A2));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM webhooks").first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deliveries").first()).n, 0);
    ok("public page: Remove deletes the webhook and forgets the channel");

    // One server can add at most MAX_CHANNELS_PER_SERVER (3) channels; re-adding one of them still works.
    {
      const G = "823456789012345678", id = i => `37000000000000000${i}`, ch = i => `47000000000000000${i}`;
      for (const i of [1, 2, 3]) assert.equal((await connect({ webhookId: id(i), channelId: ch(i), guildId: G })).status, 303);
      r = await connect({ webhookId: id(4), channelId: ch(4), guildId: G });
      assert.deepEqual([r.status, /enough channels/.test(r.text)], [409, true]);
      assert.ok(world.deletedWebhooks.includes(id(4)), "the webhook Discord just created is deleted");
      assert.equal(await hookRow(id(4)), null);
      assert.equal((await connect({ webhookId: id(5), channelId: ch(2), guildId: G })).status, 303, "re-adding a channel isn't a new one");
      await db.prepare("DELETE FROM webhooks").run();
    }
    ok("public page: one server can add at most 3 channels");

    // More channels than one queue message posts to (FANOUT_PER_MESSAGE = 20): the parts chain.
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 45)
      INSERT INTO webhooks (id, token, channel_id, manage_hash) SELECT printf('35%016d', i), printf('tok_%040d', i), printf('45%016d', i), 'h' FROM n`).run();
    d0 = world.discord.length;
    world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: "Emergency maintenance tonight", text: "Realms go offline for emergency maintenance.", topicId: 9104 })];
    await poll();
    const fanStats = await settle();
    const many = world.discordTo.slice(d0).filter(id => id?.startsWith("35"));
    assert.deepEqual([many.length, new Set(many).size], [45, 45], "every channel once");
    assert.ok(fanStats.work >= 3, "three fanout messages (20 + 20 + 5)");
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'sent'").first()).n, 45);
    assert.ok((await call("/status")).body.today["fanout:alert"] >= 45);
    await db.prepare("DELETE FROM webhooks").run();
    await db.prepare("DELETE FROM deliveries").run();
    ok("fan-out: 45 channels are reached over chained queue messages, each once");

    // 25 channels whose first post failed: once their claims expire, one restart reaches all 25 (20 + 5).
    {
      const ids = Array.from({ length: 25 }, (_, i) => `36${String(i + 1).padStart(16, "0")}`);
      for (const [i, hid] of ids.entries()) {
        await db.prepare("INSERT INTO webhooks (id, token, channel_id, manage_hash) VALUES (?, ?, ?, 'h')").bind(hid, hookToken(hid), `46${String(i + 1).padStart(16, "0")}`).run();
        world.webhookFail[hid] = 1;
      }
      d0 = world.discord.length;
      world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: "Emergency realm maintenance extended", text: "Realms stay offline for emergency maintenance.", topicId: 9107 })];
      await poll(); await settle();
      assert.equal(world.discordTo.slice(d0).filter(x => x?.startsWith("36")).length, 0);
      await db.prepare("UPDATE deliveries SET claimed_at = datetime('now', '-10 minutes') WHERE state = 'pending'").run();
      await db.prepare("UPDATE broadcasts SET nudged_at = datetime('now', '-30 minutes')").run();
      await poll(); await settle();
      const got = world.discordTo.slice(d0).filter(x => x?.startsWith("36"));
      assert.deepEqual([got.length, new Set(got).size], [25, 25], "all 25 in one restart, each once");
      await db.prepare("DELETE FROM webhooks").run();
      await db.prepare("DELETE FROM deliveries").run();
    }
    ok("fan-out: a restart after failures keeps chaining until every due channel is reached");

    // The channel is re-added while an alert is being posted to its old webhook: the alert goes on to
    // the new webhook right away, not after the sweeper.
    {
      const X1 = "380000000000000001", X2 = "380000000000000002", X_CH = "480000000000000001";
      assert.equal((await connect({ webhookId: X1, channelId: X_CH, guildId: "923456789012345678" })).status, 303);
      let readded = null;
      world.onWebhookPost = async hid => {
        if (hid !== X1) return;
        world.onWebhookPost = null;
        readded = await connect({ webhookId: X2, channelId: X_CH, guildId: "923456789012345678" });
      };
      d0 = world.discord.length;
      world.usTracker = [...world.usTracker, forumPost({ region: "us", categoryId: 348, title: "Emergency realm restart tonight", text: "Realms go offline for an emergency restart tonight.", topicId: 9108 })];
      await poll(); await settle();
      world.onWebhookPost = null;
      assert.equal(readded?.status, 303);
      assert.equal(sentTo(X2, d0).filter(m => m.embeds?.[0]?.title?.includes("Emergency realm restart tonight")).length, 1, "reached the new webhook without waiting");
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'pending'").first()).n, 0);
      await db.prepare("DELETE FROM webhooks").run();
      await db.prepare("DELETE FROM deliveries").run();
    }
    ok("fan-out: re-adding a channel mid-post passes its alert on to the new webhook at once");

    // Full: no new sign-ups, and a webhook created anyway (sign-up started before) is deleted.
    const early = await startInstall();
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
      INSERT INTO webhooks (id, token, channel_id, manage_hash) SELECT printf('9%017d', i), 'x', printf('8%017d', i), 'h' FROM n`).run();
    assert.match((await page("/")).text, /Sign-ups are closed/);
    assert.equal((await page("/discord/install")).status, 503);
    r = await connect({ webhookId: "340000000000000004", channelId: "440000000000000004", install: early });
    assert.equal(r.status, 503);
    assert.ok(world.deletedWebhooks.includes("340000000000000004"));
    assert.equal(await hookRow("340000000000000004"), null);
    await db.prepare("DELETE FROM webhooks").run();
    ok("public page: sign-ups stop at MAX_SUBSCRIBERS");
  }

  console.log(`\n${passed} integration scenarios passed`);
} finally {
  await mf.dispose();
}
