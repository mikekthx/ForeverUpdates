// Runs the parsers against REAL Blizzard responses saved by `npm run capture`
// (fixtures/capture-*.json). Skips cleanly if no capture file is present.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isNewsCopyExcerpt, newsPointerArticleId, postText, parseSearch, parseTracker, pickForeverCategories, flattenCategoryList } from "../src/lib/forum.ts";
import { articleProbe, extractArticleFullText, extractArticleTitle, parseNewsListing } from "../src/lib/news.ts";
import { htmlToText } from "../src/lib/text.ts";
import { clipMarkdown, htmlToMarkdown, stripMarkdown } from "../src/lib/markdown.ts";
import { balanced as lineBalanced } from "./balanced.mts";
import { buildAlertPayload, buildDigestMessage, DISCORD_EMBED_TOTAL_LIMIT, embedTextLength } from "../src/lib/discord.ts";
import { FORUM_CONTENT_MAX, NEWS_CONTENT_MAX } from "../src/config.ts";

// The markdown shows exactly the text of the HTML: nothing lost, nothing added (whitespace aside).
const same = (name: string, html: string) => {
  const shown = stripMarkdown(htmlToMarkdown(html)).replace(/\s+/g, "");
  const text = htmlToText(html).replace(/\s+/g, "");
  const at = [...shown].findIndex((c, i) => c !== text[i]);
  assert.equal(shown, text, `${name}: the markdown shows other text, from "${shown.slice(Math.max(0, at - 30), at + 30)}"`);
};
const hasFormatting = (md: string) => /[*_~`|[]/.test(md.replace(/\\./g, "").replace(/https?:\/\/\S+/g, ""));
let formatted = 0;

const files = existsSync("fixtures") ? readdirSync("fixtures").filter(f => /^capture-.*\.json$/.test(f)).sort() : [];
if (!files.length) {
  console.log("  – no fixtures/capture-*.json yet; skipping real-data tests (run `npm run capture`)");
  process.exit(0);
}
const cap = JSON.parse(readFileSync(`fixtures/${files.at(-1)}`, "utf8"));
const R = (name: string) => cap.responses[name];
const body = (name: string) => { const r = R(name); return r && r.status === 200 ? r.body : null; };
const json = (name: string) => { const b = body(name); try { return b ? JSON.parse(b) : null; } catch { return null; } };
console.log(`  using ${files.at(-1)} (captured ${cap.capturedAt})`);
let n = 0; const ok = (s: string) => { n++; console.log("  ✓", s); };
const notes: string[] = [];

const pointers: { name: string; articleId: string; createdAt: string }[] = [];
let excerptChecks = 0;
let videoOnly = 0;
let articleVideos = 0;
// Only regions the capture includes (EU is off by default).
for (const region of (["us", "eu"] as const).filter(r => R(`${r}-site`))) {
  const base = `https://${region}.forums.blizzard.com`;
  const site = json(`${region}-site`);
  let picked = site?.categories ? pickForeverCategories(site.categories) : null;
  if (!picked) {
    const list = json(`${region}-categories`);
    picked = pickForeverCategories(flattenCategoryList(list?.category_list?.categories ?? []));
  }
  assert.ok(picked, `${region}: Forever category not found in site.json or categories.json`);
  notes.push(`${region} categories: ${picked!.ids.join(", ")} (excluded beta: ${picked!.excluded.join(", ") || "none"})`);
  ok(`${region}: category discovery finds the Forever forums`);

  const allowed = new Set(picked!.ids);
  const trackerRaw = json(`${region}-tracker`);
  const posts: any[] = Array.isArray(trackerRaw) ? trackerRaw : trackerRaw?.posts ?? [];
  assert.ok(posts.length > 0, `${region}: tracker returned no posts`);
  for (const f of ["id", "topic_id", "post_number", "created_at"]) assert.ok(f in posts[0], `${region}: tracker post lacks "${f}" (has: ${Object.keys(posts[0]).join(", ")})`);
  assert.ok("category_id" in posts[0] || posts[0].topic?.category_id != null, `${region}: tracker post has no category_id`);
  const hits = parseTracker(trackerRaw, region, region === "us" ? "Blue Post (US)" : "Blue Post (EU)", base, allowed);
  for (const h of hits) { assert.ok(h.title && h.title !== "Blizzard Blue Post", `${region}: tracker hit without title`); assert.match(h.url, /\/t\/[^/]+\/\d+\/\d+$/); }
  notes.push(`${region} tracker: ${posts.length} posts, ${hits.length} in Forever forums`);
  ok(`${region}: tracker JSON has the fields the parser needs`);

  const search = json(`${region}-search`);
  assert.ok(search && Array.isArray(search.posts), `${region}: search.json has no posts array`);
  const sh = parseSearch(search, region, region === "us" ? "Blue Post (US)" : "Blue Post (EU)", base, allowed);
  notes.push(`${region} search: ${search.posts.length} results, ${sh.length} kept`);
  ok(`${region}: search JSON parses`);

  for (const name of Object.keys(cap.responses).filter(k => k.startsWith(`${region}-post-`))) {
    const p = json(name);
    if (!p) continue;
    assert.ok(typeof p.cooked === "string", `${name}: no cooked HTML`);
    assert.ok(postText(p.cooked).length > 0, `${name}: empty text (the bot would retry it, then use the excerpt)`);
    same(name, p.cooked);
    if (hasFormatting(postText(p.cooked))) formatted++;
    if (!htmlToText(p.cooked, { dropQuotes: true }) && /data-provider-name\s*=\s*"youtube"/i.test(p.cooked)) {
      assert.match(postText(p.cooked), /^https:\/\/youtu\.be\/[\w-]{11}\n\S/, `${name}: a video-only post should be its video's link, then its title`);
      videoOnly++;
    }
    const articleId = newsPointerArticleId(p.cooked);
    if (articleId) pointers.push({ name, articleId, createdAt: p.created_at });
    // The excerpt checks (used when a post can't be fetched) must agree with the full-post check,
    // for the tracker excerpt and the search-result excerpt alike.
    const id = name.split("-").at(-1);
    const tp = posts.find(t => String(t.id) === id);
    if (tp) {
      const excerpt = htmlToText(String(tp.excerpt ?? ""), { dropQuotes: true });
      assert.equal(isNewsCopyExcerpt(String(tp.topic_title ?? tp.title ?? ""), excerpt), !!articleId, `${name}: tracker excerpt and full post disagree on being a news copy`);
    }
    const sp = search.posts.find((x: any) => String(x.id) === id);
    if (sp) {
      const title = String(search.topics?.find((t: any) => t.id === sp.topic_id)?.title ?? "");
      assert.equal(isNewsCopyExcerpt(title, htmlToText(String(sp.blurb ?? ""))), !!articleId, `${name}: search excerpt and full post disagree on being a news copy`);
    }
    if (tp || sp) excerptChecks++;
  }
  ok(`${region}: individual post JSON has cooked HTML (${videoOnly} video-only, each linked)`);
}

const listing = body("news-listing");
assert.ok(listing, "news listing missing");
const cards = parseNewsListing(listing);
assert.ok(cards.length >= 5, `only ${cards.length} news cards parsed`);
for (const c of cards) assert.ok(c.title.length > 3 && c.url.startsWith("https://news.blizzard.com/"), `bad card ${JSON.stringify(c)}`);
notes.push(`news listing: ${cards.length} cards, ${cards.filter(c => c.titleFromSlug).length} with slug titles; first: "${cards[0].title}"`);
ok("news listing parses into titled cards");

// Forum copies of news articles are skipped in favor of the article, so the article must be on the
// news feed the bot reads (worldofwarcraft.com/news/<id> and news.blizzard.com/article/<id> share IDs).
// The listing is CDN-cached for up to 5 minutes, so a copy posted as the article went live may
// point to an article the captured listing doesn't show yet (seen on 2026-10-28).
for (const p of pointers) {
  const justPosted = Date.parse(p.createdAt) > Date.parse(cap.capturedAt) - 10 * 60_000;
  assert.ok(justPosted || cards.some(c => c.articleId === p.articleId), `${p.name} points to article ${p.articleId}, which isn't on the news listing`);
}
notes.push(`news-copy excerpt checks: ${excerptChecks} posts`);
notes.push(`news-pointer posts: ${pointers.map(p => `${p.name} → ${p.articleId}`).join(", ") || "none"}`);
ok("news-pointer posts point to articles on the news listing");

for (const name of Object.keys(cap.responses).filter(k => k.startsWith("news-article-"))) {
  const html = body(name);
  if (!html) continue;
  const full = extractArticleFullText(html);
  same(name, html.match(/<section class="blog">[\s\S]*?<\/section>/)?.[0] ?? "");
  if (hasFormatting(full)) formatted++;
  // An article with an embedded YouTube player starts with that video's link; the body follows.
  // A player inside the article itself (one elsewhere on the page doesn't count).
  const hasPlayer = /<iframe\b[^>]*\bsrc\s*=\s*"https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//i.test(html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? "");
  const video = full.match(/^https:\/\/youtu\.be\/[\w-]{11}\n/)?.[0];
  assert.equal(!!video, hasPlayer, `${name}: ${hasPlayer ? "its video isn't linked first" : "a video link without a player"}`);
  if (video) articleVideos++;
  const text = full.slice(video?.length ?? 0);
  const lines = text.split("\n");
  // Some real articles are a sentence and a video (24317865, 2026-11-05: 149 chars), so the check is
  // that it's the article's own text, not the whole page (which starts with the <title>).
  assert.ok(text.length >= 100, `${name}: only ${text.length} chars extracted`);
  assert.ok(!lines[0].includes("Blizzard News"), `${name}: extracted the whole page (its <title>), not the article`);
  // Edit detection needs one line per paragraph: at least one line per non-empty leaf block of the
  // real body (<section class="blog"> inside <article>).
  const blog = html.match(/<section class="blog">[\s\S]*?<\/section>/)?.[0] ?? "";
  const blocks = [...blog.matchAll(/<(p|li|h[1-6])\b[^>]*>((?:(?!<(?:p|li|h[1-6]|ul|ol|div)\b)[\s\S])*?)<\/\1>/gi)]
    .filter(m => htmlToText(m[2]).length > 0).length;
  // Some real articles are two paragraphs and a video (24302577, 2026-10-22), so only require one.
  assert.ok(blocks >= 1, `${name}: no <section class="blog"> body found (page layout changed?)`);
  assert.ok(lines.length >= blocks, `${name}: ${lines.length} lines for ${blocks} paragraphs (edit detection needs line breaks)`);
  assert.ok(!/^Blizzard News\b/.test(lines[0]) && !lines.includes("Comments"), `${name}: starts with the article header, not the body: "${lines[0].slice(0, 60)}"`);
  // The CMS body is CRLF; a stray \r must not become a blank line or stick to a line's end.
  assert.ok(!text.includes("\r") && lines.every(l => l.trim()), `${name}: ${lines.filter(l => !l.trim()).length} blank or CR-only lines`);
  assert.equal(await articleProbe(html), await articleProbe(html));
  notes.push(`${name}: ${(html.length / 1024) | 0} KB → ${text.length} chars / ${lines.length} lines; title "${extractArticleTitle(html)}"; starts "${lines[0].slice(0, 60)}"`);
}
ok(`articles extract to multi-line text with a stable probe (${articleVideos} with a video, linked first)`);

ok(`markdown shows exactly the text of every post and article (${formatted} keep formatting)`);

// What Discord gets for each of them: an alert each, and one digest of them all. Every line is
// balanced (nothing left open by a cut) and within Discord's limits.
const items = Object.entries<any>(cap.responses).flatMap(([k, r]) => {
  if (r.status !== 200) return [];
  const content = k.startsWith("news-article-") ? clipMarkdown(extractArticleFullText(r.body), NEWS_CONTENT_MAX)
    : /-post-/.test(k) ? clipMarkdown(postText(JSON.parse(r.body).cooked), FORUM_CONTENT_MAX) : null;
  return content ? [{ id: k, source: k.startsWith("news") ? "Blizzard News" : "Blue Post (US)", title: k, url: `https://news.blizzard.com/en-us/article/1/${k}`, summary: "A **TL;DR**.", content }] : [];
});
const balanced = (where: string, d: string) => {
  for (const l of d.split("\n")) assert.ok(lineBalanced(l), `${where}: a line with formatting left open: "${l.slice(0, 80)}"`);
};
for (const it of items) {
  const d = (buildAlertPayload(it, {}) as any).embeds[0].description;
  assert.ok(d.length <= 4096, `${it.id}: alert is ${d.length} chars`);
  balanced(it.id, d);
}
const digest = buildDigestMessage(items).payload as any;
assert.ok(digest.embeds.reduce((n: number, e: any) => n + embedTextLength(e), 0) <= DISCORD_EMBED_TOTAL_LIMIT);
for (const e of digest.embeds) { assert.ok(e.description.length <= 4096); balanced("digest", e.description); }
ok(`${items.length} alerts and their digest: every line balanced, within Discord's limits`);
console.log("\n  " + notes.join("\n  "));
console.log(`\n${n} real-data checks passed`);
