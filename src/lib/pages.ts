/** The public "Add to Discord" pages (pure HTML builders; no scripts). */

const REPO_URL = "https://github.com/mikekthx/ForeverUpdates";

export function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1d2330; --muted: #5b6475; --line: #dde1e8;
  --accent: #5865f2; --accent-text: #fff; --link: #4752c4; --ok-bg: #e8f6ee; --ok: #1b6b3a; --bad-bg: #fdecec; --bad: #a32020; }
@media (prefers-color-scheme: dark) { :root { --bg: #15171c; --card: #1e2128; --text: #e7e9ee; --muted: #a0a7b5; --line: #323743;
  --link: #9aa5ff; --ok-bg: #173325; --ok: #8fdcaa; --bad-bg: #3a1c1c; --bad: #f2a3a3; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 40px 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; margin-bottom: 16px; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 8px; }
h2 { font-size: 1.05rem; margin: 0 0 8px; }
p, ul { margin: 0 0 12px; }
ul { padding-left: 1.2em; }
.muted { color: var(--muted); font-size: .9rem; }
.button { display: inline-block; border: 0; border-radius: 8px; padding: 10px 18px; font: inherit; font-weight: 600;
  background: var(--accent); color: var(--accent-text); text-decoration: none; cursor: pointer; }
.button.secondary { background: transparent; color: var(--bad); border: 1px solid var(--line); }
.notice { border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; background: var(--ok-bg); color: var(--ok); }
.notice.bad { background: var(--bad-bg); color: var(--bad); }
label { display: block; font-weight: 600; margin-bottom: 4px; }
input[type=text] { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; margin-bottom: 12px; }
code { font-size: .9em; overflow-wrap: anywhere; }
a { color: var(--link); }
footer { text-align: center; }
`;

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${htmlEscape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<footer class="muted"><p>Unofficial. Not affiliated with or endorsed by Blizzard Entertainment. <a href="${REPO_URL}" rel="noreferrer">Source code</a></p></footer>
</main>
</body>
</html>`;
}

export interface LandingOpts { full: boolean; digestTime: string }

export function landingPage(o: LandingOpts): string {
  const action = o.full
    ? `<p class="notice bad">Sign-ups are closed for now: this bot has reached its channel limit.</p>`
    : `<p><a class="button" href="/discord/install">Add to Discord</a></p>`;
  return renderPage("ForeverUpdates", `
<div class="card">
<h1>WoW: Forever news in your Discord server</h1>
<p>ForeverUpdates watches Blizzard's forums and news site for <em>World of Warcraft: Forever</em> and posts to a channel you choose:</p>
<ul>
<li><strong>Alerts, right away,</strong> for urgent posts: hotfixes, known issues, maintenance. Pinging a role is optional.</li>
<li><strong>A daily digest</strong> of everything else that's relevant, at ${htmlEscape(o.digestTime)}.</li>
</ul>
${action}
<p class="muted">You pick the server and channel on Discord's own page, and you need the Manage Webhooks permission there. ForeverUpdates only gets a webhook for that channel: it can post there, and it can't read anything in your server.</p>
<p class="muted">To stop, delete the webhook (channel settings → Integrations → Webhooks), or use Remove on the page you get after adding it.</p>
</div>`);
}

export interface ManageOpts {
  id: string; key: string; guildId: string | null; channelId: string; roleId: string | null;
  lastOkAt: string | null; lastError: string | null;
  notice?: "new" | "saved" | "bad-role";
  roleInput?: string;
}

export function managePage(o: ManageOpts): string {
  const notice = o.notice === "new"
    ? `<p class="notice">This channel is set up. A welcome message was just posted there.</p>`
    : o.notice === "saved" ? `<p class="notice">Saved.${o.roleId ? " A message showing the role was posted in the channel, without pinging it." : ""}</p>`
    : o.notice === "bad-role" ? `<p class="notice bad">That isn't a role ID. Paste the role's ID (a long number) or its mention, like <code>&lt;@&amp;123456789012345678&gt;</code>.</p>`
    : "";
  const channel = o.guildId
    ? `<a href="https://discord.com/channels/${htmlEscape(o.guildId)}/${htmlEscape(o.channelId)}" rel="noreferrer">open the channel in Discord</a>`
    : `channel <code>${htmlEscape(o.channelId)}</code>`;
  const hidden = `<input type="hidden" name="id" value="${htmlEscape(o.id)}"><input type="hidden" name="key" value="${htmlEscape(o.key)}">`;
  const health = o.lastError
    ? `<p class="muted">Last problem posting here: <code>${htmlEscape(o.lastError)}</code></p>`
    : o.lastOkAt ? `<p class="muted">Last post here: ${htmlEscape(o.lastOkAt)} UTC</p>` : "";
  return renderPage("ForeverUpdates: channel settings", `
${notice}
<div class="card">
<h1>Channel settings</h1>
<p>ForeverUpdates posts to this channel (${channel}).</p>
<p class="muted"><strong>Bookmark this page.</strong> Its address is the only way to change these settings, and anyone who has it can change them, so share it only with your server's admins.</p>
${health}
</div>
<div class="card">
<h2>Ping a role on urgent alerts</h2>
<form method="post" action="/discord/manage">
${hidden}<input type="hidden" name="action" value="role">
<label for="role">Role ID</label>
<input type="text" id="role" name="role" inputmode="numeric" autocomplete="off" placeholder="No role: alerts don't ping anyone" value="${htmlEscape(o.roleInput ?? o.roleId ?? "")}">
<p class="muted">In Discord: Server Settings → Roles → the role's ⋯ menu → Copy Role ID. If you don't see it, turn on Developer Mode (User Settings → Advanced). Leave the box empty to stop pinging. If the role isn't pinged, turn on "Allow anyone to @mention this role" in its settings. The daily digest never pings.</p>
<button class="button" type="submit">Save</button>
</form>
</div>
<div class="card">
<h2>Remove</h2>
<p class="muted">Deletes ForeverUpdates' webhook from this channel. Nothing more is posted there.</p>
<form method="post" action="/discord/manage">
${hidden}<input type="hidden" name="action" value="remove">
<button class="button secondary" type="submit">Remove from this channel</button>
</form>
</div>`);
}

export function messagePage(title: string, text: string, link?: { href: string; label: string }): string {
  return renderPage(`ForeverUpdates: ${title}`, `
<div class="card">
<h1>${htmlEscape(title)}</h1>
<p>${htmlEscape(text)}</p>
${link ? `<p><a class="button" href="${htmlEscape(link.href)}">${htmlEscape(link.label)}</a></p>` : ""}
</div>`);
}
