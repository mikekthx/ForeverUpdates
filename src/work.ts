/**
 * Work queue consumer (one message per invocation, so each gets its own CPU budget).
 *
 *  fetch:   download the full post/article, compare it with the stored text, and record an event
 *           for a new document or for lines added since last time. The event insert and the
 *           document's new baseline are written in one atomic batch, so an edit can never be
 *           lost or reported twice, whatever happens to classification later.
 *  deliver: (re)send a critical alert to Discord.
 *  fanout:  send an alert or digest to other servers' channels (src/fanout.ts).
 */

import {
  ALERT_MAX_ATTEMPTS, BODY_MAX, CROSSPOST_WINDOW_DAYS, FORUM_CONTENT_MAX, NEWS_CONTENT_MAX,
  BASELINE_MAX_FETCHES, NUDGE_AFTER_MIN, REGIONS, WATCH_MIN_NEW_CHARS, WORK_MAX_ATTEMPTS
} from "./config";
import { bumpCounter } from "./db";
import { DiscordError, postDiscord } from "./discord";
import { processFanout } from "./fanout";
import { errMessage, getHtml, getJson } from "./http";
import { UPDATE_MARKER, markAddedLines } from "./lib/diff";
import { buildAlertPayload } from "./lib/discord";
import { fingerprintEdit, fingerprintNew } from "./lib/fingerprint";
import { isNewsCopyExcerpt, newsPointerArticleId, postText } from "./lib/forum";
import { articleProbe, extractArticleFullText, extractArticleTitle } from "./lib/news";
import { shortHash, splitVideoLine, VIDEO_LINE_RE } from "./lib/text";
import { clipMarkdown, escapeMarkdown, stripMarkdown } from "./lib/markdown";
import { postIdFromKey, postProbe } from "./poller";
import { wantedNewsTitle } from "./sources";
import type { DocRow, Env, WorkMessage } from "./types";

type Outcome = { retryAfterSec?: number };

export async function handleWorkBatch(batch: MessageBatch<WorkMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body;
      const out = body.t === "fetch" ? await processFetch(env, body.key, !!body.baseline, msg.attempts)
        : body.t === "deliver" ? await processDeliver(env, body.id, msg.attempts)
        : (await processFanout(env, body.id), {});
      if (out.retryAfterSec) msg.retry({ delaySeconds: out.retryAfterSec });
      else msg.ack();
    } catch (err) {
      console.error(`Work message failed (attempt ${msg.attempts}):`, err);
      msg.retry({ delaySeconds: Math.min(60 * 2 ** (msg.attempts - 1), 3600) });
    }
  }
}

interface Page {
  text: string; probe: string | null; title?: string; author?: string; fromExcerpt?: boolean;
  newsArticleId?: string;   // the post is only a forum copy of this news article ("" if the id is unknown)
}

async function fetchPage(doc: DocRow): Promise<Page> {
  if (doc.kind === "post") {
    const p = postIdFromKey(doc.key);
    if (!p) throw new Error(`bad post key ${doc.key}`);
    const post = await getJson(`${REGIONS[p.region].base}/en/wow/posts/${p.id}.json`);
    const cooked = String(post?.cooked ?? "");
    const text = postText(cooked);
    if (!text) throw new Error("empty post body");
    return {
      text, probe: await postProbe(post), author: post?.username ? String(post.username) : undefined,
      newsArticleId: newsPointerArticleId(cooked) ?? undefined
    };
  }
  const html = await getHtml(doc.url);
  const text = extractArticleFullText(html);
  // The article page says at least its listing teaser (a one-sentence article is all teaser); its
  // video link isn't text.
  const body = splitVideoLine(text).rest;
  if (!body || stripMarkdown(body).length < doc.excerpt.length) throw new Error("article text not found");
  return {
    text,
    probe: await articleProbe(html),
    title: doc.title_from_slug ? extractArticleTitle(html) || undefined : undefined
  };
}

export async function processFetch(env: Env, key: string, baseline: boolean, attempts: number): Promise<Outcome> {
  const db = env.DB;
  const doc = await db.prepare("SELECT * FROM documents WHERE key = ?").bind(key).first<DocRow>();
  if (!doc) return {};
  // "recovering": first classified from its teaser because the page wouldn't load; now retried for
  // the full text, which gets its own event (the teaser event already used "<key>@new").
  const recovering = doc.status === "ok" && doc.body == null;
  const isNew = doc.status === "new" || recovering;
  const isBaseline = baseline || doc.status === "seeded";

  let page: Page;
  try {
    page = await fetchPage(doc);
  } catch (err) {
    console.warn(`Fetch failed for ${key} (attempt ${attempts}):`, errMessage(err));
    await db.prepare("UPDATE documents SET fetch_attempts = fetch_attempts + 1 WHERE key = ?").bind(key).run();
    if (attempts < WORK_MAX_ATTEMPTS) return { retryAfterSec: 60 * attempts };
    if (isBaseline) {
      // Stay 'seeded' so the sweeper retries the baseline in 20 min. Stop watching only after a
      // long outage (never diff against a teaser). It stays 'seeded' even then: an 'ok' row without
      // a body would look like a new item still waiting for its full text.
      if (doc.fetch_attempts + 1 >= BASELINE_MAX_FETCHES) {
        await db.prepare("UPDATE documents SET watch_tier = 0 WHERE key = ?").bind(key).run();
      }
      return {};
    }
    if (doc.status !== "new") return {}; // a watch check or a recovery retry; tried again later
    // A new item whose page won't load: classify its teaser rather than drop it.
    page = {
      text: escapeMarkdown(doc.excerpt || doc.title), probe: null, fromExcerpt: true,
      newsArticleId: doc.kind === "post" && isNewsCopyExcerpt(doc.title, doc.excerpt) ? "" : undefined
    };
  }
  const text = clipMarkdown(page.text, BODY_MAX);
  const title = page.title ?? doc.title;
  const author = page.author ?? doc.author;
  // A forum copy of a news article is recorded as a duplicate of the article (which the news feed
  // brings in) and not watched; it is never classified, alerted or put in the digest itself. Unless
  // the news feed skips that article by title: then the copy is the only way it gets triaged.
  const pointsTo = page.newsArticleId != null && wantedNewsTitle(title)
    ? (page.newsArticleId ? `news:${page.newsArticleId}` : "news")
    : null;

  const saveDoc = db.prepare(
    `UPDATE documents SET body = ?, probe = ?, status = 'ok', title = ?, author = ?, title_from_slug = ?,
       watch_tier = CASE WHEN ? THEN 0 ELSE watch_tier END, checked_at = datetime('now') WHERE key = ?`
  ).bind(
    // A teaser must never become the edit baseline (the first real fetch would look like a rewrite).
    page.fromExcerpt ? null : text,
    page.probe, title, author, page.title ? 0 : doc.title_from_slug, pointsTo ? 1 : 0, key
  );

  if (isBaseline) {
    await saveDoc.run();
    return {};
  }

  // Build the event: the whole text for a new document, or the text with added lines marked.
  const maxContent = doc.kind === "post" ? FORUM_CONTENT_MAX : NEWS_CONTENT_MAX;
  let event: { id: string; kind: "new" | "edit"; title: string; content: string; fingerprint: string };
  let videoOnly = false; // an edit that only added a video
  if (isNew) {
    event = {
      id: recovering ? `${key}@full` : `${key}@new`,
      kind: "new", title, content: clipMarkdown(text, maxContent), fingerprint: await fingerprintNew(title, text)
    };
  } else {
    const { added, marked } = markAddedLines(doc.body!, text);
    // A new video counts too, though its link line is short.
    if (!added.some(l => stripMarkdown(l).length >= WATCH_MIN_NEW_CHARS || VIDEO_LINE_RE.test(l))) {
      // Cosmetic change (date stamp, whitespace): remember the new probe, keep the old baseline.
      await db.prepare("UPDATE documents SET probe = ?, checked_at = datetime('now') WHERE key = ?").bind(page.probe, key).run();
      return {};
    }
    videoOnly = added.every(l => VIDEO_LINE_RE.test(l));
    event = {
      id: `${key}@${shortHash(added.join("\n"))}`,
      kind: "edit",
      title: `${title} (${doc.kind === "post" ? "edited" : "updated"})`,
      content: clipMarkdown(`${UPDATE_MARKER}\n${marked}`, maxContent),
      fingerprint: await fingerprintEdit(title, added)
    };
  }

  // Only a video was added: there's no text to judge, so it's stored already decided (no model
  // call, never an alert), in the same INSERT so it can never sit waiting for the model. It goes to
  // the digest if the post is relevant: a Forever-forum post, or an article last judged relevant
  // by a classifier.
  let decided: { relevant: number; category: string } | null = null;
  if (videoOnly) {
    const prior = await db.prepare(
      `SELECT relevant, category FROM events WHERE doc_key = ? AND state = 'done' AND classified_by != 'video-edit'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).bind(key).first<{ relevant: number | null; category: string | null }>();
    decided = { relevant: doc.forum_verified || prior?.relevant === 1 ? 1 : 0, category: prior?.category ?? "General Community" };
  }

  // US/EU crossposts: the duplicate check runs inside the INSERT, so two consumers handling the US
  // and EU copies at the same moment can't both see "no duplicate yet" (D1 runs a batch as one
  // transaction). The same text from another source (a news edit and a forum reply) counts too. A
  // copy of an event already judged irrelevant is triaged itself: a forum copy is always relevant.
  const [insert, , stored] = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO events (id, doc_key, kind, source, title, url, author, forum_verified, content,
         fingerprint, state, duplicate_of, nudged_at, classified_by, relevant, critical, category, summary, rationale, digest_state)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
              CASE WHEN dup.id IS NULL THEN ?13 ELSE 'duplicate' END, dup.id, datetime('now'),
              ?14, ?15, ?16, ?17, ?18, ?19, CASE WHEN dup.id IS NULL THEN ?20 END
       FROM (SELECT COALESCE(?12, (SELECT id FROM events WHERE fingerprint = ?10 AND doc_key != ?2
                       AND created_at > datetime('now', ?11) AND (state = 'pending' OR (state = 'done' AND relevant = 1))
                       ORDER BY created_at, id LIMIT 1)) AS id) AS dup`
    ).bind(event.id, key, event.kind, doc.source, event.title, doc.url, author, doc.forum_verified,
      // An untriaged copy has no fingerprint, so it can't make a later event look like a crosspost.
      event.content, pointsTo ? null : event.fingerprint, `-${CROSSPOST_WINDOW_DAYS} days`, pointsTo,
      decided ? "done" : "pending", decided ? "video-edit" : null, decided?.relevant ?? null, decided ? 0 : null,
      decided?.category ?? null, decided ? "" : null, decided ? "Only a video was added." : null,
      decided?.relevant ? "queued" : null),
    saveDoc,
    db.prepare("SELECT state FROM events WHERE id = ?").bind(event.id)
  ]);
  const inserted = (insert.meta?.changes ?? 0) > 0;
  const state = (stored.results?.[0] as { state?: string } | undefined)?.state;
  if (!inserted) return {};
  await bumpCounter(db, pointsTo ? "events:news-pointer" : state === "duplicate" ? "events:duplicate" : `events:${event.kind}`);
  if (state === "pending") {
    // The event is safely stored. If the queue send fails, don't refetch the page: the sweeper
    // re-queues pending events after NUDGE_AFTER_MIN.
    try { await env.CLASSIFY.send({ id: event.id }); }
    catch (err) { console.warn(`Classify enqueue failed for ${event.id}; sweeper will retry:`, errMessage(err)); }
  }
  return {};
}

// ───────────────────────────── Alerts ─────────────────────────────

interface AlertRow {
  id: string; title: string; url: string; content: string; summary: string; alert_state: string | null;
}

function alertPayload(env: Env, row: AlertRow): Record<string, unknown> {
  return buildAlertPayload({ title: row.title, url: row.url, content: row.content ?? "", summary: row.summary ?? "" }, { roleId: env.DISCORD_CRITICAL_ROLE_ID });
}

async function sendAlert(env: Env, row: AlertRow): Promise<void> {
  await postDiscord(env.DISCORD_WEBHOOK_URL, alertPayload(env, row));
  await env.DB.prepare("UPDATE events SET alert_state = 'sent' WHERE id = ?").bind(row.id).run();
  await bumpCounter(env.DB, "alerts");
}

/** One attempt, used right after classification. Returns false if it should be retried later. */
export async function trySendAlert(env: Env, row: AlertRow): Promise<boolean> {
  try {
    await sendAlert(env, row);
    return true;
  } catch (err) {
    console.warn(`Alert for ${row.id} failed, will retry:`, errMessage(err));
    await env.DB.prepare("UPDATE events SET alert_attempts = alert_attempts + 1, nudged_at = datetime('now') WHERE id = ?").bind(row.id).run();
    return false;
  }
}

async function processDeliver(env: Env, id: string, attempts: number): Promise<Outcome> {
  const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<AlertRow & { alert_attempts: number }>();
  if (!row || row.alert_state !== "pending") return {};
  try {
    await sendAlert(env, row);
    return {};
  } catch (err) {
    const total = row.alert_attempts + 1;
    // nudged_at = now keeps the sweeper away while this message's own retry is pending; retry
    // delays stay under the sweeper's window so the two can't overlap and double-send.
    await env.DB.prepare(
      `UPDATE events SET alert_attempts = ?, nudged_at = datetime('now'),
         alert_state = CASE WHEN ? >= ? THEN 'failed' ELSE alert_state END WHERE id = ?`
    ).bind(total, total, ALERT_MAX_ATTEMPTS, id).run();
    if (total >= ALERT_MAX_ATTEMPTS) { console.error(`Giving up on alert ${id}:`, errMessage(err)); return {}; }
    const backoff = Math.min(60 * 2 ** (attempts - 1), (NUDGE_AFTER_MIN - 5) * 60);
    const wait = err instanceof DiscordError && err.retryAfterSec ? Math.min(err.retryAfterSec, (NUDGE_AFTER_MIN - 5) * 60) : backoff;
    return { retryAfterSec: wait };
  }
}
