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
| Sandbox enforcement | `ctx.sandbox.confine` | nothing |
| Background job registry | `ctx.jobs` | nothing |
| Settings persistence and the Web settings surface | `ctx.settings.installSection` + the `settings.plugin.item` slot | the `shell-select` namespace and its card |
| Escalation approval | `approveEscalation` from `@deepseek-ai/dsh-sandbox` | nothing |
| Model-facing result rendering | the same marker vocabulary as `tool-pwsh`/`tool-bash` | the shell fact block |

The one thing it *replaces* is the `ctx.shell` provider, because a selector has
to decide argv before the platform executor does. `resolve()` still calls the
inherited defaulting; only `argv` and the refusal gate are new.

## The verified compatibility matrix

Measured against DSH `0.1.6-alpha.1` on Windows 10.0.26200 with Node v24.15.0, by
running each shell through `ctx.sandbox.confine` into the shipped `windows-acl`
runner and then attempting one write inside the workspace and one outside it.

| Shell (Windows) | `danger-full-access` | `workspace-write` | `read-only` |
|---|---|---|---|
| PowerShell 7 (`pwsh`) | runs | runs, confined | runs, confined |
| Windows PowerShell 5.1 | runs | runs, confined; outside writes denied | runs, confined; all writes denied |
| `cmd.exe` | runs | runs, confined; outside writes denied | runs, confined; all writes denied |
| Git Bash | runs | **cannot start** | **cannot start** |
| WSL Bash | runs | **cannot start** | **cannot start** |

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
claim.

**Tested by the author, on Windows 10.0.26200 against DSH `0.1.6-alpha.1`:**

- Every catalog entry's argv, end to end, for `cmd`, PowerShell 5.1, and Git
  Bash and WSL through the real providers — 132 tests, 130 passing, 2 skipped.
- Real confinement: a workspace write succeeds and a sibling-directory write is
  denied, for `cmd` and PowerShell; `read-only` denies both.
- Real refusals: Git Bash and WSL are refused under `workspace-write` and
  `read-only` before any process is spawned, and run under `danger-full-access`.
- Timeout, caller cancellation, background read/kill, spaces and Unicode in the
  working directory, settings persistence across a restart, and the two host
  routes including their loopback restriction.
- The `shell` tool and its global guard mount cleanly inside a real DSH web
  composition (isolated `DSH_HOME`), and the Web card's bundle is discovered,
  placed in the boot graph, and served.

**Verified as logic on any host, both platforms:** the catalogs, the dialect
builders, the resolution walk, the per-platform working-directory rule, the
confinement verdicts, and the `auto` selection. `test/platform-lanes.spec.mjs`
asserts this coverage so it cannot silently regress.

**Not verified — read this before relying on it:**

- **The POSIX lane has only ever been spawned in CI.** The plugin was developed
  on Windows, so no local run has executed `bash`, `zsh`, `fish`, or `sh`. The
  CI matrix runs the integration suite on `ubuntu-latest` and `macos-latest`,
  which is where that lane is actually exercised — check the latest run before
  trusting it, and treat the POSIX rows as unobserved if CI is red or the
  workflow has not run. The POSIX catalog, argv, resolution order, and platform
  rules are additionally exercised as pure functions on every runner.
- **POSIX confinement is unclaimed.** The catalog marks POSIX entries
  confineable because the harness's POSIX backends (bwrap, Landlock, Seatbelt)
  wrap argv and are indifferent to which shell is inside — that is the harness's
  documented behavior, not a measurement made here. The status payload reports
  `confinementVerified: false` on POSIX, and the card shows a warning.
- **`auto` on POSIX has not been observed.** The rule is: a `$SHELL` naming a
  catalog entry wins when that entry is installed, otherwise the first entry
  that resolves (bash, then zsh, sh, fish, pwsh). The `$SHELL` half reads the
  harness's own `terminalEnvironment`; the outcome on a given Linux or macOS
  host is exercised only by the CI matrix, not locally.
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
- **`sh`, `fish`, and `zsh` have not been run at all**, on any platform. Their
  entries are catalog rows with dialect `bash`; fish's non-POSIX syntax is
  documented for the model but not exercised.
- **The Web card has not been rendered in a browser.** Its bundle, module-loader
  contract, slot key, copy, and data flow are tested against stand-ins for React
  and the slot registry; no browser has drawn it.

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
| `executable` | Optional explicit path. Wins over discovery; a value that cannot be resolved is an error, never a cue to discover instead. |
| `loginShell` | Run a bash-family shell with `-l`. Off by default. |
| `wslDistro`, `wslMountRoot` | WSL distribution name and where it mounts Windows drives (default `/mnt`). |
| `enableRunInBackground` | Advertise `run_in_background` (default true). |
| `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`, `cwd` | The inherited executor budgets. |
| `pwshPath` | The inherited `shell` namespace's PowerShell executable. Still honored for the PowerShell entries, so an existing setting keeps working. |

A settings change applies to subsequent calls. It never alters a spec that was
already resolved, and never alters a running process.

## The settings card

A collapsed row in **Settings → Plugins**, like every other plugin card: a name
over a one-line description, a chevron, and an `Unsaved` marker while the row
holds edits. It reads native because it reuses the shipped card's rules — the
same `--dsw-alias-*` tokens, the same geometry, the same `.16s` transitions, the
same `Menu` dropdown the other settings rows use — carried in a stylesheet the
bundle injects, since hover, focus rings, and reduced motion have no inline
equivalent.

Opening it shows:

- a **dropdown** listing every shell in the platform's catalog, each option
  carrying its own reported version, so an uninstalled shell reads as *not
  found* rather than disappearing from the list. **Automatic**, the default, is
  the first option and says which shell it currently resolves to;
- the selected shell's facts as **separate statements rather than one status
  word** — detected path, version, whether it can be confined, the permission
  mode in force, and whether it is usable under that mode — plus the measured
  refusal reason when it cannot be;
- the **executable path**, the **login-shell** toggle, and the WSL **distribution**
  and **mount root**, each shown only for the shells they apply to.

**Edits are staged and written on Save**, matching the shipped cards: choosing a
shell, typing a path, or ticking a box changes nothing until you press **Save**,
and **Discard** drops the lot. A save goes out as **one revision-fenced
mutation**, so it lands whole or not at all, and the card collapses only after it
does — a rejected write keeps its diagnostics and your edits in place.

Because the facts follow the *staged* selection, you can see what a shell would
resolve to before committing to it. What the numbers cannot yet reflect is the
staged path itself, so **Test shell** says so while edits are outstanding: it
runs the *saved* selection. The test runs `echo DSH-SHELL-SELECT-TEST-OK`, a
module constant with no input, through the same resolve/run path a model call
takes — so it reports the same refusal a model call would get, and never
demonstrates a capability the tool itself would not grant.

The card also **blocks a save the Host would refuse** — a relative path carrying
a separator, a mount root that is not a Linux path, a login flag on a shell that
takes none — with the reason at the field, instead of staging a write that comes
back rejected.

Both host routes (`/dsh-shell-select/status`, `/dsh-shell-select/test`) are
registered on the host web server and **refuse any non-loopback peer**. They
carry no credentials and run one fixed command, so even on a `0.0.0.0`-bound
deployment the worst a local peer can do is print a marker.

## Installation

The plugin is installed into a dsh **profile**, which is a pnpm project under
`~/.dsh/profiles/<name>`. It declares the harness packages as peer
dependencies, so your profile supplies them and no second copy of the harness is
pulled in.

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

## Development

```sh
pnpm install
pnpm test
```

155 tests across ten suites. Everything disposable lives under
`<projectRoot>/.test-tmp/<unique-id>/`, where the project root is this package's
own directory — never a parent, never a home directory. `test/helpers.mjs`
refuses to remove a path outside that tree, and no test reads or writes a real
harness home.

`pnpm test:execution` runs only the suites that spawn real processes.

### Why dependencies are split the way they are

The harness packages are **peer** dependencies, not dependencies. A plugin that
carried its own copy would resolve a second `@deepseek-ai/cordis`, and a service
registered through one copy of that module is not the service the harness reads
through another. Peers make the consumer's copy the only copy.

`devDependencies` pins the same packages from the registry so that
`pnpm install && pnpm test` works in a fresh clone on any machine, and so CI
exercises the published artifacts rather than a local checkout. Both are pinned
to the same version on purpose.

### The CI matrix is the point

The catalog, the dialect builders, the resolution walk, and the
working-directory rules are pure functions of `(platform, environment)` and run
on every runner. Execution is what differs: this plugin is developed on Windows,
so the POSIX lane is only ever *spawned* on the `ubuntu-latest` and
`macos-latest` runners. `test/platform-lanes.spec.mjs` asserts which state each
lane is in, so a lane that stops being covered fails rather than going quiet.

| Suite | Covers |
|---|---|
| `catalog.spec.mjs` | Both platforms' catalogs, argv per dialect, the confinement verdicts, the WSL path translation, and that the catalog names shells rather than paths |
| `discovery.spec.mjs` | Resolution through the seam, no-fallback-on-invalid-config, the failure naming every probed location, and the per-platform working-directory rule |
| `executor.spec.mjs` | The gate: zero spawn requests for every refusal, no mode downgrade, argv reaching the process per dialect, `auto` selection, and the model-facing description |
| `cmd-command-transport.spec.mjs` | The direct form's measured corruption, the transport carrying quotes/redirection/chaining/Unicode filenames, the `%NAME%` limitation and its `call` opt-in |
| `integration.spec.mjs` | Real processes: every installed shell, real confinement denial, timeout, cancellation, background read/kill |
| `platform-lanes.spec.mjs` | The verification boundary itself, asserted so it cannot be overclaimed |
| `status.spec.mjs` | The separated status facts, the test action's refusal path, the loopback restriction |
| `settings.spec.mjs` | Persistence across a fresh composition, unrelated edits surviving, a change applying only to later calls |
| `replacement.spec.mjs` | The guard denying every replaced name and leaving unrelated tools alone |
| `client.spec.mjs` | The card bundle and its interaction: the slot key, the injected stylesheet and the design tokens it uses, collapsed-by-default disclosure, staging on choose, one revision-fenced save, discard, and the validation that blocks a save the host would refuse |

## Known limitations

- **Git Bash and WSL cannot be confined on Windows.** They run only under
  `danger-full-access` and are refused under `read-only`/`workspace-write`. This
  is deliberate: the alternatives are silently running unconfined (what several
  published plugins do) or never offering the shell. There is no opt-out setting.
- **The POSIX lane is unverified at runtime** — see the section above.
- **`run_code` program bodies and PTY routes are not controlled** — see the route
  table.
- **Windows sandbox enforcement is `partial`** by the harness's own rating.
- **Working-directory validation reads the local filesystem**, so it describes
  the local execution world. It is a typo guard, not a security boundary, and it
  never substitutes another directory.
- **The loopback restriction is on the plugin's own routes**, not on the tool: an
  agent on the same machine reaches `shell` normally.
- **No destructive-command detection.** Shell selection is not a safety boundary,
  and this plugin does not pretend to be one.
