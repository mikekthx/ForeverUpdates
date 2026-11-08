/** Polling the three sources and turning responses into Hits. Cheap: no full-text fetching here. */

import { CATEGORY_CACHE_HOURS, DEFAULT_FORUM_REGIONS, FOREVER_PARENT_SLUG, MAX_POST_AGE_HOURS, NEWS_LISTING_URL, NEWS_TITLE_EXCLUDE, REGIONS } from "./config";
import { KvRow, hoursSince, kvSet } from "./db";
import { errMessage, getHtml, getJson } from "./http";
import { flattenCategoryList, parseSearch, parseTracker, pickForeverCategories, rawCount } from "./lib/forum";
import { parseNewsListing } from "./lib/news";
import type { Env, Hit, Region } from "./types";

export interface CategoryInfo {
  ids: number[];
  slug: string;
  origin: "live" | "cache" | "fallback";
  excluded?: number[];
}

export interface SourceResult {
  key: string;
  ok: boolean;
  rawCount: number;
  hits: Hit[];
  error?: string;
  sampleKeys?: string[];
}

/** The forum regions to poll: FORUM_REGIONS ("us,eu") if it names any known region, else the default. */
export function forumRegions(env: Pick<Env, "FORUM_REGIONS">): Region[] {
  const named = (env.FORUM_REGIONS ?? "").split(",").map(r => r.trim().toLowerCase());
  const regions = (Object.keys(REGIONS) as Region[]).filter(r => named.includes(r));
  return regions.length ? regions : DEFAULT_FORUM_REGIONS;
}

export async function resolveCategories(db: D1Database, region: Region, cached?: KvRow): Promise<CategoryInfo> {
  if (cached && hoursSince(cached.updated_at) < CATEGORY_CACHE_HOURS) {
    try { return { ...JSON.parse(cached.value), origin: "cache" }; } catch { /* refetch */ }
  }
  const { base, fallbackCategoryIds } = REGIONS[region];
  try {
    let picked = null;
    try {
      const site = await getJson(`${base}/en/wow/site.json`);
      if (Array.isArray(site?.categories)) picked = pickForeverCategories(site.categories, FOREVER_PARENT_SLUG);
    } catch (err) {
      console.warn(`site.json failed for ${region}:`, errMessage(err));
    }
    if (!picked) {
      const list = await getJson(`${base}/en/wow/categories.json?include_subcategories=true`);
      picked = pickForeverCategories(flattenCategoryList(list?.category_list?.categories ?? []), FOREVER_PARENT_SLUG);
    }
    if (!picked) throw new Error(`no "${FOREVER_PARENT_SLUG}" category found`);
    await kvSet(db, `cats:${region}`, JSON.stringify(picked));
    return { ...picked, origin: "live" };
  } catch (err) {
    console.error(`Category discovery failed for ${region}:`, errMessage(err));
    if (cached) {
      try { return { ...JSON.parse(cached.value), origin: "cache" }; } catch { /* fall through */ }
    }
    return { ids: fallbackCategoryIds, slug: FOREVER_PARENT_SLUG, origin: "fallback" };
  }
}

/** News titles worth fetching: not another version or a store promotion, unless they mention Forever. */
export function wantedNewsTitle(title: string): boolean {
  return /\bforever\b/i.test(title) || !NEWS_TITLE_EXCLUDE.test(title);
}

/** Forever categories for each region; `kv` holds the cached "cats:<region>" rows. */
export async function resolveAllCategories(db: D1Database, regions: Region[], kv: Map<string, KvRow>): Promise<Partial<Record<Region, CategoryInfo>>> {
  const infos = await Promise.all(regions.map(r => resolveCategories(db, r, kv.get(`cats:${r}`))));
  return Object.fromEntries(regions.map((r, i) => [r, infos[i]]));
}

/** Polls the tracker and search of each region in `cats`, plus the news listing. */
export async function collectSources(cats: Partial<Record<Region, CategoryInfo>>): Promise<SourceResult[]> {
  const forum = (region: Region, kind: "tracker" | "search") => async () => {
    const { base, label } = REGIONS[region];
    const info = cats[region]!;
    const allowed = new Set(info.ids);
    if (kind === "tracker") {
      const data = await getJson(`${base}/en/wow/groups/blizzard-tracker/posts.json`);
      const posts: any[] = Array.isArray(data) ? data : data?.posts ?? [];
      return { rawCount: rawCount(data), hits: parseTracker(data, region, label, base, allowed), sampleKeys: posts[0] ? Object.keys(posts[0]) : [] };
    }
    const q = encodeURIComponent(`group:blizzard-tracker #${info.slug} order:latest`);
    const data = await getJson(`${base}/en/wow/search.json?q=${q}`);
    return { rawCount: rawCount(data), hits: parseSearch(data, region, label, base, allowed), sampleKeys: data?.posts?.[0] ? Object.keys(data.posts[0]) : [] };
  };
  const news = async () => {
    const cards = parseNewsListing(await getHtml(NEWS_LISTING_URL));
    const hits: Hit[] = cards
      .filter(c => wantedNewsTitle(c.title))
      .map(c => ({
        key: `news:${c.articleId}`,
        kind: "news" as const,
        source: "Blizzard News" as const,
        region: null,
        url: c.url,
        title: c.title,
        author: "Blizzard Entertainment",
        excerpt: c.description,
        postedAt: null,
        forumVerified: false,
        postNumber: null,
        titleFromSlug: c.titleFromSlug
      }));
    return { rawCount: cards.length, hits };
  };

  const regions = Object.keys(cats) as Region[];
  type Job = [string, () => Promise<Omit<SourceResult, "key" | "ok">>];
  const jobs: Job[] = [
    ...regions.map((r): Job => [`tracker-${r}`, forum(r, "tracker")]),
    ...regions.map((r): Job => [`search-${r}`, forum(r, "search")]),
    ["news", news]
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? { key: jobs[i][0], ok: true, ...r.value }
      : { key: jobs[i][0], ok: false, rawCount: 0, hits: [], error: errMessage(r.reason) }
  );
}

/** Merges hits by key and drops forum posts too old to alert on. */
export function mergeHits(sources: SourceResult[], now = Date.now()): Hit[] {
  const cutoff = now - MAX_POST_AGE_HOURS * 3_600_000;
  const merged = new Map<string, Hit>();
  for (const s of sources) {
    for (const hit of s.hits) {
      if (hit.postedAt && Date.parse(hit.postedAt) < cutoff) continue;
      const prev = merged.get(hit.key);
      if (!prev || hit.excerpt.length > prev.excerpt.length) merged.set(hit.key, hit);
    }
  }
  return [...merged.values()];
}
