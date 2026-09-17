/**
 * Finding and validating a shell executable, through the harness's own
 * resolution rather than through this plugin's filesystem calls.
 *
 * `ctx.subprocess.resolveExecutable(command)` is the harness's resolution
 * contract: an absolute path is verified as an executable file, a bare name is
 * looked up in the provider's scrubbed `PATH` (plus `PATHEXT` on Windows), and
 * the answer comes from the execution world that will actually run the command.
 * Using it rather than `node:fs` means a remote provider (SSH, a sandbox host)
 * resolves against its own filesystem, where a local probe would answer for the
 * wrong machine.
 *
 * Fail-closed rules, both deliberate:
 *
 * - an explicitly configured path that cannot be resolved is an **error**, never
 *   a cue to fall back to discovery;
 * - discovery that finds nothing raises, instead of yielding a bare name for
 *   something else to resolve later at spawn time.
 *
 * @module dsh-shell-select/discovery
 */

import { statSync } from 'node:fs'
import { posix } from 'node:path'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { catalogFor, checkIdentity } from './catalog.js'

/**
 * The absolute-path test each execution platform uses for a working directory.
 *
 * The Windows rule is a drive path or a UNC share rather than
 * `path.win32.isAbsolute`, which also accepts a root-relative `/tmp` whose drive
 * is whichever one the process happens to be on. A working directory has to name
 * one unambiguous place, so the narrower rule is the correct one.
 */
const ABSOLUTE_WORKDIR = {
  windows: path => /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\'),
  posix: path => posix.isAbsolute(path),
}

/**
 * Resolve one candidate through the execution world.
 * @param ctx - context carrying `subprocess`.
 * @param candidate - an absolute path or a bare PATH name.
 * @param env - explicit environment for the lookup.
 * @param signal - cancellation.
 * @returns the canonical path, or undefined when the candidate is absent.
 */
async function tryResolve(ctx, candidate, env, signal) {
  try {
    return await ctx.subprocess.resolveExecutable(candidate, env, signal)
  } catch (error) {
    // A missing candidate is the expected case while walking a probe list; any
    // other failure names a provider problem, so it propagates.
    if (error instanceof SubprocessExecutableNotFoundError) return undefined
    throw error
  }
}

/**
 * Resolve a shell entry's executable.
 *
 * A configured path is resolved on its own and validated for identity before
 * discovery is considered, so a wrong configured value fails by name.
 * @param ctx - context carrying `subprocess`.
 * @param options - platform, catalog entry, optional configured path, environment, cancellation.
 * @returns the resolved path and whether it was configured or discovered.
 * @throws {Error} when the configured path is unusable or nothing is discovered.
 */
export async function resolveShell(ctx, options) {
  const { entry, configuredPath, env, signal, platform } = options
  const configured = typeof configuredPath === 'string' && configuredPath.trim().length > 0
    ? configuredPath.trim()
    : undefined

  if (configured !== undefined) {
    const resolved = await tryResolve(ctx, configured, env, signal)
    if (resolved === undefined) {
      throw new Error(
        `dsh-shell-select: the configured executable for ${entry.label} is not an executable file `
        + `in the execution environment: ${configured}`,
      )
    }
    const identity = checkIdentity(entry, resolved, platform)
    if (!identity.ok) {
      throw new Error(
        `dsh-shell-select: the configured executable for ${entry.label} is not that shell — ${identity.detail}. `
        + 'Clear the "executable" override, or select the shell that path belongs to.',
      )
    }
    return { path: resolved, source: 'configured' }
  }

  const probed = []
  for (const candidate of entry.candidates(env)) {
    const resolved = await tryResolve(ctx, candidate, env, signal)
    if (resolved === undefined) {
      probed.push(candidate)
      continue
    }
    const identity = checkIdentity(entry, resolved, platform)
    probed.push(candidate)
    if (identity.ok) return { path: resolved, source: 'discovered' }
  }
  throw new Error(
    `dsh-shell-select: no ${entry.label} executable found in the execution environment; `
    + `set "executable" in the shell-select settings. Probed ${probed.length} `
    + `location${probed.length === 1 ? '' : 's'}: ${probed.join(', ')}`,
  )
}

/**
 * Resolve a shell entry without throwing, for status surfaces.
 * @param ctx - context carrying `subprocess`.
 * @param options - the same options {@link resolveShell} takes.
 * @returns the resolution, or the failure diagnostic.
 */
export async function inspectShell(ctx, options) {
  try {
    const resolved = await resolveShell(ctx, options)
    return { available: true, path: resolved.path, source: resolved.source }
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Verify a working directory exists before anything is spawned.
 *
 * Never substitutes another directory: falling back to the process cwd or a home
 * directory would run the command somewhere the caller did not ask for, which is
 * the failure this check exists to prevent.
 *
 * This reads the local filesystem, so it describes the local execution world.
 * The compositions this plugin ships for run their shell locally; a deployment
 * that seats `ctx.subprocess` on a remote provider should read the check as a
 * typo guard for the local path, not as a statement about the remote directory.
 * @param workdir - the resolved working directory.
 * @param platform - `'windows'` or `'posix'`, choosing the absolute-path rule.
 * @returns the validated path.
 * @throws {Error} when the path is missing, not a directory, or not absolute.
 */
export function requireWorkingDirectory(workdir, platform) {
  if (typeof workdir !== 'string' || workdir.length === 0) {
    throw new Error('dsh-shell-select: refusing to run without a working directory')
  }
  const isAbsolute = ABSOLUTE_WORKDIR[platform]
  if (isAbsolute === undefined) throw new Error(`dsh-shell-select: unknown platform ${JSON.stringify(platform)}`)
  if (!isAbsolute(workdir)) {
    throw new Error(
      `dsh-shell-select: the working directory must be an absolute ${platform} path, got ${JSON.stringify(workdir)}`,
    )
  }
  let stat
  try {
    stat = statSync(workdir)
  } catch {
    throw new Error(`dsh-shell-select: the working directory does not exist: ${workdir}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`dsh-shell-select: the working directory is not a directory: ${workdir}`)
  }
  return workdir
}

/**
 * One status row per catalog entry on a platform.
 *
 * Each row resolves through the *same* override rule execution uses, so what the
 * card reports as the effective executable is what a command would run. An
 * override that names one shell is applied to that shell's row only, because
 * applying it to every row would report the same file as five different shells.
 * @param ctx - context carrying `subprocess`.
 * @param platform - `'windows'` or `'posix'`.
 * @param options - the selected entry id, the override rule, and the environment.
 * @returns the rows, in catalog order.
 */
export async function inspectCatalog(ctx, platform, options) {
  const rows = []
  for (const entry of catalogFor(platform)) {
    const selected = entry.id === options.selectedId
    const inspection = await inspectShell(ctx, {
      entry,
      configuredPath: options.overrideFor(entry, selected),
      env: options.env,
      platform,
    })
    rows.push({
      id: entry.id,
      label: entry.label,
      dialect: entry.dialect,
      selected,
      ...inspection,
      confineable: (entry.confineable ?? { confined: true }).confined,
      ...(entry.confineable?.confined === false ? { confineReason: entry.confineable.reason } : {}),
      supportsLoginShell: entry.supportsLoginShell === true,
      supportsDistro: entry.supportsDistro === true,
      syntax: entry.syntax,
    })
  }
  return rows
}
