// Measures the triage prompt against posts YOU labeled.
//   1. npm run capture        → fixtures/labels.todo.json (only items the bot would send to the model)
//   2. Fill in "expected" for each item and save as fixtures/labels.json:
//        "alert"  = post to Discord right away;  "digest" = include in the daily digest;
//        "ignore" = news article that isn't about WoW: Forever. Forever-forum posts are always
//        relevant, so they are only "alert" or "digest" (each item's "choices" says which apply).
//   3. $env:GEMINI_API_KEY="..." ; npm run eval      (PowerShell)
// Prints a confusion matrix and every disagreement, so prompt changes can be judged by numbers.
//
// Models are used the way the Worker uses them (src/llm/chain.ts): the main model, and when it
// fails the backup model right away; a model that reports an overload or quota is skipped for as
// long as the Worker would pause it. $env:GEMINI_BACKUP_MODEL = "none" tests the main model alone.
import { existsSync, readFileSync } from "node:fs";
import { GEMINI_BATCH_CHARS } from "../src/config.ts";
import type { Classification } from "../src/lib/classify.ts";
import { geminiModels, pauseMinutes } from "../src/llm/chain.ts";
import { LlmError } from "../src/llm/errors.ts";
import { classifyWithGemini, thinkingLevel } from "../src/llm/gemini.ts";
import type { PromptItem } from "../src/llm/prompt.ts";

type Label = "alert" | "digest" | "ignore";
const file = process.argv[2] ?? "fixtures/labels.json";
const key = process.env.GEMINI_API_KEY;
// The Worker's models and per-model settings (GEMINI_MODEL / GEMINI_BACKUP_MODEL choose the order).
// $env:EVAL_THINKING = "low" | "medium" | "high" overrides the thinking level of every model.
const evalThinking = process.env.EVAL_THINKING?.trim();
if (evalThinking && thinkingLevel(evalThinking, "low") !== evalThinking.toLowerCase()) {
  console.error(`EVAL_THINKING must be low, medium or high (got "${evalThinking}").`);
  process.exit(1);
}
const models = geminiModels(process.env).map(m => evalThinking ? { ...m, thinking: thinkingLevel(evalThinking, m.thinking) } : m);
// The classify queue's max_batch_size (wrangler.toml). $env:EVAL_BATCH_ITEMS = "19" sends larger
// requests than the Worker ever does, e.g. everything in one request.
const BATCH_MAX_ITEMS = Number(process.env.EVAL_BATCH_ITEMS) || 10;
const RETRIES = 2;          // per request, when every model failed with an overload/timeout
// Seconds before the first retry (doubled for the second); $env:EVAL_RETRY_WAIT_S overrides 20.
// Gemini 3.x has no temperature setting, so borderline items can flip between runs. $env:EVAL_RUNS
// = "3" repeats the whole eval and reports how often each item disagreed.
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS) || 1);
if (!key) { console.error("Set GEMINI_API_KEY first."); process.exit(1); }

if (!existsSync(file)) {
  console.error(`No ${file}. Labels stay local (fixtures/ is gitignored): run \`npm run capture\`, label fixtures/labels.todo.json, and save it as ${file}.`);
  process.exit(1);
}
const all = JSON.parse(readFileSync(file, "utf8")) as (PromptItem & { id: string; forum_verified: boolean; posted_at?: string | null; expected: Label | "" })[];
const items = all.filter(x => ["alert", "digest", "ignore"].includes(x.expected));
console.log(`${items.length} labeled items (of ${all.length}) from ${file}, models ${models.map(m => `${m.model} (${m.thinking} thinking)`).join(" → ")}, up to ${BATCH_MAX_ITEMS} items per request${RUNS > 1 ? `, ${RUNS} runs` : ""}\n`);
for (const x of items) {
  if (x.forum_verified && x.expected === "ignore") console.log(`  note: "${x.title}" is a Forever-forum post labeled ignore; the bot always reports those (alert or digest)`);
}

const labels: Label[] = ["alert", "digest", "ignore"];
const emptyMatrix = (): Record<Label, Record<Label, number>> => ({ alert: { alert: 0, digest: 0, ignore: 0 }, digest: { alert: 0, digest: 0, ignore: 0 }, ignore: { alert: 0, digest: 0, ignore: 0 } });
// Across all runs: each item-run counts once, overall and for the model that answered it.
const matrix = emptyMatrix();
const byModel = new Map(models.map(m => [m.model, emptyMatrix()]));
const answers = new Map<string, { got: Label[]; why: string[]; by: string[] }>(items.map(x => [x.id, { got: [], why: [], by: [] }]));
const unscored: string[] = [];
const pausedUntil = new Map<string, number>(); // model → time, as the Worker's pause:* rows
const briefPause = new Set<string>();          // models paused for an overload or rate limit

// Batches the way src/llm/chain.ts fills one Gemini call: up to GEMINI_BATCH_CHARS of content,
// at most one queue batch of items. So the timings below are what the Worker would see.
const batches: (typeof items)[] = [];
for (const x of items) {
  const last = batches.at(-1);
  const chars = last?.reduce((n, y) => n + y.content.length, 0) ?? 0;
  if (last && last.length < BATCH_MAX_ITEMS && chars + x.content.length <= GEMINI_BATCH_CHARS) last.push(x);
  else batches.push([x]);
}

/** One request through the models in order, as the Worker does it. Retries only when every model failed briefly. */
async function classifyBatch(batch: typeof items): Promise<{ res: Map<number, Classification>; model: string } | null> {
  for (let attempt = 1; ; attempt++) {
    let transient = false;
    for (const { model, timeoutMs, thinking } of models) {
      const until = pausedUntil.get(model) ?? 0;
      if (until > Date.now()) {
        process.stdout.write(`${model} paused (${Math.ceil((until - Date.now()) / 60_000)} min) … `);
        // Paused for an overload: if no other model answers, wait and retry rather than lose the
        // request (the Worker would use Workers AI here, which the eval doesn't measure).
        if (briefPause.has(model)) transient = true;
        continue;
      }
      const started = Date.now();
      try {
        // postedAt: null, as src/classify.ts sends it (posted_at in the labels is only for you).
        const res = await classifyWithGemini(batch.map(x => ({ ...x, forumVerified: x.forum_verified, postedAt: null })), key!, model, timeoutMs, thinking);
        console.log(`${model} ${((Date.now() - started) / 1000).toFixed(1)} s`);
        return { res, model };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAILED after ${((Date.now() - started) / 1000).toFixed(1)} s: ${msg.split("\n")[0]}${err instanceof LlmError ? ` [${err.kind}]` : ""}`);
        const min = pauseMinutes(err);
        if (min > 0) pausedUntil.set(model, Date.now() + min * 60_000);
        // Overload, rate limits and timeouts are usually brief; a bad key, request or daily quota isn't.
        if (err instanceof LlmError && (err.kind === "overloaded" || err.kind === "rate-limit")) {
          transient = true;
          briefPause.add(model);
        } else {
          briefPause.delete(model);
        }
        process.stdout.write("  ");
      }
    }
    if (!transient || attempt === RETRIES + 1) { console.log("no model answered"); return null; }
    const wait = (Number(process.env.EVAL_RETRY_WAIT_S) || 20) * attempt;
    process.stdout.write(`all models failed; retrying in ${wait} s (${attempt}/${RETRIES}) … `);
    await new Promise(r => setTimeout(r, wait * 1000));
    // The retry tries the briefly failed models again (the Worker would still skip them for a few
    // minutes and use Workers AI); a model out of daily quota stays skipped.
    for (const model of briefPause) pausedUntil.delete(model);
  }
}

for (let run = 1; run <= RUNS; run++) {
  if (RUNS > 1) console.log(`${run > 1 ? "\n" : ""}run ${run}/${RUNS}`);
  let runCorrect = 0, runScored = 0;
  for (const [b, batch] of batches.entries()) {
    const chars = batch.reduce((n, x) => n + x.content.length, 0);
    process.stdout.write(`request ${b + 1}/${batches.length}: ${batch.length} items, ${(chars / 1000).toFixed(1)}k chars … `);
    const answer = await classifyBatch(batch);
    if (!answer) {
      // In the Worker this batch would go to Workers AI instead (src/llm/chain.ts).
      for (const x of batch) unscored.push(`  ${RUNS > 1 ? `run ${run}: ` : ""}${x.title}`);
      continue;
    }
    batch.forEach((x, j) => {
      const c = answer.res.get(j);
      if (!c) { unscored.push(`  ${RUNS > 1 ? `run ${run}: ` : ""}${x.title} (missing from ${answer.model}'s answer)`); return; }
      const relevant = x.forum_verified || c.is_forever_relevant;
      const got: Label = !relevant ? "ignore" : c.is_critical ? "alert" : "digest";
      matrix[x.expected as Label][got]++;
      byModel.get(answer.model)![x.expected as Label][got]++;
      const a = answers.get(x.id)!;
      a.got.push(got);
      a.by.push(answer.model);
      if (got !== x.expected) a.why.push(`${answer.model}: ${c.urgency_rationale}`);
      runScored++;
      if (got === x.expected) runCorrect++;
    });
  }
  if (RUNS > 1) console.log(`run ${run}: ${runCorrect}/${runScored}`);
}

const score = (m: Record<Label, Record<Label, number>>) => {
  const total = labels.reduce((n, e) => n + labels.reduce((k, g) => k + m[e][g], 0), 0);
  const correct = labels.reduce((n, l) => n + m[l][l], 0);
  return { total, text: `${correct}/${total}; missed alerts: ${m.alert.digest + m.alert.ignore}; false alerts: ${m.digest.alert + m.ignore.alert}` };
};
console.log(`\nexpected \\ got   ${labels.map(l => l.padStart(7)).join("")}${RUNS > 1 ? `   (${RUNS} runs)` : ""}`);
for (const e of labels) console.log(`${e.padEnd(16)} ${labels.map(g => String(matrix[e][g]).padStart(7)).join("")}`);
console.log(`\naccuracy ${score(matrix).text}`);
if (models.length > 1) {
  for (const [model, m] of byModel) {
    const s = score(m);
    console.log(`  ${model.padEnd(24)} ${s.total ? s.text : "answered nothing"}`);
  }
}
if (unscored.length) console.log(`\nNot scored (no Gemini result):\n${unscored.join("\n")}`);

// Per item: how often it disagreed, and one of Gemini's reasons. With several runs this separates
// items the prompt gets wrong every time from borderline ones that flip.
const misses = items.flatMap(x => {
  const a = answers.get(x.id)!;
  const wrong = a.got.filter(g => g !== x.expected);
  if (!wrong.length) return [];
  const counts = labels.filter(l => l !== x.expected).map(l => [l, wrong.filter(g => g === l).length] as const).filter(([, n]) => n);
  const how = counts.map(([l, n]) => `got ${l} ${RUNS > 1 ? `${n}/${a.got.length}` : ""}`.trim()).join(", ");
  return [`  expected ${x.expected.padEnd(6)} ${how.padEnd(RUNS > 1 ? 16 : 10)} ${x.title}\n      ${a.why[0]}`];
});
if (misses.length) console.log(`\nDisagreements:\n${misses.join("\n")}`);
