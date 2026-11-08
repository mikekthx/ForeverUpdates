/** Workers AI fallback: free daily allowance, one item per call with JSON mode. */

import { Classification, sanitizeClassification } from "../lib/classify";
import { clip } from "../lib/text";
import type { AiLike } from "../types";
import { LlmError } from "./errors";
import { PromptItem, SINGLE_JSON_SCHEMA, SYSTEM_PROMPT, renderItem } from "./prompt";

export async function classifyWithWorkersAi(ai: AiLike, model: string, item: PromptItem): Promise<Classification> {
  let out: any;
  try {
    out = await ai.run(model, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Classify this item.\n\n${renderItem(item, null)}` }
      ],
      response_format: { type: "json_schema", json_schema: SINGLE_JSON_SCHEMA },
      max_tokens: 400
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Free plan: error 4006 once the daily neuron allowance is used up.
    if (/4006|daily free allocation|neurons/i.test(msg)) throw new LlmError(`Workers AI: ${clip(msg, 200)}`, "daily-quota");
    if (/429|rate limit|capacity|3040/i.test(msg)) throw new LlmError(`Workers AI: ${clip(msg, 200)}`, "rate-limit");
    throw new LlmError(`Workers AI: ${clip(msg, 200)}`, "other");
  }
  const raw = out?.response ?? out;
  let parsed: any = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { throw new LlmError("Workers AI returned non-JSON text", "other"); }
  }
  const cls = sanitizeClassification(parsed);
  if (!cls) throw new LlmError("Workers AI returned an invalid classification", "other");
  return cls;
}
