import path from "node:path";

// Question/filler words that carry no signal about which entry a task
// touches. Domain words ("auth", "drift") are never in this list.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "how",
  "does",
  "do",
  "is",
  "are",
  "was",
  "what",
  "where",
  "which",
  "why",
  "when",
  "who",
  "i",
  "we",
  "my",
  "our",
  "you",
  "your",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "can",
  "could",
  "should",
  "would",
  "will",
  "want",
  "need",
  "please",
  "about",
  "into",
  "from",
  "when",
  "there",
  "any",
  "all",
  "some",
  "not",
  "but",
  "also",
  "just",
  "like",
  "get",
  "make",
  "use",
  "new",
  "work",
  "works",
  "working",
  "implement",
  "implemented",
  "change",
  "changed",
  "file",
  "files",
  "code",
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
export function scoreEntry(
  taskTokens: Set<string>,
  entry: Scorable,
  corpus?: DescriptionCorpus,
): number {
  const nameTokens = tokenSet(entry.name);
  const descriptionWords = tokenize(entry.description).map(stem);
  const descTokens = new Set(descriptionWords);
  const fileTokens = tokenSet(entry.files.map((f) => path.basename(f)).join(" "));
  const lengthPenalty = corpus
    ? Math.max(1, Math.sqrt(descriptionWords.length / corpus.averageLength))
    : 1;

  let score = 0;
  for (const token of taskTokens) {
    if (nameTokens.has(token)) score += 3;
    else if (descTokens.has(token))
      score += corpus ? corpus.inverseFrequency(token) / lengthPenalty : 1;
    else if (fileTokens.has(token)) score += 1;
  }
  return score;
}

/** Number of task tokens that appear in the entry name. */
export function nameHits(taskTokens: Set<string>, name: string): number {
  const nameTokens = tokenSet(name);
  let hits = 0;
  for (const token of taskTokens) if (nameTokens.has(token)) hits++;
  return hits;
}

export interface DescriptionCorpus {
  averageLength: number;
  /** In (0, 1]: 1 for a token found in one description, lower as it becomes common. */
  inverseFrequency(token: string): number;
}

/**
 * Description statistics for scoring one entry against its peers. A word shared by most
 * descriptions carries little evidence, and a long description matches many words by
 * length alone, so neither may outweigh a name match.
 */
export function descriptionCorpus(descriptions: string[]): DescriptionCorpus {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const description of descriptions) {
    const words = tokenize(description).map(stem);
    totalLength += words.length;
    for (const token of new Set(words))
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const count = Math.max(1, descriptions.length);
  const normalizer = Math.log(1 + count);
  return {
    averageLength: Math.max(1, totalLength / count),
    inverseFrequency: (token) =>
      Math.log(1 + count / Math.max(1, documentFrequency.get(token) ?? 1)) / normalizer,
  };
}

/** Jaccard similarity of two token sets: |∩| / |∪|, 0 when both empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
