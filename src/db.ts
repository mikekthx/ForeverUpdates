/** Small D1 helpers. */

export interface KvRow { value: string; updated_at: string }

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export async function kvGetMany(db: D1Database, keys: string[]): Promise<Map<string, KvRow>> {
  if (!keys.length) return new Map();
  const { results } = await db.prepare(
    `SELECT key, value, updated_at FROM kv WHERE key IN (${placeholders(keys.length)})`
  ).bind(...keys).all<{ key: string } & KvRow>();
  return new Map((results ?? []).map(r => [r.key, { value: r.value, updated_at: r.updated_at }]));
}

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  return (await kvGetMany(db, [key])).get(key)?.value ?? null;
}

export async function kvSet(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value).run();
}

/** Daily counters shown on /status (e.g. which model classified how many items). */
export async function bumpCounter(db: D1Database, name: string, by = 1, now = new Date()): Promise<void> {
  if (by <= 0) return;
  const key = `count:${now.toISOString().slice(0, 10)}:${name}`;
  // Best effort: a failed counter update must never fail the work it's counting.
  await db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?, updated_at = excluded.updated_at`
  ).bind(key, String(by), by).run().catch(err => console.warn(`Counter ${name} not updated:`, err));
}

export function hoursSince(sqliteUtc: string): number {
  const t = Date.parse(sqliteUtc.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : Infinity;
}

/** SQLite datetime string for a JS time, e.g. '2026-11-04 23:00:00'. */
export function sqlTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
