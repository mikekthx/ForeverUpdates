# ForeverUpdates

A Discord notifier for **World of Warcraft: Forever**. It watches Blizzard's US forums and the Blizzard news site, uses Gemini to decide what matters, and posts to a Discord channel:

- **Alerts, right away,** for anything urgent: hotfixes, known issues, maintenance. When a watched post or article is edited, the new lines go through the same triage.
- **A daily digest** of everything else that's relevant, at 5 PM Pacific. Several blue posts in one thread are one entry with one TL;DR for all of them; an alerted post joins its thread there when the thread also has other posts that day.

Each alert and digest item comes with a short TL;DR written by the model. Optionally, a public page lets other people add the same alerts to a channel in their own Discord server (see [Let other servers add it](#let-other-servers-add-it-optional)).

It runs on Cloudflare's free tier (Workers, D1, Queues and Workers AI) and Gemini's free API tier.

## How it works

- **Polling.** A cron runs every 5 minutes. It reads the WoW: Forever forum categories (found by their `wow-forever` slug), the Blue Tracker, forum search and the news listing, and records anything new. The first run only records what's already there, so old posts never alert.
- **Fetching and classifying.** Queue workers fetch each new post or article, then send its text to Gemini (`gemini-3.5-flash-lite`). If Gemini fails, the same request goes to `gemini-3.6-flash`. If both are briefly overloaded (503s), the post waits up to 10 minutes (`GEMINI_WAIT_MIN`) for Gemini to come back. If Gemini is out of quota or stays down, Workers AI (Llama 3.3 70B) takes over. If no model is available, urgent-looking Blue Posts still alert, based on keywords.
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

   The Worker's address is `https://<name>.<your-subdomain>.workers.dev`, where `<name>` is `name` in `wrangler.toml` (`forever-updates`). A new Cloudflare account picks its `workers.dev` subdomain on the first deploy.

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

   To copy a role's ID, turn on Developer Mode in Discord (User Settings → Advanced), then Server Settings → Roles → the role's ⋯ menu → **Copy Role ID**. If the role isn't pinged, turn on "Allow anyone to @mention this role" in its settings.

5. **Point the links at your own fork.** Edit `USER_AGENT` in `src/config.ts`, so Blizzard can tell whose bot it is, and `REPO_URL` in `src/lib/pages.ts` (the "Source code" link on the public page).

6. **Deploy.**

   ```powershell
   npx wrangler deploy
   ```

### Updating an existing install

**Apply `schema.sql` before you deploy a new version.** It only creates tables that are missing, so running it again is safe. The Worker queries every table on each run, even for features you haven't turned on. If a table is missing, polling, alerts and the digest all stop.

```powershell
npx wrangler d1 execute forever-updates --remote --file=./schema.sql
npx wrangler deploy
```

If `d1 execute --remote` is refused (for example with error 7403), paste the SQL statements from `schema.sql` into the D1 console in the Cloudflare dashboard (Storage & databases → D1 → your database → Console) instead.

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

## Let other servers add it (optional)

The Worker can also serve a public page where anyone can add the alerts to a channel in their own Discord server. It uses Discord's `webhook.incoming` OAuth scope: the person picks a server and channel on Discord's own page, Discord creates a webhook there, and the Worker stores it. No bot joins the server, and the Worker can't read anything in it.

Each added channel gets the same alerts and daily digest as yours. Each server can set its own role to ping on urgent alerts. Your own channel (`DISCORD_WEBHOOK_URL`) works as before, and health warnings go only to it.

1. **Create a Discord application** at <https://discord.com/developers/applications>: **New Application**, give it a name, **Create**. Its name and icon are what people see on Discord's authorize page and on the posts in their channel.
2. **Add the redirect.** On the **OAuth2** page, under **Redirects**, add `https://forever-updates.<your-subdomain>.workers.dev/discord/callback` and save. It must match exactly (`https`, no trailing slash).
3. **Turn off Discord's install button.** On the **Installation** page, set **Install Link** to **None**. No bot is needed, so leave the **Bot** page alone.
4. **Set the two secrets.** Both are on the **OAuth2** page: copy the Client ID, and click **Reset Secret** for the Client Secret (Discord shows it only once). The page is live as soon as both are set, with no deploy needed.

   ```powershell
   npx wrangler secret put DISCORD_CLIENT_ID
   npx wrangler secret put DISCORD_CLIENT_SECRET
   ```

   An install set up before this feature existed needs the new tables first: see [Updating an existing install](#updating-an-existing-install).
5. **Try it.** Open your Worker's address, click **Add to Discord** and pick a test channel. You should land on that channel's settings page, the channel should get a welcome message, and `/status` should show `publicPage: true` and one channel under `subscribers`. If you get "Discord didn't confirm the channel" instead, `npx wrangler tail` shows what Discord answered.

Share `https://forever-updates.<your-subdomain>.workers.dev/`. After adding a channel, the person lands on that channel's settings page: a role to ping on urgent alerts, and **Remove**. Its address holds a secret key, so they should bookmark it. Adding the same channel again replaces its webhook and gives a new settings link (the role is kept). While sign-ups are full, that doesn't work: someone who lost the link can delete the webhook in Discord, which removes the channel, and add it again once a slot is free.

- A server that deletes the webhook in Discord is dropped on the next post.
- `/status` shows the channels (never their tokens) under `subscribers`.
- One server can add at most `MAX_CHANNELS_PER_SERVER` (3) channels, so no one server can take every slot.
- Sign-ups stop at `MAX_SUBSCRIBERS` (100) in `src/config.ts`. Each alert and digest costs one Discord request per channel, sent 20 at a time in work-queue messages, so 100 channels add about 5 queue messages per alert.
- Without the two secrets, the page is off and `/` answers as before.
- **What's stored per channel:** the webhook's ID and token, the server and channel IDs, the role ID and a hash of the settings key. Nothing from the server itself.
- To remove a channel yourself, run this in the D1 console. Its webhook stays in that server until someone deletes it there.

  ```sql
  DELETE FROM deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE channel_id = '<channel ID>');
  DELETE FROM webhooks WHERE channel_id = '<channel ID>';
  ```

## Configuration

Everything you can tune is in `src/config.ts`: the title filters, the watch tiers, the digest time and time zone, and the retry and retention limits.

These Worker variables (in `[vars]` in `wrangler.toml`) override the defaults:

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `FORUM_REGIONS` | `us` | Forums to poll; `us,eu` adds the EU forums. Changing it makes the next run seed again (no alerts for that run). |
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
- **Health warnings go to your channel only.** Alerts and the digest also go to the channels added on the public page, if it's on.

## License

[MIT](LICENSE). This project is not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment, Inc.
