# Standalone distribution

[← Mason](../README.md)

From **0.14.0**, Mason provides standalone downloads with a bundled runtime. You do not need to install Node or npm. The npm distribution remains supported.

## Install

macOS or Linux:

```sh
curl -fsSL https://github.com/adrianczuczka/mason/releases/latest/download/install.sh | sh
# Open a new terminal if prompted, then run in your Git repository:
mason setup --host codex
# Use --host claude for Claude Code.
mason status
```

Windows PowerShell:

```powershell
irm https://github.com/adrianczuczka/mason/releases/latest/download/install.ps1 | iex
# If prompted, close and reopen your terminal application, then run in your Git repository:
mason setup --host codex
# Use --host claude for Claude Code.
mason status
```

The installers download the archive for your operating system and architecture, verify its SHA-256 checksum, and install the application with its own Node runtime and production dependencies. System Node and npm are unnecessary. Git is still required for project setup and checks. Unix installation also uses curl, tar, and standard shell utilities; Windows uses PowerShell 5.1 or later.

Install and upgrade show their current stage, including download, checksum verification, extraction, and installation. Interactive terminals show native download progress and a spinner with elapsed time during installation work. Redirected output uses plain progress lines on stderr. Setup instructions offer both Codex and Claude Code; choose the assistant you use and run setup inside your project.

The default installation lives in `~/.local/share/mason`, with a launcher in `~/.local/bin`, or `%LOCALAPPDATA%\Mason` with a launcher in its `bin` directory on Windows. From 0.14.1, installation configures PATH automatically. If that directory is already on the current terminal's PATH, run setup immediately. Otherwise, the installer asks you to open a new terminal; on Windows, close and reopen the terminal application. Host trust settings remain separate. `MASON_HOME` and `MASON_BIN_DIR` select other installation locations. An existing unrelated or edited `mason` launcher is retained with an error.

For Bash, Mason appends a marked block to `.bashrc` and the existing login profile (`.bash_profile`, `.bash_login`, or `.profile`, in that order; `.profile` if none exists). For Zsh, it uses `$ZDOTDIR/.zshrc` or `~/.zshrc`; for POSIX `sh`, `~/.profile`. Existing bytes, permissions, and profile symlinks are preserved. Repeated installs and shell startups avoid duplicate entries. Windows installation updates only the user PATH, preserving other entries and unexpanded environment-variable references.

`MASON_PROFILE` selects a custom profile for a supported shell. `MASON_NO_MODIFY_PATH=1` opts out. Unsupported shells, unreadable settings, or edited Mason blocks produce manual instructions instead of claiming automatic setup succeeded.

Setup configures project MCP, hooks and instructions using the same evidence-preserving engine as npm installations. Review the host's native trust settings and start a new session. [Activation and project setup](setup.md#unified-project-setup) describes what status proves.

## Upgrade and uninstall

```sh
mason upgrade           # Latest stable release
mason upgrade 0.16.1    # Install and pin a particular published version
mason updates           # Automatic update preference, pending version, last attempt
mason rollback          # Restore and pin the previous installed version
mason teardown         # Disconnect the current project; keep its knowledge
mason uninstall
```

A global upgrade updates the command used by all configured projects. Restart running assistants to load it. Activation is measured separately for each Mason version; old observations remain local evidence of the previous version. Setup retains original repair evidence and only needs repeating for a fresh clone or configuration changes. A clone does not inherit another checkout's activation. Re-review changed hooks through native host controls.

Uninstall removes the standalone user installation, its owned launchers, and unchanged PATH additions recorded by Mason. Preexisting PATH entries and other shell settings remain; edited Mason blocks are retained with a message. It retains project instructions, MCP/hook configuration, decisions, and repair evidence. Run [mason teardown](setup.md#disconnect-a-project) in each project you want to disconnect before uninstalling. Remaining integrations require Mason to be reinstalled before they can run again. It refuses to delete an edited launcher. Daily update checks reclaim unused bundles that support process tracking, keeping the current, rollback, staged, and running versions. Legacy bundles and bundles with uncertain ownership are retained until uninstall.

The npm distribution and existing dedicated commands remain supported. Install globally with `npm install -g mason-context`; this requires Node 20.17+ and npm. The same project configuration calls `mason` whether it comes from npm or the standalone installer.

## Automatic updates

New, unpinned public standalone installations enable automatic updates and disclose the preference when installation finishes. An existing installation that predates the updater stays opted out after its first manual upgrade. Enable it with `mason updates enable`; no project setup changes are required.

```sh
mason updates enable    # Opt in
mason updates disable   # Opt out; discard a pending activation
mason updates pin       # Hold the currently installed version
mason updates unpin     # Resume following stable releases if enabled
mason updates --json    # Inspect policy and the last attempt as JSON
```

MCP startup and successful `mason setup` can launch a separate background worker. Long-running MCP servers also check whether a worker is due hourly. The worker attempts a release check at most once every 24 hours, including after a failure. It downloads only newer stable releases published at least 24 hours earlier. Releases must pass the six-platform distribution checks before publication. Network failures leave the installed command working and are recorded in `mason updates`; the next automatic attempt is on a later day. Hook, audit, review, drift, status, and version commands never initiate update requests.

Downloads are staged in a separate version directory and must pass signature, archive and file checksum verification plus a version startup check. A pending update activates on the first subsequent MCP launch when no other Mason MCP servers are running for that installation. MCP process leases and activation share the installation lock, so concurrent new servers select the same version. If standalone process tracking cannot be established, startup reports an error; it never runs an untracked server that another process could mistake for idle. Existing MCP servers and hooks keep using the current global version until activation. Close all assistants using Mason and restart one to activate a pending update. A hook-only installation needs an MCP launch or an explicit `mason upgrade` to activate an update; host sessions without a running Mason MCP server are not tracked. No updater daemon or OS scheduled task is installed.

`MASON_NO_AUTO_UPDATE=1` disables automatic checks and activation for the invoking process. CI environments, `MASON_VERSION`, and `MASON_RELEASE_BASE` also suppress them. Installing with an explicit `MASON_VERSION`, or running `mason upgrade <version>`, persists a version pin. Company mirror selection is persisted and prevents public automatic updates even after the environment variable disappears. `mason upgrade` remains an explicit immediate upgrade, clears a version pin after success, and preserves the auto-update preference; company mirrors require an explicit version. npm installations remain managed by npm.

`mason rollback` restores the previously selected bundle without a download, verifies its files, and pins it so automatic updates do not immediately reinstall the rejected release. Close running Mason MCP servers before rolling back. Previous bundles are retained until uninstall; automatic updating therefore increases installation disk usage over time.

Automatic updates verify `update.json` against `update.sigstore.json` using Sigstore, requiring GitHub's OIDC issuer and the exact Mason publishing workflow identity for that release tag, including certificate and transparency-log verification. The signed manifest binds each platform archive to its SHA-256 digest. Missing or invalid signatures never fall back to unsigned updates. Verification refreshes Sigstore trust metadata; see [network behavior](data-and-network.md#network-operations). Initial installs and explicit manual upgrades retain the checksum-based installer trust model.

## Runtime and platform support

Each archive contains the official Node runtime, its license, Mason, locked production dependencies, the installers, and a manifest of file checksums. The build pins Node 24.20.0 and the upstream archive hashes in [standalone-node.json](../scripts/standalone-node.json). Updating that file is a release maintenance task; a bundled runtime does not update itself independently of Mason. See [Node's release policy](https://nodejs.org/en/about/previous-releases).

Targets are macOS, Linux with glibc, and Windows, on x64 and arm64. Alpine/musl is not included in this initial matrix. Bundles have no project-specific paths. Project MCP and hooks invoke `mason` on PATH and resolve the Git worktree from their working directory, including subdirectories. No `run.sh`, `run.ps1`, or `run.cjs` is generated in a project. Windows MCP configuration invokes the installed command through `cmd.exe`. Setup reconciles that platform-specific command when a checkout changes operating systems.

Initial installs and explicit manual upgrades verify adjacent archive checksums. Automatic updates additionally verify signed release metadata as described above. Native executables are not currently platform-code-signed or notarized; OS and host trust requirements still apply.

## Build and validate from source

Build tools require Node and npm; the resulting distribution does not:

```sh
npm ci
npm run build
npm run pack:standalone
npm run test:standalone
```

The pack command defaults to the current platform. Pass `-- --target linux-x64` (or another supported target) to build a different archive. Output goes into the ignored `.standalone/` directory. Dependencies are installed from the lockfile with package scripts disabled. Unexpected native addons or symlinks fail the build instead of producing a misleading portable artifact.

For a local installation on an Apple Silicon Mac:

```sh
.standalone/mason-darwin-arm64/node \
  .standalone/mason-darwin-arm64/app/dist/mason.js internal-install
```

Use the corresponding target directory and `node.exe` for Windows. This installs only the user CLI; project setup remains explicit.

The smoke harness serves release archives locally and runs the actual installers in isolated directories. Child processes start with no Node/npm on PATH; a fresh shell checks discovery through the installed PATH configuration. It exercises both generated MCP configurations, every lifecycle hook, original repair evidence through the final documentation commit, global upgrades across both hosts, clone setup without Git changes, corrupted downloads, edited launchers, and uninstall, including owned PATH cleanup. Temporary-file cleanup retries transient Windows locks within a fixed bound and remains part of the job result. The driver itself uses Node. This is packaged protocol validation, not a native host UI or agent-performance evaluation.

[The standalone workflow](../.github/workflows/standalone.yml) runs that harness on six native runners. Tag publishing waits for all six, then uploads the checked archives, `SHA256SUMS`, and both installers to the GitHub release. Existing release assets are never overwritten. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the runner labels.

`MASON_VERSION` selects and pins a version and `MASON_RELEASE_BASE` overrides the archive download base. A custom base requires an explicit version, avoiding public latest-version discovery, and is retained for future manual upgrades. Production defaults use this repository's GitHub releases. The publishing job signs release metadata with its GitHub Actions OIDC identity; no long-lived signing secret is required. For company distribution, mirror the reviewed installer and artifacts as described in [data and network behavior](data-and-network.md#company-installation-and-mcp).

## Official MCP Registry publishing

The [release workflow](../.github/workflows/publish.yml) checks that the tag, `package.json`, `server.json`, and its npm package entry have the same version before publishing to npm. It then calls the [Official MCP Registry workflow](../.github/workflows/publish-mcp.yml). Registry publication checks the released package on npm, publishes the tagged manifest, and verifies that the exact version is active with the expected package metadata. Metadata checks retry briefly to allow for propagation and fail the job if the expected release never appears.

The existing `com.adrianczuczka/mason` name uses DNS authentication for `adrianczuczka.com`. Configure the repository secret `MCP_PRIVATE_KEY` with the existing Ed25519 private key as 64 hexadecimal characters, matching the domain's `v=MCPv1` TXT record. GitHub OIDC authenticates `io.github.*` names and cannot publish this domain namespace. Never commit the private key. The workflow pins the publisher version and verifies its download checksum; update both together when upgrading it.

To backfill or retry a published npm version without republishing npm or rebuilding standalone downloads, run **Publish to Official MCP Registry** from the default branch and supply the existing release tag:

```sh
gh workflow run publish-mcp.yml --ref main -f tag=v0.17.4
```

The workflow takes release metadata from that tag, including tags created before the workflow existed. A retry skips publication if the exact version is already active with matching package metadata, and fails if an existing entry differs. Publication is serialized per tag and verified against that version rather than `latest`, so an older release can be retried after a newer one exists. A failure here remains visible as a failed workflow and does not undo a successful npm release.
