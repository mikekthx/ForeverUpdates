/** Gemini batch classification. Pure fetch, so scripts/eval can run it from Node too. */

import { fetchWithTimeout } from "../http";
import { Classification, sanitizeClassification } from "../lib/classify";
import { clip } from "../lib/text";
import { LlmError } from "./errors";
import { GEMINI_BATCH_SCHEMA, PromptItem, SYSTEM_PROMPT, renderItem } from "./prompt";
import type { ThinkingLevel } from "../types";

/** A thinking level from a setting, or the default if it isn't one. */
export function thinkingLevel(value: string | undefined, fallback: ThinkingLevel): ThinkingLevel {
  const v = value?.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : fallback;
}

/** Returns classifications by item index. Items missing from the model's answer are left out. */
export async function classifyWithGemini(
  items: PromptItem[], apiKey: string, model: string, timeoutMs = 45_000, thinking: ThinkingLevel = "low"
): Promise<Map<number, Classification>> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: "user",
      parts: [{ text: `Classify these ${items.length} items. Return exactly one result per item, echoing its ref.\n\n${items.map((it, i) => renderItem(it, i)).join("\n\n")}` }]
    }],
    generationConfig: {
      // Gemini 3.x: sampling parameters (temperature/top_p/top_k) are deprecated; leave them unset.
      thinkingConfig: { thinkingLevel: thinking },
      responseMimeType: "application/json",
      responseSchema: GEMINI_BATCH_SCHEMA
    }
  };

  let data: any;
  try {
    data = await post(endpoint, apiKey, payload, model, timeoutMs);
  } catch (err) {
    // An overloaded model often answers slowly instead of with a 503. The timeout also covers
    // reading the body, so it can surface from res.json() as well as from fetch().
    if ((err as { name?: string } | null)?.name === "TimeoutError") {
      throw new LlmError(`Gemini ${model} timed out after ${timeoutMs / 1000} s`, "overloaded");
    }
    throw err;
  }
  const candidate = data?.candidates?.[0];
  if (!candidate) throw new LlmError(`Gemini ${model} returned no candidates (${data?.promptFeedback?.blockReason ?? "no reason given"})`, "other");
  const text = (candidate.content?.parts ?? [])
    .filter((p: any) => typeof p.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
  if (!text) throw new LlmError(`Gemini ${model} returned empty text (finishReason: ${candidate.finishReason ?? "unknown"})`, "other");

  const out = new Map<number, Classification>();
  for (const r of JSON.parse(text)?.results ?? []) {
    const idx = Number(r?.ref);
    const cls = sanitizeClassification(r);
    if (Number.isInteger(idx) && idx >= 0 && idx < items.length && cls) out.set(idx, cls);
  }
  return out;
}

/** The request and its body read, under one timeout. */
async function post(endpoint: string, apiKey: string, payload: unknown, model: string, timeoutMs: number): Promise<any> {
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload)
  }, timeoutMs);
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      // Daily quotas are named like "GenerateRequestsPerDayPerProjectPerModel".
      throw new LlmError(`Gemini ${model} 429: ${clip(text, 300)}`, /per\s?day|perday|daily/i.test(text) ? "daily-quota" : "rate-limit");
    }
    // 503 "This model is currently experiencing high demand" (and 500s) are usually brief.
    throw new LlmError(`Gemini ${model} HTTP ${res.status}: ${clip(text, 300)}`, res.status === 503 || res.status === 500 ? "overloaded" : "other");
  }
  return res.json();
}
