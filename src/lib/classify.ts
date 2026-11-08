/** Classification types, validation, and the keyword fallback. */

import { updateFocus } from "./diff";
import { clip } from "./text";

export const CATEGORIES = [
  "Hotfix",
  "Server Status",
  "Patch Notes",
  "Developer Blue Post",
  "General Community"
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Classification {
  is_forever_relevant: boolean;
  is_critical: boolean;
  category: Category;
  summary: string;
  urgency_rationale: string;
}

export const CRITICAL_HINT_RE =
  /\b(maintenance|downtime|outage|offline|extended|queues?|login|log in|realms?|rulesets?|hotfix(es)?|exploit|rollback|bans?|banned|launch(es|ed)?|delay(ed)?|restart(s|ing)?|emergency|known issues?|now live|unlock)\b/i;

/** Used only when Gemini is unavailable. Conservative: forum-verified posts are relevant, news needs "Forever". */

export function heuristicClassify(item: {
  title: string;
  content: string;
  forumVerified: boolean;
}): Classification {
  // For edits, judge only what was added (with its section header for context). Otherwise an
  // old "WoW: Forever" section would make a Midnight-only addition look relevant and urgent.
  const focus = updateFocus(item.content);
  const text = focus ? focus.withHeaders : `${item.title}\n${item.content}`;
  const relevant = item.forumVerified || /\bforever\b/i.test(text);
  const critical = relevant && CRITICAL_HINT_RE.test(focus ? focus.newText : text);
  const category: Category = /hotfix/i.test(focus ? `${item.title}\n${text}` : text)
    ? "Hotfix"
    : /maintenance|downtime|outage|queue|realm|server/i.test(text)
      ? "Server Status"
      : /patch notes|update notes/i.test(text)
        ? "Patch Notes"
        : item.forumVerified
          ? "Developer Blue Post"
          : "General Community";
  return {
    is_forever_relevant: relevant,
    is_critical: critical,
    category,
    summary: "", // no TL;DR without a model; the alert/digest shows the post itself
    urgency_rationale: critical
      ? "Keyword match (Gemini unavailable): post mentions an outage, queue, realm, hotfix or launch term."
      : "No urgent keywords found (Gemini unavailable)."
  };
}

/** Coerces a model result into a valid Classification, or null if it's unusable. */
export function sanitizeClassification(raw: any): Classification | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.is_forever_relevant !== "boolean" || typeof raw.is_critical !== "boolean") return null;
  const category: Category = (CATEGORIES as readonly string[]).includes(raw.category)
    ? raw.category
    : "General Community";
  return {
    is_forever_relevant: raw.is_forever_relevant,
    is_critical: raw.is_forever_relevant && raw.is_critical,
    category,
    summary: clip(String(raw.summary ?? "").trim(), 300),
    urgency_rationale: clip(String(raw.urgency_rationale ?? "").trim(), 300)
  };
}
