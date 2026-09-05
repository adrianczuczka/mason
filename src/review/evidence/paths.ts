import { normalizeRepoPath } from "../../utils/paths.js";

/** Map reported paths from the runner's checkout; never read source via a report URI. */
export function evidencePath(value: string, sourceRoot: string, uri = false): string | null {
  if (value.length > 4000) return null;
  let file = value;
  try {
    if (uri) {
      if (file.startsWith("file:")) {
        const url = new URL(file);
        if (url.hostname && url.hostname !== "localhost") return null;
        file = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
      } else {
        if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return null;
        file = decodeURIComponent(file);
      }
    }
  } catch { return null; }
  file = file.replace(/\\/g, "/");
  const root = sourceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file)) {
    if (!file.startsWith(root + "/")) return null;
    file = file.slice(root.length + 1);
  }
  return normalizeRepoPath(file);
}
