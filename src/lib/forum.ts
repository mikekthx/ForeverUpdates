/** Blizzard Discourse forums: category discovery and parsing tracker/search responses. */

import type { Hit, Region, SourceLabel } from "../types";
import { decodeEntities, dropQuoteBlocks, firstYoutubeLink, htmlToText } from "./text";
import { escapeMarkdown, htmlToMarkdown } from "./markdown";

export interface DiscourseCategory {
  id: number;
  slug?: string;
  name?: string;
  parent_category_id?: number | null;
}

/**
 * Finds the Forever parent category and its non-beta children.
 * US and EU are separate Discourse instances with different IDs, so this runs per region.
 */
export function pickForeverCategories(
  categories: DiscourseCategory[],
  parentSlug = "wow-forever"
): { ids: number[]; slug: string; excluded: number[] } | null {
  const isTop = (c: DiscourseCategory) => c.parent_category_id == null;
  const label = (c: DiscourseCategory) => `${c.slug ?? ""} ${c.name ?? ""}`;

  const parent =
    categories.find(c => isTop(c) && c.slug === parentSlug) ??
    categories.find(c => isTop(c) && /forever/i.test(label(c)) && !/beta/i.test(label(c)));
  if (!parent) return null;

  const children = categories.filter(c => c.parent_category_id === parent.id);
  const beta = children.filter(c => /beta/i.test(label(c)));
  const keep = children.filter(c => !/beta/i.test(label(c)));

  return {
    ids: [parent.id, ...keep.map(c => c.id)],
    slug: parent.slug ?? parentSlug,
    excluded: beta.map(c => c.id)
  };
}

/** Flattens /categories.json?include_subcategories=true into the site.json shape. */
export function flattenCategoryList(categoryList: any[]): DiscourseCategory[] {
  const out: DiscourseCategory[] = [];
  const walk = (cats: any[], parentId: number | null) => {
    for (const c of cats ?? []) {
      out.push({ id: Number(c.id), slug: c.slug, name: c.name, parent_category_id: c.parent_category_id ?? parentId });
      if (Array.isArray(c.subcategory_list)) walk(c.subcategory_list, Number(c.id));
    }
  };
  walk(categoryList, null);
  return out;
}

export function forumPostUrl(base: string, p: any): string {
  const url = typeof p.url === "string" ? p.url : "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("/en/wow/")) return `${base}${url}`;
  if (url.startsWith("/t/")) return `${base}/en/wow${url}`;
  return `${base}/en/wow/t/${p.topic_slug ?? "topic"}/${p.topic_id}/${p.post_number ?? 1}`;
}

function postHit(region: Region, label: SourceLabel, base: string, p: any, title: string, url: string, excerpt: string): Hit {
  return {
    key: `post:${region}:${p.id}`,
    kind: "post",
    source: label,
    region,
    url,
    title,
    author: String(p.username ?? p.user?.username ?? p.name ?? "Blizzard"),
    excerpt,
    postedAt: p.created_at ?? null,
    forumVerified: true,
    postNumber: p.post_number != null ? Number(p.post_number) : null,
    titleFromSlug: false
  };
}

/** /groups/blizzard-tracker/posts.json → posts in the allowed (Forever) categories. */
export function parseTracker(data: any, region: Region, label: SourceLabel, base: string, allowed: Set<number>): Hit[] {
  const posts: any[] = Array.isArray(data) ? data : data?.posts ?? [];
  return posts
    .filter(p => allowed.has(Number(p.category_id ?? p.topic?.category_id)))
    .map(p =>
      postHit(region, label, base, p,
        String(p.title ?? p.topic_title ?? p.topic?.title ?? "Blizzard Blue Post"),
        forumPostUrl(base, p),
        htmlToText(String(p.excerpt ?? p.cooked ?? ""), { dropQuotes: true }))
    );
}

/** search.json → posts whose topic is in an allowed category (the #slug search includes beta). */
export function parseSearch(data: any, region: Region, label: SourceLabel, base: string, allowed: Set<number>, max = 15): Hit[] {
  const posts: any[] = data?.posts ?? [];
  const topics = new Map<number, any>((data?.topics ?? []).map((t: any) => [Number(t.id), t]));
  const out: Hit[] = [];
  for (const p of posts.slice(0, max)) {
    const topic = topics.get(Number(p.topic_id));
    if (topic && topic.category_id != null && !allowed.has(Number(topic.category_id))) continue;
    out.push(postHit(region, label, base, p,
      String(topic?.title ?? "WoW: Forever Blue Post"),
      `${base}/en/wow/t/${topic?.slug ?? "topic"}/${p.topic_id}/${p.post_number ?? 1}`,
      htmlToText(String(p.blurb ?? ""))));
  }
  return out;
}

/**
 * The text the bot triages for a post (quotes of other users dropped). Its first YouTube video, if
 * any, comes first as a youtu.be link (first, so cutting a long post never drops it; Discord shows
 * it apart). A post that is only embedded videos, like the Forever podcast posts, has no text of
 * its own; the videos' titles stand in.
 */
export function postText(cooked: string): string {
  const own = dropQuoteBlocks(cooked);
  const text = htmlToMarkdown(own) || [...own.matchAll(/\bdata-video-title\s*=\s*"([^"]*)"/gi)]
    .map(m => escapeMarkdown(decodeEntities(m[1]).replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .join("\n");
  return [firstYoutubeLink(own), text].filter(Boolean).join("\n");
}

/**
 * The news article a post merely points to, or null. Blizzard copies each news article into the
 * forums as its header image (/cms/blog_header/), a sentence or two and a "View Full Article"
 * link; the article itself is triaged from the news feed. Both parts are required so that a CM
 * post that just links to an article is still triaged as a post. Quoted text doesn't count: a
 * CM reply that quotes the copy is a real post.
 */
export function newsPointerArticleId(cooked: string): string | null {
  const own = dropQuoteBlocks(cooked);
  if (!/\/cms\/blog_header\//i.test(own)) return null;
  const link = own.match(
    /\bhref\s*=\s*["']https?:\/\/(?:worldofwarcraft(?:\.blizzard)?\.com\/[a-z]{2}-[a-z]{2}\/news|news\.blizzard\.com\/[a-z]{2}-[a-z]{2}\/article)\/(\d+)/i
  );
  return link ? link[1] : null;
}

/**
 * Whether a post's excerpt (as text) is a forum copy of a news article. In the tracker the copy's
 * header image link becomes "[<topic title>]"; in search results the excerpt starts with the image
 * URL. Used only when the post itself can't be fetched, since excerpts are cut off before the
 * "View Full Article" link.
 */
export function isNewsCopyExcerpt(title: string, excerpt: string): boolean {
  if (/^https?:\/\/\S*\/cms\/blog_header\/\S*\s/i.test(excerpt)) return true;
  return title.trim().length > 0 && excerpt.startsWith(`[${title.trim()}]`);
}

export function rawCount(data: any, field = "posts"): number {
  return Array.isArray(data) ? data.length : (data?.[field]?.length ?? 0);
}
