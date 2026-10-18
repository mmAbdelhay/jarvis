import { REVIEW_MARKER } from "./types.js";
import type { ReviewComment, ReviewsConfig } from "./types.js";

export function shouldTrigger(c: ReviewComment, login: string, cfg: ReviewsConfig): boolean {
  const author = c.author.toLowerCase();
  if (author === login.toLowerCase()) return false;
  if (c.body.includes(REVIEW_MARKER)) return false;
  if (cfg.ignoreBots && c.isBot) return false;
  if (cfg.authors.length > 0 && !cfg.authors.some((name) => name.toLowerCase() === author)) {
    return false;
  }
  return c.body.toLowerCase().includes(cfg.requireText.trim().toLowerCase());
}
