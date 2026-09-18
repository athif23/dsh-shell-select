# dsh-shell-select

One model-facing `shell` tool whose shell — bash, zsh, fish, sh, PowerShell,
cmd.exe, Git Bash, or WSL Bash — is **your** setting. The model cannot choose a
different shell, and the plugin refuses to run rather than quietly dropping the
sandbox when the shell you picked cannot be confined.

This is a **selector**, not a terminal system, not a security framework, and not
a destructive-command detector. It adds no execution machinery of its own beyond
the per-dialect launch adapters.

## What it reuses, and what it adds

The plugin is deliberately thin. It adds a selector and the per-dialect launch
adapters, and hands everything else to the harness:

| Concern | Reused | Added here |
|---|---|---|
| Finding an executable | `ctx.subprocess.resolveExecutable` — the harness's absolute-path verification and PATH/`PATHEXT` lookup | the per-platform candidate lists (shell *names*, not paths) |
| Which platform we are on | `ctx.subprocess.terminalEnvironment()` → `{platform, defaultShell}` | nothing |
| PowerShell install locations | `candidatePwshPaths` exported by `@deepseek-ai/dsh-pwsh-local` | nothing |
| Process mechanics: deadlines, bounded and spilled output, background handles, process-tree termination | `PwshLocalExecutor` on Windows, `LocalBashExecutor` elsewhere, inherited whole | nothing |
| Sandbox enforcement | `ctx.sandbox.confine` | nothing — including for the settings card's version probes |
| Background job registry | `ctx.jobs` | nothing |
| Settings persistence and the Web settings surface | `ctx.settings.installSection` + the `settings.plugin.item` slot | the `shell-select` namespace and its card |
| Escalation approval | `approveEscalation` from `@deepseek-ai/dsh-sandbox` | nothing |
| Model-facing result rendering | the same marker vocabulary as `tool-pwsh`/`tool-bash` | the shell fact block |

The one thing it *replaces* is the `ctx.shell` provider, because a selector has
to decide argv before the platform executor does. `resolve()` still calls the
inherited defaulting; only the argv, the decision, and the refusal gate are new.

**One decision per call.** Each call — foreground or background — is decided
once: a frozen settings snapshot, the entry, the executable, the validated
working directory, the launch options, and the argv. The decision is what
refuses an unusable selection (before confinement and before any process
exists), what `run`/`start` spawn, and what the transcript records as the shell
that ran. A settings write that lands mid-call therefore changes the *next* call,
never the one in flight, and the recorded facts cannot drift from the process
they describe.

## The verified compatibility matrix

Measured against DSH `0.1.6-alpha.1` on Windows 10.0.26200 with Node v24.15.0, by
running each shell through `ctx.sandbox.confine` into the shipped `windows-acl`
runner and then attempting one write inside the workspace and one outside it.

| Shell (Windows) | Installed on the development host? | `danger-full-access` | `workspace-write` | `read-only` |
|---|---|---|---|---|
| PowerShell 7 (`pwsh`) | **no** — skipped, not installed | not run here | not run here | not run here |
| Windows PowerShell 5.1 | yes | runs | runs, confined; outside writes denied | runs, confined; all writes denied |
| `cmd.exe` | yes | runs | runs, confined; outside writes denied | runs, confined; all writes denied |
| Git Bash | yes | runs | **cannot start** | **cannot start** |
| WSL Bash (Ubuntu 22.04) | yes | runs | **cannot start** | **cannot start** |

The `pwsh` row is the one entry this machine could not exercise: PowerShell 7 is
not installed here, so its integration case skips with that reason and the tested
behavior for the PowerShell dialect is Windows PowerShell 5.1's. The row is kept
because the catalog supports it and a host that has it runs the same code path.

The two failures are the operating system refusing, not this plugin:

- **Git Bash** — MSYS2's runtime aborts during shared-memory setup under the
  restricted token: `fatal error - CreateFileMapping <sid>, Win32 error 5` in
  `msys-2.0.dll`.
- **WSL Bash** — the WSL service refuses to create an instance from the
  restricted token: `Access is denied. Error code: Wsl/Service/CreateInstance/E_ACCESSDENIED`.

Confinement is real where it is claimed. `enforcement: 'partial'` is the
harness's own honest rating of the Windows ACL backend — writes are restricted;
reads, network, and process visibility are not; Everyone grants and NTFS hard
links remain ambient. See `packages/sandbox/sandbox-windows-acl/README.md`.

**Do not read this table as "changing shells prevents destructive commands."**
It does not. The sandbox restricts write-class access; it is not a safety
guarantee, and this plugin adds no destructive-command detection.

## What was tested, and what remains unverified

Stated plainly, because a compatibility claim you cannot check is worse than no
claim. Every number below is from a run of `pnpm test` in this repository.

**On Windows 10.0.26200, against DSH `0.1.6-alpha.1`:** 242 tests, 241 passing, 1
skipped (`pwsh` is not installed here).

**On Linux (Ubuntu) and macOS:** the suites are written to run on either platform
and CI runs them on `ubuntu-latest` and `macos-latest`. Three independent Linux
runs by a reviewer executed Bash, Zsh, and `sh` through the plugin; that host has
no usable sandbox backend, so they verified the refusal path rather than
filesystem confinement. All three found host-dependent behavior — test
boundaries, Windows PATH parsing, a fixture-root check that could not fail, a Test
action that ran in the host process's directory, a catalog comparison that
normalized only one side against a harness list built with the host's own
separator, and a working-directory *existence* case handed a POSIX fixture path
under a simulated Windows platform — all fixed here and pinned by cases that pass
on either platform. CI is what confirms them.

- Every catalog entry's argv, end to end, for `cmd`, Windows PowerShell 5.1, Git
  Bash, and WSL (Ubuntu 22.04) through the real subprocess and sandbox providers.
- Real confinement: a workspace write succeeds and a sibling-directory write is
  denied, for `cmd` and PowerShell; `read-only` denies both. Git Bash and WSL are
  refused under `workspace-write` and `read-only` before any process is spawned,
  and run under `danger-full-access`.
- Timeout, caller cancellation, background read/kill, spaces and Unicode in the
  working directory, a missing working directory, settings persistence across a
  restart, and the two host routes including their loopback restriction.
- One decision per call: the argv, executable, and facts of a call do not move
  when the settings are rewritten mid-call, and concurrent selection refreshes
  settle as the newest answer.
- Two Windows-host races the decision exists for, both driven deterministically
  by a delayed resolution stub rather than by timing luck.
- The version probe going through `ctx.sandbox.confine` like any other command,
  and a row whose mode cannot confine its shell being reported as *not probed*
  rather than started unconfined.
- The `shell` tool and its global guard mount cleanly inside a real DSH web
  composition (isolated `DSH_HOME`), and the Web card's bundle is discovered,
  placed in the boot graph, and served.
- The two host-independence rules that a Linux run found broken: a Windows
  composition simulated on a POSIX host resolves Windows-shaped paths (the
  catalog never joins with the host's separator, and it normalizes the paths the
  harness contributes), and the working-directory rule answers *shape* for any
  platform but *existence* only for the platform that owns the filesystem.
- The fixture guard: a fixture root inside the real user profile is refused
  before anything is created, containment is decided on canonical paths, and a
  checkout inside the profile must name an approved root outside it.

**Verified as logic on any host, both platforms:** the catalogs, the dialect
builders, the resolution walk, the identity guard, the per-platform
working-directory rule, the confinement verdicts, the `auto` selection, and the
lane definitions. `test/platform-lanes.spec.mjs` asserts this coverage so it
cannot silently regress.

**Not verified — read this before relying on it:**

- **The POSIX lane has only ever been spawned in CI.** The plugin is developed on
  Windows, so no local run has executed `bash`, `zsh`, `fish`, or `sh` as the
  *host* shell. `test/integration.spec.mjs` writes that lane in full — required
  shell, spaces and Unicode in the working directory, real confinement with a
  refusal fallback, timeout, cancellation, and the background cycle — and CI runs
  it on `ubuntu-latest` and `macos-latest`. Check the latest run before trusting
  it: if CI is red or the workflow has not run, the POSIX rows are unobserved.
  `lanes.mjs` fixes which shells a lane must cover, and a required shell may not
  skip on its own platform.
- **POSIX confinement is unclaimed.** The catalog marks POSIX entries confineable
  because the harness's POSIX backends (bwrap, Landlock, Seatbelt) wrap argv and
  are indifferent to which shell is inside — the harness's documented behavior,
  not a measurement made here. The integration lane asserts the *file* outcome
  (the escape write is denied) and that a host without a backend refuses instead
  of running unconfined; it does not assert the POSIX denial signature, which is
  each backend's own. The status payload reports `confinementVerified: false` on
  POSIX, and the card says so.
- **POSIX shell semantics were observed, not executed through the plugin.** `dash`'s
  lack of `--version` (exit 2, message on stderr) and `sh -c 'echo "$0"'`
  answering with the implementation's own name were measured directly under WSL
  Ubuntu 22.04, which is why the `sh` entry asks for its interpreter instead of a
  version. The plugin's own POSIX lane was not run against `dash`.
- **`auto` on POSIX has not been observed locally.** The rule is: a `$SHELL`
  naming a catalog entry wins when that entry is installed, otherwise the first
  entry that resolves (bash, then zsh, sh, fish, pwsh). The `$SHELL` half reads
  the harness's own `terminalEnvironment`; the outcome on a given Linux or macOS
  host is exercised only by the CI matrix.
- **Remote execution worlds are unexercised.** Resolution goes through
  `ctx.subprocess`, so an SSH or hosted provider should resolve against its own
  filesystem, but no such provider was available to test. Working-directory
  validation reads the *local* filesystem; on a remote world it is a local check,
  not a statement about the remote directory.
- **`cmd`'s non-ASCII output depends on the console code page.** The collector
  decodes UTF-8; cmd writes whatever code page its console carries, so
  `echo ünïcödé` can arrive as replacement characters. PowerShell avoids this
  through a .NET-level preamble; cmd has no equivalent, and the plugin
  deliberately does **not** run `chcp` — that mutates the code page of the
  console the child shares with the host. Unicode *paths and filenames* work.
- **`fish` and `zsh` have not been run at all**, on any platform. Their entries
  are catalog rows with dialect `bash`; fish's non-POSIX syntax is documented for
  the model but not exercised. `sh` is run by CI's POSIX lane when installed.
- **The Web card has been rendered in a real browser twice, on Windows, in
  isolated `DSH_HOME`s.** Save, Discard, the dropdown, the facts, Test shell, and
  the save-during-test sequence were exercised against the running harness: the
  card listed its options with per-shell facts, the Test action reported
  `cmd → exit 0 / DSH-SHELL-SELECT-TEST-OK`, a save persisted `shell: auto` to the
  settings document, and the Test button released itself so a second run
  completed. The first run found a gap the suite had missed — a staged launch
  option surviving a switch to Automatic — which is fixed and now covered.

  The second run drove the reported sequence end to end: Git Bash saved with an
  executable override and a login flag, then Automatic chosen in the dropdown.
  The card described Automatic's own resolution (Windows PowerShell 5.1, its path,
  version, confinement, and usability), not the saved selection; it cleared the
  override and the login flag and said so; Save wrote `shell: auto`,
  `executable: ""`, and `loginShell: false` to the fixture document and collapsed
  the card; and Test then reported `powershell → exit 0 /
  DSH-SHELL-SELECT-TEST-OK`. A relative path typed into the executable field was
  refused with the reason on the field and Save disabled, and an executable path
  typed under Automatic read as *unknown* rather than naming a shell nothing would
  run.

  Both runs used a throwaway `DSH_HOME` under the plugin's own `.test-tmp`, a
  profile whose only dependency is a `link:` to this checkout, and — in the second
  run — a headless browser launched with its profile directory inside that
  fixture. Neither run read or wrote the real `~/.dsh` settings, and the installed
  profile was verified unchanged afterwards. Because the session that ran the
  second check had no browser-automation tool, the UI was driven over the Chrome
  DevTools protocol through the DOM: clicks were dispatched programmatically, so
  real pointer interaction, hover, focus rings, keyboard navigation, and layout at
  other widths and themes remain unverified, as does any other platform or
  browser. The first run's browser-automation tool timed out on the settings
  dialog's actionability checks for the same reason.

## Execution routes: covered and not covered

| Route | Covered? | Why |
|---|---|---|
| The `shell` tool | Yes | The plugin's own tool. |
| `bash` / `pwsh` tools (any composition layer, including presets) | Yes | Denied by a global `ctx.tools.guard` with a reason naming `shell`. A patch can only address rows by id, and the `standard`/`ptc` presets re-mount `tool-pwsh` inside the agent realm, where no patch reaches. |
| Command hooks (Claude Code / Codex bridges) | Yes | They call `ctx.shell`, which is this executor. |
| tmux context probe | Yes | Calls `ctx.shell`. |
| `run_code` calling `shell` | Yes | Nested dispatch uses the same registry, so `await tools.shell(...)` runs this tool. |
| **`run_code` program body** | **No** | The program runs in a child Node process with full Node APIs; it can `import('node:child_process')` and spawn anything. Only the file sandbox applies. |
| **Persistent PTY tools** (`tool-bash-persistent`, `tool-pwsh-persistent`) | **No** | They use `ctx.terminals`, not `ctx.shell`, so they run their own shell. The guard denies the `bash`/`pwsh` names they register, but the PTY service itself is untouched. |
| **`terminal_*` tools** (`dsh-tool-terminal`) | **No** | Also PTY-based. Not mounted in the base, web, or standard-preset compositions, but a deployment that mounts it gets an uncontrolled shell. |
| Human-driven Web terminal (`ui-sidebar-terminal`) | Not applicable | You type into it; it is not agent command execution. |
| `glob` / `grep` (ripgrep), LSP, MCP stdio servers | Not applicable | These spawn their own fixed programs, not the shell you select. |
| Out-of-process subagents (ACP, Claude Code, Codex, DSH-SDK) | **No** | They spawn external CLIs with their own shells. |
| In-process subagents | Yes | They inherit the global tool registry, so they see `shell` and the guard denies `bash`/`pwsh` for them too. |

Nothing here claims global coverage. The plugin controls the `ctx.shell` seam and
the `shell` tool; the rows marked **No** are real gaps, listed so you can decide
whether they matter.

## The catalog

Shells are named, never pathed. Each entry lists the names to hand to
`ctx.subprocess.resolveExecutable`, and the only absolute candidates are ones
derived from the environment (`ComSpec`, `SystemRoot`, a Git root inferred from
`PATH`) or taken from the harness's own `candidatePwshPaths`.

| Platform | Entries |
|---|---|
| `windows` | `pwsh`, `powershell`, `cmd`, `gitbash`, `wsl` |
| `posix` | `zsh`, `bash`, `fish`, `sh`, `pwsh` |

Each entry declares one of four **dialects**, which decide argv:

| Dialect | Invocation |
|---|---|
| `bash` | `<shell> -c <command>`, or `-l -c` when `loginShell` is on |
| `powershell` | `<shell> -NoLogo -NoProfile -NonInteractive -Command <preamble><command>` |
| `cmd` | `<shell> /d /q /c %DSH_SHELL_SELECT_COMMAND%`, command text in the environment |
| `wsl` | `wsl.exe [-d <distro>] --cd <linux-path> -e bash [-l] -c <command>` |

A dialect is chosen by what the shell *is*, not by the platform: `bash` on Linux
and `bash.exe` from Git for Windows take the same flags. Platform differences
live in the catalog.

Plain `-c` is produced by default for the bash family rather than
`--noprofile --norc`, because bash sources its rc files only for an interactive
shell: a non-interactive `bash -c` already reads no user configuration. `-l` is
the opt-in that does.

**Why cmd uses an environment variable.** `cmd.exe` re-parses its raw command
line with its own rules and does not understand the `\"` escaping the subprocess
seam applies to any argv element containing whitespace, so a quoted path inside a
`cmd /c` argv element arrives as `\"C:\path\"` and fails with *"The filename,
directory name, or volume label syntax is incorrect"* — measured, and covered by
`test/cmd-command-transport.spec.mjs`. Passing the text through `%NAME%` makes
cmd expand it after tokenizing, so quotes, `>`, and `&` all reach cmd's parser
intact.

That transport has one measured cost: cmd substitutes the variable **once** and
does not rescan the result, so a `%NAME%` in your command stays literal. Writing
`call` re-enables expansion (`%CD%` works in `call echo %CD%`). Prefixing every
command with `call` was rejected because it breaks caret escaping (`echo a^&b`
produces no output instead of `a&b`). The model-facing description states the
limitation and the workaround.

## Settings

One namespace in `~/.dsh/settings.yaml`, editable from the Web settings card
(**Settings → Plugins → Shell**):

| Field | Meaning |
|---|---|
| `shell` | A catalog id, or `auto` (the default). `auto` picks the first catalog entry that resolves, so installing the plugin does not change which shell an agent gets: PowerShell leads the Windows catalog because that is what the harness's Windows executor runs, and bash leads the POSIX catalog for the same reason. On POSIX a `$SHELL` that names a catalog entry wins, since there it is a real user preference. |
| `executable` | Optional explicit path for the selected shell. Wins over discovery; a value that cannot be resolved, or that names a *different* shell, is an error — never a cue to discover instead and never a cue to reuse it for another shell's launch arguments. |
| `loginShell` | Run a bash-family shell with `-l`. Off by default. |
| `wslDistro`, `wslMountRoot` | WSL distribution name and where it mounts Windows drives (default `/mnt`). |
| `enableRunInBackground` | Advertise `run_in_background` (default true). |
| `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`, `cwd` | The inherited executor budgets. |
| `pwshPath` | The inherited `shell` namespace's PowerShell executable. Still honored for the PowerShell entries, so an existing setting keeps working. |

A settings change applies to subsequent calls. It never alters a call that is
already being prepared, never alters a running process, and never alters the
facts a finished call recorded.

## The settings card

A collapsed row titled **Shell selection** in **Settings → Plugins**, like every
other plugin card: a name over a one-line description, a chevron, and an
`Unsaved` marker while the row holds edits. It reads native because it reuses
the shipped card's rules — the same `--dsw-alias-*` tokens, the same geometry,
the same `.16s` transitions, the same `Menu` dropdown the other settings rows use — carried in a stylesheet the
bundle injects, since hover, focus rings, and reduced motion have no inline
equivalent.

Opening it shows:

- a **dropdown** listing every shell in the platform's catalog, each option
  carrying its own reported version, so an uninstalled shell reads as *not
  found* rather than disappearing from the list. **Automatic**, the default, is
  the first option, says which shell the host resolves it to, and is always
  selectable — so a user who picked a specific shell can go back;
- the selected shell's facts as a **labelled table rather than a stack of
  sentences**, because they answer four different questions and a reader has to
  be able to tell which is which: **Detected** (the path, or *not found* with its
  diagnostic), **Version** — or **Interpreter**, for a shell whose entry reports
  the implementation its own `$0` names — **Sandbox**, and **Permission mode**.
  A reason sits under the row whose value it explains and is never repeated
  elsewhere: the measured confinement reason under *Sandbox*, a probe's failure
  or the workspace it could not run in under *Version*, the verdict under
  *Permission mode*. What the catalog *expects* stays separate from what this
  machine was *observed* doing — the observation is a note on the sandbox row,
  and a shell that could not be probed says *not probed here* rather than
  restating why;
- the **executable path**, the **login-shell** toggle, and the WSL **distribution**
  and **mount root**, each shown only for the shells they apply to. The
  login-shell control also stays on screen whenever it holds a value that needs
  correcting, so a flag that arrived from somewhere else is never a failure with
  nothing to press;

**Edits are staged and written on Save**, matching the shipped cards: choosing a
shell, typing a path, or ticking a box changes nothing until you press **Save**,
and **Discard** drops the lot. A save goes out as **one revision-fenced
mutation**, so it lands whole or not at all, and the card collapses only after it
does — a rejected write keeps its diagnostics, the host's own message, and your
edits in place.

Changing the shell **clears what belonged to the shell you are leaving** — a
staged executable override, and a login flag the new shell does not take — and
says so under the selector: that path would either fail the host's identity check
or pair one shell's binary with another's launch arguments, and the flag would
block the save with a control the new shell does not even render. Type them again
after the switch if they still apply.

**Automatic is judged as the shell it resolves to, which the host resolves for
itself.** It is not a row of its own, and it is not the saved selection either:
the settings may select Git Bash while Automatic — the catalog order, or a POSIX
`$SHELL` — picks PowerShell. The host resolves Automatic as its own question and
reports it, and a staged launch option is checked against *that* shell, so a login
flag staged for Git Bash does not survive a switch to Automatic that lands on
PowerShell. An executable override changes the answer, because an override naming
a shell claims that shell; the card therefore asks about two configurations — the
one the draft carries, and the one choosing Automatic produces, which drops the
override. A path you type under Automatic is a third configuration the host has
not resolved yet: the card says **unknown** rather than naming a shell nothing
would run.

Clearing a field means what that field means. An empty **executable path** is *no
override*, so clearing it writes an explicit empty and shadows a path that came
from the composition — unsetting a value you never set would simply bring that
path back. Empty **wslDistro** and **wslMountRoot** mean *use the configured
default*, so those unset and the default returns, exactly as their hints say.

Because the facts follow the *staged* selection, you can see what a shell would
resolve to before committing to it. **Test shell** runs the *saved* selection —
a module constant (`echo DSH-SHELL-SELECT-TEST-OK`) with no input, through the
same decide/run path a model call takes, so it reports the same refusal a model
call would get and never demonstrates a capability the tool itself would not
grant. The test runs in the deployment's workspace root — the directory the sandbox
grants, not wherever the host process happens to sit. A result — on screen or still
in flight — is dropped, with a note, as soon
as the saved configuration changes under it: the shell, the executable, the login
flag, the distribution, or the mount root, whether the change came from this card,
another window, or a hand-edited document. A result for a selection the host is no
longer running would be worse than no result — and the run is released with it, so
a discarded test never leaves the button saying *Testing…*.

Version probes are the one place the card runs something, and they run the same
way a command does: fixed plugin-owned arguments, through `ctx.sandbox.confine`
under the deployment's own policy. A shell the current mode cannot confine is
reported as **not probed** — never started unconfined — and a probe that exits
non-zero is a failure even when it printed something, so `dash`'s "Illegal
option" on `--version` is reported as the error it is rather than as a version.

The card also **blocks a save the Host would refuse** — a relative path carrying
a separator, a mount root that is not a Linux path, a login flag on a shell that
takes none — with the reason at the field, instead of staging a write that comes
back rejected. Each such check applies only while its own field is on screen: a
refusal the user cannot reach is a disabled Save with no way out, which is the bug
that rule exists for.

Both host routes (`/dsh-shell-select/status`, `/dsh-shell-select/test`) are
registered on the host web server and **refuse any non-loopback peer**. They
carry no credentials and run one fixed command, so even on a `0.0.0.0`-bound
deployment the worst a local peer can do is print a marker.

## Installation

The plugin is installed into a dsh **profile**, which is a pnpm project under
`~/.dsh/profiles/<name>`. It declares the harness packages as peer dependencies,
so your profile supplies them and no second copy of the harness is pulled in.

```sh
# From the registry, once published
pnpm dsh plugin --profile web add dsh-shell-select

# Or from a git checkout (a local clone, for development)
pnpm dsh plugin --profile web add link:/absolute/path/to/dsh-shell-select
```

Then add it to that profile's bundle list — `~/.dsh/profiles/web/package.json`,
under `dsh.profile.bundles`:

```json
{
  "dependencies": { "dsh-shell-select": "link:/absolute/path/to/dsh-shell-select" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-shell-select"] } }
}
```

Materialize and check the composition before booting:

```sh
cd ~/.dsh/profiles/web && pnpm install
dsh --profile web --dump-config | grep -A3 shell-select
dsh --profile web
```

To try it without editing any profile, apply its patch layer directly:

```sh
dsh --profile web --patch /path/to/dsh-shell-select/cordis.patch.yml --dump-config
```

To remove it: drop the dependency and the bundle entry from the profile's
`package.json`, run `pnpm install` there, and delete the `shell-select:` section
from `~/.dsh/settings.yaml` if you want the stored selection gone too.

This repository commits its own `pnpm-lock.yaml`, so a clone installs the exact
harness graph the suite was verified against (`pnpm install --frozen-lockfile`).
That lockfile governs *this* repository's development install; your profile keeps
its own.

### Pinning

`peerDependencies` names the harness version this plugin is built and tested
against:

```
"@deepseek-ai/dsh-shell": "^0.1.6-alpha.1"
```

A dsh release is a lockstep release of every `@deepseek-ai/dsh-*` package, and a
prerelease range only matches prereleases at the same `major.minor.patch` —
`^0.1.6-alpha.1` will not match `0.1.7-alpha.1`. When dsh moves, widen the range
deliberately rather than by accident, and re-run the suite.

The peers are marked `optional` in `peerDependenciesMeta`, which is how a plugin
says "the deployment provides these, do not install them on my behalf". Without
that, an installer would try to fetch a second harness inside the plugin's own
tree, which is exactly the duplicate-copy problem peers exist to avoid.

## Development

```sh
pnpm install --frozen-lockfile   # pnpm is the supported installer; see below
pnpm test
```

**pnpm is the supported installer**, and `packageManager` pins the version the
whole suite was verified with. The harness itself is a pnpm workspace whose root
manifest declares `packageManager: pnpm@11.7.0` and whose dependency graph uses
`link:` overrides that npm cannot express, so npm is not a supported installer
for anything in this ecosystem — including this plugin.

`npm install` here fails with `ERESOLVE`, and the failure was traced rather than
worked around. The harness's own cross-package `peerDependencies` are prerelease
ranges such as `@deepseek-ai/dsh-agent@^0.1.6-alpha.1`; npm resolves those to the
newest matching prerelease (`0.1.6-alpha.2`), whose own peers require the
`alpha.2` line, while this package pins its `devDependencies` to the `alpha.1`
line it was verified against. `--force` and `--legacy-peer-deps` are not
workarounds for that: both would install a graph that disagrees with itself.
pnpm resolves the same ranges correctly, and the committed `pnpm-lock.yaml` makes
that graph the same one every time.

`pnpm install` prints a warning that build scripts for `koffi`, `node-pty`, and
`@deepseek-ai/dsh-subprocess-local` were ignored. That is pnpm 10's default
deny-first policy and is deliberate here (`pnpm.onlyBuiltDependencies` is empty):
nothing this plugin exercises needs those scripts to run. The prebuilt binaries
those packages ship are what the real subprocess and sandbox providers use, and
the integration lane proves they work.

242 tests across twelve suites. Everything disposable lives under an approved
scratch root: `<projectRoot>/.test-tmp/<unique-id>/` by default, or
`DSH_SHELL_SELECT_TEST_TMP` when this checkout has no scratch of its own outside
the user profile. `test/helpers.mjs` validates the root before creating anything
and refuses one inside the real profile, decides containment on canonical paths
rather than lexical ones, refuses to remove anything outside the root it
validated, and no test reads or writes a real harness home. `test/helpers.spec.mjs`
asserts that.

A clone that lives inside the user profile — a GitHub runner, or a checkout in
`$HOME` — has no such scratch, so it must name one:

```sh
DSH_SHELL_SELECT_TEST_TMP=/tmp/dsh-shell-select pnpm test
```

The suite stops with that instruction rather than falling back to the profile,
and CI sets the variable per runner. On Windows the default profile excludes
`%TEMP%` too, since it is under the profile; name a directory outside it.

`pnpm test:execution` runs only the suites that spawn real processes.

### Why dependencies are split the way they are

The harness packages are **peer** dependencies, not dependencies. A plugin that
carried its own copy would resolve a second `@deepseek-ai/cordis`, and a service
registered through one copy of that module is not the service the harness reads
through another. Peers make the consumer's copy the only copy.

`devDependencies` pins **only the packages the source and the suites actually
import**, from the registry, so that `pnpm install && pnpm test` works in a fresh
clone on any machine and CI exercises the published artifacts rather than a local
checkout. The packages that exist only as runtime services a deployment mounts —
`dsh-jobs`, `dsh-settings`, `dsh-system-prompt`, `dsh-shell-env`,
`dsh-sandbox-policy` — stay declared as peers and are stubbed in the suites, so a
plugin that never imports them does not drag their graphs into every install.

### The CI matrix is the point

The catalog, the dialect builders, the resolution walk, the identity guard, and
the working-directory rules are pure functions of `(platform, environment)` and
run on every runner. Execution is what differs: this plugin is developed on
Windows, so the POSIX lane is only ever *spawned* on the `ubuntu-latest` and
`macos-latest` runners. `test/lanes.mjs` fixes which shells each lane must cover,
`test/integration.spec.mjs` runs both lanes on their own platform, and
`test/platform-lanes.spec.mjs` asserts that a lane still names real catalog
entries — so a lane that stops being covered fails rather than going quiet.

| Suite | Covers |
|---|---|
| `catalog.spec.mjs` | Both platforms' catalogs, argv per dialect, the confinement verdicts, the WSL path translation, the identity guard against a sibling shell's program, and that the catalog names shells rather than paths |
| `discovery.spec.mjs` | Resolution through the seam, no-fallback-on-invalid-config, the override that names another shell, the failure naming every probed location, and the per-platform working-directory rule |
| `executor.spec.mjs` | The decision: zero spawn requests for every refusal, no mode downgrade, one immutable decision per call (settings rewritten mid-call included), argv reaching the process per dialect, `auto` selection, `auto` resolved independently of the selection (including under an executable override, and agreeing with what a call runs), concurrent refresh ordering, and the model-facing description |
| `tool.spec.mjs` | The per-call record: the shell, executable, and working directory come from the call's own decision for foreground and background, an aborted or refused background call never reaches the job registry, and the description names the selected shell |
| `cmd-command-transport.spec.mjs` | The direct form's measured corruption, the transport carrying quotes/redirection/chaining/Unicode filenames, the `%NAME%` limitation and its `call` opt-in |
| `integration.spec.mjs` | Real processes on this host's lane: every required and installed shell, real confinement denial or a fail-closed refusal, timeout, cancellation, background read/kill, spaces and Unicode in the working directory, and `auto` |
| `helpers.spec.mjs` | The fixture rule itself: profile roots are canonical and refused, an approved root is honored, removal is contained and exact, and a simulated platform gets a path shaped for it |
| `lanes.mjs` | The lane definitions themselves: which shells a platform's lane must cover and which may skip |
| `platform-lanes.spec.mjs` | The verification boundary itself, asserted so it cannot be overclaimed |
| `status.spec.mjs` | The separated status facts, Automatic resolved for its own configurations as distinct from the selected row, probes running confined or not at all, a non-zero probe exit as a failure, the `sh` interpreter probe, the test action's refusal path, and the loopback restriction |
| `settings.spec.mjs` | Persistence across a fresh composition, unrelated edits surviving, a change applying only to later calls |
| `replacement.spec.mjs` | The guard denying every replaced name and leaving unrelated tools alone |
| `client.spec.mjs` | The card bundle and its interaction: the slot key, the injected stylesheet and the design tokens it uses, collapsed-by-default disclosure, staging on choose, one revision-fenced save, discard, launch options and overrides cleared on a shell change (and the note that says so), Automatic described by its own resolution rather than by the saved selection, an override the host has not resolved reported as unknown, the facts read as labelled rows with each reason under the row it explains, an inherited value shadowed rather than unset, a test result and an in-flight test response dropped when the saved configuration moves, stale-status ordering, boolean-versus-string field values, and the validation that blocks a save the host would refuse while keeping the way out visible |

## Known limitations

- **Git Bash and WSL cannot be confined on Windows.** They run only under
  `danger-full-access` and are refused under `read-only`/`workspace-write`. This
  is deliberate: the alternatives are silently running unconfined (what several
  published plugins do) or never offering the shell. There is no opt-out setting.
- **The POSIX lane is spawned in CI, not locally** — see the section above.
- **An unconfineable shell shows no version in the card** under a confining mode,
  because its probe is not allowed to run unconfined. The `danger-full-access`
  mode, or a shell the mode can confine, is what produces a version line; the
  card says which of the two happened.
- **`run_code` program bodies and PTY routes are not controlled** — see the route
  table.
- **Windows sandbox enforcement is `partial`** by the harness's own rating.
- **Working-directory validation reads the local filesystem**, so it describes
  the local execution world. Its *shape* check runs for any platform, but its
  *existence* check runs only when the execution platform is the one this process
  runs on: a local `stat` cannot answer for another machine, and refusing on it
  would refuse a directory that is valid in the execution world. There, the
  provider that owns the filesystem refuses a missing directory at spawn. It is a
  typo guard, not a security boundary, and it never substitutes another directory.
- **A path typed under Automatic is not resolved until the selection is saved.**
  The host resolves Automatic for the configurations it is asked about, and the
  card asks about the saved one and the one a switch leaves staged; asking about
  every keystroke would put a resolution request in the typing path. Until then
  the card reports Automatic as *unknown* for that path instead of naming a shell
  nothing would run, and the launch-option checks apply to the saved
  configuration — the one a call uses.
- **The loopback restriction is on the plugin's own routes**, not on the tool: an
  agent on the same machine reaches `shell` normally.
- **The identity guard is a pairing check, not executable authentication.** It
  refuses an override whose program name belongs to a different catalog entry, so
  a `cmd.exe` path cannot be run with bash's arguments. A renamed binary that no
  entry names is accepted, because the user selecting a shell is the assertion
  being trusted; nothing here proves what a binary *is*.
- **No destructive-command detection.** Shell selection is not a safety boundary,
  and this plugin does not pretend to be one.
