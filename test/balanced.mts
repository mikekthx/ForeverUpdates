// Test helper: whether a line of Discord markdown has no formatting left open (escapes, inline code
// and bare URLs aside, every marker pairs up and every "[" is a whole link).
export function balanced(line: string): boolean {
  // Read left to right, as stripMarkdown does: an escape, inline code or a URL, whichever comes first.
  let s = line.replace(/\\[\s\S]|(`+)[\s\S]*?\1|<https?:\/\/[^\s<>]*>|https?:\/\/[\w\-.:/?#@!$&'+,;=%]+/gi, "");
  if (s.includes("<")) return false; // a <url> a cut left open (a literal "<" is escaped)
  if (s.includes("`")) return false;
  const links = (s.match(/\]\([^)\s]*\)/g) ?? []).length;
  s = s.replace(/\]\([^)\s]*\)/g, "]");
  if ((s.match(/\[/g) ?? []).length !== links || (s.match(/\]/g) ?? []).length !== links) return false;
  for (const m of ["||", "~~", "__"]) {
    if ((s.split(m).length - 1) % 2) return false;
    s = s.split(m).join("");
  }
  return !/[|~_]/.test(s) && (s.match(/\*/g) ?? []).length % 2 === 0;
}
