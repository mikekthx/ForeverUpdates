#!/usr/bin/env node
// Saves real responses from every source the bot reads into ONE file you can attach to the chat:
//   fixtures/capture-<date>.json
// It also writes fixtures/labels.todo.json: the recent posts and articles the bot would actually
// send to the model (Forever-forum Blue Posts and news articles that pass the title filter), for you
// to label. `npm run eval` uses the labels to measure the triage prompt. Labels you already gave in
// fixtures/labels.json or labels.todo.json are carried over by id.
//
// Usage (PowerShell or any shell):   npm run capture   (runs under tsx so labels use the bot's own code)
// Read-only and polite: about 35 sequential GET requests with a 1-second pause between them.
// Forums captured: the bot's default regions, or $env:FORUM_REGIONS = "us,eu".

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FORUM_CONTENT_MAX, NEWS_CONTENT_MAX, REGIONS } from "../src/config.ts";
import { flattenCategoryList, newsPointerArticleId, parseSearch, parseTracker, pickForeverCategories, postText } from "../src/lib/forum.ts";
import { extractArticleFullText, extractArticleTitle, parseNewsListing } from "../src/lib/news.ts";
import { clip } from "../src/lib/text.ts";
import { forumRegions, wantedNewsTitle } from "../src/sources.ts";

const UA = "ForeverUpdates-capture/4.1 (personal Discord notifier; one-off fixture capture; +https://github.com/mikekthx/ForeverUpdates)";
const NEWS = "https://news.blizzard.com/en-us/feed/world-of-warcraft";
const MAX_POSTS = 20;      // per region
const MAX_ARTICLES = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const capture = { capturedAt: new Date().toISOString(), node: process.version, responses: {} };

async function grab(name, url, accept = "application/json") {
  await sleep(1000);
  process.stdout.write(`  ${name.padEnd(28)} `);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept } });
    const body = await res.text();
    capture.responses[name] = {
      url, status: res.status, contentType: res.headers.get("content-type"),
      etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"),
      cacheControl: res.headers.get("cache-control"), bytes: body.length, body
    };
    console.log(`${res.status}  ${(body.length / 1024).toFixed(0)} KB`);
    return res.ok ? body : null;
  } catch (err) {
    capture.responses[name] = { url, error: String(err) };
    console.log(`ERROR ${err}`);
    return null;
  }
}
const json = s => { try { return JSON.parse(s); } catch { return null; } };

// Labels already given (labels.json wins over labels.todo.json), so a recapture doesn't lose them.
const given = new Map();
for (const f of ["fixtures/labels.todo.json", "fixtures/labels.json"]) {
  if (!existsSync(f)) continue;
  for (const x of json(readFileSync(f, "utf8")) ?? []) if (x?.id && x.expected) given.set(x.id, x.expected);
}

console.log("Capturing Blizzard responses…");
const labels = [];
// Label content is exactly what the bot sends to the model (src/work.ts): the full post or article text.
const label = (item, choices) => labels.push({ ...item, choices, expected: given.get(item.id) ?? "" });

for (const region of forumRegions(process.env)) {
  const base = REGIONS[region].base;
  const site = json(await grab(`${region}-site`, `${base}/en/wow/site.json`));
  const list = json(await grab(`${region}-categories`, `${base}/en/wow/categories.json?include_subcategories=true`));
  const picked = (site?.categories && pickForeverCategories(site.categories))
    ?? pickForeverCategories(flattenCategoryList(list?.category_list?.categories ?? []));
  console.log(`    Forever categories (${region}): ${picked ? picked.ids.join(", ") : "NOT FOUND"}`);
  if (!picked) capture.responses[`${region}-site`].error = "no Forever category in site.json or categories.json";
  const allowed = new Set(picked?.ids ?? []);

  const tracker = json(await grab(`${region}-tracker`, `${base}/en/wow/groups/blizzard-tracker/posts.json`));
  const search = json(await grab(`${region}-search`, `${base}/en/wow/search.json?q=${encodeURIComponent(`group:blizzard-tracker #${picked?.slug ?? "wow-forever"} order:latest`)}`));

  // Only what the bot keeps: posts in the Forever forums (no beta, no other versions).
  const hits = new Map();
  for (const h of [...parseTracker(tracker, region, REGIONS[region].label, base, allowed), ...parseSearch(search, region, REGIONS[region].label, base, allowed)]) {
    if (!hits.has(h.key)) hits.set(h.key, h);
  }
  let skipped = 0;
  for (const h of [...hits.values()].slice(0, MAX_POSTS)) {
    const id = h.key.split(":")[2];
    const post = json(await grab(`${region}-post-${id}`, `${base}/en/wow/posts/${id}.json`));
    if (!post?.cooked) continue;
    // Forum copies of news articles are skipped by the bot (unless the news feed drops that
    // article by title); the article is labeled instead.
    if (newsPointerArticleId(post.cooked) && wantedNewsTitle(h.title)) { skipped++; continue; }
    label({
      id: h.key, source: h.source, forum_verified: true, author: post.username ?? h.author,
      title: h.title, url: h.url, posted_at: h.postedAt,
      content: clip(postText(post.cooked), FORUM_CONTENT_MAX)
    }, "alert | digest (Forever-forum posts are always relevant)");
  }
  console.log(`    ${region}: ${hits.size} Forever-forum posts, ${skipped} news copies skipped`);
}

const listing = await grab("news-listing", NEWS, "text/html");
if (listing) {
  const cards = parseNewsListing(listing).filter(c => wantedNewsTitle(c.title));
  console.log(`    News cards passing the title filter: ${cards.length}`);
  for (const c of cards.slice(0, MAX_ARTICLES)) {
    const html = await grab(`news-article-${c.articleId}`, c.url, "text/html");
    if (!html) continue;
    label({
      id: `news:${c.articleId}`, source: "Blizzard News", forum_verified: false, author: "Blizzard Entertainment",
      title: c.titleFromSlug ? extractArticleTitle(html) || c.title : c.title, url: c.url,
      content: clip(extractArticleFullText(html), NEWS_CONTENT_MAX)
    }, "alert | digest | ignore (ignore = not about Forever)");
  }
}

// A failed source would make the fixture tests fail and lose labels; keep the previous files instead.
const failed = Object.entries(capture.responses)
  .filter(([name, r]) => /-(site|tracker|search)$|^news-listing$/.test(name) && (r.status !== 200 || r.error))
  .map(([name, r]) => `${name} (${r.error ?? r.status})`);
if (failed.length) {
  console.error(`\nNot saved: ${failed.join(", ")} failed. Blizzard may be having trouble; try again in a few minutes.`);
  process.exit(1);
}

mkdirSync("fixtures", { recursive: true });
const file = `fixtures/capture-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(capture, null, 1));
writeFileSync("fixtures/labels.todo.json", JSON.stringify(labels, null, 2));

const total = Object.values(capture.responses).reduce((n, r) => n + (r.bytes ?? 0), 0);
console.log(`\nSaved ${file} (${(total / 1024 / 1024).toFixed(1)} MB) and fixtures/labels.todo.json (${labels.length} items).`);
const todo = labels.filter(l => !l.expected).length;
console.log(`${labels.length - todo} labels carried over, ${todo} to fill in: set "expected" (see "choices") and save as fixtures/labels.json.`);
