/**
 * WoW: Forever news triage bot — v4.
 *
 *   cron (5 min) ─► poller ──► WORK queue ──► fetch/diff → event ──► CLASSIFY queue ──► model chain
 *                  │                                                          │
 *                  ├─ cheap edit probes                                       ├─ critical → Discord alert
 *                  ├─ sweeper (re-queues stuck work)                          └─ relevant → daily digest
 *                  ├─ daily digest (after 5 PM Pacific)
 *                  └─ health warnings
 *
 * Alerts and digests also go to other servers' channels added on the public "Add to Discord" page
 * (src/subscribe.ts), through WORK queue "fanout" messages (src/fanout.ts).
 */

import { handleAdmin } from "./admin";
import { handleClassifyBatch } from "./classify";
import { maybeSendDigest } from "./digest";
import { warnIfUnhealthy } from "./health";
import { runPoll } from "./poller";
import { handlePublic } from "./subscribe";
import type { ClassifyMessage, Env, WorkMessage } from "./types";
import { handleWorkBatch } from "./work";

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    let failed: unknown = null;
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        const out = await fn();
        if (out) console.log(JSON.stringify({ event: name, ...(out as object) }));
      } catch (err) {
        console.error(`${name} failed:`, err);
        failed ??= err;
      }
    };
    // Independent steps: a failing source can't block the digest, and vice versa.
    await step("poll", () => runPoll(env));
    await step("digest", () => maybeSendDigest(env, new Date(controller.scheduledTime)));
    await step("health", () => warnIfUnhealthy(env));
    if (failed) throw failed;
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue.includes("classify")) await handleClassifyBatch(batch as MessageBatch<ClassifyMessage>, env);
    else await handleWorkBatch(batch as MessageBatch<WorkMessage>, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    return (await handlePublic(request, env)) ?? handleAdmin(request, env);
  }
};
