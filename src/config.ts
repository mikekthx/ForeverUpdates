/** Every tunable in one place. */

import type { Region, SourceLabel, ThinkingLevel } from "./types";

// Edit this to point at your repo or profile so Blizzard can identify the bot.
export const USER_AGENT = "ForeverUpdates/4.1 (personal Discord notifier; +https://github.com/mikekthx/ForeverUpdates)";
export const FETCH_TIMEOUT_MS = 10_000;

// ── Sources ──
export const NEWS_LISTING_URL = "https://news.blizzard.com/en-us/feed/world-of-warcraft";
export const FOREVER_PARENT_SLUG = "wow-forever";
export const CATEGORY_CACHE_HOURS = 24;
export const REGIONS: Record<Region, { base: string; label: SourceLabel; fallbackCategoryIds: number[] }> = {
  // Fallback IDs are used only if discovery fails and nothing is cached. EU 359/360 confirmed from
  // forum URLs; US unverified. /debug shows what discovery found.
  us: { base: "https://us.forums.blizzard.com", label: "Blue Post (US)", fallbackCategoryIds: [346, 347, 348] },
  eu: { base: "https://eu.forums.blizzard.com", label: "Blue Post (EU)", fallbackCategoryIds: [359, 360] }
};
/** Forums that are polled. EU mostly repeats US posts; set the FORUM_REGIONS var ("us,eu") to add it back. */
export const DEFAULT_FORUM_REGIONS: Region[] = ["us"];

/**
 * News titles that clearly belong to another game/version or a store promotion. They are skipped
 * unless the title also mentions Forever. Only titles are checked: shared hotfix teasers list
 * every version.
 */
export const NEWS_TITLE_EXCLUDE =
  /\b(midnight|mists of pandaria|mop classic|burning crusade|bcca|season of discovery|classic era|cataclysm classic|talebound|worldcore|housing|savings|sale|bundle|shop|trading post|to your collection|twitch drops?|\d+% off)\b/i;

/** Forum posts older than this are ignored (old search hits must never alert). */
export const MAX_POST_AGE_HOURS = 48;

// ── Watching for edits ──
export const HOTFIX_TITLE = /hotfix/i;
/** Titles of posts Blizzard tends to keep editing. */
export const OPERATIONAL_TITLE =
  /\b(hotfix(es)?|known issues?|patch notes|update notes|maintenance|realms?|rulesets?|queues?|layers?|status|launch|tuning|class changes|outage)\b/i;
/** Watch tiers: higher = checked first. Interval in minutes, duration in days. */
export const WATCH_TIERS: Record<number, { intervalMin: number; days: number; label: string }> = {
  3: { intervalMin: 15, days: 21, label: "hotfix post" },
  2: { intervalMin: 15, days: 7, label: "Blue Post thread" },
  1: { intervalMin: 60, days: 21, label: "relevant article" }
};
export const WATCH_PROBES_PER_RUN = 6;     // cheap probes; only real changes are queued
export const WATCH_MIN_NEW_CHARS = 40;      // ignore edits where no added line is at least this long
export const BODY_MAX = 200_000;            // stored baseline text

// ── Work / classification ──
export const FORUM_CONTENT_MAX = 12_000;
export const NEWS_CONTENT_MAX = 30_000;
export const GEMINI_BATCH_CHARS = 90_000;
export const WORKERS_AI_ITEM_CHARS = 6_000;  // the fallback model gets a shorter excerpt per item
export const WORK_MAX_ATTEMPTS = 4;          // fetch failures before using the listing excerpt
export const BASELINE_MAX_FETCHES = 12;      // ≈3 sweeper cycles (~1 h) before giving up watching a seeded post
export const RECOVERY_MAX_FETCHES = 12;      // teaser-only items: retries for the full text, within 24 h
export const CLASSIFY_MAX_ATTEMPTS = 6;      // all models unavailable this many times → keywords
export const ALERT_MAX_ATTEMPTS = 8;
export const CROSSPOST_WINDOW_DAYS = 3;
export const NUDGE_AFTER_MIN = 20;           // sweeper re-queues work stuck this long
export const NUDGE_PER_RUN = 10;

// Gemini models, tried in this order (then Workers AI, with a short excerpt). Free tier per day:
// Flash-Lite 500 requests, the Flash models 20 (503 errors count too). Eval, 2026-10-28, 19 labeled
// items, 3 runs each: Flash-Lite at "high" thinking 47/47, no missed or false alerts, ~10 s per
// request ("low" 24/29, "medium" 50/57); 3.6 Flash at "low" 17-19/19, no missed alerts.
// 2026-11-07, 36 items (launch week added), markdown content, 3 runs: before the timing/known-issues
// prompt rules Flash-Lite 31/36 (2 missed, 3 false); after them Flash-Lite 99/108 (3 missed), and
// with the final wording (beta events, self-dated items, Twitch drops) Flash-Lite 20/20 and 3.6
// Flash 85/88 (2 missed: "tweaking numbers tomorrow"); Flash-Lite was mostly 503-overloaded then.
// A full Flash-Lite run on the final wording: 34/36, no missed alerts, 2 false (a Twitch drop
// starting that day, the "Now Live!" launch article).
// The GEMINI_MODEL and GEMINI_BACKUP_MODEL vars override the order ("none" turns the backup off).
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_BACKUP_MODEL = "gemini-3.6-flash";
/**
 * Settings per model, whichever place it has in the order, so swapping the models keeps the
 * settings they were tested with. Flash-Lite at "high" took 9-23 s, 3.6 Flash up to 26 s.
 */
export const GEMINI_MODEL_SETTINGS: Record<string, { thinking: ThinkingLevel; timeoutMs: number }> = {
  "gemini-3.5-flash-lite": { thinking: "high", timeoutMs: 45_000 },
  "gemini-3.6-flash": { thinking: "low", timeoutMs: 45_000 }
};
export const GEMINI_UNLISTED_MODEL_SETTINGS: { thinking: ThinkingLevel; timeoutMs: number } = { thinking: "low", timeoutMs: 45_000 };
export const WORKERS_AI_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const LLM_PAUSE_DAILY_QUOTA_MIN = 60; // after a per-day quota error, retry the model hourly
export const LLM_PAUSE_RATE_LIMIT_MIN = 2;
// 503 "high demand" or a timeout: skip the model past the next 5-minute polls (2026-10-28: hours long).
export const LLM_PAUSE_OVERLOAD_MIN = 10;

// ── Digest, retention, health ──
// The digest goes out at 5 PM Pacific (standard or daylight time), the end of Blizzard's US workday.
export const DIGEST_TIME_ZONE = "America/Los_Angeles";
export const DIGEST_HOUR = 17;
/** The digest is one message: at most this many items are loaded into it; any more are only counted
 * ("…and N more updates") and marked sent with the rest. */
export const DIGEST_MAX_ITEMS = 500;
/** For the digest's thread TL;DRs (main Gemini model only): well under the 2 minutes after which
 * another run may take over a digest in progress. */
export const DIGEST_TLDR_TIMEOUT_MS = 25_000;
/** The thread TL;DR request: each post's share, and the whole request's limit (cron CPU, Gemini
 * tokens per minute); threads past it are shown post by post. */
export const THREAD_POST_CHARS = 2000;
export const THREAD_PROMPT_CHARS = 30_000;
export const EVENT_RETENTION_DAYS = 45;
export const DOC_RETENTION_DAYS = 180;
export const HEALTH_MAX_FAILURES = 12;        // 1 hour of consecutive errors
export const HEALTH_MAX_EMPTY = 6;            // 30 minutes of zero items
export const HEALTH_WARN_COOLDOWN_HOURS = 6;
export const BACKLOG_WARN_MIN = 60;           // work stuck longer than this → warning

// ── Other servers (Discord OAuth "Add to Discord"; on when DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are set) ──
export const DISCORD_API = "https://discord.com/api/v10";
/** Channels that can sign up. Each alert or digest costs one Discord request per channel (Workers
 * Free: 50 per invocation, so they're spread over queue messages of FANOUT_PER_MESSAGE). */
export const MAX_SUBSCRIBERS = 100;
/** So one server can't take every slot. Re-adding a channel doesn't count against it. */
export const MAX_CHANNELS_PER_SERVER = 3;
export const FANOUT_PER_MESSAGE = 20;
/** A claimed delivery that's still pending this long later is claimed again (each post times out in 10 s). */
export const FANOUT_LEASE_MIN = 3;
export const FANOUT_MAX_ATTEMPTS = 8;
/** Stored alert/digest messages for other servers; only the last day is ever retried. */
export const BROADCAST_RETENTION_DAYS = 7;
/** How long the "Add to Discord" round trip may take. */
export const OAUTH_STATE_MAX_AGE_SEC = 600;
