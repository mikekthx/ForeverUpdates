/** Discord payload builders (pure; sending lives in src/discord.ts). */

import { UPDATE_MARKER, updateFocus } from "./diff";
import { cutMarkdown, escapeMarkdown, inlineMarkdown, linkUrl } from "./markdown";
import { clip, splitVideoLine } from "./text";

export interface DigestRow {
  id: string;
  source: string;  // "Blizzard News" or a Blue Post label
  title: string;
  url: string;
  summary: string; // Gemini's TL;DR; may be empty
  content: string; // the text that was classified (for an edit, marked with [NEW] lines)
}

/** Posts of one forum topic share a key (host + topic id); anything else is keyed by its own URL. */
export function threadKey(url: string): string {
  const m = url.match(/^(https:\/\/[a-z]{2}\.forums\.blizzard\.com)\/[a-z]{2}\/wow\/t\/[^/]+\/(\d+)\/\d+$/i);
  return m ? `${m[1].toLowerCase()}/t/${m[2]}` : url;
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
const ALERT_POST_CHARS = 1500;   // post text in an alert, before "Read the full post"
const MIN_EXCERPT_CHARS = 60;    // a shorter cut of a longer post says too little to show

// Side-bar colors: red alerts; in the digest, Blizzard blue for Blue Posts and gold for news.
export const ALERT_COLOR = 0xdc2626;
export const DIGEST_BLUE_POST_COLOR = 0x00aeff;
export const DIGEST_NEWS_COLOR = 0xf8b700;

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
  item: { title: string; url: string; content: string; summary: string },
  opts: { roleId?: string }
): Record<string, unknown> {
  // A Discord quote ends at a line break, so the TL;DR is kept to one line.
  const summary = item.summary?.replace(/\s+/g, " ").trim();
  const tldr = summary ? `> **TL;DR:** ${escapeMarkdown(summary)}\n\n` : "";
  const { video, text } = splitVideo(item.content);
  const watch = video ? `▶ [Watch on YouTube](${video})\n\n` : "";
  // Each line of post text (markdown, escaped when it was extracted) is a paragraph, heading, list
  // item or quote line: a blank line between paragraphs, as on the forum, but a list or quote stays together.
  const lines = text.split("\n").map(l => l.trimEnd()).filter(l => l.trim());
  const kind = (l: string) => (/^> /.test(l) ? ">" : /^[ \t]*(?:-|\d+\.) /.test(l) ? "-" : "");
  const post = cutAtSentence(lines.map((l, i) => (i && kind(l) && kind(l) === kind(lines[i - 1]) ? "\n" : i ? "\n\n" : "") + l).join(""), ALERT_POST_CHARS);
  // The title already links to the post; an absurdly long URL just isn't repeated.
  const more = post.cut && item.url.length <= 400 ? `\n[Read the full post](${linkUrl(item.url)})` : "";
  const description = clip(`${tldr}${watch}${post.text}${more}`.trim(), EMBED_DESCRIPTION_LIMIT);
  // Only the configured role can be mentioned (see withRole).
  return withRole({
    embeds: [{ title: clip(`🚨 ${item.title}`, 256), url: item.url, description: description || escapeMarkdown(clip(item.title, 256)), color: ALERT_COLOR }]
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
 * The daily digest as ONE message: "N updates today", then a blue embed listing the Blue Posts and
 * a gold one listing the news (oldest first). Each item is its linked title, Gemini's TL;DR and as
 * much of the post as fits: the 6000-character budget is shared so short posts appear in full and
 * long ones are cut at a sentence end. On a busier day excerpts go first, then TL;DRs; if even the
 * linked titles don't all fit, the rest are counted in a closing "…and N more updates" line, along
 * with `extra` items the caller didn't load. Posts of one forum thread (or versions of one article)
 * are one item: the title once, then `threadTldr`'s one TL;DR for the thread (by threadKey) and a link
 * to each post, or without it a line per post.
 */
export function buildDigestMessage(rows: DigestRow[], opts: { extra?: number; threadTldr?: Map<string, string> } = {}): { payload: Record<string, unknown>; shown: number } {
  const extra = Math.max(0, opts.extra ?? 0);
  const count = rows.length + extra;
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  // Each line without its heading, list or quote prefix, to run together into one paragraph.
  const bodyOf = (text: string) => text.split("\n").map(l => inlineMarkdown(l.trim())).filter(Boolean).join("\n");
  const items = [...groupByThread(rows)].map(([key, posts]) => {
    const r = posts[0];
    const news = r.source === "Blizzard News";
    if (posts.length === 1) {
      const { video, text } = splitVideo(r.content);
      return {
        news, n: 1,
        head: `**[${linkText(r.title)}](${linkUrl(shortLink(r.url))})**${video ? ` · [▶ Video](${video})` : ""}`,
        tldr: r.summary?.trim() ? `> ${escapeMarkdown(clip(oneLine(r.summary), 300))}` : "", // a one-line quote box
        body: bodyOf(text)
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
    const summary = opts.threadTldr?.get(key)?.trim();
    return {
      news, n: posts.length,
      head: `**[${linkText(r.title.replace(/ \((?:edited|updated)\)$/, ""))}](${linkUrl(shortLink(r.url))})** · ${posts.length} ${news ? "versions" : "posts"}`,
      tldr: summary ? `> ${escapeMarkdown(clip(oneLine(summary), 300))}\n${posts.map(link).join(" · ")}` : posts.map(line).join("\n"),
      body: ""
    };
  });
  const groups = [false, true]; // Blue Posts, then news
  const SEP = 2;                // "\n\n" between items (counted for each item: a little conservative)
  const closing = (more: number) => `\n\n…and ${more} more update${more === 1 ? "" : "s"}`;
  // The longest the closing line can be, reserved in every limit whenever it may be needed.
  const tailRoom = (needed: boolean) => (needed ? closing(count).length : 0);

  const render = (texts: string[], more: number) => {
    const embeds: { description: string; color: number }[] = [];
    for (const news of groups) {
      const lines = texts.filter((t, i) => t && items[i].news === news);
      if (lines.length) embeds.push({ description: lines.join("\n\n"), color: news ? DIGEST_NEWS_COLOR : DIGEST_BLUE_POST_COLOR });
    }
    if (more) {
      if (embeds.length) embeds[embeds.length - 1].description += closing(more);
      else embeds.push({ description: closing(more).trim(), color: DIGEST_BLUE_POST_COLOR });
    }
    return embeds;
  };

  // 1-2: linked title + TL;DR (+ a share of the post); 3: linked titles only.
  const budget = DIGEST_BUDGET - tailRoom(extra > 0);
  const cap = EMBED_DESCRIPTION_LIMIT - tailRoom(extra > 0);
  for (const withTldr of [true, false]) {
    const fixed = items.map(it => it.head.length + (withTldr && it.tldr ? 1 + it.tldr.length : 0) + SEP);
    const fixedOf = (news: boolean) => fixed.reduce((n, f, i) => n + (items[i].news === news ? f : 0), 0);
    const total = fixed.reduce((a, b) => a + b, 0);
    if (total > budget || groups.some(g => fixedOf(g) > cap)) continue;

    const needs = items.map(it => (withTldr && it.body ? it.body.length + 1 : 0)); // +1 for "\n"
    const share = shareBudget(needs, budget - total);
    // Each embed's description also has its own limit: cap a group that went over, and give what
    // it frees to the other group.
    for (let pass = 0; pass < 2; pass++) {
      for (const g of groups) {
        const idx = items.map((it, i) => i).filter(i => items[i].news === g);
        const room = cap - fixedOf(g);
        if (idx.reduce((n, i) => n + share[i], 0) <= room) continue;
        const capped = shareBudget(idx.map(i => needs[i]), room);
        idx.forEach((i, k) => { share[i] = capped[k]; });
        const otherIdx = items.map((it, i) => i).filter(i => items[i].news !== g);
        const left = Math.min(cap - fixedOf(!g), budget - total - capped.reduce((a, b) => a + b, 0));
        const other = shareBudget(otherIdx.map(i => needs[i]), left);
        otherIdx.forEach((i, k) => { share[i] = other[k]; });
      }
    }
    const texts = items.map((it, i) => {
      const parts = [it.head];
      if (withTldr && it.tldr) parts.push(it.tldr);
      const room = share[i] - 1;
      // Cut while still one line per paragraph (so whole ones keep their formatting), then run together.
      if (withTldr && it.body && (it.body.length <= room || room >= MIN_EXCERPT_CHARS)) parts.push(cutAtSentence(it.body, room).text.replace(/\n/g, " "));
      return parts.join("\n");
    });
    return { payload: digestPayload(count, render(texts, extra)), shown: rows.length };
  }

  // 4: as many linked titles as fit, in order; the rest counted. A full embed doesn't stop the
  // other one from filling.
  const texts = items.map(() => "");
  const tail = tailRoom(true);
  const usedIn = { true: 0, false: 0 } as Record<string, number>;
  let used = 0, shown = 0;
  for (const [i, it] of items.entries()) {
    const cost = it.head.length + SEP;
    if (used + cost + tail > DIGEST_BUDGET) break;
    if (usedIn[String(it.news)] + cost + tail > EMBED_DESCRIPTION_LIMIT) continue;
    texts[i] = it.head;
    used += cost;
    usedIn[String(it.news)] += cost;
    shown += it.n;
  }
  return { payload: digestPayload(count, render(texts, count - shown)), shown };
}

function digestPayload(count: number, embeds: { description: string; color: number }[]): Record<string, unknown> {
  return { content: `${count} update${count === 1 ? "" : "s"} today`, allowed_mentions: { parse: [] }, embeds };
}

export function embedTextLength(embed: any): number {
  let n = (embed.title ?? "").length + (embed.description ?? "").length + (embed.footer?.text ?? "").length;
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
    embeds: [{ title: "🔔 Test alert", description: "This is only a test: urgent WoW: Forever alerts will be posted here like this, pinging the role set on the settings page.", color: ALERT_COLOR }]
  };
}

/** Shows which role urgent alerts will ping, without pinging it (no mentions allowed). */
export function roleNoticePayload(roleId: string | null): Record<string, unknown> {
  return {
    content: roleId ? `Urgent ForeverUpdates alerts in this channel will ping <@&${roleId}>.` : "Urgent ForeverUpdates alerts in this channel will no longer ping a role.",
    allowed_mentions: { parse: [] }
  };
}
