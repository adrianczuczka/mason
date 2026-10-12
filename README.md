<div align="center">

# Mason

### Preserve why your code was built this way.

**Record the reason · Review the lesson · Surface applicable guidance · Reconsider it as code changes**

[![npm version](https://img.shields.io/npm/v/mason-context?style=flat-square&labelColor=334155&color=2563eb)](https://www.npmjs.com/package/mason-context)
[![CI](https://img.shields.io/github/actions/workflow/status/adrianczuczka/mason/ci.yml?branch=main&style=flat-square&labelColor=334155&label=CI)](https://github.com/adrianczuczka/mason/actions/workflows/ci.yml)
[![Monthly downloads](https://img.shields.io/npm/dm/mason-context?style=flat-square&labelColor=334155&color=2563eb)](https://www.npmjs.com/package/mason-context)
[![License](https://img.shields.io/github/license/adrianczuczka/mason?style=flat-square&labelColor=334155&color=64748b)](https://github.com/adrianczuczka/mason/blob/main/LICENSE)

[![Works with Codex](https://img.shields.io/badge/Codex-supported-64748b?style=flat-square&labelColor=334155)](https://github.com/adrianczuczka/mason/blob/main/docs/setup.md)
[![Works with Claude Code](https://img.shields.io/badge/Claude%20Code-supported-64748b?style=flat-square&labelColor=334155)](https://github.com/adrianczuczka/mason/blob/main/docs/setup.md)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-64748b?style=flat-square&labelColor=334155)](https://github.com/adrianczuczka/mason/blob/main/docs/setup.md#other-clients)
[![Supported platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-64748b?style=flat-square&labelColor=334155)](https://github.com/adrianczuczka/mason/blob/main/docs/distribution.md)

</div>

Mason preserves reviewed engineering reasoning with your repository, so future maintainers and coding agents can retrieve the evidence behind consequential decisions. Record workarounds, rejected approaches and constraints while their reasons are available; revisit them when the underlying code changes.

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

New standard standalone installs update automatically in the background. Updates activate on a future MCP launch after existing Mason MCP servers exit. Run `mason updates` to inspect or change this preference. Existing installations require one manual upgrade and `mason updates enable`. [Update controls](docs/distribution.md#automatic-updates)

Run this in your Git repository (open a new terminal if the installer asks):

```bash
mason init --host codex    # Maintainer: prepare shared configuration for review/commit
mason setup --host codex   # Each developer: activate locally
# For Claude Code, use --host claude.
```

If the repository already has compatible Mason configuration, run only `mason setup`. Initialization prepares MCP, hooks and project instructions; setup leaves shared files untouched. Review your host's trust settings, start a new session, and give your agent a normal task.

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

The audit checks claims in README and agent instruction files throughout the repository. The review checks committed changes against your chosen base. Both are read-only and need no model calls.

## What Mason catches

| As your project grows… | Mason helps by… |
|---|---|
| Instructions fall behind the code. | Flagging missing paths, incorrect workspace counts, and missing npm scripts. |
| A patch misses a related update. | Surfacing references, related tests, and files that historically change together. |
| Old decisions lose their context. | Retrieving recorded rationale and review status, and flagging changes to the code they apply to. |
| A repair gets interrupted. | Retaining the original findings and verifying them through the final documentation commit. |

After resolving an incident or settling a constraint, ask your agent to record a sourced proposal with Mason. Review it before accepting it as project guidance. Later tasks can retrieve the operative accepted revision while proposed replacements remain distinct, and changes to referenced code can prompt inspection, revision or retirement.

Mason complements tests, linters, and code review. Findings are evidence to inspect; unavailable checks stay explicit.

## Evidence so far

Earlier read-only decision-retrieval evaluations scored **9.0/10 with Mason vs 7.0/10 without**. The initial ten-task patch comparison tied at **10/10 for both**. Improved patch outcomes remain to be demonstrated. [Results, methodology, and limitations](docs/benchmarks.md)

Maintained notes also succeeded in the reuse trials. Recent hook experiments verified supported file delivery, with additional context cost and no demonstrated correctness gain; direct delivery for ordinary Bash workflows remains open. The current focus is useful preservation and reuse of engineering reasoning during ordinary work, with capture and maintenance effort that feels worthwhile. Preventing repeat mistakes is one intended benefit; comparative superiority remains unestablished. [Positioning and validation plan](ROADMAP.md#historical-context-focus--2026-10-12) · [Current evidence](ROADMAP.md#current-evidence-and-boundaries)

## Documentation

- [Setup, hooks, and upgrades](docs/setup.md)
- [Data and network behavior](docs/data-and-network.md) · [Hook performance](docs/hook-performance.md)
- [Audits, repair verification, and CI evidence](docs/checks.md)
- [Decisions, tools, and optional architecture maps](docs/reference.md)
- [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

## Development

For development, use Node 20 (20.19+), Node 22 (22.13+), or Node 24+.
After `npm ci`, run `npm run format` to format TypeScript sources, tests, and tooling configs.
CI checks formatting with `npm run format:check` and runs `npm run lint`,
`npm run typecheck`, and the test suite. Run `npm test` locally to check behavior.

ESLint uses the recommended TypeScript rules plus type-aware checks for unhandled
promises, misused async callbacks, and invalid awaits. Prettier handles formatting.
Test fixtures and generated outputs are excluded from formatting and linting.
Production sources also reject explicit `any` and unsafe assignments, property
access, calls, arguments, and returns. External data is validated before use.
Test doubles keep the more permissive rules.
