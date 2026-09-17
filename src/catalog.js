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
 *    from either platform and the shared logic stays testable.
 *
 * @module dsh-shell-select/catalog
 */

import { candidatePwshPaths } from '@deepseek-ai/dsh-pwsh-local'
import { join } from 'node:path'

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
    candidates.push(join(root, 'bin', 'bash.exe'))
    candidates.push(join(root, 'usr', 'bin', 'bash.exe'))
  }
  for (const entry of pathEntries(env)) {
    const lower = entry.toLowerCase()
    if (lower.includes('system32') || lower.includes('windowsapps')) continue
    candidates.push(join(entry, 'bash.exe'))
  }
  candidates.push('bash.exe')
  return candidates
}

/**
 * PowerShell candidates from the harness's own well-known list.
 * @param env - environment to read.
 * @param pick - which part of the list this entry owns.
 * @returns candidate paths.
 */
function powershellCandidates(env, pick) {
  const known = candidatePwshPaths(env)
  const isWindowsPowershell = candidate => candidate.toLowerCase().includes('windowspowershell')
  return known.filter(candidate => pick === 'legacy' ? isWindowsPowershell(candidate) : !isWindowsPowershell(candidate))
}

/**
 * The per-platform catalogs.
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
      syntax: 'Bash syntax with MSYS path translation: Windows drives appear as /c/..., /d/..., '
        + 'and the workspace is reached the same way. `$NAME` reads environment variables. '
        + 'Runs the real bash.exe, never the git-bash.exe GUI launcher. ',
      candidates: gitBashCandidates,
      supportsLoginShell: true,
      // The GUI launcher would open a window instead of running the command.
      accept: candidate => /(^|[\\/])bash\.exe$/iu.test(candidate)
        ? { ok: true }
        : { ok: false, detail: 'expected bash.exe, got ' + candidate.split(/[\\/]/u).pop() },
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
      syntax: 'Linux Bash syntax and LINUX paths only — the Windows workspace is mounted at '
        + '/mnt/<drive>/... (for example D:\\work becomes /mnt/d/work). Windows-style paths (C:\\...) are '
        + 'NOT valid here. Runs inside the WSL distribution. ',
      candidates: env => {
        const systemRoot = envValue(env, 'SystemRoot')
        return [...new Set([
          'wsl.exe',
          ...systemRoot === undefined ? [] : [join(systemRoot, 'System32', 'wsl.exe')],
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
      syntax: POSIX_SHELL_SYNTAX,
      candidates: () => ['bash'],
      supportsLoginShell: true,
      confineable: { confined: true },
    },
    {
      id: 'zsh',
      label: 'Zsh',
      dialect: 'bash',
      syntax: POSIX_SHELL_SYNTAX,
      candidates: () => ['zsh'],
      supportsLoginShell: false,
      confineable: { confined: true },
    },
    {
      id: 'fish',
      label: 'Fish',
      dialect: 'bash',
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
      syntax: POSIX_SHELL_SYNTAX + 'This is the system `sh`, which may be dash rather than bash; avoid bash-only syntax. ',
      candidates: () => ['sh'],
      supportsLoginShell: false,
      confineable: { confined: true },
    },
    {
      id: 'pwsh',
      label: 'PowerShell',
      dialect: 'powershell',
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
 * The identity guard for a resolved executable, when the entry declares one.
 * @param entry - a catalog entry.
 * @param resolved - the path the execution world resolved.
 * @returns the verdict, with a diagnostic when the path is the wrong program.
 */
export function checkIdentity(entry, resolved) {
  return entry.accept === undefined ? { ok: true } : entry.accept(resolved)
}
