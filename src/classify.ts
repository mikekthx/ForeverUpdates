/**
 * Classify queue consumer. Batches up to 10 events into one Gemini call (Workers AI per item as
 * fallback), stores the results, promotes relevant articles to the watch list, and sends alerts.
 */

import { CLASSIFY_MAX_ATTEMPTS, OPERATIONAL_TITLE, WATCH_TIERS } from "./config";
import { bumpCounter, placeholders, sqlTime } from "./db";
import { broadcastStmts, startFanout } from "./fanout";
import { Classification, heuristicClassify } from "./lib/classify";
import { buildAlertPayload } from "./lib/discord";
import { classifyItems } from "./llm/chain";
import type { PromptItem } from "./llm/prompt";
import type { ClassifyMessage, Env, EventRow } from "./types";
import { trySendAlert } from "./work";

type By = "gemini" | "gemini-backup" | "workers-ai" | "keywords";

export async function handleClassifyBatch(batch: MessageBatch<ClassifyMessage>, env: Env): Promise<void> {
  const db = env.DB;
  const ids = [...new Set(batch.messages.map(m => m.body.id))];
  const { results } = await db.prepare(
    `SELECT * FROM events WHERE id IN (${placeholders(ids.length)}) AND state = 'pending'`
  ).bind(...ids).all<EventRow & { created_at: string }>();
  const rows = results ?? [];

  const items: PromptItem[] = rows.map(r => ({
    source: r.source, author: r.author, title: r.title, content: r.content,
    forumVerified: !!r.forum_verified, postedAt: null
  }));
  const chain = rows.length ? await classifyItems(env, items) : { results: new Map(), overflow: new Set<number>(), errors: [] };
  if (chain.errors.length) console.warn("Classification errors:", chain.errors);

  const decided = new Map<string, { cls: Classification; by: By }>();
  const deferred: string[] = [];
  const overflow: string[] = [];
  rows.forEach((row, i) => {
    const got = chain.results.get(i);
    if (got) { decided.set(row.id, got); return; }
    if (chain.overflow.has(i)) { overflow.push(row.id); return; } // not a failure; no attempt counted
    // No model available. An urgent-looking Blue Post goes out now on keywords; anything else
    // waits for a model, up to CLASSIFY_MAX_ATTEMPTS tries.
    const fallback = heuristicClassify({ title: row.title, content: row.content, forumVerified: !!row.forum_verified });
    // classify_attempts persists across queue retries and sweeper re-queues.
    const giveUp = row.classify_attempts + 1 >= CLASSIFY_MAX_ATTEMPTS;
    if (giveUp || (row.forum_verified && fallback.is_critical)) decided.set(row.id, { cls: fallback, by: "keywords" });
    else deferred.push(row.id);
  });

  // Store results. Forum-verified items are always relevant; irrelevant items are never critical.
  const stmts: D1PreparedStatement[] = [];
  const fanouts: { at: number; id: string }[] = []; // statement index of each broadcast's deliveries
  for (const row of rows) {
    const d = decided.get(row.id);
    if (!d) continue;
    const relevant = !!row.forum_verified || d.cls.is_forever_relevant;
    const critical = relevant && d.cls.is_critical;
    stmts.push(db.prepare(
      `UPDATE events SET state = 'done', classified_by = ?, relevant = ?, critical = ?, category = ?, summary = ?,
         rationale = ?, alert_state = ?, digest_state = ?, nudged_at = datetime('now')
       WHERE id = ? AND state = 'pending'`
    ).bind(d.by, relevant ? 1 : 0, critical ? 1 : 0, d.cls.category, d.cls.summary, d.cls.urgency_rationale,
      critical ? "pending" : null, relevant && !critical ? "queued" : null, row.id));
    // Other servers' channels get the same alert (with their own role), stored with the result.
    if (critical) {
      const payload = buildAlertPayload({ title: row.title, url: row.url, content: row.content, summary: d.cls.summary }, {});
      const [broadcast, deliveries] = broadcastStmts(db, row.id, "alert", payload);
      stmts.push(broadcast);
      fanouts.push({ at: stmts.length, id: row.id });
      stmts.push(deliveries);
    }

    // Watch relevant news articles that look operational (or were critical) for later edits.
    if (row.kind === "new" && row.doc_key.startsWith("news:") && relevant && (critical || OPERATIONAL_TITLE.test(row.title))) {
      stmts.push(db.prepare(
        `UPDATE documents SET watch_tier = 1, watch_until = ?, checked_at = datetime('now') WHERE key = ? AND watch_tier = 0`
      ).bind(sqlTime(Date.now() + WATCH_TIERS[1].days * 86_400_000), row.doc_key));
    }
  }
  // nudged_at = now on everything still waiting, so the sweeper doesn't queue a second copy while
  // this message's own retry is pending.
  if (deferred.length) {
    stmts.push(db.prepare(
      `UPDATE events SET classify_attempts = classify_attempts + 1, nudged_at = datetime('now') WHERE id IN (${placeholders(deferred.length)})`
    ).bind(...deferred));
  }
  if (overflow.length) {
    stmts.push(db.prepare(`UPDATE events SET nudged_at = datetime('now') WHERE id IN (${placeholders(overflow.length)})`).bind(...overflow));
  }
  const stored = stmts.length ? await db.batch(stmts) : [];
  await startFanout(env, fanouts.filter(f => (stored[f.at]?.meta?.changes ?? 0) > 0).map(f => f.id));
  for (const by of ["gemini", "gemini-backup", "workers-ai", "keywords"] as const) {
    await bumpCounter(db, `classified:${by}`, [...decided.values()].filter(d => d.by === by).length);
  }

  // Alerts: try right away; failures go to the work queue for retries with backoff.
  for (const row of rows) {
    const d = decided.get(row.id);
    if (!d || !(!!row.forum_verified || d.cls.is_forever_relevant) || !d.cls.is_critical) continue;
    const sent = await trySendAlert(env, {
      id: row.id, title: row.title, url: row.url, content: row.content, summary: d.cls.summary, alert_state: "pending"
    });
    if (!sent) {
      // If even the enqueue fails, the sweeper re-queues pending alerts after NUDGE_AFTER_MIN.
      try { await env.WORK.send({ t: "deliver", id: row.id }, { delaySeconds: 60 }); }
      catch (err) { console.warn(`Deliver enqueue failed for ${row.id}; sweeper will retry`, err); }
    }
  }

  const deferredSet = new Set(deferred);
  const overflowSet = new Set(overflow);
  for (const m of batch.messages) {
    if (deferredSet.has(m.body.id)) m.retry({ delaySeconds: 300 });
    else if (overflowSet.has(m.body.id)) m.retry({ delaySeconds: 10 });
    else m.ack();
  }
}
