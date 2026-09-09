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
mason status
```

The installers download the archive for your operating system and architecture, verify its SHA-256 checksum, and install the application with its own Node runtime and production dependencies. System Node and npm are unnecessary. Git is still required for project setup and checks. Unix installation also uses curl, tar, and standard shell utilities; Windows uses PowerShell 5.1 or later.

The default installation lives in `~/.local/share/mason`, with a launcher in `~/.local/bin`, or `%LOCALAPPDATA%\Mason` with a launcher in its `bin` directory on Windows. From 0.14.1, installation configures PATH automatically. If that directory is already on the current terminal's PATH, run setup immediately. Otherwise, the installer asks you to open a new terminal; on Windows, close and reopen the terminal application. Host trust settings remain separate. `MASON_HOME` and `MASON_BIN_DIR` select other installation locations. An existing unrelated or edited `mason` launcher is retained with an error.

For Bash, Mason appends a marked block to `.bashrc` and the existing login profile (`.bash_profile`, `.bash_login`, or `.profile`, in that order; `.profile` if none exists). For Zsh, it uses `$ZDOTDIR/.zshrc` or `~/.zshrc`; for POSIX `sh`, `~/.profile`. Existing bytes, permissions, and profile symlinks are preserved. Repeated installs and shell startups avoid duplicate entries. Windows installation updates only the user PATH, preserving other entries and unexpanded environment-variable references.

`MASON_PROFILE` selects a custom profile for a supported shell. `MASON_NO_MODIFY_PATH=1` opts out. Unsupported shells, unreadable settings, or edited Mason blocks produce manual instructions instead of claiming automatic setup succeeded.

Setup configures project MCP, hooks and instructions using the same evidence-preserving engine as npm installations. Review the host's native trust settings and start a new session. [Activation and project setup](setup.md#unified-project-setup) describes what status proves.

## Upgrade and uninstall

```sh
mason upgrade           # Latest stable release
mason upgrade 0.16.1    # A particular published version
mason teardown         # Disconnect the current project; keep its knowledge
mason uninstall
```

A global upgrade updates the command used by all configured projects. Restart running assistants to load it. Activation is measured separately for each Mason version; old observations remain local evidence of the previous version. Setup retains original repair evidence and only needs repeating for a fresh clone or configuration changes. A clone does not inherit another checkout's activation. Re-review changed hooks through native host controls.

Uninstall removes the standalone user installation, its owned launchers, and unchanged PATH additions recorded by Mason. Preexisting PATH entries and other shell settings remain; edited Mason blocks are retained with a message. It retains project instructions, MCP/hook configuration, decisions, and repair evidence. Run [mason teardown](setup.md#disconnect-a-project) in each project you want to disconnect before uninstalling. Remaining integrations require Mason to be reinstalled before they can run again. It refuses to delete an edited launcher. Previous global bundle versions are retained until uninstall.

The npm distribution and existing dedicated commands remain supported. Install globally with `npm install -g mason-context`; this requires Node 20+ and npm. The same project configuration calls `mason` whether it comes from npm or the standalone installer.

## Runtime and platform support

Each archive contains the official Node runtime, its license, Mason, locked production dependencies, the installers, and a manifest of file checksums. The build pins Node 24.20.0 and the upstream archive hashes in [standalone-node.json](../scripts/standalone-node.json). Updating that file is a release maintenance task; a bundled runtime does not update itself independently of Mason. See [Node's release policy](https://nodejs.org/en/about/previous-releases).

Targets are macOS, Linux with glibc, and Windows, on x64 and arm64. Alpine/musl is not included in this initial matrix. Bundles have no project-specific paths. Project MCP and hooks invoke `mason` on PATH and resolve the Git worktree from their working directory, including subdirectories. No `run.sh`, `run.ps1`, or `run.cjs` is generated in a project. Windows MCP configuration invokes the installed command through `cmd.exe`. Setup reconciles that platform-specific command when a checkout changes operating systems.

Checksums detect corrupted or changed artifacts; they do not provide an independent signature. Archives are not currently code-signed or notarized. Native trust requirements still apply.

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

`MASON_VERSION` selects a version and `MASON_RELEASE_BASE` overrides the archive download base. A custom base requires an explicit version, avoiding public latest-version discovery. Production defaults use this repository's GitHub releases. For company distribution, mirror the reviewed installer and artifacts as described in [data and network behavior](data-and-network.md#company-installation-and-mcp).
