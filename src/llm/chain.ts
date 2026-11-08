/**
 * Model chain: Gemini main model (one batched call) → Gemini backup model (the same call) →
 * Workers AI (per item, free daily allowance). A model that reports a quota, rate limit or
 * overload is paused for a while (stored in D1), so the bot stops spending calls on it and goes
 * straight to the next one. No limits are hard-coded: it
 * adapts to whatever your AI Studio project and Cloudflare account actually allow.
 */

import {
  GEMINI_BACKUP_MODEL, GEMINI_BATCH_CHARS, GEMINI_DEFAULT_MODEL, GEMINI_MODEL_SETTINGS, GEMINI_UNLISTED_MODEL_SETTINGS,
  LLM_PAUSE_DAILY_QUOTA_MIN, LLM_PAUSE_OVERLOAD_MIN, LLM_PAUSE_RATE_LIMIT_MIN,
  WORKERS_AI_DEFAULT_MODEL, WORKERS_AI_ITEM_CHARS
} from "../config";
import { bumpCounter, kvGetMany, kvSet } from "../db";
import type { Classification } from "../lib/classify";
import { clip } from "../lib/text";
import type { Env, ThinkingLevel } from "../types";
import { LlmError } from "./errors";
import { classifyWithGemini } from "./gemini";
import type { PromptItem } from "./prompt";
import { classifyWithWorkersAi } from "./workersAi";

export type Provider = "gemini" | "gemini-backup" | "workers-ai";

export interface GeminiModel { provider: "gemini" | "gemini-backup"; model: string; thinking: ThinkingLevel; timeoutMs: number }

/**
 * The Gemini models to try, in order, each with its own settings from GEMINI_MODEL_SETTINGS
 * (whatever its place in the order). Also used by /status and scripts/eval.
 */
export function geminiModels(env: Pick<Env, "GEMINI_MODEL" | "GEMINI_BACKUP_MODEL">): GeminiModel[] {
  const settings = (model: string) =>
    Object.hasOwn(GEMINI_MODEL_SETTINGS, model) ? GEMINI_MODEL_SETTINGS[model] : GEMINI_UNLISTED_MODEL_SETTINGS;
  const main = env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL;
  const backup = env.GEMINI_BACKUP_MODEL?.trim() || GEMINI_BACKUP_MODEL;
  const out: GeminiModel[] = [{ provider: "gemini", model: main, ...settings(main) }];
  if (backup !== main && backup.toLowerCase() !== "none") out.push({ provider: "gemini-backup", model: backup, ...settings(backup) });
  return out;
}

/** Pauses are per model, so a model keeps its pause when the order changes. */
export const geminiPauseKey = (model: string) => `pause:gemini:${model}`;
export interface ChainResult {
  results: Map<number, { cls: Classification; by: Provider }>;
  /** Items Gemini wasn't asked about only because the batch was full; retry them for Gemini. */
  overflow: Set<number>;
  errors: string[];
}

/** How long to stop calling a model after this error (0 = don't pause). Also used by scripts/eval. */
export function pauseMinutes(err: unknown): number {
  if (!(err instanceof LlmError)) return 0;
  return err.kind === "daily-quota" ? LLM_PAUSE_DAILY_QUOTA_MIN
    : err.kind === "rate-limit" ? LLM_PAUSE_RATE_LIMIT_MIN
    : err.kind === "overloaded" ? LLM_PAUSE_OVERLOAD_MIN
    : 0;
}

async function pause(db: D1Database, key: string, err: unknown): Promise<void> {
  const min = pauseMinutes(err);
  if (min > 0) await kvSet(db, key, new Date(Date.now() + min * 60_000).toISOString());
}

export async function classifyItems(env: Env, items: PromptItem[]): Promise<ChainResult> {
  const results: ChainResult["results"] = new Map();
  const overflow = new Set<number>();
  const errors: string[] = [];
  const models = geminiModels(env);
  const kv = await kvGetMany(env.DB, [...models.map(m => geminiPauseKey(m.model)), "pause:workers-ai"]);
  const paused = (key: string) => {
    const until = kv.get(key)?.value;
    return !!until && Date.parse(until) > Date.now();
  };

  // 1. Gemini: as many items as fit in one request, to the main model, then (if it fails) the
  //    same request to the backup model.
  if (env.GEMINI_API_KEY) {
    const take: number[] = [];
    let chars = 0;
    items.forEach((it, i) => {
      if (take.length === 0 || chars + it.content.length <= GEMINI_BATCH_CHARS) { take.push(i); chars += it.content.length; }
    });
    for (const { provider, model, timeoutMs, thinking } of models) {
      if (paused(geminiPauseKey(model))) continue;
      try {
        const got = await classifyWithGemini(take.map(i => items[i]), env.GEMINI_API_KEY, model, timeoutMs, thinking);
        got.forEach((cls, j) => results.set(take[j], { cls, by: provider }));
        await bumpCounter(env.DB, `calls:${provider}`);
        // Gemini is working: items left out only for size wait for its next batch rather than
        // going to the fallback model with a much shorter excerpt.
        items.forEach((_, i) => { if (!take.includes(i)) overflow.add(i); });
        break;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        // Failed calls count against the daily quota too (503s included), so count them.
        await bumpCounter(env.DB, `failed:${model}`);
        await pause(env.DB, geminiPauseKey(model), err);
      }
    }
  }

  // 2. Workers AI for anything left (shorter excerpt per item; free allowance is per day).
  const left = items.map((_, i) => i).filter(i => !results.has(i) && !overflow.has(i));
  if (left.length && env.AI && !paused("pause:workers-ai")) {
    const model = env.WORKERS_AI_MODEL?.trim() || WORKERS_AI_DEFAULT_MODEL;
    for (const i of left) {
      try {
        const cls = await classifyWithWorkersAi(env.AI, model, { ...items[i], content: clip(items[i].content, WORKERS_AI_ITEM_CHARS) });
        results.set(i, { cls, by: "workers-ai" });
        await bumpCounter(env.DB, "calls:workers-ai");
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        await pause(env.DB, "pause:workers-ai", err);
        if (pauseMinutes(err) > 0) break; // quota/rate limit: don't keep trying this run
      }
    }
  }
  return { results, overflow, errors };
}
