/** Discord payload builders (pure; sending lives in src/discord.ts). */

import { UPDATE_MARKER, updateFocus } from "./diff";
import { cutMarkdown, escapeMarkdown, inlineMarkdown, linkUrl, stripMarkdown } from "./markdown";
import { clip, localTimes, splitVideoLine, timeTags } from "./text";

export interface DigestRow {
  id: string;
  source: string;  // "Blizzard News" or a Blue Post label
  title: string;
  url: string;
  summary: string; // Gemini's TL;DR; may be empty
  content: string; // the text that was classified (for an edit, marked with [NEW] lines)
}

/**
 * Posts of one forum topic share a key (host + topic id); anything else is keyed by its short link, so
 * versions of a renamed article (same id, new slug) are one item, not two embeds with one URL (Discord
 * shows only the first of those).
 */
export function threadKey(url: string): string {
  // The slug is optional: Discourse links a post with or without it.
  const m = url.match(/^(https:\/\/[a-z]{2}\.forums\.blizzard\.com)\/[a-z]{2}\/wow\/t\/(?:[^/]+\/)?(\d+)\/\d+$/i);
  return m ? `${m[1].toLowerCase()}/t/${m[2]}` : shortLink(url);
}

/** Rows by thread, each thread where its first row was. */
export function groupByThread<T extends { url: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = threadKey(r.url);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

/** Discord caps the combined text of all embeds in one message at 6000 characters. */
export const DISCORD_EMBED_TOTAL_LIMIT = 6000;
const EMBED_DESCRIPTION_LIMIT = 4096;
const DIGEST_BUDGET = 5800;      // headroom under the 6000 limit
const EMBEDS_PER_MESSAGE = 10;   // Discord's limit
const ALERT_POST_CHARS = 1500;   // post text in an alert, before "Read the full post"
const MIN_EXCERPT_CHARS = 60;    // a shorter cut of a longer post says too little to show

// Side-bar colors: red alerts; in the digest, Blizzard blue for Blue Posts and gold for news.
export const ALERT_COLOR = 0xdc2626;
export const DIGEST_BLUE_POST_COLOR = 0x00aeff;
export const DIGEST_NEWS_COLOR = 0xf8b700;

// The ForeverUpdates app's emojis (Developer Portal → the app → Emojis), shown as embed author icons:
// a webhook can't use an app's emojis in text (Discord shows them as ":name:").
const emojiUrl = (id: string) => `https://cdn.discordapp.com/emojis/${id}.png`;
export const ICON_ALERT = emojiUrl("1572629828732198912");
export const ICON_BLUE_POST = emojiUrl("1569540602910220369");
export const ICON_NEWS = emojiUrl("1572629866497581127");
const sourceName = (news: boolean) => (news ? "Blizzard News" : "Blue Post");

/** A short line that is all bold and isn't a sentence: a section title, as Blizzard writes them. */
function sectionTitle(line: string): string | null {
  const m = line.match(/^\*\*([^*]{1,80})\*\*$/);
  return m && !/[.!?]$/.test(m[1]) ? m[1] : null;
}

/**
 * Post lines (markdown, escaped when extracted) as paragraphs: a blank line between paragraphs, as on
 * the forum, but a list or quote stays together, and a heading or section title sits right on its text.
 * `aboveHeading` goes between a heading and the text before it: "\n" where it is a real heading (Discord
 * spaces it), "\n\n" where it will be a bold line.
 */
function joinPost(lines: string[], aboveHeading: "\n" | "\n\n"): string {
  const kind = (l: string) => (/^> /.test(l) ? ">" : /^[ \t]*(?:-|\d+\.) /.test(l) ? "-" : /^#{1,3} /.test(l) || sectionTitle(l) ? "#" : "");
  const sep = (prev: string, l: string) => (kind(prev) === "#" || (kind(l) && kind(l) !== "#" && kind(l) === kind(prev)) ? "\n" : kind(l) === "#" ? aboveHeading : "\n\n");
  return lines.map((l, i) => (i ? sep(lines[i - 1], l) : "") + l).join("");
}

/** Shortens post markdown for display, marking a cut with " …": see cutMarkdown (whole lines first). */
export function cutAtSentence(text: string, max: number): { text: string; cut: boolean } {
  return { text: cutMarkdown(text, max, true), cut: text.length > max };
}

/** The post text to show: for an edited post, the lines that were added (with their headers). */
function shownText(content: string): string {
  const focus = updateFocus(content ?? "");
  return (focus ? focus.shown : content ?? "").trim();
}

/**
 * The post's video (the first line of its text, put there by postText/extractArticleFullText) and
 * the text to show without it. For an edit, the video comes from the whole new version, so it's
 * shown whether or not it was just added.
 */
function splitVideo(content: string): { video?: string; text: string } {
  const c = content ?? "";
  const version = c.startsWith(UPDATE_MARKER) ? c.slice(UPDATE_MARKER.length + 1).replace(/^\[NEW\] /, "") : c;
  const { video } = splitVideoLine(version);
  const shown = splitVideoLine(shownText(c));
  return { video, text: (shown.video === video ? shown.rest : shownText(c)).trim() };
}

/**
 * The same page without the title words in its URL (Blizzard redirects to the full one), so more
 * of the digest fits: links count toward Discord's limit, and a forum slug is often 60+ characters.
 */
export function shortLink(url: string): string {
  return url
    .replace(/^(https:\/\/[a-z]{2}\.forums\.blizzard\.com\/[a-z]{2}\/wow\/t\/)[^/]+\/(\d+\/\d+)$/i, "$1$2")
    .replace(/^(https:\/\/news\.blizzard\.com\/[a-z]{2}-[a-z]{2}\/article\/\d+)\/[^/?#]+$/i, "$1");
}
/** A post's lines (blank ones dropped), without a line that is only a date its title already shows. */
function postLines(text: string, title: string): string[] {
  return text.split("\n").map(l => l.trimEnd()).filter(l => {
    const date = stripMarkdown(l.replace(/^#{1,3} /, "")).trim();
    return l.trim() && !(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(date) && title.includes(date));
  });
}
const linkText = (title: string) => escapeMarkdown(clip(title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim(), 200));
/** A Discord ID (a snowflake), e.g. a role's; anything else is ignored rather than sent. */
const SNOWFLAKE_RE = /^\d{17,20}$/;
const ROLE_ID_RE = SNOWFLAKE_RE;

/**
 * Adds the @mention of `roleId` to a message, allowing exactly that mention. Without a valid role
 * the message can mention no one. Either way forum/LLM text can never trigger @everyone or pings.
 */
export function withRole(payload: Record<string, unknown>, roleId?: string | null): Record<string, unknown> {
  const id = roleId?.trim() ?? "";
  if (!ROLE_ID_RE.test(id)) return { ...payload, allowed_mentions: { parse: [] } };
  const content = typeof payload.content === "string" && payload.content ? `<@&${id}> ${payload.content}` : `<@&${id}>`;
  return { ...payload, content, allowed_mentions: { parse: [], roles: [id] } };
}

/**
 * A role as a person enters it on the manage page: its ID, or the `<@&ID>` Discord gives for
 * `\@Role`. Empty clears it. A server's own ID is its @everyone role, which is never allowed.
 */
export function parseRoleInput(input: string, guildId?: string | null): { ok: true; roleId: string | null } | { ok: false } {
  const s = input.trim();
  if (!s) return { ok: true, roleId: null };
  const m = s.match(/^<@&(\d{17,20})>$/) ?? s.match(/^@?(\d{17,20})$/);
  if (!m || m[1] === guildId) return { ok: false };
  return { ok: true, roleId: m[1] };
}

export interface OAuthWebhook { id: string; token: string; channelId: string; guildId: string | null }

/** The `webhook` object of an OAuth token response (scope webhook.incoming), checked; null if it isn't one. */
export function readOAuthWebhook(w: any): OAuthWebhook | null {
  const id = String(w?.id ?? ""), token = String(w?.token ?? ""), channelId = String(w?.channel_id ?? "");
  if (!SNOWFLAKE_RE.test(id) || !/^[\w-]{20,200}$/.test(token) || !SNOWFLAKE_RE.test(channelId)) return null;
  const guildId = SNOWFLAKE_RE.test(String(w?.guild_id ?? "")) ? String(w.guild_id) : null;
  return { id, token, channelId, guildId };
}

export const webhookUrl = (id: string, token: string) => `https://discord.com/api/webhooks/${id}/${token}`;

export function buildAlertPayload(
  item: { source: string; title: string; url: string; content: string; summary: string },
  opts: { roleId?: string; now?: Date }
): Record<string, unknown> {
  const now = opts.now ?? new Date();
  // A Discord quote ends at a line break, so the TL;DR is kept to one line.
  const summary = localTimes(item.summary ?? "", now).replace(/\s+/g, " ").trim();
  const tldr = summary ? `> **TL;DR:** ${escapeMarkdown(summary)}` : "";
  const { video, text } = splitVideo(localTimes(item.content ?? "", now));
  const watch = video ? `▶ [Watch on YouTube](${video})` : "";
  // In an alert a section title is a heading.
  const lines = postLines(text, item.title).map(l => { const t = sectionTitle(l); return t ? `### ${t}` : l; });
  const post = cutAtSentence(joinPost(lines, "\n"), ALERT_POST_CHARS);
  // A blank line between the TL;DR, the video and the post, except above a heading (Discord spaces it).
  const body = [tldr, watch, post.text].filter(Boolean).map((p, i) => (i ? (/^#{1,3} /.test(p) ? "\n" : "\n\n") : "") + p).join("");
  // The title already links to the post; an absurdly long URL just isn't repeated.
  const more = post.cut && item.url.length <= 400 ? `\n[Read the full post](${linkUrl(item.url)})` : "";
  const description = timeTags(clip(`${body}${more}`.trim(), EMBED_DESCRIPTION_LIMIT));
  // Only the configured role can be mentioned (see withRole).
  return withRole({
    embeds: [{
      author: { name: `Urgent · ${sourceName(item.source === "Blizzard News")}`, icon_url: ICON_ALERT },
      title: clip(item.title, 256), url: item.url, description: description || escapeMarkdown(clip(item.title, 256)), color: ALERT_COLOR
    }]
  }, opts.roleId);
}

/**
 * Shares `budget` characters among `needs`: everyone gets what they need if it fits; otherwise
 * smaller needs are met in full and the rest is split evenly among the larger ones.
 */
function shareBudget(needs: number[], budget: number): number[] {
  const out = needs.map(() => 0);
  let remaining = Math.max(0, budget);
  const order = needs.map((n, i) => i).sort((a, b) => needs[a] - needs[b]);
  order.forEach((i, k) => {
    const give = Math.min(needs[i], Math.floor(remaining / (order.length - k)));
    out[i] = give;
    remaining -= give;
  });
  return out;
}

/**
 * The daily digest as ONE message: "N updates today", then one embed per item, oldest first: its
 * source (icon and name) and linked title, colored Blizzard blue for a Blue Post and gold for news, then
 * Gemini's TL;DR and as much of the post as fits. Discord allows 10 embeds a message: on a day with
 * more items, the first 9 get their own embed and a 10th lists the rest as linked titles. The
 * 6000-character budget is shared so short posts appear in full and long ones are cut at a sentence
 * end. On a busier day excerpts go first, then TL;DRs; if even the titles don't all fit, the rest are
 * counted in a closing "…and N more updates" line, along with `extra` items the caller didn't load.
 * Posts of one forum thread (or versions of one article) are one item: the title once, then
 * `threadTldr`'s one TL;DR for the thread (by threadKey) and a link to each post, or without it a line
 * per post. Two posts with the same video are one item, linking both.
 */
export function buildDigestMessage(rows: DigestRow[], opts: { extra?: number; threadTldr?: Map<string, string>; now?: Date } = {}): { payload: Record<string, unknown>; shown: number } {
  const now = opts.now ?? new Date();
  rows = rows.map(r => ({ ...r, summary: localTimes(r.summary ?? "", now), content: localTimes(r.content ?? "", now) }));
  const extra = Math.max(0, opts.extra ?? 0);
  const count = rows.length + extra;
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  // Each line without its heading, list or quote prefix, to run together into one paragraph.
  const bodyOf = (text: string) => text.split("\n").map(l => inlineMarkdown(l.trim())).filter(Boolean).join("\n");
  const found = [...groupByThread(rows)].map(([key, posts]) => {
    const r = posts[0];
    const news = r.source === "Blizzard News";
    const url = shortLink(r.url);
    if (posts.length === 1) {
      const { video, text } = splitVideo(r.content);
      return {
        news, n: 1, video, url, title: r.title, suffix: "", also: [] as string[],
        tldr: r.summary?.trim() ? `> ${escapeMarkdown(clip(oneLine(r.summary), 300))}` : "", // a one-line quote box
        body: joinPost(postLines(text, r.title), "\n\n") // its own paragraphs, headings and lists, for its excerpt
      };
    }
    // A thread: its title once, then its one TL;DR for all the posts and a link to each; without that
    // TL;DR, one quote line per post (a link, then its TL;DR or else the start of the post).
    const label = (p: DigestRow) => {
      const edit = p.content?.startsWith(UPDATE_MARKER);
      const num = p.url.match(/\/(\d+)$/)?.[1];
      return news ? (edit ? "Update" : "Article") : `#${num ?? "?"}${edit ? " (edited)" : ""}`;
    };
    const link = (p: DigestRow) => `[${label(p)}](${linkUrl(shortLink(p.url))})`;
    const line = (p: DigestRow) => {
      const gist = p.summary?.trim() ? escapeMarkdown(clip(oneLine(p.summary), 200)) : cutAtSentence(bodyOf(splitVideo(p.content).text), 200).text.replace(/\n/g, " ");
      return `> ${link(p)} ${gist}`.trimEnd();
    };
    const summary = localTimes(opts.threadTldr?.get(key)?.trim() ?? "", now);
    return {
      news, n: posts.length, video: undefined as string | undefined, url, also: [] as string[],
      title: r.title.replace(/ \((?:edited|updated)\)$/, ""), suffix: ` · ${posts.length} ${news ? "versions" : "posts"}`,
      tldr: summary ? `> ${escapeMarkdown(clip(oneLine(summary), 300))}\n${posts.map(link).join(" · ")}` : posts.map(line).join("\n"),
      body: ""
    };
  });
  // One video in two posts (a news article and its forum announcement): one entry, the one with
  // more to show, with a link to each other one.
  const byVideo = new Map<string, number>();
  const merged = new Set<number>();
  found.forEach((it, i) => {
    if (!it.video) return;
    const j = byVideo.get(it.video);
    if (j === undefined) { byVideo.set(it.video, i); return; }
    const size = (x: typeof it) => x.tldr.length + x.body.length;
    const [keep, drop] = size(found[j]) >= size(it) ? [j, i] : [i, j];
    found[keep].also.push(`[${found[drop].news ? "Article" : "Forum post"}](${linkUrl(found[drop].url)})`, ...found[drop].also);
    found[keep].n += found[drop].n;
    merged.add(drop);
    byVideo.set(it.video, keep);
  });
  const items = found.filter((_, i) => !merged.has(i)).map(it => {
    // The video and the other posts' links: an embed title can't hold links, so they lead the text.
    const links = [it.video ? `[▶ Video](${it.video})` : "", ...it.also].filter(Boolean).join(" · ");
    // Posts merged by their video say how many they are, like a thread. A long title is cut, never the count.
    const suffix = it.suffix || (it.also.length ? ` · ${it.n} posts` : "");
    return {
      ...it, links,
      author: { name: sourceName(it.news), icon_url: it.news ? ICON_NEWS : ICON_BLUE_POST },
      title: clip(oneLine(it.title), 256 - suffix.length) + suffix,
      // The item as one line of the overflow list.
      head: `**[${linkText(it.title)}${suffix}](${linkUrl(it.url)})** · ${sourceName(it.news)}${links ? ` · ${links}` : ""}`
    };
  });
  const boxes = items.length <= EMBEDS_PER_MESSAGE ? items.length : EMBEDS_PER_MESSAGE - 1;
  const closing = (more: number) => `…and ${more} more update${more === 1 ? "" : "s"}`;
  // The longest the closing line can be (with its "\n\n"), reserved in every limit whenever it may be needed.
  const tailRoom = (needed: boolean) => (needed ? closing(count).length + 2 : 0);

  // The first `shownBoxes` items as embeds (descs: their text), then the overflow list.
  const render = (descs: string[], shownBoxes: number, listed: string[], more: number) => {
    const embeds: { author?: { name: string; icon_url: string }; title?: string; url?: string; description?: string; color: number }[] = items.slice(0, shownBoxes).map((it, i) => ({
      author: it.author, title: it.title, url: it.url, ...(descs[i] ? { description: timeTags(descs[i]) } : {}),
      color: it.news ? DIGEST_NEWS_COLOR : DIGEST_BLUE_POST_COLOR
    }));
    if (listed.length) embeds.push({ description: listed.join("\n"), color: DIGEST_BLUE_POST_COLOR });
    if (more) {
      if (!embeds.length) embeds.push({ color: DIGEST_BLUE_POST_COLOR });
      const last = embeds[embeds.length - 1];
      last.description = last.description ? `${last.description}\n\n${closing(more)}` : closing(more);
    }
    return embeds;
  };

  // 1-2: title, links + TL;DR (+ a share of the post); without TL;DRs if they don't all fit.
  const tail = tailRoom(extra > 0);
  const budget = DIGEST_BUDGET - tail;
  const listed = items.slice(boxes).map(it => it.head);
  const listCost = listed.reduce((n, h) => n + h.length + 1, 0);
  const boxed = items.slice(0, boxes);
  for (const withTldr of [true, false]) {
    const lead = (it: (typeof items)[number]) => [it.links, withTldr ? it.tldr : ""].filter(Boolean);
    const fixedDesc = boxed.map(it => lead(it).reduce((n, p) => n + p.length + 1, 0));
    const total = boxed.reduce((n, it, i) => n + it.author.name.length + it.title.length + fixedDesc[i], 0) + listCost;
    // Every embed's own text must fit too (a thread of many posts lists a line for each).
    if (total > budget || listCost + tail > EMBED_DESCRIPTION_LIMIT || fixedDesc.some(f => f + tail > EMBED_DESCRIPTION_LIMIT)) continue;

    // +1 for "\n"; headings become bold lines, up to 2 characters more each. No more than its
    // embed's description holds.
    const boldRoom = (body: string) => 2 * (body.match(/^(?:> )?#{1,3} /gm)?.length ?? 0);
    const needs = boxed.map((it, i) => (withTldr && it.body ? Math.max(0, Math.min(it.body.length + 1 + boldRoom(it.body), EMBED_DESCRIPTION_LIMIT - tail - fixedDesc[i])) : 0));
    const share = shareBudget(needs, budget - total);
    const descs = boxed.map((it, i) => {
      const parts = lead(it);
      // Headings become bold lines, no bigger than the item's title: their text as plain (escaped)
      // text, so nothing inside (bold, code, a link) can meet the added markers. One that would come
      // out longer than its room stays a heading.
      // Only headings within the first share[i] characters can be kept by the cut.
      const room = share[i] - 1 - boldRoom(it.body.slice(0, share[i]));
      if (withTldr && it.body && (it.body.length <= room || room >= MIN_EXCERPT_CHARS)) {
        parts.push(cutAtSentence(it.body, room).text.replace(/^((?:> )?)#{1,3} (.+)$/gm, (line, quote: string, text: string) => {
          const bold = `${quote}**${escapeMarkdown(stripMarkdown(text)).trim()}**`;
          return bold.length > quote.length + 4 && bold.length <= line.length + 2 ? bold : line;
        }));
      }
      return parts.join("\n");
    });
    return { payload: digestPayload(count, render(descs, boxes, listed, extra)), shown: rows.length };
  }

  // 3: titles and links only, as many as fit, in order; the rest counted.
  const fullTail = tailRoom(true);
  const descs: string[] = [], heads: string[] = [];
  let used = 0, listUsed = 0, shown = 0, shownBoxes = 0;
  for (const [i, it] of items.entries()) {
    const inBox = i < boxes;
    const cost = inBox ? it.author.name.length + it.title.length + it.links.length + 1 : it.head.length + 1;
    if (used + cost + fullTail > DIGEST_BUDGET || (inBox ? it.links.length : listUsed + cost) + fullTail > EMBED_DESCRIPTION_LIMIT) break;
    if (inBox) { descs.push(it.links); shownBoxes++; } else { heads.push(it.head); listUsed += cost; }
    used += cost;
    shown += it.n;
  }
  return { payload: digestPayload(count, render(descs, shownBoxes, heads, count - shown)), shown };
}

function digestPayload(count: number, embeds: Record<string, unknown>[]): Record<string, unknown> {
  return { content: `${count} update${count === 1 ? "" : "s"} today`, allowed_mentions: { parse: [] }, embeds };
}

export function embedTextLength(embed: any): number {
  let n = (embed.author?.name ?? "").length + (embed.title ?? "").length + (embed.description ?? "").length + (embed.footer?.text ?? "").length;
  for (const f of embed.fields ?? []) n += (f.name ?? "").length + (f.value ?? "").length;
  return n;
}

/**
 * Posted once to a channel that was just added on the public page. `nextDigest` (Unix seconds) is
 * shown as a Discord timestamp, so each reader sees the digest time in their own time zone.
 */
export function welcomePayload(nextDigest: number): Record<string, unknown> {
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "ForeverUpdates is set up in this channel",
      description: `Urgent WoW: Forever news (hotfixes, known issues, maintenance) will be posted here right away, and a digest of everything else that's relevant every day at <t:${Math.floor(nextDigest)}:t>.\n\nEach alert and digest item comes with a short TL;DR, so you can see what changed at a glance.\n\nTo stop, delete this webhook in the channel's settings (Integrations → Webhooks).`,
      color: DIGEST_BLUE_POST_COLOR
    }]
  };
}

/** The manage page's test alert: shaped like an alert; the caller adds the role ping (withRole). */
export function testAlertPayload(): Record<string, unknown> {
  return {
    content: "Test alert from ForeverUpdates.",
    embeds: [{ author: { name: "Urgent", icon_url: ICON_ALERT }, title: "Test alert", description: "This is only a test: urgent WoW: Forever alerts will be posted here like this, pinging the role set on the settings page.", color: ALERT_COLOR }]
  };
}

/** Shows which role urgent alerts will ping, without pinging it (no mentions allowed). */
export function roleNoticePayload(roleId: string | null): Record<string, unknown> {
  return {
    content: roleId ? `Urgent ForeverUpdates alerts in this channel will ping <@&${roleId}>.` : "Urgent ForeverUpdates alerts in this channel will no longer ping a role.",
    allowed_mentions: { parse: [] }
  };
}
