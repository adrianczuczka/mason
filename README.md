# Mason

[![npm version](https://img.shields.io/npm/v/mason-context)](https://www.npmjs.com/package/mason-context)
[![CI](https://img.shields.io/github/actions/workflow/status/adrianczuczka/mason/ci.yml?branch=main)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/mason-context)](https://www.npmjs.com/package/mason-context)
[![license](https://img.shields.io/github/license/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)
[![issues](https://img.shields.io/github/issues/adrianczuczka/mason)](https://github.com/adrianczuczka/mason/issues)

## Your AI agent is creating tech debt.

**Mason helps your coding agent catch what a patch leaves behind:** stale instructions, missed companion updates, and engineering decisions that need another look.

Works through MCP, with automatic documentation checks for **Codex** and **Claude Code**. No concept map required.

Core checks run locally with no model calls or telemetry. Results become context for your existing assistant. [Data, network access, and team installation](docs/data-and-network.md) covers storage, optional networked features, and internal mirrors.

## Get started

Install on macOS or Linux:

```sh
curl -fsSL https://github.com/adrianczuczka/mason/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/adrianczuczka/mason/releases/latest/download/install.ps1 | iex
```

No Node or npm required. Git is required. The installer configures PATH for Bash, Zsh, and Windows. [Platform details](docs/distribution.md) · [npm installation](docs/setup.md#unified-project-setup)

Run this in your Git repository (open a new terminal if the installer asks):

```bash
mason setup --host codex
# For Claude Code, use --host claude.
```

Setup connects MCP, hooks, and project instructions. Review your host's trust settings, start a new session, and give your agent a normal task.

Check that Mason is being used:

```bash
mason status
```

Setup uses your installed `mason` command—no project launch scripts or runtime copies. Status distinguishes configuration from observed use. [Setup and upgrades](docs/setup.md#unified-project-setup) · [Disconnect a project](docs/setup.md#disconnect-a-project) · [Other MCP clients](docs/setup.md#other-clients)

### Try a check without setup

```bash
mason audit --dir .
mason review --dir . --base origin/main
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
- [Data and network behavior](docs/data-and-network.md) · [Hook performance](docs/hook-performance.md)
- [Audits, repair verification, and CI evidence](docs/checks.md)
- [Decisions, tools, and optional architecture maps](docs/reference.md)
- [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
