import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const execute = promisify(execFile);
export const pathChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), file: z.string(), block: z.string(), created: z.boolean() }),
  z.object({ kind: z.literal("windows"), entry: z.string(), created: z.boolean() }),
]);
export type PathChange = z.infer<typeof pathChangeSchema>;
export type PathResult = { status: "configured" | "manual"; message: string; changes: PathChange[] };
export type PathOptions = { platform?: NodeJS.Platform; userHome?: string; env?: NodeJS.ProcessEnv };
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

// Store the ownership intent before changing settings, so interrupted installs
// can resume and uninstall can distinguish our addition from existing settings.
export async function configurePath(bin: string, previous: PathChange[], save: (changes: PathChange[]) => Promise<void>, options: PathOptions = {}): Promise<PathResult> {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform;
  const changes = [...previous];
  // Profile/registry changes affect future shells. The inherited PATH tells us
  // whether this terminal already has the installation directory available.
  const currentPath = platform === "win32" ? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] : env.PATH;
  const alreadyOnPath = platform === "win32" ? hasWindowsEntry(currentPath ?? null, bin, env)
    : (currentPath ?? "").split(":").some(entry => path.posix.isAbsolute(entry) && path.posix.resolve(entry) === path.posix.resolve(bin));
  const message = alreadyOnPath ? "Run: mason setup --host codex" : "Open a new terminal, then run: mason setup --host codex";
  const manual = (reason: string): PathResult => ({ status: "manual", changes, message: `${reason}\n${alreadyOnPath ? message : `Add ${bin} to your PATH, then run: mason setup --host codex`}` });
  if (env.MASON_NO_MODIFY_PATH === "1") return manual("Automatic PATH setup is disabled (MASON_NO_MODIFY_PATH=1).");
  if (/[\r\n\0]/.test(bin) || bin.includes(platform === "win32" ? ";" : ":")) return manual("This installation path cannot be represented safely in PATH.");
  try {
    if (platform === "win32") {
      const current = await windowsPath("read");
      if (!hasWindowsEntry(current.value, bin)) {
        if (!changes.some(c => c.kind === "windows" && c.entry === bin)) {
          changes.push({ kind: "windows", entry: bin, created: current.value === null }); await save(changes);
        }
        await windowsPath("add", bin, current);
      }
      return { status: "configured", changes, message };
    }
    const shell = path.basename(env.SHELL ?? os.userInfo().shell ?? "");
    const userHome = options.userHome ?? os.homedir();
    let profiles: string[];
    if (!["bash", "zsh", "sh"].includes(shell)) return manual(`Automatic PATH setup is unavailable for ${shell || "an unknown shell"}.`);
    if (env.MASON_PROFILE) profiles = [path.resolve(env.MASON_PROFILE)];
    else if (shell === "zsh") profiles = [path.join(env.ZDOTDIR || userHome, ".zshrc")];
    else if (shell === "sh") profiles = [path.join(userHome, ".profile")];
    else {
      const candidates = [".bash_profile", ".bash_login", ".profile"].map(name => path.join(userHome, name));
      let login = candidates[2];
      for (const file of candidates) if (await fs.lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) { login = file; break; }
      profiles = [path.join(userHome, ".bashrc"), login];
    }
    const marker = `# >>> mason PATH ${createHash("sha256").update(bin).digest("hex").slice(0, 12)} >>>`;
    for (const profile of profiles) {
      // Preserve symlinked dotfiles by updating their target. A dangling link is
      // an error, not permission to replace the link with an unrelated file.
      const stat = await fs.lstat(profile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      const file = stat?.isSymbolicLink() ? await fs.realpath(profile) : path.resolve(profile);
      const original = await fs.readFile(file).catch(error => { if (error.code === "ENOENT" && !stat) return null; throw error; });
      if (original && !Buffer.from(original.toString("utf8")).equals(original)) return manual(`Shell profile is not UTF-8: ${profile}.`);
      const text = original?.toString("utf8") ?? "";
      const owned = changes.find((c): c is Extract<PathChange, { kind: "profile" }> => c.kind === "profile" && c.file === file);
      if (owned && text.includes(owned.block)) continue;
      if (text.includes(marker) || (owned && text.includes("# <<< mason PATH"))) return manual(`Mason's PATH block was edited; retained ${profile}.`);
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      const block = owned?.block ?? ("\n" + marker + "\ncase \":${PATH-}:\" in\n  *:" + quote(bin) + ":*) ;;\n  *) export PATH=" + quote(bin) + ":\"${PATH-}\" ;;\nesac\n# <<< mason PATH <<<\n").replaceAll("\n", newline);
      if (!owned) { changes.push({ kind: "profile", file, block, created: original === null }); await save(changes); }
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Append without rewriting existing bytes, modes or symlinks. Recheck the
      // bytes on the opened file to detect edits since the preflight read.
      const handle = await fs.open(file, original === null ? "ax+" : "a+", 0o600);
      try {
        if (!(await handle.readFile()).equals(original ?? Buffer.alloc(0))) throw new Error(`Shell profile changed during installation: ${profile}`);
        await handle.writeFile(block); await handle.sync();
      } finally { await handle.close(); }
    }
    return { status: "configured", changes, message };
  } catch (error) { return manual(`Could not configure PATH: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function removePath(changes: PathChange[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const change of changes) {
    try {
      if (change.kind === "windows") {
        const current = await windowsPath("read");
        if (!(current.value ?? "").split(";").includes(change.entry) && hasWindowsEntry(current.value, change.entry)) throw new Error("PATH entry was edited");
        await windowsPath("remove", change.entry, current, change.created); continue;
      }
      const stat = await fs.lstat(change.file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!stat) continue;
      if (!stat.isFile()) throw new Error("profile type changed");
      const bytes = await fs.readFile(change.file), text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes)) throw new Error("profile encoding changed");
      const index = text.indexOf(change.block);
      if (index < 0 || text.indexOf(change.block, index + change.block.length) >= 0) throw new Error("PATH block was edited or removed");
      const prefix = text.slice(0, index), suffix = text.slice(index + change.block.length);
      const separator = prefix && suffix && !prefix.endsWith("\n") ? (change.block.startsWith("\r\n") ? "\r\n" : "\n") : "";
      const next = Buffer.from(prefix + separator + suffix);
      const temporary = change.file + ".mason-" + randomUUID();
      try {
        if (stat.nlink > 1) throw new Error("profile has multiple hard links");
        const handle = await fs.open(temporary, "wx", stat.mode & 0o777);
        try {
          await handle.writeFile(next); await handle.chmod(stat.mode & 0o777);
          if (process.platform !== "win32") await handle.chown(stat.uid, stat.gid);
          await handle.sync();
        } finally { await handle.close(); }
        const current = await fs.lstat(change.file);
        if (!current.isFile() || current.ino !== stat.ino || !(await fs.readFile(change.file)).equals(bytes)) throw new Error("profile changed during uninstall");
        await fs.rename(temporary, change.file);
      } finally { await fs.rm(temporary, { force: true }); }
      // Empty created profiles are harmless; retain them to avoid masking any
      // dotfile another process created or linked since installation.
    } catch (error) { warnings.push(`Retained PATH setting ${change.kind === "profile" ? change.file : change.entry}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return warnings;
}

export type WindowsPath = { value: string | null; kind: string | null };
const normalizeWindowsEntry = (value: string) => path.win32.normalize(value.trim().replace(/^"(.*)"$/, "$1")).replace(/[\\/]+$/, "").toLowerCase();
export const hasWindowsEntry = (value: string | null, entry: string, env: NodeJS.ProcessEnv = process.env) => {
  const variables = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  const expand = (part: string) => part.replace(/%([^%]+)%/g, (match, key: string) => variables.get(key.toLowerCase()) ?? match);
  return (value ?? "").split(";").some(part => normalizeWindowsEntry(expand(part)) === normalizeWindowsEntry(entry));
};

// Read unexpanded registry text and preserve its value kind. No machine PATH,
// setx truncation, or expanded copy of the process environment is written.
export async function windowsPath(action: "read" | "add" | "remove", entry = "", expected?: WindowsPath, removeEmpty = false): Promise<WindowsPath> {
  const payload = Buffer.from(JSON.stringify({ action, entry, expected, removeEmpty })).toString("base64");
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($null -eq $value) { $null } else { $key.GetValueKind('Path').ToString() }
  if ($null -ne $kind -and $kind -notin @('String','ExpandString')) { throw 'User PATH is not a string.' }
  if ($p.action -eq 'read') { @{ value = $value; kind = $kind } | ConvertTo-Json -Compress; exit 0 }
  if ($p.expected -and ($value -cne $p.expected.value -or $kind -cne $p.expected.kind)) { throw 'User PATH changed concurrently; retry the operation.' }
  $parts = if ($null -eq $value -or $value -eq '') { @() } else { @($value.Split(';')) }
  if ($p.action -eq 'add') { $next = (@($p.entry) + $parts) -join ';' }
  else { $next = (@($parts | Where-Object { $_ -cne $p.entry })) -join ';' }
  if ($next -cne $value) {
    $writeKind = if ($kind) { [Microsoft.Win32.RegistryValueKind]$kind } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    if ($p.action -eq 'remove' -and $p.removeEmpty -and $next -eq '') { $key.DeleteValue('Path', $false) }
    else { $key.SetValue('Path', $next, $writeKind) }
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class MasonEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
    $result = [UIntPtr]::Zero
    [void][MasonEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)
  }
  @{ value = $next; kind = $kind } | ConvertTo-Json -Compress
} finally { $key.Dispose() }
`;
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}
