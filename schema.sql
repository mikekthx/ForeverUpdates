-- ForeverUpdates — v4 schema. Safe to run again: it only creates what is missing.
-- Two core tables: documents (every post/article ever seen, with its last known text) and
-- events (each new post or edit to triage). A new post is just an edit from nothing.

CREATE TABLE IF NOT EXISTS documents (
    key             TEXT PRIMARY KEY,          -- 'post:us:123456' | 'news:24302093'
    kind            TEXT NOT NULL,             -- 'post' | 'news'
    region          TEXT,                      -- 'us' | 'eu' | NULL
    source          TEXT NOT NULL,
    url             TEXT NOT NULL,
    title           TEXT NOT NULL,
    author          TEXT NOT NULL,
    excerpt         TEXT NOT NULL DEFAULT '',  -- listing/tracker teaser; last-resort content
    forum_verified  INTEGER NOT NULL DEFAULT 0,
    post_number     INTEGER,
    title_from_slug INTEGER NOT NULL DEFAULT 0,
    posted_at       TEXT,
    body            TEXT,                      -- last processed full text (edit baseline)
    probe           TEXT,                      -- cheap change signal for watched documents
    status          TEXT NOT NULL,             -- 'new' (awaiting first fetch) | 'seeded' | 'ok'
    watch_tier      INTEGER NOT NULL DEFAULT 0,-- 0 none, 1 article (hourly), 2 Blue Post thread, 3 hotfix post
    watch_until     TEXT,
    checked_at      TEXT,
    fetch_attempts  INTEGER NOT NULL DEFAULT 0,
    nudged_at       TEXT,                      -- last time work was queued for it
    first_seen      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_docs_watch  ON documents (watch_tier, checked_at);
CREATE INDEX IF NOT EXISTS idx_docs_status ON documents (status, nudged_at);
CREATE INDEX IF NOT EXISTS idx_docs_seen   ON documents (first_seen);

CREATE TABLE IF NOT EXISTS events (
    id                TEXT PRIMARY KEY,        -- '<doc key>@new' | '<doc key>@<hash of added lines>'
    doc_key           TEXT NOT NULL,
    kind              TEXT NOT NULL,           -- 'new' | 'edit'
    source            TEXT NOT NULL,
    title             TEXT NOT NULL,
    url               TEXT NOT NULL,
    author            TEXT NOT NULL,
    forum_verified    INTEGER NOT NULL DEFAULT 0,
    content           TEXT NOT NULL,           -- exactly what the model classifies
    fingerprint       TEXT,                    -- crosspost detection
    state             TEXT NOT NULL,           -- 'pending' | 'done' | 'duplicate'
    duplicate_of      TEXT,                    -- the crosspost's event id, or 'news:<id>' ('news' if the id is unknown) for a forum copy of an article
    classify_attempts INTEGER NOT NULL DEFAULT 0,
    classified_by     TEXT,                    -- 'gemini' | 'gemini-backup' | 'workers-ai' | 'keywords' | 'video-edit' (no model: only a video was added)
    relevant          INTEGER,
    critical          INTEGER,
    category          TEXT,
    summary           TEXT,
    rationale         TEXT,
    alert_state       TEXT,                    -- NULL | 'pending' | 'sent' | 'failed'
    alert_attempts    INTEGER NOT NULL DEFAULT 0,
    digest_state      TEXT,                    -- NULL | 'queued' | 'sent'
    nudged_at         TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_fp     ON events (fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_events_state  ON events (state, nudged_at);
CREATE INDEX IF NOT EXISTS idx_events_alert  ON events (alert_state, created_at);
CREATE INDEX IF NOT EXISTS idx_events_digest ON events (digest_state, created_at);

CREATE TABLE IF NOT EXISTS source_health (
    source               TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_empty    INTEGER NOT NULL DEFAULT 0,
    last_raw_count       INTEGER,
    last_ok_at           TEXT,
    last_nonempty_at     TEXT,
    last_error           TEXT,
    warned_at            TEXT,
    updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Small key/value store: category cache, seeded flag, digest date, model pauses, daily counters.
CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Other servers' channels, added through the public "Add to Discord" page (OAuth webhook.incoming).
-- A channel that removes its webhook is deleted here on the next post (Discord answers 404).
CREATE TABLE IF NOT EXISTS webhooks (
    id          TEXT PRIMARY KEY,              -- Discord webhook id
    token       TEXT NOT NULL,                 -- secret: never shown on /status
    guild_id    TEXT,
    channel_id  TEXT NOT NULL,
    role_id     TEXT,                          -- that server's role to @mention on critical alerts
    manage_hash TEXT NOT NULL,                 -- SHA-256 (hex) of the key in the server's manage link
    last_ok_at  TEXT,
    last_error  TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks (channel_id);

-- An alert or digest to send to every subscribed channel: one row per message, one delivery per channel.
CREATE TABLE IF NOT EXISTS broadcasts (
    id         TEXT PRIMARY KEY,               -- the event id (alert) | 'digest:<date>'
    kind       TEXT NOT NULL,                  -- 'alert' | 'digest'
    payload    TEXT NOT NULL,                  -- the Discord message (JSON); alerts get each server's role at send time
    nudged_at  TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts (created_at);

CREATE TABLE IF NOT EXISTS deliveries (
    broadcast_id TEXT NOT NULL,
    webhook_id   TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
    attempts     INTEGER NOT NULL DEFAULT 0,
    claim        TEXT,                         -- the queue run sending it now
    claimed_at   TEXT,
    last_error   TEXT,
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (broadcast_id, webhook_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON deliveries (webhook_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_claim   ON deliveries (claim);
