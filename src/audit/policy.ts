import fg from "fast-glob";
import { auditGlob } from "./inputs.js";

/** Filter literal existing paths with the same bounded, symlink-safe policy as discovery. */
export async function includedCheckPaths(
  root: string,
  paths: string[],
  exclude: string[],
): Promise<Set<string>> {
  if (!exclude.length) return new Set(paths);
  const included = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += 256) {
    for (const file of await auditGlob(
      root,
      paths.slice(offset, offset + 256).map((file) => fg.escapePath(file)),
      {
        ignore: exclude,
        followSymbolicLinks: false,
        label: "Audit check exclusions",
      },
    ))
      included.add(file);
  }
  return included;
}
