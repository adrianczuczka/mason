import path from "node:path";

// Question/filler words that carry no signal about which entry a task
// touches. Domain words ("auth", "drift") are never in this list.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "how", "does", "do", "is", "are", "was", "what", "where", "which", "why",
  "when", "who", "i", "we", "my", "our", "you", "your", "it", "its", "this",
  "that", "these", "those", "can", "could", "should", "would", "will",
  "want", "need", "please", "about", "into", "from", "when", "there", "any",
  "all", "some", "not", "but", "also", "just", "like", "get", "make", "use",
  "new", "work", "works", "working", "implement", "implemented", "change",
  "changed", "file", "files", "code",
]);

/** Split camelCase/PascalCase/kebab/snake/path into lowercase word tokens. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Crude singular/plural folding so "flows" matches "flow" etc. */
export function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text).map(stem));
}

export interface Scorable {
  name: string;
  description: string;
  files: string[];
}

/**
 * Lexical relevance of one entry to the task. Name hits are the strongest
 * signal, then description, then file-path words. Each distinct task token
 * counts once at its best weight, so a token appearing everywhere doesn't
 * triple-count.
 */
export function scoreEntry(taskTokens: Set<string>, entry: Scorable): number {
  const nameTokens = tokenSet(entry.name);
  const descTokens = tokenSet(entry.description);
  const fileTokens = tokenSet(entry.files.map((f) => path.basename(f)).join(" "));

  let score = 0;
  for (const token of taskTokens) {
    if (nameTokens.has(token)) score += 3;
    else if (descTokens.has(token)) score += 1;
    else if (fileTokens.has(token)) score += 1;
  }
  return score;
}

/** Jaccard similarity of two token sets: |∩| / |∪|, 0 when both empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
