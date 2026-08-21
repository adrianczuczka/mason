import type { PathClaim } from "./types.js";

/**
 * A fenced block is treated as a directory tree only when it clearly is one —
 * below this many branch-glyph lines it's more likely an ASCII sketch.
 */
const MIN_GLYPH_LINES = 3;

const GLYPHS = ["├──", "└──"] as const;

function glyphIndex(line: string): number {
  for (const glyph of GLYPHS) {
    const idx = line.indexOf(glyph);
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Tree furniture: blank, or only vertical bars and whitespace. */
function isSpacerLine(line: string): boolean {
  return /^[\s│|]*$/.test(line);
}

/**
 * Strip an inline comment/annotation from a tree entry. Entries commonly
 * carry `# comment` or column-aligned notes after two or more spaces.
 */
function entryName(afterGlyph: string): string | null {
  let name = afterGlyph.replace(/^\s+/, "");
  const hash = name.search(/\s+#/);
  if (hash !== -1) name = name.slice(0, hash);
  const columns = name.search(/\s{2,}/);
  if (columns !== -1) name = name.slice(0, columns);
  name = name.trim();
  // A name with remaining internal whitespace is not a path — treat the
  // line as malformed rather than guessing.
  if (!name || /\s/.test(name)) return null;
  return name;
}

/**
 * Reconstruct full paths from an ASCII directory tree inside a fenced block.
 *
 * The failure mode must always be a missed claim, never an invented path: a
 * line that doesn't parse cleanly aborts reconstruction below it, and every
 * emitted path still passes the deleted-reference provability gate later.
 *
 * `blockLines` are the fence's content lines; `blockStartLine` is the 1-based
 * doc line number of the first content line.
 */
export function extractTreeClaims(
  blockLines: string[],
  blockStartLine: number
): PathClaim[] {
  const glyphLines = blockLines.filter((l) => glyphIndex(l) !== -1).length;
  if (glyphLines < MIN_GLYPH_LINES) return [];

  const claims: PathClaim[] = [];
  // Directories on the path from the root to the current entry, keyed by the
  // column their branch glyph appeared at.
  const stack: Array<{ col: number; name: string }> = [];
  let rootPrefix = "";
  let started = false;

  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    const col = glyphIndex(line);

    if (col === -1) {
      if (isSpacerLine(line)) continue;
      if (!started) {
        // A bare `src/` line above the first glyph names the tree's root.
        const candidate = line.trim();
        if (candidate.endsWith("/") && !/\s/.test(candidate)) {
          rootPrefix = candidate.replace(/\/+$/, "");
          claims.push({
            path: rootPrefix,
            line: blockStartLine + i,
            excerpt: candidate,
          });
        }
        continue;
      }
      // Unparseable line after the tree began: stop here, keep what we have.
      return claims;
    }

    started = true;
    const name = entryName(line.slice(col + GLYPHS[0].length));
    if (name === null) return claims;

    while (stack.length > 0 && stack[stack.length - 1].col >= col) {
      stack.pop();
    }

    const isDir = name.endsWith("/");
    const cleanName = name.replace(/\/+$/, "");
    const segments = [
      ...(rootPrefix ? [rootPrefix] : []),
      ...stack.map((s) => s.name),
      cleanName,
    ];
    claims.push({
      path: segments.join("/"),
      line: blockStartLine + i,
      excerpt: name,
    });

    if (isDir) stack.push({ col, name: cleanName });
  }

  return claims;
}
