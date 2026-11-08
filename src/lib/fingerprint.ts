/**
 * Crosspost fingerprints. The US and EU copies of a Blue Post (often by different CMs) share the
 * same title and text; edits to both copies add the same lines. Author is deliberately excluded.
 */

import { normalizeText, sha256Hex } from "./text";

/** A new post or article: title + opening text. */
export async function fingerprintNew(title: string, text: string): Promise<string> {
  return (await sha256Hex(`new|${normalizeText(title)}|${normalizeText(text).slice(0, 400)}`)).slice(0, 24);
}

/**
 * An edit: only the lines that were added. Two successive edits to the same thread therefore get
 * different fingerprints (the first 400 characters of the whole post would be identical).
 */
export async function fingerprintEdit(title: string, addedLines: string[]): Promise<string> {
  return (await sha256Hex(`edit|${normalizeText(title)}|${normalizeText(addedLines.join("\n")).slice(0, 2000)}`)).slice(0, 24);
}
