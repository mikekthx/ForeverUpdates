# ForeverUpdates

A Discord notifier for **World of Warcraft: Forever**. It watches Blizzard's US forums and the Blizzard news site, uses Gemini to decide what matters, and posts to a Discord channel:

- **Alerts, right away,** for anything urgent: hotfixes, known issues, maintenance, launch problems. When a watched post or article is edited, the new lines go through the same triage.
- **A daily digest** of everything else that's relevant, at 5 PM Pacific.

It runs on Cloudflare's free tier (Workers, D1, Queues and Workers AI) and Gemini's free API tier.

## How it works

- **Polling.** A cron runs every 5 minutes. It reads the WoW: Forever forum categories (found by their `wow-forever` slug), the Blue Tracker, forum search and the news listing, and records anything new. The first run only records what's already there, so old posts never alert.
- **Fetching and classifying.** Queue workers fetch each new post or article, then send its text to Gemini (`gemini-3.5-flash-lite`). If Gemini fails, the same request goes to `gemini-3.6-flash`. If Gemini is out of quota, Workers AI (Llama 3.3 70B) takes over. If no model is available, urgent-looking Blue Posts still alert, based on keywords.
- **Formatting.** Posts keep their own formatting in Discord: bold, italics, lists, headings, links and spoilers. All source text is escaped, so it can't fake a link or ping anyone.
- **Edit watching.**
  - Hotfix posts are checked every 15 minutes for 21 days.
  - Operational Blue Post threads are checked every 15 minutes for 7 days.
  - Relevant news articles are checked hourly for 21 days.
  - An edit alerts only if it adds a line of at least 40 characters.

## Setup

You need Node 20 or later, a Cloudflare account (the free plan is fine), a [Gemini API key](https://aistudio.google.com) and a Discord channel webhook. The commands below are for PowerShell.

1. **Install and log in.**

   ```powershell
   npm install
   npx wrangler login
   ```

2. **Create the database.** `d1 create` prints a `database_id`: put it in `wrangler.toml`, and keep the binding name `DB`. Then create the tables:

   ```powershell
   npx wrangler d1 create forever-updates
   npx wrangler d1 execute forever-updates --remote --file=./schema.sql
   ```

3. **Create the queues.**

   ```powershell
   npx wrangler queues create forever-updates-work
   npx wrangler queues create forever-updates-classify
   ```

4. **Set the secrets.** Each command asks for its value. To make an admin token, run `[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`.

   ```powershell
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put DISCORD_WEBHOOK_URL       # channel settings → Integrations → Webhooks
   npx wrangler secret put ADMIN_TOKEN               # any long random string
   npx wrangler secret put DISCORD_CRITICAL_ROLE_ID  # optional: a role to @mention on critical alerts
   ```

5. **Point the User-Agent at your own fork.** Edit `USER_AGENT` in `src/config.ts`, so Blizzard can tell whose bot it is.

6. **Deploy.**

   ```powershell
   npx wrangler deploy
   ```

### Check that it works

The admin routes need the bearer token:

```powershell
$Worker = "https://forever-updates.<your-subdomain>.workers.dev"
$H = @{ Authorization = "Bearer <your ADMIN_TOKEN>" }
Invoke-RestMethod "$Worker/debug" -Headers $H | ConvertTo-Json -Depth 6   # fetches every source once
Invoke-RestMethod "$Worker/status" -Headers $H | ConvertTo-Json -Depth 5  # counters, pauses, watch list, recent events
```

What to look for in `/debug`:
- every source shows `ok: true`;
- the forum categories come from the live site (`"origin": "live"`);
- the article sample starts with the article's text, not the site navigation.

The other admin routes are `/run-poll`, `/run-digest` (sends today's digest now) and `/seed`. For live logs, run `npx wrangler tail`.

## Configuration

Everything you can tune is in `src/config.ts`: the title filters, the watch tiers, the digest time and time zone, and the retry and retention limits.

These Worker variables (in `[vars]` in `wrangler.toml`) override the defaults:

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `FORUM_REGIONS` | `us` | Forums to poll; `us,eu` adds the EU forums. |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Main model. |
| `GEMINI_BACKUP_MODEL` | `gemini-3.6-flash` | Model tried when the main one fails. `none` turns it off. |
| `WORKERS_AI_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Fallback model used while Gemini is paused. |

To stop using Workers AI, remove the `[ai]` block from `wrangler.toml`.

## Development

```powershell
npm test               # typecheck, unit tests, real-data tests, end-to-end tests (Miniflare)
npm run capture        # saves real Blizzard responses to fixtures/ (about 25 polite requests)
npm run eval           # scores the triage prompt against your labels (needs $env:GEMINI_API_KEY)
npx wrangler deploy --dry-run --outdir dist   # checks wrangler.toml and its bindings offline
```

The `fixtures/` folder is local only and gitignored. Its captures contain full Blizzard pages and other players' forum posts.

The real-data tests use those captures and skip when there are none. On a fresh clone, run `npm run capture` first.

To score the prompt:
1. Run `npm run capture`. Besides the captures, it writes `fixtures/labels.todo.json`.
2. Set `"expected"` on each item to `"alert"`, `"digest"` or `"ignore"`.
3. Save the file as `fixtures/labels.json`.
4. Run `npm run eval`.

## Limits

- **CPU time.** Cloudflare's free plan gives 10 ms of CPU per request. In production, a cold run that fetches a large news article has measured up to about 70 ms. Even so, Cloudflare reported no CPU-limit errors.
  - Check this in the dashboard: Metrics, then **Exceeded CPU Time Limits**.
  - If those errors ever appear, Workers Paid lifts the limit.
- **One Discord channel.** Every alert, digest and health warning goes to the single webhook in `DISCORD_WEBHOOK_URL`.

## License

[MIT](LICENSE). This project is not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.
