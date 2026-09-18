# Testing and verification

What the suites cover, which platforms have actually been exercised, and what
remains unverified. Every claim here is either a command that can be re-run or a
measurement that was taken once and is named as such.

## Running the suites

```sh
pnpm install --frozen-lockfile
pnpm test              # every suite
pnpm test:execution    # only the suites that spawn real processes
```

`packageManager` pins the pnpm version the graph was verified with. pnpm is the
supported installer: the harness is a pnpm workspace whose dependency graph uses
`link:` overrides that npm cannot express, and npm resolves the harness's
prerelease peer ranges to a newer line than this package pins.

Test counts on the development host (Windows 10.0.26200, Node v24.15.0, DSH
`0.1.6-alpha.1`): **249 tests, 248 passed, 1 skipped** (`pwsh` is not installed
there). An independent review ran an earlier revision on Linux: **242 tests, 227
passed, 0 failed, 15 skipped**; the counts differ because the suite has grown
since.

## Coverage by suite

| Suite | Covers |
|---|---|
| `catalog.spec.mjs` | Both platforms' catalogs, argv per dialect, the confinement verdicts, WSL path translation, the identity guard against a sibling shell's program, and that the catalog names shells rather than paths |
| `discovery.spec.mjs` | Resolution through the seam, no fallback on an invalid configured path, the override that names another shell, the failure naming every probed location, and the per-platform working-directory rule |
| `executor.spec.mjs` | The decision: zero spawn requests for every refusal, no mode downgrade, one immutable decision per call (settings rewritten mid-call included), argv reaching the process per dialect, `auto` selection, `auto` resolved independently of the selection (including under an executable override, and agreeing with what a call runs), concurrent refresh ordering, and the model-facing description |
| `tool.spec.mjs` | The per-call record: shell, executable, and working directory come from the call's own decision for foreground and background, an aborted or refused background call never reaches the job registry, and the description names the selected shell |
| `cmd-command-transport.spec.mjs` | The direct form's measured corruption, the transport carrying quotes, redirection, chaining, and Unicode filenames, the `%NAME%` limitation and its `call` opt-in |
| `integration.spec.mjs` | Real processes on the host's own lane: every required and installed shell, real confinement denial or a fail-closed refusal, timeout, cancellation, background read and kill, spaces and Unicode in the working directory, and `auto` |
| `status.spec.mjs` | The separated status facts, Automatic resolved for its own configurations as distinct from the selected row, probes running confined or not at all, a non-zero probe exit as a failure, the `sh` interpreter probe, the test action's refusal path, and the loopback restriction |
| `client.spec.mjs` | The card bundle and its interaction: the slot key, the injected stylesheet and the design tokens it uses, collapsed-by-default disclosure, staging on choose, one revision-fenced save, discard, launch options and overrides cleared on a shell change, Automatic described by its own resolution, an unresolved override reported as unknown, the facts as labelled rows, an in-flight test response dropped when the saved configuration moves, stale-status ordering, field types, and the validation that keeps a refused save reachable |
| `settings.spec.mjs` | Persistence across a fresh composition, unrelated edits surviving, and a change applying only to later calls |
| `replacement.spec.mjs` | The guard denying every replaced tool name and leaving unrelated tools alone |
| `helpers.spec.mjs` | The fixture rule itself: profile roots are canonical and refused, an approved root is honored, removal is contained and exact, and a simulated platform gets a path shaped for it |
| `docs-links.spec.mjs` | Every relative link and heading anchor in the published documents resolves |
| `lanes.mjs` and `platform-lanes.spec.mjs` | Which shells a platform's lane must cover, which may skip, and that the verification boundary itself cannot be overclaimed |

**Verified as logic on any host:** the catalogs, the dialect builders, the
resolution walk, the identity guard, the per-platform working-directory rule, the
confinement verdicts, the `auto` selection, and the lane definitions. These are
pure functions of `(platform, environment)`, so the POSIX rows are exercised on
Windows and the Windows rows on Linux.

## Platform evidence

### Windows (primary)

Measured on Windows 10.0.26200 by running each shell through
`ctx.sandbox.confine` into the shipped `windows-acl` runner, then attempting one
write inside the workspace and one outside it:

| Shell | Installed on that host? | `danger-full-access` | `workspace-write` | `read-only` |
|---|---|---|---|---|
| PowerShell 7 (`pwsh`) | no, skipped | not run | not run | not run |
| Windows PowerShell 5.1 | yes | runs | runs, confined; outside writes denied | runs, confined; all writes denied |
| `cmd.exe` | yes | runs | runs, confined; outside writes denied | runs, confined; all writes denied |
| Git Bash | yes | runs | cannot start | cannot start |
| WSL Bash (Ubuntu 22.04) | yes | runs | cannot start | cannot start |

The two failures are the operating system refusing, not this plugin:

- **Git Bash**: MSYS2's runtime aborts during shared-memory setup under the
  restricted token (`fatal error - CreateFileMapping <sid>, Win32 error 5` in
  `msys-2.0.dll`).
- **WSL Bash**: the WSL service refuses to create an instance from the restricted
  token (`Access is denied. Error code: Wsl/Service/CreateInstance/E_ACCESSDENIED`).

`enforcement: 'partial'` is the harness's own rating of the Windows ACL backend:
writes are restricted; reads, network, and process visibility are not.

### Linux (secondary)

An independent review ran the suite on Linux, and Bash, Zsh, and `sh` executed
through the plugin there. That host had **no usable sandbox backend**, so those
runs exercised the refusal path and the POSIX shell lanes rather than filesystem
confinement: Linux confinement is not verified by them. Three such runs also
found host-dependent behavior in the suites themselves (Windows PATH parsing, a
catalog comparison normalizing only one side, a working-directory existence case
handed a POSIX path under a simulated Windows platform), all fixed and pinned by
cases that pass on either platform.

The test workflow runs on Linux too, and what it can verify there is narrower
than the Windows lane, because the two profiles grant different roots. The Linux
`workspace-write` profile grants `/tmp` writable, so a fixture under `/tmp`
cannot test that a write outside the workspace is denied: the write succeeds
because the location is granted. CI therefore names a scratch root outside both
the profile and `/tmp` (`/var/tmp/dsh-shell-select`), the suite refuses to assert the
denial from a `/tmp` fixture and says which variable to set instead, and Windows
is where the file outcome has actually been measured.

POSIX shell semantics were measured directly under WSL Ubuntu 22.04 rather than
through the plugin: `dash` answers `--version` with an illegal-option error on
stderr and exit 2, and `sh -c 'echo "$0"'` names the implementation. That is why
the `sh` entry asks for its interpreter instead of a version.

### macOS and everything else

macOS is unverified: no run has been executed there, and it is not in the test
workflow's matrix. CI runs the suite on Windows and Linux, so check the latest
run before relying on either; this document does not claim the workflow's current
state. Remote execution worlds (SSH or hosted providers) are also unexercised:
resolution goes through `ctx.subprocess`, which should resolve against the remote
filesystem, but no such provider was available to test.

`fish` is a catalog row only: its entry exists and its non-POSIX syntax is
documented for the model, but it has not been executed anywhere.

## Fixture safety

Everything disposable lives under an approved scratch root:
`<projectRoot>/.test-tmp/<unique-id>/` by default, or the directory named by
`DSH_SHELL_SELECT_TEST_TMP` when the checkout itself has no scratch outside the
user profile.

`test/helpers.mjs` validates the root before creating anything, refuses a root
inside the real user profile, decides containment on canonical paths rather than
lexical ones, and refuses to remove anything outside the root it validated. No
suite reads or writes a real harness home; `test/helpers.spec.mjs` asserts that.

A checkout inside the user profile (a GitHub runner, or a clone in `$HOME`) must
name an approved root, and the suite stops with that instruction instead of
falling back to the profile:

```sh
# Linux, macOS, or Git Bash
DSH_SHELL_SELECT_TEST_TMP=/var/tmp/dsh-shell-select pnpm test
```

```powershell
# Windows PowerShell: %TEMP% is under the profile, so name a path outside it
$env:DSH_SHELL_SELECT_TEST_TMP = 'D:\dsh-shell-select-test-tmp'
pnpm test
```

## Browser checks

The settings card has been rendered in a real browser twice, on Windows, each
time in a throwaway `DSH_HOME` under `.test-tmp` whose profile links this
checkout. Both runs drove the running harness: the card listed its options with
per-shell facts, **Test shell** reported `cmd → exit 0 /
DSH-SHELL-SELECT-TEST-OK`, a save persisted `shell: auto` to the settings
document, and the Test button released itself so a second run completed. The
second run also walked Git Bash with an executable override and a login flag to
Automatic: the card described Automatic's own resolution, cleared the override
and the flag, saved `shell: auto`, `executable: ""`, and `loginShell: false`, and
Test then reported `powershell → exit 0`.

After each run the real `~/.dsh` settings document and the installed profile's
manifest were verified unchanged. That is what those runs establish; they do not
establish anything about which files the fixture process read.

Both checks drove the DOM over the Chrome DevTools protocol, dispatching clicks
programmatically, because neither session had browser-automation tooling
available. Real pointer interaction, hover, focus rings, keyboard navigation,
copy selection, and layout at other widths, themes, or languages remain
unverified, as does every platform and browser other than the one used.

## Known limitations

- **Git Bash and WSL Bash cannot be confined on Windows** under `read-only` or
  `workspace-write`, and are refused there rather than run unconfined. There is
  no setting that opts out of that refusal.
- **An unconfineable shell shows no version in the card** under a confining mode,
  because its probe is not allowed to run unconfined. The card says which of the
  two happened.
- **Windows sandbox enforcement is `partial`** by the harness's own rating.
- **Working-directory validation reads the local filesystem.** Its shape check
  runs for any platform; its existence check runs only when the execution
  platform is the one this process runs on. It is a typo guard, not a security
  boundary, and it never substitutes another directory.
- **A path typed under Automatic is not resolved until the selection is saved.**
  The card reports Automatic as unknown for that path rather than naming a shell
  nothing would run.
- **`cmd`'s non-ASCII output depends on the console code page.** The collector
  decodes UTF-8; cmd writes whatever code page its console carries. PowerShell
  avoids this through a .NET-level preamble, and cmd has no equivalent that does
  not mutate the console the child shares with the host. Unicode paths and
  filenames work.
- **The loopback restriction is on the plugin's own routes**, not on the tool.
- **The identity guard is a pairing check, not executable authentication.** A
  renamed binary that no entry names is accepted.
- **Some execution routes are outside the selector**: `run_code` program bodies,
  PTY-based terminal tools, and out-of-process subagents. See the route table in
  [architecture.md](architecture.md#execution-routes-covered-and-not-covered).
- **Shell selection is not destructive-command protection.** The sandbox
  restricts write-class access according to the session's permission mode; the
  plugin adds no destructive-command detection and should not be relied on as a
  safety layer.
