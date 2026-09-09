<div align="center">

# Mason

### Your agents are creating tech debt. Mason helps you prevent it.

**Remember why decisions were made · Catch outdated guidance · Find what else needs updating**

[![npm version](https://shieldcn.dev/npm/mason-context.svg?variant=outline&size=sm)](https://www.npmjs.com/package/mason-context)
[![CI](https://shieldcn.dev/github/ci/adrianczuczka/mason.svg?workflow=ci.yml&branch=main&variant=outline&size=sm)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![Monthly downloads](https://shieldcn.dev/npm/dm/mason-context.svg?variant=outline&size=sm)](https://www.npmjs.com/package/mason-context)
[![License](https://shieldcn.dev/npm/license/mason-context.svg?variant=outline&size=sm)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)

[![Works with Codex](https://shieldcn.dev/badge/agent-Codex-64748b.svg?variant=outline&size=sm)](https://github.com/adrianczuczka/mason/blob/main/docs/setup.md)
[![Works with Claude Code](https://shieldcn.dev/badge/agent-Claude%20Code-64748b.svg?variant=outline&size=sm)](https://github.com/adrianczuczka/mason/blob/main/docs/setup.md)
[![MCP compatible](https://shieldcn.dev/badge/protocol-MCP-64748b.svg?variant=outline&size=sm)](https://github.com/adrianczuczka/mason/blob/main/docs/setup.md#other-clients)
[![Supported platforms](https://shieldcn.dev/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-64748b.svg?variant=outline&size=sm)](https://github.com/adrianczuczka/mason/blob/main/docs/distribution.md)

</div>

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
