
export type Region = "us" | "eu";
/** Gemini 3.x thinking levels (there is no "minimal"). */
export type ThinkingLevel = "low" | "medium" | "high";
export type SourceLabel = "Blue Post (US)" | "Blue Post (EU)" | "Blizzard News";

/** Minimal shape of a queue producer, so tests can substitute a fake. */
export interface QueueLike<T> {
  send(body: T, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Iterable<{ body: T; delaySeconds?: number }>): Promise<void>;
}

/** Minimal shape of the Workers AI binding. */
export interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  WORK: QueueLike<WorkMessage>;
  CLASSIFY: QueueLike<ClassifyMessage>;
  AI?: AiLike;                       // optional: Workers AI fallback classifier
  GEMINI_API_KEY: string;
  DISCORD_WEBHOOK_URL: string;
  ADMIN_TOKEN: string;
  DISCORD_CRITICAL_ROLE_ID?: string;
  DISCORD_CLIENT_ID?: string;        // with DISCORD_CLIENT_SECRET: the public "Add to Discord" page
  DISCORD_CLIENT_SECRET?: string;
  GEMINI_MODEL?: string;
  GEMINI_BACKUP_MODEL?: string;      // "none" turns the backup model off
  WORKERS_AI_MODEL?: string;
  FORUM_REGIONS?: string;            // comma-separated, e.g. "us,eu"; default DEFAULT_FORUM_REGIONS
}

export type WorkMessage =
  | { t: "fetch"; key: string; baseline?: boolean }
  | { t: "deliver"; id: string }
  | { t: "fanout"; id: string };     // a broadcast to other servers' webhooks

export interface ClassifyMessage { id: string }

/** Something seen on a source during a poll. */
export interface Hit {
  key: string;                 // "post:us:123456" | "news:24302093"
  kind: "post" | "news";
  source: SourceLabel;
  region: Region | null;
  url: string;
  title: string;
  author: string;
  excerpt: string;
  postedAt: string | null;
  forumVerified: boolean;      // posted in a Forever forum category
  postNumber: number | null;   // 1 = opening post of a thread
  titleFromSlug: boolean;
}

export interface DocRow {
  key: string;
  kind: "post" | "news";
  region: Region | null;
  source: SourceLabel;
  url: string;
  title: string;
  author: string;
  excerpt: string;
  forum_verified: number;
  post_number: number | null;
  title_from_slug: number;
  body: string | null;
  probe: string | null;
  status: "new" | "seeded" | "ok";
  watch_tier: number;
  fetch_attempts: number;
}

export interface EventRow {
  id: string;
  doc_key: string;
  kind: "new" | "edit";
  source: string;
  title: string;
  url: string;
  author: string;
  forum_verified: number;
  content: string;
  classify_attempts: number;
}

