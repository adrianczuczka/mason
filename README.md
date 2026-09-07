# Mason

[![npm version](https://img.shields.io/npm/v/mason-context)](https://www.npmjs.com/package/mason-context)
[![CI](https://img.shields.io/github/actions/workflow/status/adrianczuczka/mason/ci.yml?branch=main)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/mason-context)](https://www.npmjs.com/package/mason-context)
[![license](https://img.shields.io/github/license/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)
[![issues](https://img.shields.io/github/issues/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/issues)

## Your AI agent is creating tech debt.

**Mason helps your coding agent catch what a patch leaves behind:** stale instructions, missed companion updates, and engineering decisions that need another look.

Works through MCP, with automatic documentation checks for **Codex** and **Claude Code**. No concept map required.

## Get started

Run this in your Git repository:

```bash
npx --package mason-context@0.13.0 mason-auto setup --host codex
# For Claude Code, use --host claude.
```

Requires Node 20+, npm, and Git. Setup connects MCP, hooks, and project instructions. Review your host's trust settings, start a new session, and give your agent a normal task.

Check that Mason is being used:

```bash
npx --package mason-context@0.13.0 mason-auto status
```

Status distinguishes installed configuration from observed use. [Setup and upgrades](docs/setup.md#unified-project-setup) · [Other MCP clients](docs/setup.md#other-clients)

### Try a check without setup

```bash
npx -p mason-context mason-audit --dir .
npx -p mason-context mason-review --dir . --base origin/main
```

The audit checks claims in `AGENTS.md` and `CLAUDE.md`. The review checks committed changes against your chosen base. Both are read-only and need no model calls.

## What Mason catches

| As your project grows… | Mason helps by… |
|---|---|
| Instructions fall behind the code. | Flagging missing paths, incorrect workspace counts, and missing npm scripts. |
| A patch misses a related update. | Surfacing references, related tests, and files that historically change together. |
| Old decisions lose their context. | Retrieving recorded rationale and review status, and flagging changes to the code they apply to. |
| A repair gets interrupted. | Retaining the original findings and verifying them through the final documentation commit. |

After resolving an incident or settling a constraint, ask your agent to record the reason with Mason. Later tasks can retrieve it. Proposals and accepted decisions stay distinct.

Mason complements tests, linters, and code review. Findings are evidence to inspect; unavailable checks stay explicit.

## Evidence so far

Earlier read-only decision-retrieval evaluations scored **9.0/10 with Mason vs 7.0/10 without**. The initial ten-task patch comparison tied at **10/10 for both**. Improved patch outcomes remain to be demonstrated. [Results, methodology, and limitations](docs/benchmarks.md)

## Documentation

- [Setup, hooks, and upgrades](docs/setup.md)
- [Audits, repair verification, and CI evidence](docs/checks.md)
- [Decisions, tools, and optional architecture maps](docs/reference.md)
- [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
