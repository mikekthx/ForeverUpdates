/**
 * Crosspost fingerprints. The US and EU copies of a Blue Post (often by different CMs) share the
 * same title and text; edits to both copies add the same lines. Author is deliberately excluded.
 * Both functions take the text as markdown.
 *
 * Text with enough long lines is fingerprinted by all of its lines except section names and a
 * leading video link (no title, new or edit alike). That way the same hotfix notes
 * still match when they show up as a new forum reply, an edit to the thread's first post and an
 * edit to the news article. Each has its own title, and an edit drops headers the article already
 * had ("Classes", "Hunter"), but every other line is the same. Posts that differ in any other
 * line, even a short date or a bold "**November 10, 2026**", don't match.
 */

import { isHeaderLine } from "./diff";
import { stripMarkdown } from "./markdown";
import { normalizeText, sha256Hex } from "./text";

const LONG_LINE_CHARS = 40;
const MIN_LONG_LINES = 3; // fewer: too little text to match without the title

/** A header that only names a section: "**Classes**", "- **Beast Mastery**", "**Enemies and NPCs**". */
function isSectionName(line: string): boolean {
  const text = stripMarkdown(line).trim();
  // A sentence ("**Maintenance is extended.**") or anything with a date or number counts as content.
  return isHeaderLine(line) && text.split(/\s+/).length <= 3 && !/\d/.test(text) && !/[.!?]$/.test(text);
}

async function contentFingerprint(lines: string[]): Promise<string | null> {
  // The post's video link sits first (postText, extractArticleFullText); an edit may not repeat it.
  const first = lines.findIndex(l => l.trim());
  const body = first >= 0 && /^https?:\/\/\S+$/.test(stripMarkdown(lines[first]).trim()) ? lines.slice(first + 1) : lines;
  const kept = body
    .filter(l => !isSectionName(l))
    .map(l => normalizeText(stripMarkdown(l)))
    .filter(Boolean);
  if (kept.filter(l => l.length >= LONG_LINE_CHARS).length < MIN_LONG_LINES) return null;
  return (await sha256Hex(`lines|${kept.join("\n")}`)).slice(0, 24);
}

/** A new post or article: its lines, else title + opening text. */
export async function fingerprintNew(title: string, text: string): Promise<string> {
  return await contentFingerprint(text.split("\n"))
    ?? (await sha256Hex(`new|${normalizeText(title)}|${normalizeText(stripMarkdown(text)).slice(0, 400)}`)).slice(0, 24);
}

/**
 * An edit: only the lines that were added. Two successive edits to the same thread therefore get
 * different fingerprints (the first 400 characters of the whole post would be identical).
 */
export async function fingerprintEdit(title: string, addedLines: string[]): Promise<string> {
  return await contentFingerprint(addedLines)
    ?? (await sha256Hex(`edit|${normalizeText(title)}|${normalizeText(addedLines.map(stripMarkdown).join("\n")).slice(0, 2000)}`)).slice(0, 24);
}
