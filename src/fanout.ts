/**
 * Alerts and digests for other servers' channels (added through the public "Add to Discord" page).
 *
 * The owner's channel (DISCORD_WEBHOOK_URL) keeps its own path. For the other channels, each alert
 * or digest is stored once as a broadcast, with one delivery row per channel, written in the same
 * D1 batch that decides to send it. Work-queue "fanout" messages then post to FANOUT_PER_MESSAGE
 * channels each (Workers Free allows 50 subrequests per invocation), chaining one message to the
 * next until every channel has it. A delivery is claimed before it's posted, so two runs never post
 * the same one; the poller's sweeper restarts a chain that stopped.
 */

import { FANOUT_LEASE_MIN, FANOUT_MAX_ATTEMPTS, FANOUT_PER_MESSAGE, NUDGE_AFTER_MIN } from "./config";
import { bumpCounter, placeholders } from "./db";
import { DiscordError, postDiscord } from "./discord";
import { errMessage } from "./http";
import { webhookUrl, withRole } from "./lib/discord";
import { clip } from "./lib/text";
import type { Env } from "./types";

export type BroadcastKind = "alert" | "digest";

/**
 * Statements that store a broadcast and a pending delivery for every subscribed channel; nothing
 * when there are none. `guard` is an SQL condition (with its bound values) that must also hold, so
 * the broadcast can depend on another statement of the same batch. Idempotent: a second call
 * updates the stored message but never adds a second delivery to a channel. The second
 * statement's `meta.changes` is the number of new deliveries.
 */
export function broadcastStmts(
  db: D1Database, id: string, kind: BroadcastKind, payload: Record<string, unknown>,
  guard: { sql: string; binds: unknown[] } = { sql: "1", binds: [] }
): [D1PreparedStatement, D1PreparedStatement] {
  return [
    // (An INSERT ... SELECT needs its WHERE for SQLite to read ON CONFLICT as an upsert.)
    db.prepare(
      `INSERT INTO broadcasts (id, kind, payload) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM webhooks) AND (${guard.sql})
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`
    ).bind(id, kind, JSON.stringify(payload), ...guard.binds),
    db.prepare(
      `INSERT OR IGNORE INTO deliveries (broadcast_id, webhook_id) SELECT ?, id FROM webhooks WHERE (${guard.sql})`
    ).bind(id, ...guard.binds)
  ];
}

/** Starts sending broadcasts. If the queue is unavailable, the sweeper starts them later. */
export async function startFanout(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try { await env.WORK.sendBatch(ids.map(id => ({ body: { t: "fanout" as const, id } }))); }
  catch (err) { console.warn(`Fanout enqueue failed for ${ids.join(", ")}; sweeper will retry:`, errMessage(err)); }
}

interface Claimed { webhook_id: string; token: string; role_id: string | null; attempts: number }

/** Posts one broadcast to up to FANOUT_PER_MESSAGE channels, then queues the next part if any remain. */
export async function processFanout(env: Env, id: string): Promise<void> {
  const db = env.DB;
  const claim = crypto.randomUUID();
  const [, claimedRes, broadcastRes] = await db.batch<any>([
    db.prepare(
      `UPDATE deliveries SET claim = ?1, claimed_at = datetime('now'), attempts = attempts + 1
       WHERE rowid IN (
         SELECT d.rowid FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id
         WHERE d.broadcast_id = ?2 AND d.state = 'pending'
           AND (d.claimed_at IS NULL OR d.claimed_at < datetime('now', ?3))
         ORDER BY d.created_at LIMIT ?4)`
    ).bind(claim, id, `-${FANOUT_LEASE_MIN} minutes`, FANOUT_PER_MESSAGE),
    db.prepare(
      `SELECT d.webhook_id, d.attempts, w.token, w.role_id FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.claim = ?`
    ).bind(claim),
    db.prepare("SELECT kind, payload FROM broadcasts WHERE id = ?").bind(id),
    db.prepare("UPDATE broadcasts SET nudged_at = datetime('now') WHERE id = ?").bind(id)
  ]);
  const rows = (claimedRes.results ?? []) as Claimed[];
  const broadcast = broadcastRes.results?.[0] as { kind: BroadcastKind; payload: string } | undefined;
  if (!broadcast) return; // pruned
  if (!rows.length) return;

  const payload = JSON.parse(broadcast.payload) as Record<string, unknown>;
  const outcomes = await Promise.allSettled(rows.map(r =>
    // No inline waits: a rate-limited channel is retried by a later message instead.
    postDiscord(webhookUrl(r.webhook_id, r.token), broadcast.kind === "alert" ? withRole(payload, r.role_id) : withRole(payload, null), 0)));

  const stmts: D1PreparedStatement[] = [];
  const sent: string[] = [];
  let retries = 0, retryAfterSec = 0;
  const setState = (r: Claimed, state: "pending" | "sent" | "failed", error: string | null) => stmts.push(
    db.prepare("UPDATE deliveries SET state = ?, last_error = ? WHERE broadcast_id = ? AND webhook_id = ? AND claim = ?")
      .bind(state, error && clip(error, 300), id, r.webhook_id, claim));
  outcomes.forEach((o, i) => {
    const r = rows[i];
    if (o.status === "fulfilled") { sent.push(r.webhook_id); return; }
    const err = o.reason;
    const msg = errMessage(err);
    stmts.push(db.prepare("UPDATE webhooks SET last_error = ? WHERE id = ?").bind(clip(msg, 300), r.webhook_id));
    if (err instanceof DiscordError && err.gone) {
      // The server removed the webhook: forget the channel.
      console.log(`Webhook ${r.webhook_id} is gone (${err.status}); removing that channel`);
      stmts.push(db.prepare("DELETE FROM deliveries WHERE webhook_id = ?").bind(r.webhook_id));
      stmts.push(db.prepare("DELETE FROM webhooks WHERE id = ?").bind(r.webhook_id));
      return;
    }
    const rateLimited = err instanceof DiscordError && err.status === 429;
    if (err instanceof DiscordError && err.refused && !rateLimited) { setState(r, "failed", msg); return; }
    // A digest is posted at most once, as for the owner's channel: after no answer or a 5xx it may
    // have been posted. A duplicate alert is better than a missed one.
    if (broadcast.kind === "digest" && !rateLimited) { setState(r, "sent", `maybe posted: ${msg}`); return; }
    if (r.attempts >= FANOUT_MAX_ATTEMPTS) { setState(r, "failed", msg); return; }
    setState(r, "pending", msg);
    retries++;
    if (rateLimited) retryAfterSec = Math.max(retryAfterSec, err.retryAfterSec ?? 0);
  });
  if (sent.length) {
    stmts.push(db.prepare(
      `UPDATE deliveries SET state = 'sent', last_error = NULL WHERE broadcast_id = ? AND claim = ? AND webhook_id IN (${placeholders(sent.length)})`
    ).bind(id, claim, ...sent));
    stmts.push(db.prepare(
      `UPDATE webhooks SET last_ok_at = datetime('now'), last_error = NULL WHERE id IN (${placeholders(sent.length)})`
    ).bind(...sent));
  }
  stmts.push(db.prepare(
    `SELECT COUNT(*) AS n FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.broadcast_id = ? AND d.state = 'pending' AND d.claimed_at IS NULL`
  ).bind(id));
  const results = await db.batch<any>(stmts);
  await bumpCounter(db, `fanout:${broadcast.kind}`, sent.length);

  // Channels not tried yet: next part now. Channels to retry: one message after their claim expires,
  // within the sweeper's window so the two don't overlap.
  const fresh = Number(results.at(-1)?.results?.[0]?.n ?? 0);
  const sends: Promise<void>[] = [];
  if (fresh > 0) sends.push(env.WORK.send({ t: "fanout", id }));
  if (retries > 0) {
    const delaySeconds = Math.min(Math.max(retryAfterSec, FANOUT_LEASE_MIN * 60 + 10), (NUDGE_AFTER_MIN - 5) * 60);
    sends.push(env.WORK.send({ t: "fanout", id }, { delaySeconds }));
  }
  for (const r of await Promise.allSettled(sends)) {
    if (r.status === "rejected") console.warn(`Fanout re-enqueue failed for ${id}; sweeper will retry:`, errMessage(r.reason));
  }
}

/** Sweeper: broadcasts with deliveries still pending that no queue message has touched for a while (last day only). */
export function staleBroadcastsStmt(db: D1Database, limit: number): D1PreparedStatement {
  return db.prepare(
    `SELECT b.id FROM broadcasts b
     WHERE b.created_at > datetime('now', '-1 day')
       AND COALESCE(b.nudged_at, b.created_at) < datetime('now', ?)
       AND EXISTS (SELECT 1 FROM deliveries d WHERE d.broadcast_id = b.id AND d.state = 'pending')
     LIMIT ?`
  ).bind(`-${NUDGE_AFTER_MIN} minutes`, limit);
}
