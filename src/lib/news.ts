/** news.blizzard.com: listing cards, article text, and a cheap change probe. */

import { decodeEntities, dropElements, firstYoutubeLink, htmlToText, sha256Hex, tagAttrs, tokenize } from "./text";
import { htmlToMarkdown } from "./markdown";

// Blocks a page never shows (and that change per request: nonces, tokens, render times).
const NOT_SHOWN = ["script", "style", "noscript", "template"];

export interface NewsCard {
  articleId: string;
  url: string;
  title: string;
  description: string;
  titleFromSlug: boolean; // true when the card had no text and the title came from the URL
}

const LABEL_SEGMENT_RE = /^(world of warcraft|news|blizzard( entertainment)?|read more|featured( articles)?|latest articles|loading.*|load more)$/i;

function sameHost(url: string, origin: string): boolean {
  try { return new URL(url).hostname === new URL(origin).hostname; } catch { return false; }
}

function absoluteUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return `${origin}${href.startsWith("/") ? "" : "/"}${href}`;
}

/**
 * Parses the news.blizzard.com listing page (served as HTML, not RSS).
 * Groups every <a href=".../article/<id>..."> by article ID so a card whose image
 * and title are separate links still yields one item. Returns items in page order.
 */
export function parseNewsListing(html: string, origin = "https://news.blizzard.com"): NewsCard[] {
  const cards = new Map<string, { url: string; segments: string[]; seen: Set<string>; attrTitle: string }>();

  // Embedded scripts/JSON often contain anchor-like strings; never treat those as cards.
  const parts = tokenize(dropElements(html, NOT_SHOWN, undefined, true));

  for (let i = 1; i < parts.length; i += 2) {
    if (!/^<a(?=[\s/>])/i.test(parts[i])) continue;
    const attrs = tagAttrs(parts[i]);
    const href = attrs.get("href") ?? "";
    const articleId = href.match(/\/article\/(\d+)/)?.[1];
    if (!articleId) continue;
    // The link's content, to its </a>. Links don't nest, so a link left unclosed ends at the next one.
    let j = i + 2;
    while (j < parts.length && !/^<\/?a(?=[\s/>])/i.test(parts[j])) j += 2;
    if (!/^<\/a/i.test(parts[j] ?? "")) continue;
    const inner = dropElements(parts.slice(i + 1, j).join(""), ["script", "style", "svg"]);
    i = j;

    const segments = tokenize(inner)
      .filter((t, k) => k % 2 === 0)
      .map(t => decodeEntities(t).replace(/\s+/g, " ").trim())
      .filter(t => t.length > 0);

    const attrTitle = (attrs.get("aria-label") || attrs.get("title") || "").trim(); // ("" for one with no value)

    const url = absoluteUrl(href, origin);
    // Only follow links to the news site itself; never fetch arbitrary hosts found in the page.
    if (!sameHost(url, origin)) continue;

    const existing = cards.get(articleId);
    if (!existing) {
      cards.set(articleId, { url, segments, seen: new Set(segments), attrTitle });
    } else {
      // (A Set beside the list: many links to one article can't make this quadratic.)
      for (const seg of segments) if (!existing.seen.has(seg)) { existing.seen.add(seg); existing.segments.push(seg); }
      if (!existing.attrTitle && attrTitle) existing.attrTitle = attrTitle;
    }
  }

  const out: NewsCard[] = [];
  for (const [articleId, card] of cards) {
    const content = card.segments.filter(s => !LABEL_SEGMENT_RE.test(s));
    // Some card layouts use an empty "stretched link" over sibling text; fall back to the URL slug.
    const slugTitle = titleFromSlug(card.url);
    const title = content[0] || card.attrTitle || slugTitle;
    if (!title) continue;
    out.push({
      articleId,
      url: card.url,
      title,
      description: content.slice(1).join(" "),
      titleFromSlug: !content[0] && !card.attrTitle
    });
  }
  return out;
}

export function titleFromSlug(url: string): string {
  const m = url.match(/\/article\/\d+\/([^/?#]+)/i);
  if (!m) return "";
  const words = decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** Collects every JSON-LD object on a page (handles arrays and @graph). */
function jsonLdObjects(html: string): any[] {
  const out: any[] = [];
  // tokenize gives each <script>'s raw text whole, to its exact </script> (a "</scripture>" in a JSON
  // string doesn't end it); one never closed runs to the end of the page and is skipped.
  // Not one inside a <template> or <noscript>: those aren't the page's (the depth counts them).
  const parts = tokenize(html);
  let inert = 0;
  for (let i = 1; i + 2 < parts.length; i += 2) {
    const container = /^<(\/?)(?:template|noscript)(?=[\s/>])/i.exec(parts[i]);
    if (container) { inert = Math.max(0, inert + (container[1] ? -1 : 1)); continue; }
    if (inert || !/^<script(?=[\s/>])/i.test(parts[i]) || tagAttrs(parts[i]).get("type")?.trim().toLowerCase() !== "application/ld+json") continue;
    if (!/^<\/script/i.test(parts[i + 2])) continue;
    const m = [parts[i], parts[i + 1]];
    try {
      const walk = (v: any) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") {
          out.push(v);
          if (Array.isArray(v["@graph"])) v["@graph"].forEach(walk);
        }
      };
      walk(JSON.parse(m[1].trim()));
    } catch { /* malformed block; ignore */ }
  }
  return out;
}

/** Best available article title: JSON-LD headline, og:title, then the first <h1>. */
export function extractArticleTitle(html: string): string {
  for (const o of jsonLdObjects(html)) {
    if (typeof o.headline === "string" && o.headline.trim()) return decodeEntities(o.headline.trim());
  }
  const parts = tokenize(html);
  for (let i = 1; i < parts.length; i += 2) {
    if (!/^<meta(?=[\s/>])/i.test(parts[i])) continue;
    const a = tagAttrs(parts[i]);
    if (a.get("property")?.toLowerCase() === "og:title" && a.get("content")?.trim()) return a.get("content")!.trim();
  }
  const h1 = parts.findIndex((p, i) => i % 2 === 1 && /^<h1(?=[\s/>])/i.test(p));
  if (h1 < 0) return "";
  let end = h1 + 2;
  while (end < parts.length && !/^<\/h1(?=[\s/>])/i.test(parts[end])) end += 2;
  return end < parts.length ? htmlToText(parts.slice(h1 + 1, end).join("")) : "";
}

/** Outermost <tag>…</tag> elements, matched by depth so nested tags don't cut them short. */
function topLevelElements(html: string, tag: string): string[] {
  // The exact name ("<article-card>" isn't one), over tokenize's tags (with where each starts).
  const re = new RegExp(`^<(/?)${tag}(?=[\\s/>])`, "i");
  const out: string[] = [];
  let depth = 0, start = -1, pos = 0;
  for (const [i, part] of tokenize(html).entries()) {
    const m = i % 2 ? re.exec(part) : null;
    if (m && !m[1]) { // ("<article/>" opens one: browsers ignore "/>" here)
      if (depth === 0) start = pos;
      depth++;
    } else if (m && m[1] && depth > 0 && --depth === 0) out.push(html.slice(start, pos + part.length));
    pos += part.length;
  }
  return out;
}

function longest(texts: string[]): string {
  return texts.reduce((a, b) => (b.length > a.length ? b : a), "");
}

/**
 * Full readable text of an article page (unclipped).
 *
 * Prefers the page markup because it keeps line breaks, which in-place update detection relies
 * on. Drops <header> elements, then picks the largest top-level <article> (so "related articles"
 * cards elsewhere on the page, which change over time, aren't mistaken for edits), then <main>,
 * then the whole page.
 * JSON-LD articleBody is used only when the markup yields almost nothing (e.g. after a redesign).
 * The article's first YouTube video, if any, comes first as a youtu.be link (see postText).
 */
export function extractArticleFullText(html: string): string {
  const body = articleBody(html);
  // The video is looked for only where the text came from (not in promos or related cards).
  return [firstYoutubeLink(body.html), htmlToMarkdown(body.html)].filter(Boolean).join("\n");
}

/** The article's text and the markup it came from. */
function articleBody(html: string): { text: string; html: string } {
  // The article's own <header> holds the breadcrumb, a second copy of the title, the byline and
  // a comments link; the body follows it. (One pass over the page, with what it never shows.)
  const markupOnly = dropElements(html, [...NOT_SHOWN, "header"], undefined, true);

  // <article>, else <main>: the first with substantial text, else the first non-empty one (some real
  // articles are a sentence and a video). A short one gives way to a longer JSON-LD body. The whole
  // page (which adds the <title> and the site around it) only when none of these has any text.
  const largest = (tag: string) => topLevelElements(markupOnly, tag)
    .map(el => ({ text: htmlToText(el), html: el }))
    .reduce((a, b) => (b.text.length > a.text.length ? b : a), { text: "", html: "" });
  let dom = { text: "", html: "" };
  for (const tag of ["article", "main"]) {
    const el = largest(tag);
    if (el.text.length >= 200) { dom = el; break; }
    if (!dom.text) dom = el;
  }
  if (dom.text.length >= 200) return dom;

  let best = dom;
  for (const o of jsonLdObjects(html)) { // (tokenize sees a JSON-LD script inside a comment as the comment)
    if (typeof o.articleBody === "string") {
      const text = htmlToText(o.articleBody);
      if (text.length > best.text.length) best = { text, html: o.articleBody };
    }
  }
  return best.text ? best : { text: htmlToText(markupOnly), html: markupOnly };
}

/**
 * Cheap change signal for a watched article page, computed without text extraction: a hash of
 * the raw markup of the largest top-level <article> (or <main>, or the JSON-LD body, or the
 * page). Navigation, ads and "related articles" cards elsewhere on the page don't affect it.
 */
export async function articleProbe(html: string): Promise<string> {
  // Scripts, styles and comments often carry per-request values (nonces, tokens, render times);
  // hashing them would make every probe look like an edit.
  const markup = dropElements(html, NOT_SHOWN, undefined, true);
  const article = longest(topLevelElements(markup, "article"));
  if (article) return sha256Hex(article);
  const main = longest(topLevelElements(markup, "main"));
  if (main) return sha256Hex(main);
  const ld = jsonLdObjects(html).find(o => typeof o.articleBody === "string");
  return sha256Hex(ld ? ld.articleBody : markup);
}
