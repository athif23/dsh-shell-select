/**
 * Shared test support: isolated fixtures and service stubs.
 *
 * Fixture rule this file enforces: every disposable path lives under an approved
 * scratch root — `<projectRoot>/.test-tmp/<unique-id>/` by default, or
 * `DSH_SHELL_SELECT_TEST_TMP` when the project itself sits inside the real user
 * profile and that checkout therefore has no approved scratch of its own. A
 * fixture root inside the user profile is refused before anything is created,
 * and {@link removeFixture} refuses to delete anything outside the root it
 * validated, so a bug that computed a user path could not turn into a write or a
 * deletion there.
 *
 * Containment is decided on canonical paths: a symlinked `$HOME` or a `/tmp`
 * that resolves elsewhere must not be able to pass a lexical check.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { localPlatform } from '../src/catalog.js'

/** Absolute path of this project's root: the directory holding `package.json`. */
export function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * The environment variable naming an approved scratch root.
 *
 * It exists for the case the fixture rule cannot solve on its own: a checkout
 * that lives inside the real user profile (a CI runner, a clone in `$HOME`) has
 * no scratch directory outside that profile, so the location has to be named
 * explicitly rather than guessed.
 */
export const TEST_TMP_ENV = 'DSH_SHELL_SELECT_TEST_TMP'

/**
 * The real user profile directories no fixture may live under.
 *
 * Read, never assigned: these are the machine's own facts about where the user's
 * files are, and a test that wrote to one would be testing in the user's home.
 * @returns canonical profile roots, longest first.
 */
export function profileRoots() {
  const candidates = [process.env.USERPROFILE, process.env.HOME, homedir()]
  const roots = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    roots.add(canonicalize(candidate))
  }
  return [...roots].sort((left, right) => right.length - left.length)
}

/**
 * Canonicalize a path that may not exist yet.
 *
 * `realpathSync` answers only for paths that exist, so the longest existing
 * ancestor is resolved and the remaining segments are re-appended: that is what
 * makes the comparison immune to a symlinked profile or a symlinked scratch root
 * without requiring the fixture to exist first.
 * @param path - an absolute path, existing or not.
 * @returns its canonical form.
 */
export function canonicalize(path) {
  const absolute = resolve(path)
  const tail = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.unshift(parse(current).base)
      current = parent
    }
  }
}

/** Whether a path is one of the profile roots or inside one. */
function isInsideProfile(path) {
  const canonical = canonicalize(path)
  const separator = sep
  return profileRoots().some(root => canonical === root
    || canonical.toLowerCase().startsWith(`${root.toLowerCase()}${separator}`))
}

/**
 * Assert a directory is an approved place to create fixtures in.
 *
 * Refuses a location inside the real user profile, whether it came from the
 * default or from the environment: the rule is about the location, not about who
 * asked for it. It also refuses a root that exists as a file, which would
 * otherwise fail later as a confusing `mkdir`.
 * @param path - the proposed fixture root.
 * @returns the path, once it is allowed.
 * @throws {Error} when the root is inside the profile or is not a directory.
 */
export function assertApprovedFixtureRoot(path) {
  if (isInsideProfile(path)) {
    throw new Error(
      `test helpers: refusing to create fixtures in the user profile: ${path}. `
      + `This checkout has no approved scratch outside the profile, so name one with `
      + `${TEST_TMP_ENV}=<absolute path outside the profile> and run the suite again.`,
    )
  }
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`test helpers: the fixture root is not usable: ${path} (${error.message})`)
    }
  }
  return path
}

/**
 * The scratch root every disposable fixture lives under.
 *
 * `DSH_SHELL_SELECT_TEST_TMP` when set — an absolute path the user approved —
 * otherwise `<projectRoot>/.test-tmp`. Either way the result is validated against
 * the profile rule before it is used.
 * @returns the absolute fixture root.
 * @throws {Error} when the root is not absolute, or is inside the user profile.
 */
export function testTmpRoot() {
  const configured = process.env[TEST_TMP_ENV]
  if (configured === undefined || configured.length === 0) {
    return assertApprovedFixtureRoot(join(projectRoot(), '.test-tmp'))
  }
  if (!resolve(configured).startsWith(sep) && !/^[A-Za-z]:[\\/]/u.test(configured)) {
    throw new Error(`test helpers: ${TEST_TMP_ENV} must be an absolute path, got ${JSON.stringify(configured)}`)
  }
  return assertApprovedFixtureRoot(configured)
}

/**
 * Create one unique fixture directory.
 * @param label - short name included in the directory name for readability.
 * @returns the absolute fixture path.
 */
export function makeFixture(label) {
  const root = testTmpRoot()
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, `${label}-`))
}

/**
 * A working directory that is valid for a simulated execution platform.
 *
 * The executor validates the *shape* of a working directory for the execution
 * platform, and its *existence* only when that platform is this process's own —
 * a local `stat` cannot answer for another machine. So a suite that simulates the
 * other platform passes a path shaped for it, and a suite simulating this host
 * passes the real fixture directory, which is what exercises the existence rule.
 * @param platform - the platform the composition is being asked about.
 * @param hostWorkdir - a real directory of this host's own platform.
 * @returns a working directory valid for that platform on this host.
 */
export function workdirFor(platform, hostWorkdir) {
  if (platform === localPlatform()) return hostWorkdir
  return platform === 'windows' ? 'C:\\fixtures\\work' : '/fixtures/work'
}

/**
 * Delete one fixture directory, refusing anything outside its scratch root.
 *
 * A guard rather than a bare `rmSync`: a bug that passed a resolved user path
 * here would delete real files, so containment is decided on canonical paths
 * every time, and the profile rule is re-checked rather than assumed from
 * creation time.
 * @param path - the fixture directory to remove.
 */
export function removeFixture(path) {
  const containmentRoot = canonicalize(testTmpRoot()) + sep
  const resolved = canonicalize(path)
  if (!resolved.startsWith(containmentRoot) || isInsideProfile(resolved)) {
    throw new Error(`test helpers: refusing to remove ${resolved}, outside ${containmentRoot}`)
  }
  rmSync(resolved, { recursive: true, force: true })
}

/**
 * A stand-in for the deployment's SandboxPolicyService.
 *
 * The real service depends on `sessionProjections` and a session log, neither of
 * which is under test here; what matters to this plugin is only that
 * `defaultMode` exists and `resolve()` returns the configured policy.
 */
export class StubSandboxPolicy extends Service {
  /**
   * @param ctx - plugin context.
   * @param config - the mode and workspace root every resolution returns.
   */
  constructor(ctx, config) {
    super(ctx, 'sandboxPolicy')
    this.defaultMode = config.mode
    this.workspaceRoot = config.workspaceRoot
  }

  /** @returns the configured policy, optionally overridden per call. */
  resolve(request = {}) {
    return {
      mode: request.mode ?? this.defaultMode,
      workspaceRoot: this.workspaceRoot,
    }
  }

  /** @returns no session override: this stub keeps no session state. */
  overrideOf() {
    return undefined
  }
}

/** One recorded spawn request plus its scripted outcome. */
function makeHandle(spec, outcome, output) {
  const reader = text => ({
    readFrom: () => ({ text, nextOffset: text.length, lossy: false }),
  })
  return {
    spec,
    done: Promise.resolve(outcome),
    collected: { stdout: reader(output.stdout ?? ''), stderr: reader(output.stderr ?? '') },
    terminate() {},
  }
}

/**
 * A stand-in for the subprocess seam that answers resolution, platform, and
 * spawn from one scripted table.
 *
 * `resolveExecutable` mirrors the real provider's contract: a name it does not
 * know raises `SubprocessExecutableNotFoundError`, which is exactly what
 * discovery must treat as "try the next candidate". `delayMsFor` and
 * `onResolve` exist so a suite can make one resolution slower than another, or
 * change the world while a call is being prepared.
 * @param options - platform, default shell, resolvable names, spawn outcome,
 *   per-command resolution delay, and a hook run during resolution.
 * @returns the seam stand-in plus its recorded calls.
 */
export function stubSubprocess(options = {}) {
  const spawns = []
  const resolutions = []
  return {
    spawns,
    resolutions,
    /** Scripted name→path table; absolute paths resolve to themselves. */
    resolvable: options.resolvable ?? {},
    platform: options.platform ?? 'posix',
    defaultShell: options.defaultShell,
    async resolveExecutable(command, _env, _signal) {
      resolutions.push(command)
      options.onResolve?.(command, resolutions.length)
      const delay = options.delayMsFor?.(command, resolutions.length)
      if (delay !== undefined && delay > 0) {
        await new Promise(resolve => { setTimeout(resolve, delay) })
      }
      const known = this.resolvable[command]
      if (known !== undefined) return known
      // An absolute path is verified by the real provider; the stub accepts it
      // only when the scripted table says it exists.
      throw new SubprocessExecutableNotFoundError(
        `stub-subprocess: command ${JSON.stringify(command)} was not found`,
      )
    },
    async terminalEnvironment() {
      return {
        platform: this.platform,
        ...this.defaultShell === undefined ? {} : { defaultShell: this.defaultShell },
      }
    },
    spawn(spec) {
      spawns.push(spec)
      return makeHandle(spec, options.outcome ?? { exitCode: 0, signal: null }, options.output ?? {})
    },
    async waitForExit() { return true },
  }
}

/**
 * A stand-in for the sandbox provider that records what it was asked to confine.
 *
 * Returns the caller's argv unchanged, which is enough for the executor's
 * argv-construction assertions; real confinement behavior is exercised by the
 * integration suite against the shipped provider.
 * @param options - an optional `confine` replacing the pass-through, so a suite
 *   can script a runner failure or a refusal.
 * @returns the provider stand-in plus its recorded calls.
 */
export function stubSandbox(options = {}) {
  const calls = []
  return {
    calls,
    confine(argv, policy, signal) {
      calls.push({ argv: [...argv], policy })
      if (options.confine !== undefined) return options.confine(argv, policy, signal)
      return Promise.resolve({
        argv: [...argv],
        enforcement: 'partial',
        denialSignatures: ['access is denied'],
        runnerFailureRules: [],
      })
    },
  }
}

/**
 * Build a context with the stubs this plugin needs, without touching the host.
 * @param options - sandbox mode, workspace root, and the service stand-ins.
 * @returns the assembled context.
 */
export async function makeContext(options = {}) {
  const ctx = new Context()
  await ctx.plugin(StubSandboxPolicy, {
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
  })
  const subprocess = options.subprocess ?? stubSubprocess()
  const sandbox = options.sandbox ?? stubSandbox()
  await ctx.plugin({
    name: 'stub-runtime',
    apply(context) {
      context.provide('subprocess', subprocess)
      context.provide('sandbox', sandbox)
    },
  })
  return ctx
}
