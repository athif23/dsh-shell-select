/**
 * The selectable shells, per execution platform.
 *
 * Two rules shape this module:
 *
 * 1. **The catalog names shells, it does not name paths.** Every entry lists the
 *    names (and, where an install root must be inferred, the derived absolute
 *    candidates) to hand to `ctx.subprocess.resolveExecutable`, which is the
 *    harness's own absolute-path/PATH/`PATHEXT` resolution and also the only one
 *    that works in a remote execution world. The one exception is PowerShell's
 *    well-known install locations, which are taken from the harness's own
 *    exported `candidatePwshPaths` rather than restated here.
 * 2. **The platform is an input, not a branch.** Every function takes
 *    `'windows' | 'posix'`, so the catalog for either platform can be exercised
 *    from either platform and the shared logic stays testable. Windows path text
 *    is built with `win32.join`, never `node:path`'s host-dependent `join`: the
 *    Windows catalog has to be the same catalog on every machine that asks for
 *    it, and `D:\Git/bin/bash.exe` is not a Windows path.
 *
 * @module dsh-shell-select/catalog
 */

import { candidatePwshPaths } from '@deepseek-ai/dsh-pwsh-local'
import { win32 } from 'node:path'

/**
 * The program name in a path, for either platform's separators.
 *
 * `node:path`'s own `basename` splits on the separators of the platform it runs
 * on, and a resolved path can come from a remote execution world whose
 * separators differ from the local process's.
 * @param candidate - a path or bare command name.
 * @returns its last path segment.
 */
export function programName(candidate) {
  return candidate.split(/[\\/]/u).pop() ?? candidate
}

/**
 * The platform this process runs on.
 *
 * The catalog, the working-directory rule, and the executor all need this one
 * fact, and a rule keyed to the host platform has to be the same platform
 * everywhere it is asked about.
 * @returns `'windows'` or `'posix'`.
 */
export function localPlatform() {
  return process.platform === 'win32' ? 'windows' : 'posix'
}

/** Execution-world platform words, as `ctx.subprocess.terminalEnvironment` reports them. */
export const PLATFORMS = Object.freeze(['windows', 'posix'])

/**
 * The settings value meaning "use this platform's default shell".
 *
 * It exists so the schema carries no platform-specific default: a stored
 * `shell` value that named `bash` would be wrong on Windows and a stored `cmd`
 * wrong everywhere else, and a settings document is shared across platforms.
 */
export const AUTO_SHELL = 'auto'

/** Model-facing syntax note shared by every bash-family entry. */
const POSIX_SHELL_SYNTAX =
  'POSIX shell syntax. Paths are POSIX paths (/home/you/project). '
  + '`$NAME` reads environment variables; `|`, `>`, `&&` and `&` chain and redirect. '
  + 'Each call is a fresh non-interactive process: no cd, variable, or function persists between calls. '

/**
 * Read one environment variable as a string.
 * @param env - environment to read.
 * @param name - variable name.
 * @returns the value, or undefined when absent or empty.
 */
function envValue(env, name) {
  const value = env?.[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * PATH entries, quotes stripped, empties removed.
 * @param env - environment to read.
 * @returns the entries in PATH order.
 */
function pathEntries(env) {
  return (envValue(env, 'PATH') ?? '').split(process.platform === 'win32' ? ';' : ':')
    .map(entry => entry.trim().replace(/^"|"$/gu, ''))
    .filter(entry => entry.length > 0)
}

/**
 * Git for Windows install roots inferred from PATH.
 *
 * A PATH entry inside a Git install (`D:\Git\cmd`, `C:\Program Files\Git\mingw64\bin`)
 * identifies the root that holds `bin\bash.exe` and `usr\bin\bash.exe`. No fixed
 * drive or directory name is assumed, so a portable or relocated Git is found.
 * @param env - environment to read.
 * @returns candidate roots, most specific first.
 */
function gitRootsFromPath(env) {
  const roots = []
  const seen = new Set()
  const push = root => {
    const key = root.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    roots.push(root)
  }
  for (const entry of pathEntries(env)) {
    const marker = entry.toLowerCase().lastIndexOf('\\git\\')
    if (marker >= 0) push(entry.slice(0, marker + 4))
  }
  // A `git.exe` on PATH names its own install root even when the entry layout
  // is unusual (`mingw64\bin`, `cmd`, a shim directory).
  for (const entry of pathEntries(env)) {
    const lower = entry.toLowerCase()
    if (lower.endsWith('\\mingw64\\bin') || lower.endsWith('\\cmd') || lower.endsWith('\\bin')) {
      push(entry.replace(/\\(mingw64|cmd|bin)$/iu, ''))
    }
  }
  return roots
}

/**
 * Bash candidates on Windows, in probe order.
 *
 * `System32\bash.exe` is the WSL launcher and `WindowsApps` holds Store shims;
 * neither is Git Bash, so both are excluded from the PATH scan. The bare name
 * is probed last, and the entry's `accept` guard rejects those two locations
 * wherever they appear.
 * @param env - environment to read.
 * @returns candidate paths.
 */
function gitBashCandidates(env) {
  const candidates = []
  for (const root of gitRootsFromPath(env)) {
    candidates.push(win32.join(root, 'bin', 'bash.exe'))
    candidates.push(win32.join(root, 'usr', 'bin', 'bash.exe'))
  }
  for (const entry of pathEntries(env)) {
    const lower = entry.toLowerCase()
    if (lower.includes('system32') || lower.includes('windowsapps')) continue
    candidates.push(win32.join(entry, 'bash.exe'))
  }
  candidates.push('bash.exe')
  return candidates
}

/**
 * PowerShell candidates from the harness's own well-known list.
 *
 * The harness builds that list with `node:path.join`, so on a POSIX host it
 * arrives with POSIX separators inside Windows paths. The catalog normalizes
 * them back into Windows form: what it hands to `resolveExecutable` has to
 * describe the execution platform, not the host this code happens to run on.
 * @param env - environment to read.
 * @param pick - which part of the list this entry owns.
 * @returns candidate paths, in Windows form.
 */
function powershellCandidates(env, pick) {
  const known = candidatePwshPaths(env)
  const isWindowsPowershell = candidate => candidate.toLowerCase().includes('windowspowershell')
  return known
    .filter(candidate => pick === 'legacy' ? isWindowsPowershell(candidate) : !isWindowsPowershell(candidate))
    .map(candidate => win32.normalize(candidate))
}

/**
 * The per-platform catalogs.
 *
 * `names` is the entry's identity: the program names that mean *this* shell. It
 * is what {@link checkIdentity} uses to refuse a configured executable that
 * names a different entry, so an override given for one shell can never be
 * paired with another shell's launch arguments.
 *
 * `probe` overrides how the entry answers the card's version question. The
 * default is the dialect's own version query; an entry whose family has no
 * version flag declares its own harmless query instead.
 *
 * `confineable` states only what has been measured: the Windows ACL
 * restricted-token runner cannot start an MSYS2 shell or a WSL instance, so
 * those two entries carry a refusal reason. Everywhere else confinement wraps
 * argv and the shell binary is not a factor, so entries default to confineable.
 */
const ENTRIES = {
  windows: [
    {
      id: 'pwsh',
      label: 'PowerShell',
      dialect: 'powershell',
      names: ['pwsh.exe'],
      syntax: 'PowerShell syntax and native Windows paths (C:\\dir\\file). '
        + '`$env:NAME` reads environment variables; `|`, `>` and `;` chain and redirect. '
        + 'Runs with -NoProfile -NonInteractive: no profile script loads and no interactive state persists. ',
      candidates: env => powershellCandidates(env, 'current'),
      supportsLoginShell: false,
    },
    {
      id: 'powershell',
      label: 'Windows PowerShell 5.1',
      dialect: 'powershell',
      names: ['powershell.exe'],
      syntax: 'PowerShell syntax and native Windows paths (C:\\dir\\file). '
        + '`$env:NAME` reads environment variables. Windows PowerShell 5.1, the version shipped with Windows; '
        + 'runs with -NoProfile -NonInteractive. Non-ASCII output is pinned to UTF-8 by the launcher. ',
      candidates: env => powershellCandidates(env, 'legacy'),
      supportsLoginShell: false,
    },
    {
      id: 'cmd',
      label: 'Command Prompt (cmd.exe)',
      dialect: 'cmd',
      names: ['cmd.exe'],
      syntax: 'cmd.exe syntax and native Windows paths (C:\\dir\\file). '
        + 'Redirection uses `>`/`>>` and `&` chains commands; quote every path containing spaces. '
        + 'IMPORTANT: `%NAME%` is NOT expanded — the command reaches cmd in one pass, so write `call ...` '
        + 'when you need cmd to expand a variable, for example `call echo %CD%`. '
        + 'Runs as `cmd /d /q /c`: AutoRun is skipped and echo is off. ',
      candidates: env => [...new Set([envValue(env, 'ComSpec'), 'cmd.exe'].filter(value => value !== undefined))],
      supportsLoginShell: false,
    },
    {
      id: 'gitbash',
      label: 'Git Bash',
      dialect: 'bash',
      names: ['bash.exe'],
      syntax: 'Bash syntax with MSYS path translation: Windows drives appear as /c/..., /d/..., '
        + 'and the workspace is reached the same way. `$NAME` reads environment variables. '
        + 'Runs the real bash.exe, never the git-bash.exe GUI launcher. ',
      candidates: gitBashCandidates,
      supportsLoginShell: true,
      // The GUI launcher would open a window instead of running the command.
      accept: candidate => /(^|[\\/])bash\.exe$/iu.test(candidate)
        ? { ok: true }
        : { ok: false, detail: 'expected bash.exe, got ' + programName(candidate) },
      confineable: {
        confined: false,
        reason: 'MSYS2 bash cannot start under the Windows restricted token: its runtime aborts with '
          + '"fatal error - CreateFileMapping <sid>, Win32 error 5" (access denied) during shared-memory setup.',
      },
    },
    {
      id: 'wsl',
      label: 'WSL Bash',
      dialect: 'wsl',
      names: ['wsl.exe'],
      syntax: 'Linux Bash syntax and LINUX paths only — the Windows workspace is mounted at '
        + '/mnt/<drive>/... (for example D:\\work becomes /mnt/d/work). Windows-style paths (C:\\...) are '
        + 'NOT valid here. Runs inside the WSL distribution. ',
      candidates: env => {
        const systemRoot = envValue(env, 'SystemRoot')
        return [...new Set([
          'wsl.exe',
          ...systemRoot === undefined ? [] : [win32.join(systemRoot, 'System32', 'wsl.exe')],
        ])]
      },
      supportsLoginShell: true,
      supportsDistro: true,
      confineable: {
        confined: false,
        reason: 'the WSL service refuses to create an instance from a restricted token: '
          + '"Access is denied. Error code: Wsl/Service/CreateInstance/E_ACCESSDENIED".',
      },
    },
  ],
  // Catalog order is preference order: `auto` takes the first entry that
  // resolves. Bash leads because that is the shell the harness's own POSIX
  // executor runs, so `auto` reproduces the shipped behavior instead of picking
  // a different shell on a deployment that never asked to change one.
  posix: [
    {
      id: 'bash',
      label: 'Bash',
      dialect: 'bash',
      names: ['bash'],
      syntax: POSIX_SHELL_SYNTAX,
      candidates: () => ['bash'],
      supportsLoginShell: true,
      confineable: { confined: true },
    },
    {
      id: 'zsh',
      label: 'Zsh',
      dialect: 'bash',
      names: ['zsh'],
      syntax: POSIX_SHELL_SYNTAX,
      candidates: () => ['zsh'],
      supportsLoginShell: false,
      confineable: { confined: true },
    },
    {
      id: 'fish',
      label: 'Fish',
      dialect: 'bash',
      names: ['fish'],
      syntax: 'Fish syntax: it is NOT POSIX — `set NAME value` assigns a variable rather than `NAME=value`, '
        + 'and `$NAME` reads one. Pipes and redirection behave as in other shells. '
        + 'Each call is a fresh non-interactive process: no state persists between calls. ',
      candidates: () => ['fish'],
      supportsLoginShell: false,
      confineable: { confined: true },
    },
    {
      id: 'sh',
      label: 'POSIX sh',
      dialect: 'bash',
      names: ['sh', 'dash', 'ash'],
      syntax: POSIX_SHELL_SYNTAX + 'This is the system `sh`, which may be dash rather than bash; avoid bash-only syntax. ',
      candidates: () => ['sh'],
      supportsLoginShell: false,
      confineable: { confined: true },
      // `dash --version` is an illegal option (exit 2, message on stderr), so a
      // version query reports the failure rather than the shell. `$0` answers
      // with the implementation's own name, which is the useful fact here.
      probe: { kind: 'interpreter', argv: executable => [executable, '-c', 'echo "$0"'] },
    },
    {
      id: 'pwsh',
      label: 'PowerShell',
      dialect: 'powershell',
      names: ['pwsh'],
      syntax: 'PowerShell syntax and POSIX paths. `$env:NAME` reads environment variables; '
        + '`|`, `>` and `;` chain and redirect. Runs with -NoProfile -NonInteractive. ',
      candidates: () => ['pwsh'],
      supportsLoginShell: false,
      confineable: { confined: true },
    },
  ],
}

/**
 * Whether a confinement fact was measured on this platform.
 *
 * Only the Windows ACL backend has been exercised against these entries; the
 * POSIX rows are the harness's documented behavior for a wrapper-based sandbox
 * (bwrap, Landlock, Seatbelt confine any argv), not a measurement made here.
 */
export const VERIFIED_CONFINEMENT_PLATFORMS = Object.freeze(['windows'])

/**
 * The catalog for one platform.
 * @param platform - `'windows'` or `'posix'`.
 * @returns the entries, in presentation order.
 * @throws {Error} for an unknown platform.
 */
export function catalogFor(platform) {
  const entries = ENTRIES[platform]
  if (entries === undefined) throw new Error(`dsh-shell-select: unknown platform ${JSON.stringify(platform)}`)
  return entries
}

/**
 * Look one entry up by id.
 * @param platform - `'windows'` or `'posix'`.
 * @param id - the entry id a settings document selected.
 * @returns the entry, or undefined when this platform has no such shell.
 */
export function findEntry(platform, id) {
  return catalogFor(platform).find(entry => entry.id === id)
}

/**
 * Whether an entry may run under a mode, with the measured reason when it may not.
 *
 * `danger-full-access` runs unconfined by definition and is always allowed:
 * choosing it is the user's permission decision, never this plugin's.
 * @param entry - a catalog entry.
 * @param mode - the resolved sandbox mode for the call.
 * @returns the verdict and, when refused, why.
 */
export function checkConfinement(entry, mode) {
  if (mode === 'danger-full-access') return { ok: true, confined: false }
  const capability = entry.confineable ?? { confined: true }
  if (capability.confined) return { ok: true, confined: true }
  return { ok: false, confined: false, reason: capability.reason }
}

/**
 * The entry a program name identifies on a platform, when exactly one names it.
 * @param platform - `'windows'` or `'posix'`.
 * @param program - a bare program name, e.g. `bash.exe`.
 * @returns the claiming entry, or undefined when none or several claim it.
 */
export function entryClaiming(platform, program) {
  const leaf = program.toLowerCase()
  const claimed = catalogFor(platform).filter(entry => entry.names.some(name => name.toLowerCase() === leaf))
  return claimed.length === 1 ? claimed[0] : undefined
}

/**
 * The identity guard for a resolved executable.
 *
 * Two checks, in order:
 *
 * 1. A resolved path whose program name identifies a *different* catalog entry
 *    is refused. This is what stops an executable override configured for one
 *    shell from being reused with another shell's launch arguments — the pair
 *    (`cmd.exe`, `-c command`) cannot be produced by a stale override.
 * 2. The entry's own `accept`, where it declares one, which rejects a program of
 *    the right family but the wrong kind (Git for Windows' GUI launcher).
 *
 * A program name no entry claims is accepted: an override naming a shell this
 * catalog does not know is the user saying which shell their binary is, and
 * refusing it would break relocated or renamed installs without preventing any
 * wrong pairing.
 * @param entry - the catalog entry that asked for the executable.
 * @param resolved - the path the execution world resolved.
 * @param platform - `'windows'` or `'posix'`, selecting the sibling entries.
 * @returns the verdict, with a diagnostic when the path is the wrong program.
 */
export function checkIdentity(entry, resolved, platform) {
  const leaf = programName(resolved)
  const own = entry.names.some(name => name.toLowerCase() === leaf.toLowerCase())
  const claimed = entryClaiming(platform, leaf)
  if (!own && claimed !== undefined && claimed.id !== entry.id) {
    return {
      ok: false,
      detail: `expected ${entry.names.join(' or ')}, got ${leaf} — that is ${claimed.label}`,
    }
  }
  return entry.accept === undefined ? { ok: true } : entry.accept(resolved)
}

/**
 * The argument vector probing an entry's version, or its own identity where the
 * family has no version flag.
 * @param entry - a catalog entry.
 * @param executable - the resolved executable.
 * @param dialectDefault - the dialect's own version query.
 * @returns the argv to spawn and the kind of answer to expect.
 */
export function probeFor(entry, executable, dialectDefault) {
  if (entry.probe !== undefined) return { kind: entry.probe.kind, argv: entry.probe.argv(executable) }
  return { kind: 'version', argv: dialectDefault(entry.dialect, executable) }
}
