import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Pass the map as one TOML value: dotted override keys can split dots inside paths.
const trustedProject = cwd => `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`;

/** Inspect all effective hook sources before bypassing trust in a disposable fixture. */
export function inspectCodexHooks(cwd) {
  const configPath = path.join(cwd, ".codex/hooks.json");
  const expected = JSON.parse(fs.readFileSync(path.join(cwd, ".mason/automation.json"), "utf8")).hosts.codex.command;
  return new Promise(resolve => {
    const child = spawn("codex", ["app-server", "--stdio", "-c", trustedProject(cwd)], { cwd });
    let buffer = "", settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); resolve(result); } };
    const timer = setTimeout(() => finish({ ok: false, reason: "Codex hook inspection timed out" }), 10000);
    const send = (id, method, params) => child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    child.on("error", e => finish({ ok: false, reason: e.message }));
    child.on("close", () => finish({ ok: false, reason: "Codex exited before hook inspection completed" }));
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return finish({ ok: false, reason: "Codex hook inspection exceeded its output limit" });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.error) return finish({ ok: false, reason: "Codex does not support the required hook inspection: " + message.error.message });
        if (message.id === 1) send(2, "hooks/list", { cwds: [cwd] });
        if (message.id !== 2) continue;
        const entry = message.result?.data?.find(e => e.cwd === cwd);
        if (!entry || entry.errors.length || entry.warnings.length) return finish({ ok: false, reason: "Codex could not load the fixture hooks cleanly" });
        const enabled = entry.hooks.filter(h => h.enabled);
        if (enabled.some(h => h.sourcePath !== configPath || h.handlerType !== "command" || h.command !== expected || h.async)) {
          return finish({ ok: false, reason: "Additional or altered hooks are active; refusing to bypass trust outside the generated fixture configuration" });
        }
        const events = enabled.map(h => h.eventName);
        const ok = ["sessionStart", "userPromptSubmit", "preToolUse", "postToolUse", "stop"].every(e => events.includes(e));
        finish({ ok, events, loaded: entry.hooks.map(h => ({ event: h.eventName, enabled: h.enabled, trust: h.trustStatus, source: h.source })),
          reason: ok ? null : "Required Codex hooks were not loaded" });
      }
    });
    send(1, "initialize", { clientInfo: { name: "mason-automation-evaluation", version: "1" }, capabilities: { experimentalApi: true } });
  });
}

export async function runHost({ host, arm, cwd, prompt, transcript, timeoutMs = 180000, model, budgetUsd = 1 }) {
  const preflight = host === "codex" && arm === "hooks" ? await inspectCodexHooks(cwd) : null;
  if (preflight && !preflight.ok) return { ok: false, exitCode: null, costUsd: 0, preflight, result: preflight.reason };
  const args = host === "claude" ? ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "25",
    "--max-budget-usd", String(budgetUsd), "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--dangerously-skip-permissions", "--tools", "Read,Write,Edit,Glob,Grep,Bash"] :
    ["exec", "--json", "--ignore-rules", "--sandbox", "workspace-write",
      ...(arm === "hooks" ? ["--dangerously-bypass-hook-trust"] : ["--disable", "hooks"]),
      "-c", trustedProject(cwd), "--color", "never", prompt];
  if (host === "claude" && arm !== "hooks") args.push("--settings", '{"disableAllHooks":true}');
  if (model) args.push("--model", model);
  // Hook trust bypass is confined to fixtures whose exact integration config the harness created.
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(host, args, { cwd, env: process.env, detached: process.platform !== "win32" });
    const output = fs.createWriteStream(transcript, { flags: "wx" });
    let stdout = "", stderr = "", timedOut = false, outputLimited = false;
    const kill = () => { try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdin.end();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => {
      if (stdout.length + text.length > 16 * 1024 * 1024) { outputLimited = true; kill(); return; }
      stdout += text; output.write(text);
    });
    child.stderr.on("data", text => { stderr = (stderr + text).slice(-8000); });
    child.on("error", error => { stderr += error.message; });
    output.on("error", error => { stderr += error.message; kill(); });
    child.on("close", code => {
      clearTimeout(timer);
      const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const result = events.findLast(e => host === "claude" ? e.type === "result" : e.type === "turn.completed");
      const failed = host === "claude" ? result?.is_error || result?.subtype !== "success" : events.some(e => e.type === "turn.failed" || e.type === "error");
      output.end(() => resolve({ ok: code === 0 && !!result && !failed && !timedOut && !outputLimited,
        exitCode: code, timedOut, outputLimited, elapsedMs: Date.now() - start, costUsd: result?.total_cost_usd ?? null,
        usage: result?.usage ?? null, stderr, eventCount: events.length, preflight,
        result: host === "claude" ? result?.result : events.filter(e => e.item?.type === "agent_message").at(-1)?.item?.text ?? null,
      }));
    });
  });
}
