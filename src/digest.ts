/** Daily digest of relevant, non-critical events. Sent by the 5-minute cron once it's due. */

import { BROADCAST_RETENTION_DAYS, DIGEST_HOUR, DIGEST_MAX_ITEMS, DIGEST_TIME_ZONE, DOC_RETENTION_DAYS, EVENT_RETENTION_DAYS } from "./config";
import { kvGet, placeholders } from "./db";
import { DiscordError, postDiscord } from "./discord";
import { broadcastStmts, startFanout } from "./fanout";
import { DigestRow, buildDigestMessage } from "./lib/discord";
import { UPDATE_MARKER } from "./lib/diff";
import { clipMarkdown } from "./lib/markdown";
import type { Env } from "./types";

const DIGEST_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: DIGEST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
});

/** The date (YYYY-MM-DD) and hour at `now` in DIGEST_TIME_ZONE, daylight saving included. */
export function digestClock(now: Date): { date: string; hour: number } {
  const p = Object.fromEntries(DIGEST_CLOCK.formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/**
 * When the next digest is due (DIGEST_HOUR in DIGEST_TIME_ZONE), as a Unix time in seconds.
 * shortcut: steps through whole UTC hours, so a zone offset of :30 or :45 would be off by that much.
 */
export function nextDigestAt(now: Date): number {
  let t = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  while (t <= now.getTime() || digestClock(new Date(t)).hour !== DIGEST_HOUR) t += 3_600_000;
  return t / 1000;
}

/**
 * Sends the day's ONE digest message once DIGEST_TIME_ZONE's clock passes DIGEST_HOUR (or now, for
 * /run-digest: a manual send is that day's digest). If Discord refuses it (nothing posted), the
 * next run tries again; once it's posted, or may have been, the day is closed. Returns null when
 * it's not time yet or today's digest was already sent.
 */
export async function maybeSendDigest(env: Env, now: Date, opts: { anyTime?: boolean } = {}): Promise<{ sent: number; busy?: boolean } | null> {
  const { date: today, hour } = digestClock(now);
  if (!opts.anyTime && hour < DIGEST_HOUR) return null;
  if (((await kvGet(env.DB, "digest:last")) ?? "") >= today) return null; // today, or a later day (clock skew)

  const result = await sendDigest(env, today);
  if (result.busy) return result; // another run is posting today's digest right now
  await closeDayStmt(env.DB, today).run();
  await prune(env.DB);
  return result;
}

/**
 * The one "digest in progress" row: every run must create it (atomically) before sending, so only
 * one can be sending at a time, and changes or removes it only while it still holds it (its
 * `owner` tag). "preparing" while it loads the posts (if the run stops there, nothing was posted);
 * "posting" from just before the Discord call (if it stops there, the message may have been posted).
 */
interface InFlight { name: string; owner: string; ids: string[]; state: "preparing" | "posting" }
const IN_FLIGHT_KEY = "digest:inflight";
/** A run still in progress after this long has stopped (Discord times out in 10 s). */
const STALE_MIN = 2;

/**
 * Posts the digest of everything queued now, as `name` (its date in DIGEST_TIME_ZONE), then marks those items
 * sent. Delivery is at most once: a 4xx means Discord refused it, so the next run tries again;
 * after no answer or a 5xx the message may have been posted, so it counts as sent. A run that
 * stopped while posting is completed by the next one, without posting again; one that stopped
 * while preparing is simply redone.
 */
async function sendDigest(env: Env, name: string): Promise<{ sent: number; busy?: boolean }> {
  const db = env.DB;
  const owner = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    const taken = await db.prepare(
      "INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    ).bind(IN_FLIGHT_KEY, JSON.stringify({ name, owner, ids: [], state: "preparing" } satisfies InFlight)).run();
    if (taken.meta?.changes) break;

    // Another run holds it: leave it alone unless it's clearly stopped.
    const held = await db.prepare(
      `SELECT value, updated_at < datetime('now', ?) AS stale FROM kv WHERE key = ?`
    ).bind(`-${STALE_MIN} minutes`, IN_FLIGHT_KEY).first<{ value: string; stale: number }>();
    if (!held) { // it just finished; try once more
      if (attempt > 1) return { sent: 0, busy: true };
      continue;
    }
    if (!held.stale || attempt > 0) return { sent: 0, busy: true };
    const other = parseInFlight(held.value);
    if (other?.state === "posting") {
      // It may have posted: mark its items (never repost them) and take the row from it.
      await finish(db, other.ids, other.name, held.value);
      if (other.name === name) return { sent: 0 }; // that was this digest
    } else {
      // It never reached Discord: remove its row (only if it's still that exact row).
      await db.prepare("DELETE FROM kv WHERE key = ? AND value = ?").bind(IN_FLIGHT_KEY, held.value).run();
    }
  }

  // Holding the row now: recheck the day, in case a run finished today's digest just before.
  if (((await kvGet(db, "digest:last")) ?? "") >= name) {
    await releaseMine(db, owner);
    return { sent: 0 };
  }

  const mine = (state: InFlight["state"], ids: string[]) => JSON.stringify({ name, owner, ids, state } satisfies InFlight);
  let mayHavePosted = false;
  try {
    // Exactly the items queued now; items queued while this runs wait for the next digest.
    const { results: queued } = await db.prepare(
      "SELECT id FROM events WHERE digest_state = 'queued' ORDER BY created_at ASC, id ASC"
    ).all<{ id: string }>();
    const ids = (queued ?? []).map(r => r.id);
    if (!ids.length) { await releaseMine(db, owner); return { sent: 0 }; }

    const rows = await loadRows(db, ids.slice(0, DIGEST_MAX_ITEMS));
    const { payload } = buildDigestMessage(rows, { extra: ids.length - rows.length });
    // "preparing" → "posting", only if this run still holds the row. In the same batch, and only if
    // that worked, the digest is stored for other servers' channels: one per channel per day.
    const posting = {
      sql: `EXISTS (SELECT 1 FROM kv WHERE key = ? AND json_extract(value, '$.owner') = ? AND json_extract(value, '$.state') = 'posting')`,
      binds: [IN_FLIGHT_KEY, owner]
    };
    const [moved, , fanned] = await db.batch([
      db.prepare(
        `UPDATE kv SET value = ?, updated_at = datetime('now')
         WHERE key = ? AND json_extract(value, '$.owner') = ? AND json_extract(value, '$.state') = 'preparing'`
      ).bind(mine("posting", ids), IN_FLIGHT_KEY, owner),
      ...broadcastStmts(db, `digest:${name}`, "digest", payload, posting)
    ]);
    if (!moved.meta?.changes) return { sent: 0, busy: true }; // another run took over: it sends instead
    if ((fanned.meta?.changes ?? 0) > 0) await startFanout(env, [`digest:${name}`]);

    mayHavePosted = true;
    try {
      await postDiscord(env.DISCORD_WEBHOOK_URL, payload);
    } catch (err) {
      if (err instanceof DiscordError && err.refused) { mayHavePosted = false; throw err; } // retried next run
      console.warn("Digest post may have reached Discord (no answer, 5xx or 408); counting it as sent so it is never posted twice:", err);
    }
    await finish(db, ids, name, null, owner);
    return { sent: ids.length };
  } catch (err) {
    // Before Discord could have it (loading failed, or Discord refused it): free the row so the
    // next run sends the digest. After that, the "posting" row stays, and the next run marks its
    // items without reposting.
    if (!mayHavePosted) await releaseMine(db, owner).catch(() => { /* stale after STALE_MIN; redone then */ });
    throw err;
  }
}

function parseInFlight(value: string | null): InFlight | null {
  try { return value ? (JSON.parse(value) as InFlight) : null; } catch { return null; }
}

/** Records `day`'s digest as sent. Only ever moves forward, so a run finishing late can't reopen a later day. */
function closeDayStmt(db: D1Database, day: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES ('digest:last', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE excluded.value > kv.value`
  ).bind(day);
}

async function releaseMine(db: D1Database, owner: string): Promise<void> {
  await db.prepare("DELETE FROM kv WHERE key = ? AND json_extract(value, '$.owner') = ?").bind(IN_FLIGHT_KEY, owner).run();
}

/**
 * Marks the items sent, closes the digest's day and removes the in-progress row, in one batch (so no
 * other run can find the row gone but the day still open): the row this run owns, or (settling a
 * stopped run) exactly the row that was read.
 */
async function finish(db: D1Database, ids: string[], day: string, heldValue: string | null, owner?: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    stmts.push(db.prepare(`UPDATE events SET digest_state = 'sent' WHERE digest_state = 'queued' AND id IN (${placeholders(chunk.length)})`).bind(...chunk));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) stmts.push(closeDayStmt(db, day));
  stmts.push(heldValue != null
    ? db.prepare("DELETE FROM kv WHERE key = ? AND value = ?").bind(IN_FLIGHT_KEY, heldValue)
    : db.prepare("DELETE FROM kv WHERE key = ? AND json_extract(value, '$.owner') = ?").bind(IN_FLIGHT_KEY, owner ?? ""));
  await db.batch(stmts);
}

/**
 * The digest text for these events. The message shows at most ~5,800 characters, so only a share of
 * each post is loaded (cron runs get 10 ms of CPU): about 30,000 characters in all. An edit's added
 * lines can be anywhere in it, so edits get three times as much.
 */
async function loadRows(db: D1Database, ids: string[]): Promise<DigestRow[]> {
  const perItem = Math.min(4500, Math.floor(30_000 / ids.length));
  const perEdit = Math.min(12_000, Math.floor(90_000 / ids.length));
  const rows: (DigestRow & { created_at: string })[] = [];
  // D1 allows 100 bound parameters per statement.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT id, source, title, url, substr(summary, 1, 300) AS summary, created_at,
              substr(content, 1, CASE WHEN kind = 'edit' THEN ? ELSE ? END) AS content
       FROM events WHERE id IN (${placeholders(chunk.length)})`
    ).bind(perEdit + 1, perItem + 1, ...chunk).all<DigestRow & { created_at: string }>();
    // One character more than needed shows whether substr cut it: then it's cut again as markdown
    // (whole lines, the last one as plain text), so no formatting is left open.
    for (const r of results ?? []) r.content = clipMarkdown(r.content ?? "", r.content?.startsWith(UPDATE_MARKER) ? perEdit : perItem);
    rows.push(...(results ?? []));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

async function prune(db: D1Database): Promise<void> {
  await db.batch([
    // Finished events. Pending alerts/digest items and unclassified events are never pruned.
    db.prepare(
      `DELETE FROM events WHERE created_at < datetime('now', ?)
         AND state != 'pending' AND (alert_state IS NULL OR alert_state != 'pending')
         AND (digest_state IS NULL OR digest_state != 'queued')`
    ).bind(`-${EVENT_RETENTION_DAYS} days`),
    // Documents are the "already seen" set; keep them long enough that nothing old resurfaces.
    db.prepare(
      `DELETE FROM documents WHERE first_seen < datetime('now', ?) AND status != 'new'
         AND (watch_tier = 0 OR watch_until < datetime('now'))`
    ).bind(`-${DOC_RETENTION_DAYS} days`),
    // Watched documents past their window: drop the stored text, keep the row.
    db.prepare(`UPDATE documents SET watch_tier = 0, body = NULL WHERE watch_tier > 0 AND watch_until < datetime('now')`),
    db.prepare(`DELETE FROM kv WHERE key LIKE 'count:%' AND updated_at < datetime('now', '-30 days')`),
    // Other servers' alerts and digests: only the last day is ever retried.
    db.prepare(`DELETE FROM deliveries WHERE broadcast_id IN (SELECT id FROM broadcasts WHERE created_at < datetime('now', ?))`).bind(`-${BROADCAST_RETENTION_DAYS} days`),
    db.prepare(`DELETE FROM broadcasts WHERE created_at < datetime('now', ?)`).bind(`-${BROADCAST_RETENTION_DAYS} days`)
  ]);
}
