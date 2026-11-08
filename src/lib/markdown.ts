/**
 * Post and article text as Discord markdown: the source's own formatting (bold, italic, underline,
 * strikethrough, code, spoilers, links, headings, lists, quotes) is kept, and its text is escaped
 * so it can't add formatting, fake a link or ping anyone. One line per paragraph, heading or list
 * item, and every line closes its own formatting, so lines can be compared and marked [NEW].
 * A line is never cut as markdown: one that must be cut is turned into plain text first
 * (plainLine), which is safe to cut anywhere.
 */

import { decodeEntities, dropHidden, dropQuoteBlocks, tagAttrs, TAG_NAME_RE, tokenize } from "./text";

const ZWSP = String.fromCharCode(0x200b);
// A URL as Discord's autolinker reads it: up to a space or "<" ("<" and ">" also end it here), without
// the punctuation that ends a sentence after it. It's written as <url>, which Discord links and ends
// exactly at the ">", so nothing after it (text, markers, "…") can run into it.
// (Nor "*", "`" or "|": "**https://x**" is a URL in bold, not one ending in "**".)
const URL_RE = /https?:\/\/[^\s<>*`|]+[^\s<>*`|.,:;"')\]]/gi;
// A bare URL (the post's video line), which stripMarkdown leaves whole.
const BARE_URL_RE = /https?:\/\/[\w\-.:/?#@!$&'+,;=%]+/i;
// stripMarkdown: an escape, a <url> (or one a cut left without its ">": dropped, the address is
// gone), a bare URL, inline code, a link's address (or what a cut left of it), or markers.
const STRIP_RE = new RegExp([
  /\\([\s\S])/.source,
  /<(https?:\/\/[^\s<>]*)>/.source,
  /<(?:h[^\s<>]*)?$/.source, // (an unescaped "<" is always a <url>'s: literal ones are escaped)
  `(${BARE_URL_RE.source})`,
  "(`+)([\\s\\S]*?)\\4", // inline code (groups 4, 5)
  /\](?:\([^)\s]*\)?)?/.source,
  `[*_~|[${ZWSP}]+`,
  "`" // a backtick a cut left without its pair (after the inline-code alternative, so code is read first)
].join("|"), "gi");

/** The URLs in text, as [start, end) ranges; a ")" that closes a "(" inside one is part of it. */
function urlRanges(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of s.matchAll(URL_RE)) {
    let end = m.index! + m[0].length;
    let open = (m[0].match(/\(/g) ?? []).length - (m[0].match(/\)/g) ?? []).length;
    while (s[end] === ")" && open-- > 0) end++;
    out.push([m.index!, end]);
  }
  return out;
}

/**
 * Formatting characters in text shown literally. A URL is never in this text (it's a <url>), so an
 * "http(s):" left here (like "https://x", or one a formatting tag splits) gets its ":" escaped, which
 * Discord shows as ":" but doesn't autolink: it can't run into what follows.
 */
function escapeInline(s: string): string {
  return s.replace(/[\\*_~`|[\]<]/g, "\\$&").replace(/(https?|steam):(?=\/|$)/gi, "$1\\:"); // Discord autolinks steam:// too
}

/** A line start Discord would read as a quote, heading, subtext or list, shown literally. */
function escapeLineStarts(s: string): string {
  return s
    .replace(/^([ \t]*)(#{1,3}|>{1,3}|-#?)(?=\s|$)/gm, "$1\\$2")
    .replace(/^([ \t]*)(\d+)\.(?=\s|$)/gm, "$1$2\\.");
}

/**
 * Plain text for Discord: formatting characters shown literally (so `**` or `[x](y)` can't format or
 * fake a link, and `<t:…>`, `<#…>` or `<:emoji:…>` codes show as typed), and URLs as <url>.
 */
export function escapeMarkdown(s: string): string {
  let out = "", at = 0;
  for (const [a, b] of urlRanges(s)) { out += escapeInline(s.slice(at, a)) + `<${s.slice(a, b)}>`; at = b; }
  return escapeLineStarts(out + escapeInline(s.slice(at)));
}

type Fmt = { open: string; close: string };
type Run = { text: string; fmts: Fmt[]; url?: boolean };

// The order formatting is written in, outermost first: Discord reads "***a***" but not "***a** b*",
// shows no spoiler inside a link's text, and nothing inside inline code.
const RANK: Record<string, number> = { "||": 0, "[": 1, "~~": 2, "__": 3, "**": 4, "*": 5, "`": 6 };

const MARK: Record<string, string> = {
  b: "**", strong: "**", i: "*", em: "*", u: "__", ins: "__", s: "~~", strike: "~~", del: "~~",
  code: "`", kbd: "`", samp: "`", tt: "`"
};
// Inline elements with no Discord equivalent: their text joins the words around them.
const JOIN = new Set("a abbr bdi bdo cite data dfn font mark q small span sub sup time var wbr".split(" "));
const BLOCK = new Set(("address article aside blockquote dd details div dl dt fieldset figcaption figure footer form " +
  "h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody tfoot thead tr ul").split(" "));
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));

/**
 * An address safe inside a markdown link's "(…)", also inside other formatting: Discord matches an
 * outer "||", "__", "~~" or "**" before the link inside it, so those characters are encoded too.
 */
export const linkUrl = (url: string) => url.replace(/[\\`()\s<>_*~|]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));


const sameFmts = (a: Fmt[], b: Fmt[]) => a.length === b.length && a.every((f, i) => f.open === b[i].open && f.close === b[i].close);

/**
 * Each run's formatting as it will be written (in RANK order, without inline code where code can't
 * hold the text: a backtick, or a bracket or "http(s):" in a link's text, which Discord won't mask),
 * and neighbours that come out the same merged into one. Any two runs left side by side then have a
 * marker between them, so text can't join up across a tag (<wbr>, <span>, nesting order) into a URL
 * that escapeInline and splitUrls didn't see whole.
 */
function mergeRuns(runs: Run[]): Run[] {
  const merge = (list: Run[]) => {
    const out: Run[] = [];
    for (const r of list) {
      const prev = out.at(-1);
      if (prev && sameFmts(prev.fmts, r.fmts)) prev.text += r.text;
      else out.push({ text: r.text, fmts: r.fmts });
    }
    return out;
  };
  // Merged first, so "where code can't hold the text" sees the whole text (a URL split by <wbr>), then
  // merged again, as dropping code can make neighbours the same.
  const sorted = merge(runs.map(r => ({ text: r.text, fmts: [...r.fmts].sort((a, b) => RANK[a.open] - RANK[b.open]) })));
  return merge(sorted.map(r => {
    const link = r.fmts.some(f => f.open === "[");
    // (Discord reads formatting around code first, so a marker inside the code would end it.)
    const outer = r.fmts.some(f => f.open !== "`");
    const noCode = r.text.includes("`") || (link && /[[\]]|(?:https?|steam):/i.test(r.text)) || (outer && /[*_~|]/.test(r.text));
    return noCode ? { text: r.text, fmts: r.fmts.filter(f => f.open !== "`") } : r;
  }));
}

/**
 * The URLs in each (merged) run as runs of their own, written <url> with no formatting but a spoiler
 * around them ("|" can't be in a URL, so it can't end the spoiler): Discord can't link a URL inside a
 * masked link's text, and a URL's own "_" or "*" would end formatting around it. A URL in inline code
 * stays code (mergeRuns already took code off a link's text with one).
 */
function splitUrls(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const ranges = r.fmts.some(f => f.open === "`") ? [] : urlRanges(r.text);
    const spoiler = r.fmts.filter(f => f.open === "||");
    let at = 0;
    for (const [a, b] of ranges) {
      if (a > at) out.push({ text: r.text.slice(at, a), fmts: r.fmts });
      out.push({ text: r.text.slice(a, b), fmts: spoiler, url: true });
      at = b;
    }
    if (at < r.text.length || !ranges.length) out.push({ text: r.text.slice(at), fmts: r.fmts });
  }
  return out;
}

/** Runs of text with their formatting → one line of markdown (markers hug the text, spaces stay outside). */
function renderLine(runs: Run[]): string {
  let out = "";
  let open: Fmt[] = [];
  let ws = false;
  for (const run of splitUrls(mergeRuns(runs))) {
    const m = run.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    const fmts = run.fmts;
    let k = 0; // formatting already open that this run keeps
    while (k < open.length && k < fmts.length && open[k].open === fmts[k].open && open[k].close === fmts[k].close) k++;
    const closes = open.slice(k).reverse().map(f => f.close).join("");
    if (!m[2]) {
      // A space outside formatting ends it ("<s>a</s> <s>b</s>" doesn't strike the space between).
      out += closes;
      open = open.slice(0, k);
      ws ||= run.text.length > 0;
      continue;
    }
    const opens = fmts.slice(k).map(f => f.open).join("");
    const gap = ws || m[1] ? " " : "";
    // "**a**" right before "*b*" would read as other markers; an invisible space keeps them apart.
    const zw = !gap && /[*_~|]$/.test(closes) && /^[*_~|]/.test(opens) ? ZWSP : "";
    const literal = fmts.some(f => f.open === "`");
    out += closes + gap + zw + opens + (run.url ? `<${m[2]}>` : literal ? m[2] : escapeInline(m[2]));
    open = fmts;
    ws = !!m[3];
  }
  out += open.slice().reverse().map(f => f.close).join("");
  return out.trim();
}

/** HTML → Discord markdown. dropQuotes removes Discourse quote blocks (player text a blue is replying to). */
export function htmlToMarkdown(html: string, opts: { dropQuotes?: boolean } = {}): string {
  let s = dropHidden(html);
  if (opts.dropQuotes) s = dropQuoteBlocks(s);
  // Sibling spans (Discourse's image caption: "<span>image</span><span>800×381 …</span>") are words apart.
  s = s.replace(/<\/span\s*>(?=<span[\s>])/gi, "</span> ");
  const parts = tokenize(s);

  type El = { name: string; fmt?: Fmt; list?: { ol: boolean; n: number }; item?: { marker: string; first: boolean } };
  const stack: El[] = [];
  const lines: string[] = [];
  let runs: Run[] = [];
  // The open formatting, worked out again only when the stack changes (every change alters its
  // length or its last element), so many runs under a deep stack stay cheap.
  let cached: Fmt[] = [], cachedLen = -1, cachedTop: El | undefined;
  const fmts = () => {
    if (stack.length !== cachedLen || stack.at(-1) !== cachedTop) {
      cached = stack.flatMap(e => (e.fmt ? [e.fmt] : []));
      cachedLen = stack.length;
      cachedTop = stack.at(-1);
    }
    return cached;
  };
  const add = (text: string) => runs.push({ text, fmts: fmts() });
  const flush = () => {
    const line = escapeLineStarts(renderLine(runs));
    runs = [];
    if (!line) return;
    // One pass over the stack, copying nothing (this runs for every line).
    let quote = "", h: El | undefined, items = 0, item: El["item"];
    for (const e of stack) {
      if (e.name === "blockquote") quote = "> ";
      if (e.name.length === 2 && e.name[0] === "h" && e.name[1] >= "1" && e.name[1] <= "6") h = e;
      if (e.item) { items++; item = e.item; }
    }
    // Discord shows no heading inside a list item.
    let prefix = h && !items ? "#".repeat(Math.min(3, Number(h.name[1]))) + " " : "";
    if (item?.first) { prefix = "  ".repeat(items - 1) + item.marker + prefix; item.first = false; }
    lines.push(quote + prefix + line);
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      if (!part) continue;
      // A line break in the text is a new line, as in htmlToText (and JSON-LD bodies are plain text).
      decodeEntities(part).split("\n").forEach((l, j) => { if (j) flush(); add(l.replace(/\s+/g, " ")); });
      continue;
    }
    const m = TAG_NAME_RE.exec(part);
    if (!m) { add(" "); continue; }
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    if (name === "br") { flush(); continue; }
    const block = BLOCK.has(name);
    if (closing) {
      let at = stack.length - 1, blockInside = false;
      for (; at >= 0 && stack[at].name !== name; at--) blockInside ||= BLOCK.has(stack[at].name);
      if (at < 0) { if (block) flush(); else if (!JOIN.has(name) && !MARK[name]) add(" "); continue; }
      if (block || blockInside) flush();
      stack.length = at;
      if (!block && !JOIN.has(name) && !MARK[name]) add(" ");
      continue;
    }
    if (block) {
      flush();
      // End tags HTML lets you leave out: a block ends an open <p>, and an <li> the previous one.
      const last = (f: (e: El) => boolean) => { for (let k = stack.length - 1; k >= 0; k--) if (f(stack[k])) return k; return -1; };
      const inner = last(e => BLOCK.has(e.name));
      if (inner >= 0 && stack[inner].name === "p") stack.splice(inner, 1); // its open link or bold goes on
      const li = last(e => e.name === "li");
      if (name === "li" && li >= 0 && li > last(e => !!e.list)) stack.length = li;
    }
    const a = tagAttrs(part);
    const el: El = { name };
    if (MARK[name]) el.fmt = { open: MARK[name], close: MARK[name] };
    if ((name === "span" || name === "div") && /\bspoiler\b/.test(a.get("class") ?? "")) el.fmt = { open: "||", close: "||" };
    if (name === "a") {
      const href = (a.get("href") ?? "").replace(/^https?:/i, s => s.toLowerCase());
      // Always a masked link when it has text, even text that is its address: a bare URL would take
      // in whatever Discord finds after it up to a space. (The text is looked for only a few tokens
      // ahead, so an unclosed <a> can't make this quadratic.)
      let text = "";
      for (let j = i + 1; j < Math.min(parts.length, i + 40) && !/^<\/a[\s>]/i.test(parts[j]); j++) if (j % 2 === 0) text += parts[j];
      if (/^https?:\/\/\S+$/.test(href) && text.trim()) el.fmt = { open: "[", close: `](${linkUrl(href)})` };
    }
    // Formatting already open isn't opened again ("<b><strong>x</strong></b>" is "**x**", not "****x****").
    if (el.fmt && fmts().some(f => f.open === el.fmt!.open)) el.fmt = undefined;
    if (name === "ul" || name === "ol") el.list = { ol: name === "ol", n: Math.max(1, Math.floor(Number(a.get("start") ?? 1)) || 1) - 1 };
    if (name === "li") {
      let list: El["list"];
      for (let k = stack.length - 1; k >= 0 && !list; k--) list = stack[k].list;
      el.item = { marker: list?.ol ? `${++list.n}. ` : "- ", first: true };
    }
    // shortcut: nesting deeper than 40 is flattened (Blizzard bodies nest far less); it bounds the
    // per-line cost, which is the stack's depth. Raise it if a real page ever nests deeper.
    // ("/>" closes nothing: browsers ignore it on HTML elements, and <svg> is gone.)
    if (!VOID.has(name) && stack.length < 40) stack.push(el);
    if (!block && !JOIN.has(name) && !MARK[name] && !el.fmt) add(" ");
  }
  flush();
  return lines.join("\n");
}

const LINE_PREFIX_RE = /^(?:> )?(?:#{1,3} |[ \t]*(?:-|\d+\.) )?/;

/** A line's quote, heading or list prefix removed (to run lines together into one paragraph). */
export function inlineMarkdown(line: string): string {
  return line.replace(LINE_PREFIX_RE, "");
}

/** Markdown from htmlToMarkdown (or a cut of it) → the plain text it shows, line for line. */
export function stripMarkdown(md: string): string {
  return md.split("\n").map(line => inlineMarkdown(line)
    .replace(STRIP_RE, (m, esc, url, bare, tick, code) => esc ?? url ?? bare ?? (tick ? code : ""))
  ).join("\n");
}

/** A line's [NEW] mark and prefix (kept whole), and the rest as escaped plain text (safe to cut anywhere). */
function plainParts(line: string): { keep: string; body: string } {
  const mark = line.match(/^(?:\[NEW\] )?/)![0];
  const keep = mark + line.slice(mark.length).match(LINE_PREFIX_RE)![0];
  return { keep, body: escapeMarkdown(stripMarkdown(line.slice(keep.length))) };
}

/** One line of markdown as escaped plain text, keeping its [NEW] mark and prefix. */
export function plainLine(line: string): string {
  const { keep, body } = plainParts(line);
  return keep + body;
}

/** Escaped plain text cut to `room`: at a sentence end that keeps half the room, else a word end. */
function cutPlain(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room <= 0) return "";
  const head = text.slice(0, room + 1);
  let end = -1;
  // A sentence end, with an optional closing quote or bracket; an escaped "1\." is a list number.
  for (const m of head.matchAll(/(?<!\\)[.!?…](?:["')]|\\\])?(?=\s)/g)) {
    const at = m.index! + m[0].length;
    if (at <= room) end = at;
  }
  let out: string;
  if (end >= room / 2) out = text.slice(0, end);
  else {
    const space = head.lastIndexOf(" ", room);
    out = space > 0 ? text.slice(0, space) : text.slice(0, room);
    if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1); // don't split an emoji in half
  }
  // Never cut inside a <url> (a URL has no spaces, so only a cut with no word end can), and never
  // leave a lone escape backslash in front of the mark.
  // (A literal "<" is always escaped, so one after an even run of backslashes is a <url>'s.)
  const lt = out.search(/(?<=(?:^|[^\\])(?:\\\\)*)<[^\s<>]*$/);
  if (lt >= 0) out = out.slice(0, lt);
  return out.trimEnd().replace(/\\+$/, b => (b.length % 2 ? b.slice(1) : b));
}

/**
 * Shortens markdown to at most `max` characters, marking the cut with " …" (spaced, so a URL before
 * it doesn't take it in). Markdown is never cut: whole lines are kept, and the line the cut falls
 * in becomes plain text first (its [NEW] mark and prefix kept whole, or the line dropped). With
 * `linesFirst`, whole lines are all that's kept if they fill at least half the room. A heading
 * left with nothing under it goes too.
 */
export function cutMarkdown(md: string, max: number, linesFirst = false): string {
  if (md.length <= max) return md;
  const mark = " …";
  if (max <= mark.length) return "…".slice(0, Math.max(0, max));
  const room = max - mark.length;
  const nl = md.lastIndexOf("\n", room);
  let out: string;
  if (linesFirst && nl >= room / 2) out = md.slice(0, nl);
  else {
    const start = nl + 1;
    const end = md.indexOf("\n", start);
    const { keep, body } = plainParts(md.slice(start, end < 0 ? undefined : end));
    // One character spare: a cut can leave a line start ("#WoW" cut to "#"), which is escaped.
    const cut = cutPlain(body, room - start - keep.length - 1);
    out = md.slice(0, start) + (cut ? keep + escapeLineStarts(cut) : "");
  }
  // Headings (one or a stack of them) left with nothing under them go too (line by line from the
  // end: linear).
  const lines = out.split("\n");
  while (lines.length && (!lines.at(-1)!.trim() || /^(?:\[NEW\] )?(?:> )?#{1,3} /.test(lines.at(-1)!))) lines.pop();
  out = lines.join("\n").trimEnd();
  return out ? out + mark : "…";
}

/** clip() for markdown (stored content, the digest query's cuts): see cutMarkdown. */
export function clipMarkdown(md: string, max: number): string {
  return cutMarkdown(md, max);
}
