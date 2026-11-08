/** Per-source health, plus a backlog check that catches a stalled queue. */

import { BACKLOG_WARN_MIN, HEALTH_MAX_EMPTY, HEALTH_MAX_FAILURES, HEALTH_WARN_COOLDOWN_HOURS } from "./config";
import { kvGet, kvSet } from "./db";
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
export async function backlog(db: D1Database): Promise<{ docs: number; events: number; alerts: number }> {
  const age = `-${BACKLOG_WARN_MIN} minutes`;
  const [docs, events, alerts] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'new' AND first_seen < datetime('now', ?)").bind(age),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'pending' AND created_at < datetime('now', ?)").bind(age),
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE alert_state = 'pending' AND created_at < datetime('now', ?)").bind(age)
  ]);
  return { docs: docs.results?.[0]?.n ?? 0, events: events.results?.[0]?.n ?? 0, alerts: alerts.results?.[0]?.n ?? 0 };
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
  const stuckTotal = stuck.docs + stuck.events + stuck.alerts;
  if (stuckTotal > 0 && backlogDue) {
    lines.push(`• **queues**: ${stuck.docs} item(s) not fetched, ${stuck.events} not classified and ${stuck.alerts} alert(s) not sent for over ${BACKLOG_WARN_MIN} min. Check the queue consumer in \`wrangler tail\` and the Queues daily operations quota.`);
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
  } catch (err) {
    console.error("Health warning failed:", errMessage(err));
  }
}
