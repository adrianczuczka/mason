# Data, network access, and team installation

[← Mason](../README.md)

Mason's core checks run in your checkout using local files and Git. They do not call a model, send telemetry, or contact a Mason service. MCP results and hook messages are returned to your coding assistant, which may send that context to its configured model provider. Your assistant's data policy still applies.

This describes the implementation in 0.16.2. It is not a promise that every optional feature, installer, dependency, or inherited system configuration is network-free.

## Hook input and storage

The host sends JSON on stdin, including prompt text, tool arguments such as shell commands and file contents, tool responses, identifiers, and a transcript path, depending on the event. The binary receives that data in memory even when a field is unused. See the [Claude hook contract](https://code.claude.com/docs/en/hooks) and [Codex hook contract](https://learn.chatgpt.com/docs/hooks).

Automation uses the working directory, event, tool name, tool/session identifiers, and continuation/plan flags. It does not execute supplied commands, read the supplied transcript, or persist raw prompts, tool argument bodies, or tool responses. Inputs above 1 MiB are rejected; malformed JSON diagnostics do not quote payload contents. The separate decision-injection hook uses a touched file path to retrieve decisions.

Mason separately reads files and Git history needed by the requested checks or tools. Reports can contain proprietary document excerpts, paths, commit information, and decision evidence. Context tools can return code previews and decision bodies to the assistant.

| Location | Contents and retention |
|---|---|
| `.mason/decisions/` | Rationale, sources, owners, and proposal/review history. Intended for normal Git review and versioning; never automatically published to a service. |
| `.mason/reviews/advisories/` | Explicit advisory assessments, reviewer and reason, original findings, and scoped Git evidence. Intended for project review and versioning; shared across clones. |
| `.mason/snapshot.json`, `.mason/config.json` | Optional architecture map and repository settings. Shared when committed; maps can contain proprietary descriptions and paths. |
| `.mason/local/` | Setup and ownership records, ignored by generated setup rules. |
| `.mason/reports/` | Original evidence, findings, caches, execution/activation receipts; ignored by generated setup rules. Receipts can contain root paths, branch, hostname, PID, timing, event names, hashed session identifiers, and tool call identifiers. Baselines persist; execution history is bounded. |
| `~/.mason/config.json` | Optional Confluence credentials and LLM configuration. User-level JSON; credentials are not encrypted by Mason. |
| Standalone installation directory | Executable, bundled Node, dependencies, receipts, and previous versions. Defaults to `~/.local/share/mason` or `%LOCALAPPDATA%\Mason`. |

Teardown disconnects integrations but retains knowledge and evidence. Uninstall removes the standalone installation but keeps project data and optional user configuration. Review ignore rules before committing; they are not an access-control boundary. Mason runs with the invoking process's filesystem permissions.

## Network operations

| Operation | Destination and data |
|---|---|
| Core audit, review, drift, decision/context/impact tools, and automation hooks | No direct remote API or telemetry calls. Local file and Git operations; results return to the caller. |
| Standalone installation or explicit `mason upgrade` | GitHub releases and their download redirects, or a configured mirror. Downloads installers, archives, and checksums without uploading the checkout. Unpinned public installation resolves the latest release. No background updater. |
| npm installation or an `npx` MCP entry | The npm client's configured registry and download destinations. Resolution/cache behavior belongs to npm; `npx` is not a no-network guarantee. |
| Optional Confluence tools | The configured Confluence base URL. Configuration can query spaces/pages; export sends generated wiki content. Requires invocation and configuration; outside the hook path. |
| Optional product-language rewrite during Confluence export | Feature/flow descriptions and paths go to the configured LLM. API defaults are Anthropic (`api.anthropic.com`), OpenAI (`api.openai.com`), or Gemini (`generativelanguage.googleapis.com`); Ollama defaults to `http://localhost:11434`. CLI providers and environment overrides use their configured endpoints and policies. |

There is no global Mason switch enforcing network denial for every feature. Limit exposed tools and use organizational egress controls where required. Include Git subprocesses, external CLIs, npm, and environment configuration in that policy; source inspection alone is not an OS sandbox.

## Company installation and MCP

A `.mcp.json` entry with `command` launches a local program; it does not install it. A `url` entry connects to an already-running MCP service. Mason uses local stdio to inspect the checkout and uncommitted changes. A remote URL would require a different deployment and repository-access arrangement. Lifecycle hooks also need a local executable.

Review a pinned version and distribute it through your approved artifact or npm mirror. Public source supports inspection. Checksums supplied beside an archive detect changes but are not an independent signature; standalone archives are not currently signed or notarized.

For an internal standalone mirror, copy the reviewed installer, platform archives, and `SHA256SUMS` to the approved service. Preserve the `v<VERSION>/<asset>` layout beneath the release base. After obtaining the installer internally:

```sh
MASON_VERSION=0.16.2 \
MASON_RELEASE_BASE=https://artifacts.example.internal/mason \
sh ./install.sh
```

The hostname is a placeholder. Both installers require `MASON_VERSION` when `MASON_RELEASE_BASE` is supplied, avoiding a public latest-version lookup. Set the mirror again for upgrades and specify the approved version: `MASON_RELEASE_BASE=… mason upgrade 0.16.2`. Mirror selection is not persisted. npm users should use their organization's registry configuration.

Each developer runs `mason setup --host claude` or `--host codex` and reviews native host trust. Generated hooks stay quiet when the command is absent or that checkout lacks local host setup. `mason status` explains inactive setup. Corrupt setup and failures in active checks remain visible. MCP itself still requires installation and setup; quiet hooks do not fake a connected server.

Setup owns the inline guards; no project wrapper scripts are required. Commands are platform-specific, as is Windows MCP configuration. Rerun setup when changing operating systems. Custom manual commands remain the caller's responsibility. Refresh existing guards by rerunning setup after upgrading, then review and commit the configuration.

## Verification and limits

[Adoption regressions](../test/adoption-hardening.test.ts) exercise core CLI checks, stdio context/impact requests, and hooks with Node network operations denied. A tripwire records attempted operations even if exceptions are caught. On macOS, the process tree also runs under an OS network-denial policy. Other platforms' tests do not claim to sandbox arbitrary subprocess networking.

Synthetic prompt, command, response, and transcript-path markers must not appear in output or persisted records. Other regressions cover absent commands, unconfigured checkouts, invalid setup, and evidence capture before shell/unknown tools. Packaged tests run generated guards without system Node/npm across the six native platform targets. This verifies exercised paths, not a comprehensive security audit or future releases.

See [hook performance](hook-performance.md) for measurement scope and reproduction.
