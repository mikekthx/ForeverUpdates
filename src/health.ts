/** Per-source health, plus a backlog check that catches a stalled queue. */

import { BACKLOG_WARN_MIN, DIGEST_HOUR, HEALTH_MAX_EMPTY, HEALTH_MAX_FAILURES, HEALTH_WARN_COOLDOWN_HOURS } from "./config";
import { kvGet, kvSet } from "./db";
import { digestClock } from "./digest";
import { postDiscord } from "./discord";
import { errMessage } from "./http";
import { clip } from "./lib/text";
import type { SourceResult } from "./sources";
import type { Env } from "./types";

export async function recordHealth(db: D1Database, sources: SourceResult[]): Promise<void> {
  const stmts = sources.map(s => {
    if (!s.ok) {
      return db.prepare(
        `INSERT INTO source_health (source, consecutive_failures, last_error, updated_at)
         VALUES (?, 1, ?, datetime('now'))
         ON CONFLICT(source) DO UPDATE SET
           consecutive_failures = consecutive_failures + 1,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      ).bind(s.key, clip(s.error ?? "unknown", 500));
    }
    const empty = s.rawCount === 0 ? 1 : 0;
    return db.prepare(
      `INSERT INTO source_health (source, consecutive_failures, consecutive_empty, last_ok_at, last_nonempty_at, last_raw_count, updated_at)
       VALUES (?1, 0, ?2, datetime('now'), CASE WHEN ?2 = 0 THEN datetime('now') END, ?3, datetime('now'))
       ON CONFLICT(source) DO UPDATE SET
         consecutive_failures = 0,
         consecutive_empty = CASE WHEN ?2 = 1 THEN consecutive_empty + 1 ELSE 0 END,
         last_ok_at = datetime('now'),
         last_nonempty_at = CASE WHEN ?2 = 0 THEN datetime('now') ELSE last_nonempty_at END,
         last_raw_count = ?3,
         last_error = NULL,
         updated_at = datetime('now')`
    ).bind(s.key, empty, s.rawCount);
  });
  if (stmts.length) await db.batch(stmts);
}

/** Work that has waited much longer than it should: the queue or consumer is stuck. */
export async function backlog(db: D1Database, now = new Date()): Promise<{ docs: number; events: number; alerts: number; digest: number; deliveries: number }> {
  const age = `-${BACKLOG_WARN_MIN} minutes`;
  // The last day a digest was due (an hour's grace after DIGEST_HOUR). Every digest run that gets
  // through closes its day, even an empty one, so a digest that keeps failing leaves digest:last behind it.
  const clock = digestClock(now);
  // The day before, by calendar (a 23 h DST day would make "24 hours ago" two days back).
  const dueDay = clock.hour > DIGEST_HOUR ? clock.date : new Date(Date.parse(`${clock.date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [docs, events, alerts, digest, deliveries] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'new' AND first_seen < datetime('now', ?)").bind(age),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'pending' AND created_at < datetime('now', ?)").bind(age),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE alert_state = 'pending' AND created_at < datetime('now', ?)").bind(age),
    // Items over a day old (so a new bot doesn't warn before its first digest) still queued after a missed digest.
    db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE digest_state = 'queued' AND created_at < datetime('now', '-25 hours')
         AND COALESCE((SELECT value FROM kv WHERE key = 'digest:last'), '') < ?`).bind(dueDay),
    // Other servers' posts still pending long after they were due: the fan-out is stuck (channels removed by hand don't count).
    db.prepare("SELECT COUNT(*) AS n FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.state = 'pending' AND d.created_at < datetime('now', ?)").bind(age)
  ]);
  const n = (r: D1Result<{ n: number }>) => r.results?.[0]?.n ?? 0;
  return { docs: n(docs), events: n(events), alerts: n(alerts), digest: n(digest), deliveries: n(deliveries) };
}

export async function warnIfUnhealthy(env: Env): Promise<void> {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT source, consecutive_failures, consecutive_empty, last_error, last_nonempty_at
     FROM source_health
     WHERE (consecutive_failures >= ? OR consecutive_empty >= ?)
       AND (warned_at IS NULL OR warned_at < datetime('now', ?))`
  ).bind(HEALTH_MAX_FAILURES, HEALTH_MAX_EMPTY, `-${HEALTH_WARN_COOLDOWN_HOURS} hours`).all<any>();

  const lines = (results ?? []).map((r: any) =>
    r.consecutive_failures >= HEALTH_MAX_FAILURES
      ? `• **${r.source}**: failing for ${r.consecutive_failures} runs. Last error: \`${clip(String(r.last_error ?? ""), 200)}\``
      : `• **${r.source}**: zero items for ${r.consecutive_empty} runs (parser or endpoint may have changed). Last non-empty: ${r.last_nonempty_at ?? "never"} UTC`
  );

  const stuck = await backlog(db);
  const lastBacklogWarn = await kvGet(db, "warn:backlog");
  const backlogDue = !lastBacklogWarn || Date.now() - Date.parse(lastBacklogWarn) > HEALTH_WARN_COOLDOWN_HOURS * 3_600_000;
  const queued = stuck.docs + stuck.events + stuck.alerts;
  const stuckTotal = queued + stuck.digest + stuck.deliveries;
  if (queued > 0 && backlogDue) {
    lines.push(`• **queues**: ${stuck.docs} item(s) not fetched, ${stuck.events} not classified and ${stuck.alerts} alert(s) not sent for over ${BACKLOG_WARN_MIN} min. Check the queue consumer in \`wrangler tail\` and the Queues daily operations quota.`);
  }
  if (stuck.digest > 0 && backlogDue) {
    lines.push(`• **digest**: ${stuck.digest} digest item(s) waiting: a digest was due but none went out. Discord may be refusing it: check \`wrangler tail\`.`);
  }
  // Alerts that gave up (ALERT_MAX_ATTEMPTS) since the last report, each reported once, outside the
  // cooldown. nudged_at is when the last attempt failed (whole seconds); the mark is the newest one
  // reported. Only finished seconds count, so a failure later in the same second isn't skipped. No
  // mark yet: every failed alert still stored (EVENT_RETENTION_DAYS).
  const failed = await db.prepare(
    `SELECT COUNT(*) AS n, MAX(nudged_at) AS last FROM events WHERE alert_state = 'failed'
       AND nudged_at > COALESCE((SELECT value FROM kv WHERE key = 'warn:failed-alerts'), '') AND nudged_at < datetime('now')`
  ).first<{ n: number; last: string | null }>();
  if (failed?.n) {
    lines.push(`• **alerts**: ${failed.n} alert(s) gave up after repeated Discord errors and were never posted. Check \`wrangler tail\` and the webhook.`);
  }
  if (stuck.deliveries > 0 && backlogDue) {
    lines.push(`• **other servers**: ${stuck.deliveries} post(s) to other servers' channels pending for over ${BACKLOG_WARN_MIN} min. Check fan-out messages in \`wrangler tail\`.`);
  }
  if (!lines.length) return;

  try {
    await postDiscord(env.DISCORD_WEBHOOK_URL, {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "⚠️ Triage bot: health warning",
        description: clip(lines.join("\n"), 4000),
        color: 0xf59e0b,
        footer: { text: "Check /status and /debug on the Worker" },
        timestamp: new Date().toISOString()
      }]
    });
    const marks = (results ?? []).map((r: any) =>
      db.prepare("UPDATE source_health SET warned_at = datetime('now') WHERE source = ?").bind(r.source));
    if (marks.length) await db.batch(marks);
    if (stuckTotal > 0 && backlogDue) await kvSet(db, "warn:backlog", new Date().toISOString());
    if (failed?.n) await kvSet(db, "warn:failed-alerts", failed.last!);
  } catch (err) {
    console.error("Health warning failed:", errMessage(err));
  }
}
