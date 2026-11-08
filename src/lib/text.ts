/** Text helpers shared by every module. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", bull: "•",
  copy: "©", reg: "®", trade: "™", middot: "·"
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ent: string) => {
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const cp = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

// Where a browser is while reading a tag (after a quoted value it's as BEFORE: it ends the same way).
const NAME = 0, BEFORE = 1, ATTR = 2, AFTER_ATTR = 3, BEFORE_VALUE = 4, VALUE = 5, SELF = 6;

/**
 * Where the tag at p ("<a…" or "</a…") ends (after its ">"), read as a browser reads it: a quote opens
 * a value only after an attribute name's "=", and nothing else ("<", "=" with no name, a quote) is
 * special. -1 if it never ends: the rest of the input is inside it. With `info`, also its attributes
 * (as a browser keeps them: names lowercased, the first of a name wins) and whether it ends "/>".
 */
function readTag(s: string, p: number, info?: { attrs: Map<string, string>; self: boolean }): number {
  let state = NAME, ns = 0, ne = 0, vs = 0;
  // (Only when asked: tokenize's calls make no strings; "attr?.(…)" doesn't build its argument.)
  const attr = info && ((value: string) => {
    const name = s.slice(ns, ne).toLowerCase();
    if (!info.attrs.has(name)) info.attrs.set(name, decodeEntities(value));
  });
  for (let j = p + (s.charCodeAt(p + 1) === 47 ? 2 : 1); j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 62) { // ">"
      if (state === ATTR) ne = j;
      if (state === ATTR || state === AFTER_ATTR || state === BEFORE_VALUE) attr?.("");
      else if (state === VALUE) attr?.(s.slice(vs, j));
      if (info) info.self = state === SELF;
      return j + 1;
    }
    const space = c === 32 || c === 10 || c === 9 || c === 12 || c === 13; // HTML's whitespace (not a no-break space)
    if (state === NAME) { if (space) state = BEFORE; else if (c === 47) state = SELF; }
    else if (state === BEFORE || state === SELF) {
      if (space) state = BEFORE; else if (c === 47) state = SELF; else { state = ATTR; ns = j; } // "=" too
    } else if (state === ATTR) {
      if (space || c === 47 || c === 61) ne = j;
      if (space) state = AFTER_ATTR; else if (c === 47) { attr?.(""); state = SELF; } else if (c === 61) state = BEFORE_VALUE;
    } else if (state === AFTER_ATTR) {
      if (space) continue;
      if (c === 61) { state = BEFORE_VALUE; continue; }
      attr?.("");
      if (c === 47) state = SELF; else { state = ATTR; ns = j; }
    } else if (state === BEFORE_VALUE) {
      if (space) continue;
      if (c === 34 || c === 39) { // a quote
        const q = s.indexOf(s[j], j + 1);
        if (q < 0) return -1;
        attr?.(s.slice(j + 1, q));
        j = q;
        state = BEFORE;
      } else { state = VALUE; vs = j; }
    } else if (space) { attr?.(s.slice(vs, j)); state = BEFORE; } // VALUE
  }
  return -1;
}

/**
 * HTML split into text and markup, alternating: [text, tag, text, …, text], each tag or comment whole,
 * as a browser splits it (readTag). <script>, <style> and <noscript> hold raw text up to their exact
 * close tag ("</scripture>" isn't one), or to the end. A "<" that starts no tag ("<3", "< b") is text;
 * "<?…", "<!…" and "</1…" are comments to their ">". A tag or comment never ended holds the rest of the
 * input, which a browser doesn't show, so it's left out. Linear: every tag is read once, and the first
 * that never ends is the last. (Not modelled: a script's "<!--<script>" escaped state.)
 */
export function tokenize(html: string): string[] {
  const n = html.length;
  const letter = (c: number) => (c | 32) >= 97 && (c | 32) <= 122;
  // The next "-->" and "--!>", each searched for again only once passed (so many comments stay linear).
  let dash = -2, bang = -2;
  const out: string[] = [];
  let text = 0;
  for (let i = html.indexOf("<"); i >= 0; i = html.indexOf("<", i)) {
    const c1 = html.charCodeAt(i + 1);
    let end: number;
    if (letter(c1) || (c1 === 47 && letter(html.charCodeAt(i + 2)))) end = readTag(html, i);
    else if (html.startsWith("<!--", i)) {
      // "<!-->" and "<!--->" are whole; it ends at "-->" or "--!>".
      if (dash !== -1 && dash < i + 2) dash = html.indexOf("-->", i + 2);
      if (bang !== -1 && bang < i + 4) bang = html.indexOf("--!>", i + 4);
      end = dash < 0 ? (bang < 0 ? -1 : bang + 4) : bang < 0 || dash < bang ? dash + 3 : bang + 4;
    } else if (c1 === 33 || c1 === 63 || (c1 === 47 && i + 2 < n)) end = html.indexOf(">", i + 2) + 1 || -1; // "<!", "<?", "</"
    else { i++; continue; }
    if (end < 0) { out.push(html.slice(text, i)); return out; }
    const tag = html.slice(i, end);
    out.push(html.slice(text, i), tag);
    text = i = end;
    // (Browsers ignore "/>" on these: "<script/>" opens one too.)
    const raw = (c1 | 32) === 115 || (c1 | 32) === 110 ? /^<(script|style|noscript)(?=[\t\n\f\r />])/i.exec(tag) : null; // "s", "n"
    if (raw) {
      const close = new RegExp(`</${raw[1]}(?=[\\t\\n\\f\\r />])`, "gi");
      close.lastIndex = i;
      const k = close.exec(html)?.index ?? -1;
      if (k < 0) break; // the rest is its raw text
      i = k;
    }
  }
  out.push(html.slice(text));
  return out;
}

/** A tag's attributes, as a browser reads them (readTag): entities decoded, the first of a name wins, "" for one with no value. */
export function tagAttrs(tag: string): Map<string, string> {
  const info = { attrs: new Map<string, string>(), self: false };
  readTag(tag, 0, info);
  return info.attrs;
}

/** A tag's name, as a browser reads it: to a space, "/" or ">". */
export const TAG_NAME_RE = /^<(\/?)([a-z][^\t\n\f\r />]*)/i;
// Browsers ignore "/>" on HTML elements; only foreign ones (<svg>) close with it ("<svg / >" doesn't).
const selfClosing = (name: string, tag: string) => {
  if (name !== "svg") return false;
  const info = { attrs: new Map<string, string>(), self: false };
  readTag(tag, 0, info);
  return info.self;
};

const HIDES_REST = new Set(["script", "style", "noscript", "template"]);

/**
 * Removes elements from HTML: each <name> whose opening tag `drop` accepts, through its matching
 * close, matched by name and nesting (a nested one doesn't end it early). With `comments`, comments
 * go too. Inside an element that's kept, the rest is still looked at. One never closed stays as it is, except
 * a HIDES_REST one, which takes the rest of the page with it.
 */
export function dropElements(html: string, names: string[], drop: (openTag: string) => boolean = () => true, comments = false): string {
  const want = new Set(names);
  const parts = tokenize(html);
  const match = new Map<number, number>(); // an open tag's index → its close's
  const open = new Map<string, number[]>();
  for (let i = 1; i < parts.length; i += 2) {
    const m = TAG_NAME_RE.exec(parts[i]);
    const name = m?.[2].toLowerCase() ?? "";
    if (!want.has(name)) continue;
    if (m![1]) {
      const o = open.get(name)?.pop();
      if (o !== undefined) match.set(o, i);
    } else if (!selfClosing(name, parts[i])) {
      if (!open.has(name)) open.set(name, []);
      open.get(name)!.push(i);
    }
  }
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2) {
      if (comments && /^<[!?]|^<\/(?![a-z])/i.test(p)) { out += " "; continue; } // comments, bogus ones too
      const m = TAG_NAME_RE.exec(p);
      const name = m?.[2].toLowerCase() ?? "";
      if (m && !m[1] && want.has(name) && drop(p)) {
        if (selfClosing(name, p)) { out += " "; continue; } // "<svg/>": just the tag
        const end = match.get(i);
        if (end !== undefined) { out += " "; i = end; continue; }
        // One of these never closed holds the rest of the page (raw text, or a template's content).
        if (HIDES_REST.has(name)) { out += " "; break; }
      }
    }
    out += p;
  }
  return out;
}

/** Removes what a page never shows: <script>, <style>, <noscript>, <svg> and <template> blocks, and comments. */
export function dropHidden(html: string): string {
  return dropElements(html, ["script", "style", "noscript", "svg", "template"], undefined, true);
}

/** Removes Discourse quote blocks (the text a post is replying to), nested ones included. */
export function dropQuoteBlocks(html: string): string {
  return dropElements(html, ["aside"], tag => /\bquote\b/i.test(tagAttrs(tag).get("class") ?? ""));
}

/**
 * The first YouTube video embedded in this HTML, as a short youtu.be link: a Discourse onebox
 * (forum posts) or an <iframe> player (news articles). Only an exact 11-character id is accepted.
 */
export function firstYoutubeLink(html: string): string | null {
  const parts = tokenize(html);
  for (let i = 1; i < parts.length; i += 2) {
    const name = /^<(div|iframe)(?=[\s/>])/i.exec(parts[i])?.[1];
    if (!name) continue;
    const attr = tagAttrs(parts[i]);
    const onebox = attr.get("data-provider-name")?.toLowerCase() === "youtube"
      ? attr.get("data-video-id")?.match(/^[\w-]{11}$/)?.[0] : undefined;
    const player = name.toLowerCase() === "iframe"
      ? attr.get("src")?.match(/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})(?:[?&#]|$)/i)?.[1] : undefined;
    const id = onebox ?? player;
    if (id) return `https://youtu.be/${id}`;
  }
  return null;
}

/** A line that is just a post's video link, as firstYoutubeLink makes it. */
export const VIDEO_LINE_RE = /^https:\/\/youtu\.be\/[\w-]{11}$/;

/** Text from postText/extractArticleFullText → its video link (the first line, if it is one) and the rest. */
export function splitVideoLine(text: string): { video?: string; rest: string } {
  const nl = text.indexOf("\n");
  const first = nl < 0 ? text : text.slice(0, nl);
  return VIDEO_LINE_RE.test(first) ? { video: first, rest: nl < 0 ? "" : text.slice(nl + 1) } : { rest: text };
}

// A closing one of these (or <br>) is a line break; inline ones join the words around them.
const LINE_END = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote"]);
const INLINE = new Set("a abbr b bdi bdo cite code del dfn em font i ins kbd mark q s samp small span strike strong sub sup time tt u var wbr".split(" "));

/** HTML → readable plain text. dropQuotes removes Discourse quote blocks (player text a blue is replying to). */
export function htmlToText(html: string, opts: { dropQuotes?: boolean } = {}): string {
  let s = dropHidden(html);
  if (opts.dropQuotes) s = dropQuoteBlocks(s);
  const parts = tokenize(s);
  s = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { s += parts[i]; continue; }
    const m = TAG_NAME_RE.exec(parts[i]);
    const name = m?.[2].toLowerCase() ?? "";
    if (m && (m[1] ? LINE_END.has(name) : name === "br")) s += "\n";
    // Inline formatting sits inside words and before punctuation ("<em>Forever</em>,"), so it adds
    // nothing, except between sibling spans: Discourse's image caption is "<span>image</span><span>800×381 …</span>".
    else if (m && INLINE.has(name)) s += m[1] && name === "span" && !parts[i + 1] && /^<span[\s>]/i.test(parts[i + 2] ?? "") ? " " : "";
    else s += " ";
  }
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // don't split an emoji in half
  return cut.trimEnd() + "…";
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
