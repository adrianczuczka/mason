import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { reviewAdvisory, type AdvisoryReviewInput } from "./advisory-review.js";

const USAGE = `Usage: mason audit review --baseline <path> --finding <id> [options]

Prepare an advisory assessment against retained evidence (read-only by default).
  --dir <path>       Repository root (default: current directory)
  --baseline <path>  Original repair baseline
  --finding <id>     findingId from repair verification or automation
  --outcome <value>  Record addressed, inapplicable, or deferred
  --reviewer <name>  Actual authorized reviewer
  --note <reason>    Assessment reason
  --token <token>    reviewToken returned by preparation
  --json            Full evidence and review history

Recording requires prior preparation and committed relevant edits. Review records
belong in Git under .mason/reviews/advisories/. Deferral remains outstanding.
Decision findings use review_decision; this command never approves decisions.
Exit 0: prepared/recorded; 2: unavailable, conflict, or decision review required.`;

export async function runAdvisoryCli(args: string[], io = { out: (text: string) => console.log(text), err: (text: string) => console.error(text) }): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { io.out(USAGE); return 0; }
  try {
    const flags: Record<string, string> = {}; let json = false;
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--json") { json = true; continue; }
      if (!["--dir", "--baseline", "--finding", "--outcome", "--reviewer", "--note", "--token"].includes(flag) || flags[flag]) throw new Error("Unexpected or repeated argument: " + flag);
      const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(flag + " requires a value.");
      flags[flag] = value;
    }
    if (!flags["--outcome"] && ["--reviewer", "--note", "--token"].some(key => flags[key])) throw new Error("Use --outcome to record an assessment.");
    const input = { baselinePath: flags["--baseline"], findingId: flags["--finding"],
      action: flags["--outcome"] ?? "prepare", reviewer: flags["--reviewer"], note: flags["--note"], reviewToken: flags["--token"] } as AdvisoryReviewInput;
    const result = await reviewAdvisory(path.resolve(flags["--dir"] ?? process.cwd()), input);
    if (json) io.out(JSON.stringify(result, null, 2));
    else {
      const lines = [`Advisory review: ${result.status}.`];
      if ("finding" in result && result.finding && result.evidence) lines.push(`[${result.finding.type}] ${result.finding.anchor.doc}: ${result.finding.message}`,
        `Finding: ${result.findingId}`, `Prepared against commit ${result.evidence.head.slice(0, 12)}.`,
        result.evidence.dirty ? "Relevant files have uncommitted edits; commit them and prepare again before recording." : "Relevant files are committed.",
        `Review token: ${result.reviewToken}`, ...(result.diff ? ["Scoped changes:", result.diff] : []), ...(result.diffNote ? [result.diffNote] : []));
      if ("event" in result) lines.push(`${result.event.outcome} — ${result.event.reviewer}: ${result.event.note}`, `Record: ${result.recordPath}`);
      lines.push(result.hint);
      io.out(stripVTControlCharacters(lines.join("\n")));
    }
    return result.status === "decision-review-required" ? 2 : 0;
  } catch (error) { io.err(stripVTControlCharacters(error instanceof Error ? error.message : String(error))); return 2; }
}
