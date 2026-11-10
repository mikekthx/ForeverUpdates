/**
 * The 5-minute cron. Deliberately cheap so it stays well under the free plan's 10 ms CPU limit:
 * it reads the sources, records new documents, runs a few cheap edit probes, and hands all heavy
 * work (full-text fetches, diffs, model calls) to queue consumers, each with its own CPU budget.
 */

import { HOTFIX_TITLE, NUDGE_AFTER_MIN, NUDGE_PER_RUN, RECOVERY_MAX_FETCHES, OPERATIONAL_TITLE, REGIONS, WATCH_PROBES_PER_RUN, WATCH_TIERS } from "./config";
import { kvGetMany, kvSet, placeholders, sqlTime } from "./db";
import { staleBroadcastsStmt } from "./fanout";
import { recordHealth } from "./health";
import { errMessage, getHtml, getJson } from "./http";
import { articleProbe } from "./lib/news";
import { sha256Hex } from "./lib/text";
import { collectSources, forumRegions, mergeHits, resolveAllCategories } from "./sources";
import type { Env, Hit, Region, WorkMessage } from "./types";

export interface PollStats {
  hits: number;
  newDocs: number;
  seeded: number;
  queued: number;
  probed: number;
  changed: number;
  nudged: number;
  sourceErrors: string[];
  queueError?: string;
}

/** The "seeded" flag names the forum regions it covers, so adding a region seeds once more. */
export const seededKey = (regions: Region[]) => `seeded:${regions.join(",")}`;

/** Watch tier for a newly seen document (relevant articles are promoted later by the classifier). */
export function initialWatchTier(hit: Hit): number {
  if (hit.kind === "news") return HOTFIX_TITLE.test(hit.title) ? 3 : 0;
  return hit.postNumber === 1 && OPERATIONAL_TITLE.test(hit.title) ? 2 : 0;
}

export async function runPoll(env: Env, opts: { seedOnly?: boolean } = {}): Promise<PollStats> {
  const db = env.DB;
  const stats: PollStats = { hits: 0, newDocs: 0, seeded: 0, queued: 0, probed: 0, changed: 0, nudged: 0, sourceErrors: [] };
  const regions = forumRegions(env);
  const seedFlag = seededKey(regions);
  const kv = await kvGetMany(db, [...regions.map(r => `cats:${r}`), seedFlag]);

  // 1. Sources.
  const sources = await collectSources(await resolveAllCategories(db, regions, kv));
  await recordHealth(db, sources);
  for (const s of sources) if (!s.ok) stats.sourceErrors.push(`${s.key}: ${s.error}`);
  const hits = mergeHits(sources);
  stats.hits = hits.length;

  // 2. New documents. On the first run (or /seed) everything visible is recorded as already seen;
  //    only watch-worthy ones are fetched, to get a baseline for edit detection.
  const seeding = opts.seedOnly || !kv.has(seedFlag);
  const existing = new Map<string, string>(); // key → stored URL
  for (let i = 0; i < hits.length; i += 50) {
    const chunk = hits.slice(i, i + 50).map(h => h.key);
    const { results } = await db.prepare(`SELECT key, url FROM documents WHERE key IN (${placeholders(chunk.length)})`)
      .bind(...chunk).all<{ key: string; url: string }>();
    for (const r of results ?? []) existing.set(r.key, r.url);
  }
  // A news article renamed by Blizzard (its title, so its URL slug, changed): store the listing's URL,
  // so probes and fetches go straight to it (the old one only redirects in a browser; getHtml
  // follows that as a fallback).
  const moved = hits.filter(h => h.kind === "news" && existing.has(h.key) && existing.get(h.key) !== h.url);
  if (moved.length) await db.batch(moved.map(h => db.prepare("UPDATE documents SET url = ? WHERE key = ?").bind(h.url, h.key)));
  const fresh = hits.filter(h => !existing.has(h.key));
  const messages: WorkMessage[] = [];
  const now = Date.now();
  if (fresh.length) {
    await db.batch(fresh.map(h => {
      const tier = initialWatchTier(h);
      const queue = !seeding || tier > 0;
      if (queue) messages.push({ t: "fetch", key: h.key, baseline: seeding || undefined });
      return db.prepare(
        `INSERT OR IGNORE INTO documents
           (key, kind, region, source, url, title, author, excerpt, forum_verified, post_number, title_from_slug,
            posted_at, status, watch_tier, watch_until, nudged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        h.key, h.kind, h.region, h.source, h.url, h.title, h.author, h.excerpt,
        h.forumVerified ? 1 : 0, h.postNumber, h.titleFromSlug ? 1 : 0, h.postedAt,
        seeding ? "seeded" : "new",
        tier, tier ? sqlTime(now + WATCH_TIERS[tier].days * 86_400_000) : null,
        queue ? sqlTime(now) : null
      );
    }));
  }
  stats.newDocs = seeding ? 0 : fresh.length;
  stats.seeded = seeding ? fresh.length : 0;
  if (seeding) {
    // Seeded only after a complete look: anything a failed source (or a news page showing no
    // articles, e.g. a bot check) hid would otherwise alert later as new. News has no post date,
    // so nothing else stops its old articles; forum posts older than 48 h are dropped anyway.
    const complete = sources.every(s => s.ok && (s.key !== "news" || s.rawCount > 0));
    // Every flag goes, so a failed /seed seeds again next run, and so does switching back to a region set used before.
    await db.prepare("DELETE FROM kv WHERE key LIKE 'seeded%'").run();
    if (complete) await kvSet(db, seedFlag, new Date().toISOString());
  }

  // 3. Cheap edit probes on watched documents that are due (highest tier first).
  const probes = await probeWatched(db);
  stats.probed = probes.checked;
  stats.changed = probes.changed.length;
  messages.push(...probes.changed.map(key => ({ t: "fetch" as const, key })));

  // 4. Sweeper: re-queue anything that should have been processed by now (lost message,
  //    exhausted queue quota, consumer crash). Makes the pipeline self-healing.
  const nudges = await collectNudges(db);
  stats.nudged = nudges.work.length + nudges.classify.length;
  messages.push(...nudges.work);

  stats.queued = messages.length;
  try {
    await sendAll(env.WORK, messages);
    if (nudges.classify.length) await env.CLASSIFY.sendBatch(nudges.classify.map(id => ({ body: { id } })));
  } catch (err) {
    // Nothing is lost: unprocessed documents/events are picked up by the sweeper on a later run.
    stats.queueError = errMessage(err);
    console.error("Queue send failed:", err);
  }
  return stats;
}

async function sendAll(queue: Env["WORK"], messages: WorkMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100).map(body => ({ body })));
  }
}

/** Hash used to notice that a forum post changed. Must match what the work consumer stores. */
export async function postProbe(post: any): Promise<string> {
  return sha256Hex(String(post?.cooked ?? ""));
}

export function postIdFromKey(key: string): { region: Region; id: number } | null {
  const m = key.match(/^post:(us|eu):(\d+)$/);
  return m ? { region: m[1] as Region, id: Number(m[2]) } : null;
}

async function probeWatched(db: D1Database): Promise<{ checked: number; changed: string[] }> {
  const due = (tier: number) => `(watch_tier = ${tier} AND checked_at < datetime('now', '-${WATCH_TIERS[tier].intervalMin} minutes'))`;
  const { results } = await db.prepare(
    `SELECT key, kind, url, probe FROM documents
     WHERE status = 'ok' AND watch_tier > 0 AND watch_until > datetime('now')
       AND (checked_at IS NULL OR ${due(3)} OR ${due(2)} OR ${due(1)})
     ORDER BY watch_tier DESC, checked_at ASC
     LIMIT ?`
  ).bind(WATCH_PROBES_PER_RUN).all<{ key: string; kind: string; url: string; probe: string | null }>();
  const rows = results ?? [];
  if (!rows.length) return { checked: 0, changed: [] };

  const outcomes = await Promise.allSettled(rows.map(async row => {
    if (row.kind === "post") {
      const p = postIdFromKey(row.key);
      if (!p) return false;
      return (await postProbe(await getJson(`${REGIONS[p.region].base}/en/wow/posts/${p.id}.json`))) !== row.probe;
    }
    return (await articleProbe(await getHtml(row.url))) !== row.probe;
  }));

  const changed = rows.filter((_, i) => outcomes[i].status === "fulfilled" && (outcomes[i] as PromiseFulfilledResult<boolean>).value).map(r => r.key);
  outcomes.forEach((o, i) => { if (o.status === "rejected") console.warn(`Probe failed for ${rows[i].key}:`, errMessage(o.reason)); });

  await db.prepare(`UPDATE documents SET checked_at = datetime('now') WHERE key IN (${placeholders(rows.length)})`)
    .bind(...rows.map(r => r.key)).run();
  return { checked: rows.length, changed };
}

async function collectNudges(db: D1Database): Promise<{ work: WorkMessage[]; classify: string[] }> {
  const stale = `datetime('now', '-${NUDGE_AFTER_MIN} minutes')`;
  const [docs, events, alerts, broadcasts] = await db.batch<any>([
    db.prepare(
      `SELECT key, status FROM documents
       WHERE (status = 'new'
              OR (status = 'seeded' AND watch_tier > 0)
              -- classified from its teaser because the page wouldn't load: retry for the full text
              OR (status = 'ok' AND body IS NULL AND first_seen > datetime('now', '-1 day') AND fetch_attempts < ?))
         AND (nudged_at IS NULL OR nudged_at < ${stale})
       LIMIT ?`).bind(RECOVERY_MAX_FETCHES, NUDGE_PER_RUN),
    db.prepare(
      `SELECT id FROM events WHERE state = 'pending' AND (nudged_at IS NULL OR nudged_at < ${stale}) LIMIT ?`
    ).bind(NUDGE_PER_RUN),
    db.prepare(
      `SELECT id FROM events
       WHERE alert_state = 'pending' AND created_at > datetime('now', '-1 day')
         AND (nudged_at IS NULL OR nudged_at < ${stale})
       LIMIT ?`).bind(NUDGE_PER_RUN),
    staleBroadcastsStmt(db, NUDGE_PER_RUN)
  ]);
  const work: WorkMessage[] = [
    ...(docs.results ?? []).map((r: any) => ({ t: "fetch" as const, key: r.key, baseline: r.status === "seeded" || undefined })),
    ...(alerts.results ?? []).map((r: any) => ({ t: "deliver" as const, id: r.id })),
    ...(broadcasts.results ?? []).map((r: any) => ({ t: "fanout" as const, id: r.id }))
  ];
  const classify = (events.results ?? []).map((r: any) => r.id as string);

  const marks: D1PreparedStatement[] = [];
  const docKeys = (docs.results ?? []).map((r: any) => r.key);
  const eventIds = [...classify, ...(alerts.results ?? []).map((r: any) => r.id)];
  if (docKeys.length) marks.push(db.prepare(`UPDATE documents SET nudged_at = datetime('now') WHERE key IN (${placeholders(docKeys.length)})`).bind(...docKeys));
  if (eventIds.length) marks.push(db.prepare(`UPDATE events SET nudged_at = datetime('now') WHERE id IN (${placeholders(eventIds.length)})`).bind(...eventIds));
  const broadcastIds = (broadcasts.results ?? []).map((r: any) => r.id);
  if (broadcastIds.length) marks.push(db.prepare(`UPDATE broadcasts SET nudged_at = datetime('now') WHERE id IN (${placeholders(broadcastIds.length)})`).bind(...broadcastIds));
  if (marks.length) await db.batch(marks);
  return { work, classify };
}
