/** Edit detection: which lines of a post/article are new since the last version. */

import { stripMarkdown } from "./markdown";

/**
 * Compares two versions of an article. Returns the lines that are new, and the new text with
 * those lines prefixed "[NEW] ". The marked version keeps unchanged lines (like a repeated
 * "WoW: Forever" section header) as context for the new ones.
 */
export function markAddedLines(oldText: string, newText: string): { added: string[]; marked: string } {
  // Compared as the text they show: a change of formatting or link address alone isn't new text.
  const norm = (l: string) => stripMarkdown(l).replace(/\s+/g, " ").trim().toLowerCase();
  const before = new Set(oldText.split("\n").map(norm).filter(Boolean));
  const added: string[] = [];
  const marked: string[] = [];
  for (const raw of newText.split("\n")) {
    const line = raw.trimEnd(); // a nested list item keeps its indent
    const n = norm(line);
    if (!n) continue;
    if (!before.has(n)) {
      before.add(n); // a line repeated within the new text is only "new" once
      added.push(line);
      marked.push(`[NEW] ${line}`);
    } else {
      marked.push(line);
    }
  }
  return { added, marked: marked.join("\n") };
}

export const UPDATE_MARKER = "[EDITED: lines marked [NEW] were added since the last check]";

/**
 * For an edited post/article: the [NEW] lines, plus the section header each one sits under
 * (nearest earlier unchanged short line, e.g. "WoW: Forever"). Null for ordinary items.
 */
export function updateFocus(content: string): { newText: string; withHeaders: string } | null {
  if (!content.startsWith(UPDATE_MARKER)) return null;
  const lines = content.split("\n").slice(1);
  const newLines: string[] = [];
  const out: string[] = [];
  let lastHeader = "";
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("[NEW] ")) continue;
    const line = lines[i].slice(6);
    let header = "";
    for (let j = i - 1; j >= 0; j--) {
      // The nearest earlier unchanged short line, but not a bare link (like the post's video).
      if (!lines[j].startsWith("[NEW] ") && lines[j].length <= 80 && !/^https?:\/\/\S+$/.test(lines[j])) { header = lines[j]; break; }
    }
    if (header && header !== lastHeader) { out.push(header); lastHeader = header; }
    out.push(line);
    newLines.push(line);
  }
  return { newText: newLines.join("\n"), withHeaders: out.join("\n") };
}
