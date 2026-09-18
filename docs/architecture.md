# Architecture

This document holds the implementation detail behind
[`dsh-shell-select`](../README.md): how a call is decided, which harness APIs the
plugin delegates to, how each shell dialect builds argv, how the settings card
works, and which execution routes the selector does and does not control.

## What the plugin mounts

`apply()` in [`index.js`](../index.js) mounts three things and nothing else:

1. **A `ctx.shell` provider.** [`ShellSelectExecutor`](../src/executor.js) seats
   the harness's own local executor for the platform (`PwshLocalExecutor` on
   Windows, `LocalBashExecutor` elsewhere) and replaces exactly two things: which
   argv is built, and the decision that refuses a call before any process exists.
   Everything that already routes through `ctx.shell` then uses the selected
   shell: the `shell` tool, Claude Code and Codex hook commands, and the tmux
   context probe.
2. **One model-facing `shell` tool** plus a global tool guard. The guard denies
   `bash` and `pwsh` wherever a preset re-mounts them, so no second shell tool
   competes with the selector. See
   [Execution routes](#execution-routes-covered-and-not-covered).
3. **Two loopback-only host routes** the Web settings card reads.

The shell is a user setting. There is no per-call shell argument, so the model
cannot pick a different shell for one command.

## Harness APIs it delegates to

| Concern | Harness API | What this plugin adds |
|---|---|---|
| Finding an executable | `ctx.subprocess.resolveExecutable` (absolute-path verification, PATH and `PATHEXT` lookup) | per-platform candidate lists of shell *names*, plus the few absolute locations derived from the environment |
| Execution platform and default shell | `ctx.subprocess.terminalEnvironment()` | the rule that decides when `defaultShell` is a preference |
| PowerShell install locations | `candidatePwshPaths` from `@deepseek-ai/dsh-pwsh-local` | nothing |
| Process mechanics: deadlines, bounded and spilled output, background handles, process-tree termination | the inherited local executor | nothing |
| Sandbox enforcement | `ctx.sandbox.confine`, `ctx.sandboxPolicy.resolve` | nothing, including for the card's version probes |
| Background jobs | `ctx.jobs` | nothing |
| Settings persistence and the Web settings surface | `ctx.settings.installSection`, the `settings.plugin.item` slot | the `shell-select` namespace and its card |
| Model-facing result rendering | the same marker vocabulary as the shipped `tool-bash` and `tool-pwsh` | the shell fact block |

The one thing the plugin replaces is the `ctx.shell` provider, because a selector
has to choose argv before the platform executor would. `resolve()` still calls the
inherited defaulting.

## One decision per call

Every call, foreground or background, is decided once in
`ShellSelectExecutor.decide()` from **one frozen settings snapshot**
(`settingsSnapshot()`): a copy of `shell`, `executable`, `pwshPath`,
`loginShell`, `wslDistro`, and `wslMountRoot`. The decision fixes:

1. the execution platform, from the subprocess seam;
2. the catalog entry, following `auto` when the settings ask for it;
3. the refusal when the entry's dialect cannot take the staged launch options;
4. the confinement verdict for the caller's resolved mode;
5. the working directory, validated for the platform;
6. the executable, resolved through the subprocess seam;
7. the argv, built by the dialect adapter;
8. the transport environment the dialect needs.

The decision is frozen, and `run()` and `start()` reuse it rather than deciding
again: a spec carries its decision under an enumerable symbol, so the background
path (`{ ...spec, signal }`) hands the same decision to `ctx.jobs`. A settings
write that lands mid-call therefore changes the *next* call, never the one in
flight, and the facts a result reports cannot drift from the process they
describe.

`refreshSelection()` keeps a separate, generation-guarded cache of the selection
facts for the synchronous surfaces: the model-facing description and the card's
summary. Execution never writes that cache and never reads it.

### Refusals

Refusals happen in a deliberate order, and each one is raised before confinement
and before any process exists:

- a shell this platform's catalog does not have;
- launch options the entry's dialect cannot take (`loginShell` on a
  non-bash-family shell, a `wslMountRoot` that is not an absolute Linux path);
- a call with no resolved sandbox policy;
- a shell the caller's mode cannot confine, raised as
  `ShellSelectionRefusedError` with the shell, the mode, and the legal ways out;
- a working directory that is missing, not a directory, or not absolute for the
  execution platform;
- a configured executable that does not resolve, or that resolves to a program
  another catalog entry names.

There is no fallback at any of these points: the plugin never runs a different
shell, never runs unconfined because confinement was inconvenient, and never
substitutes another working directory.

## The catalog and the dialects

The catalog (`src/catalog.js`) names shells, not paths. Each entry lists the
program names that identify it, the candidate list to hand to
`ctx.subprocess.resolveExecutable`, an optional version query, and whether the
sandbox was measured to be able to confine it on that platform.

| Platform | Entries |
|---|---|
| `windows` | `pwsh`, `powershell`, `cmd`, `gitbash`, `wsl` |
| `posix` | `bash`, `zsh`, `fish`, `sh`, `pwsh` |

Each entry declares one of four **dialects** (`src/dialects.js`), which decide
argv:

| Dialect | Invocation |
|---|---|
| `bash` | `<shell> -c <command>`, or `-l -c` when `loginShell` is on |
| `powershell` | `<shell> -NoLogo -NoProfile -NonInteractive -Command <preamble><command>` |
| `cmd` | `<shell> /d /q /c %DSH_SHELL_SELECT_COMMAND%`, command text in the environment |
| `wsl` | `wsl.exe [-d <distro>] --cd <linux path> -e bash [-l] -c <command>` |

A dialect is chosen by what the shell *is*, not by the platform it runs on:
`bash` on Linux and `bash.exe` from Git for Windows take the same flags, and
PowerShell takes the same flags wherever it ships. Platform differences live in
the catalog. Every dialect receives the command as one argv element or one
environment value, so no argument needs a second round of quoting.

**The bash family runs without an rc file by default.** Plain `-c` is already
hermetic: bash sources its rc files only for an interactive shell, so a
non-interactive `bash -c` reads no user configuration. `-l` is the opt-in that
does, and `--rcfile` is deliberately unused because a per-call rc file would be
configuration execution by another name.

**Why `cmd` passes the command through the environment.** `cmd.exe` re-parses its
raw command line with its own rules and does not understand the `\"` escaping the
subprocess seam applies to any argv element containing whitespace, so a quoted
path inside a `cmd /c` argv element arrives as `\"C:\path\"` and fails with *"The
filename, directory name, or volume label syntax is incorrect"*. Measured, and
covered by `test/cmd-command-transport.spec.mjs`. Passing the text through an
environment variable makes cmd expand it after tokenizing, so quotes, `>`, `|`,
and `&` reach cmd's parser intact. The cost is that cmd substitutes the variable
once and does not rescan the result, so a `%NAME%` in the command stays literal;
writing `call` re-enables expansion. Prefixing every command with `call` was
rejected because it breaks caret escaping (`echo a^&b` produces no output instead
of `a&b`). The model-facing description states both the limitation and the
workaround.

**WSL path translation.** The WSL dialect translates the working directory from
`X:\dir` into the distribution's mount namespace (`/mnt/x/dir` by default, or the
configured `wslMountRoot`). A path with no drive letter, such as a UNC share, is
refused instead of guessed: running the command in the wrong directory would be
worse than not running it.

### Resolution and the identity guard

`resolveExecutable` is the harness's own resolution, and it is the only one that
is correct in a remote execution world: an absolute path is verified as an
executable file, a bare name is looked up in the provider's `PATH` (plus
`PATHEXT` on Windows), and the answer comes from the world that will run the
command.

Two rules sit on top of it:

- **A configured executable that fails is an error, never a cue to discover
  instead.** `executable` names one shell, so the identity guard refuses a path
  whose program name belongs to a *different* catalog entry. That is what stops
  a stale override from pairing one shell's binary with another shell's launch
  arguments. A program name no entry claims is accepted, because a user naming
  their own binary is the assertion being trusted. `gitbash` is the one entry
  stricter than that rule: it requires the real `bash.exe`, since the sibling
  `git-bash.exe` opens a GUI window instead of running the command.
- **Working-directory validation separates shape from existence.** Shape is a
  pure function of the execution platform, so it always runs, which is what
  stops a `/tmp` from being handed to Windows. Existence is a fact about one
  filesystem, so it is checked only when the execution platform is the one this
  process runs on; a local `stat` cannot answer for another machine, and refusing
  on it would refuse a directory that is valid in the execution world. There the
  provider that owns the filesystem refuses a missing directory at spawn.

## Settings and the card

The selection lives in one namespace, `shell-select`, installed with
`ctx.settings.installSection`. Composition entry values are the base layer, the
user's settings document is the layer above, and the schema
(`ShellSelectConfig`) supplies the defaults.

The card is a client bundle (`client.js`) that registers into the
`settings.plugin.item` slot under the same namespace. It stages edits and writes
them on Save as **one revision-fenced `mutate`**, so a save lands whole or not at
all; a rejected write keeps its diagnostics and the staged edits in place. Both
host routes it reads are registered on the host web server and refuse any
non-loopback peer.

**Automatic is resolved by the host, for the configurations a card can be
describing.** An executable override naming a shell claims that shell under
`auto`, so the answer depends on the override in force. The status payload
carries the resolution for the saved configuration and for the same configuration
with the override removed, which is what a shell switch leaves staged, because
clearing the override is what a save then stores. The card reads the first for
the facts it judges a staged selection on, and the second for the Automatic
option itself, whose label must say what choosing it produces. A path typed under
Automatic is a third configuration the host has not resolved, and the card
reports it as *unknown* rather than naming a shell nothing would run.

**Test shell** runs a module constant (`echo DSH-SHELL-SELECT-TEST-OK`) with no
input, through the same decide/run path a model call takes, in the deployment's
workspace root, so it reports the same refusal a model call would get. A result,
on screen or in flight, is dropped with a note as soon as the saved configuration
changes under it.

**Version probes are the one place the card runs something**, and they run the
way a command does: fixed plugin-owned arguments through `ctx.sandbox.confine`
under the deployment's own policy. A shell the current mode cannot confine is
reported as not probed rather than started unconfined, and a probe that exits
non-zero is a failure even when it printed something.

The card **blocks a save the host would refuse** (a relative path carrying a
separator, a mount root that is not a Linux path, a login flag on a shell that
takes none) with the reason at the field. Each check applies only while its own
field is on screen, because a refusal the user cannot reach is a disabled Save
with no way out.

## Execution routes: covered and not covered

| Route | Covered? | Why |
|---|---|---|
| The `shell` tool | Yes | The plugin's own tool. |
| `bash` / `pwsh` tools, from any composition layer including presets | Yes | Denied by a global `ctx.tools.guard` with a reason naming `shell`. A patch can only address rows by id, and the `standard` and `ptc` presets re-mount `tool-pwsh` inside the agent realm, where no patch reaches. |
| Command hooks (Claude Code and Codex bridges) | Yes | They call `ctx.shell`, which is this executor. |
| tmux context probe | Yes | Calls `ctx.shell`. |
| `run_code` calling `shell` | Yes | Nested dispatch uses the same registry. |
| `run_code` program body | No | The program runs in a child Node process with full Node APIs and can spawn anything. Only the file sandbox applies. |
| Persistent PTY tools (`tool-bash-persistent`, `tool-pwsh-persistent`) | No | They use `ctx.terminals`, not `ctx.shell`. The guard denies the names they register, but the PTY service itself is untouched. |
| `terminal_*` tools (`dsh-tool-terminal`) | No | Also PTY-based. Not mounted in the base, web, or standard-preset compositions, but a deployment that mounts it gets an uncontrolled shell. |
| Human-driven Web terminal | Not applicable | It is typed into, not agent command execution. |
| `glob` and `grep` (ripgrep), LSP, MCP stdio servers | Not applicable | They spawn their own fixed programs. |
| Out-of-process subagents (ACP, Claude Code, Codex, DSH-SDK) | No | They spawn external CLIs with their own shells. |
| In-process subagents | Yes | They inherit the global tool registry. |

Nothing here claims global coverage. The plugin controls the `ctx.shell` seam and
the `shell` tool; the rows marked No are real gaps.

## Installation and composition

A dsh **profile** is a pnpm project under `~/.dsh/profiles/<name>`. A plugin that
declares `dsh.bundle.patch` is a bundle: a patch layer applied over the empty
profile root, in the order the profile's `dsh.profile.bundles` list gives.

```sh
dsh plugin --profile web add dsh-shell-select
```

That command forwards its arguments to pnpm with the profile directory as the
working directory, and then reconciles `dsh.profile.bundles` against the
installed state: a dependency whose manifest declares `dsh.bundle` joins the
layer stack, and a removed one leaves it. The install therefore registers the
bundle without hand-editing the manifest, and existing entries are untouched. A
running profile keeps the bundle set from its start, so restart after adding,
removing, or updating one.

The harness packages are **peer** dependencies, marked optional. A plugin that
carried its own copy would resolve a second `@deepseek-ai/cordis`, and a service
registered through one copy of that module is not the service the harness reads
through another. `peerDependencies` names the harness version the plugin is built
and tested against; a dsh release is a lockstep release, and a prerelease range
only matches prereleases at the same `major.minor.patch`. When dsh moves, widen
the range deliberately and re-run the suite.

`devDependencies` pins only the packages the source and the suites import, from
the registry, so a fresh clone installs and tests without a local harness
checkout. pnpm is the supported installer: the harness is a pnpm workspace whose
graph uses `link:` overrides that npm cannot express, and npm resolves the
harness's prerelease peer ranges to a newer line than this package pins.

Removing the plugin: `dsh plugin --profile web remove dsh-shell-select`, then
restart. The stored selection stays in the settings document as an inert section
and can be deleted by hand.

## Not a security boundary

The selected shell runs inside whichever sandbox the session's permission mode
resolves to. Selecting a shell does not add, remove, or weaken confinement, and
the plugin does not detect destructive commands: it is a selector, not a safety
layer.
