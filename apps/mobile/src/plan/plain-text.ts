export function planBlockPlainText(source: string): string {
  return source
    .replace(/^\s*```.*$/gm, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
