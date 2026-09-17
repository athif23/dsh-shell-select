/**
 * Shared test support: isolated fixtures and service stubs.
 *
 * Fixture rule this file enforces: every disposable path lives under
 * `<projectRoot>/.test-tmp/<unique-id>/`, where the project root is this
 * package's own directory — never a parent, never a home directory, never
 * anywhere the suites did not create. {@link removeFixture} refuses to delete
 * anything outside that tree, so a bug that computed a user path could not turn
 * into a deletion.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'

/** Absolute path of this project's root: the directory holding `package.json`. */
export function projectRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** The `.test-tmp` root every disposable fixture lives under. */
export function testTmpRoot() {
  return join(projectRoot(), '.test-tmp')
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
 * Delete one fixture directory, refusing anything outside `.test-tmp`.
 *
 * A guard rather than a bare `rmSync`: a bug that passed a resolved user path
 * here would delete real files, so the containment check runs on the resolved
 * path every time.
 * @param path - the fixture directory to remove.
 */
export function removeFixture(path) {
  const resolved = resolve(path)
  const containmentRoot = resolve(testTmpRoot()) + sep
  if (!resolved.startsWith(containmentRoot)) {
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
