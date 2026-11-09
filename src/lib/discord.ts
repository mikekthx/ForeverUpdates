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

/** The post text to show: for an edited post, only the lines that were added. */
function shownText(content: string): string {
  const focus = updateFocus(content ?? "");
  return (focus ? focus.newText : content ?? "").trim();
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
/** A Discord role ID (a snowflake); anything else is ignored rather than sent. */
const ROLE_ID_RE = /^\d{17,20}$/;

export function buildAlertPayload(
  item: { title: string; url: string; content: string; summary: string },
  opts: { roleId?: string }
): Record<string, unknown> {
  const roleId = ROLE_ID_RE.test(opts.roleId?.trim() ?? "") ? opts.roleId!.trim() : undefined;
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
  return {
    content: roleId ? `<@&${roleId}>` : undefined,
    // Never let forum/LLM text trigger @everyone or user pings; only the configured role.
    allowed_mentions: roleId ? { parse: [], roles: [roleId] } : { parse: [] },
    embeds: [{ title: clip(`🚨 ${item.title}`, 256), url: item.url, description: description || escapeMarkdown(clip(item.title, 256)), color: ALERT_COLOR }]
  };
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
 * with `extra` items the caller didn't load.
 */
export function buildDigestMessage(rows: DigestRow[], opts: { extra?: number } = {}): { payload: Record<string, unknown>; shown: number } {
  const extra = Math.max(0, opts.extra ?? 0);
  const count = rows.length + extra;
  const items = rows.map(r => {
    const { video, text } = splitVideo(r.content);
    return {
      news: r.source === "Blizzard News",
      head: `**[${linkText(r.title)}](${linkUrl(shortLink(r.url))})**${video ? ` · [▶ Video](${video})` : ""}`,
      tldr: r.summary?.trim() ? `> ${escapeMarkdown(clip(r.summary.replace(/\s+/g, " ").trim(), 300))}` : "", // a one-line quote box
      // Each line without its heading, list or quote prefix, to run together into one paragraph.
      body: text.split("\n").map(l => inlineMarkdown(l.trim())).filter(Boolean).join("\n")
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
    return { payload: digestPayload(count, render(texts, extra)), shown: items.length };
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
    shown++;
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
