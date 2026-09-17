/**
 * The `ctx.shell` provider for a user-selected shell.
 *
 * The process mechanics — deadlines, bounded and spilled output, the background
 * process handle, process-tree termination — are inherited from the harness's
 * own local executor for the running platform: `@deepseek-ai/dsh-pwsh-local` on
 * Windows, `@deepseek-ai/dsh-bash-local` elsewhere. Those two are deliberate
 * mirrors, so one subclass body drives either. This class replaces exactly two
 * things: **which argv** is built, and **the gate** that refuses a call before
 * any process exists.
 *
 * The gate is asynchronous because finding an executable goes through
 * `ctx.subprocess.resolveExecutable`, the only resolution that is correct in a
 * remote execution world. `resolve()` therefore performs only the defaulting and
 * the per-call policy stamping that must happen synchronously; every refusal
 * lives in `run`/`start`, ahead of confinement and ahead of the spawn.
 *
 * @module dsh-shell-select/executor
 */

import z from '@deepseek-ai/schemastery'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import {
  SandboxUnavailableError,
  classifyRunnerFailure,
  isRunnerSpawnFailure,
  matchesSignature,
} from '@deepseek-ai/dsh-sandbox'
import { basename } from 'node:path'
import { buildInvocation, transportEnv } from './dialects.js'
import { AUTO_SHELL, catalogFor, checkConfinement, findEntry } from './catalog.js'
import { inspectCatalog, inspectShell, requireWorkingDirectory, resolveShell } from './discovery.js'

/** Settings namespace owning the shell selection. */
export const SHELL_SELECT_NAMESPACE = 'shell-select'

/** Default SIGTERM→SIGKILL grace period; mirrors the local executors'. */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap; mirrors the local executors'. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Every shell id selectable on some platform; the settings schema accepts each. */
export const SELECTABLE_SHELL_IDS = Object.freeze(
  [...new Set(['windows', 'posix'].flatMap(platform => catalogFor(platform).map(entry => entry.id)))].sort(),
)

/**
 * Plugin configuration: the shell selection plus the local executor's own knobs.
 *
 * `shell` and `executable` are the selector. Everything below them is the budget
 * set the inherited executor already owns, carried here so one composition row
 * configures the whole executor.
 */
export const ShellSelectConfig = z.object({
  /** Which catalog entry every command runs through; `auto` follows the platform's default shell. */
  shell: z.union([AUTO_SHELL, ...SELECTABLE_SHELL_IDS]).default(AUTO_SHELL),
  /** Advertise `run_in_background` on the shell tool; disabled calls are also rejected. */
  enableRunInBackground: z.boolean().default(true),
  /**
   * Explicit shell executable. Wins over discovery for the selected entry; a
   * value that cannot be resolved is an error, never a cue to discover instead.
   */
  executable: z.string(),
  /**
   * Run a bash-family shell as a login shell. Off by default: a login shell
   * sources the user's profile scripts on every command.
   */
  loginShell: z.boolean().default(false),
  /** WSL distribution name; empty uses the distribution's default. */
  wslDistro: z.string(),
  /** Mount root the distribution maps Windows drives under. */
  wslMountRoot: z.string().default('/mnt'),
  /** Default working directory (inherited local-executor knob). */
  cwd: z.string(),
  /** Default foreground timeout in milliseconds. */
  timeoutMs: z.number().default(120_000),
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs: z.number().default(600_000),
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes: z.number().default(64_000),
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
  /** Grace period for kill escalation and inherited pipes. */
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  /** Explicit PowerShell executable; the inherited `shell.pwshPath` field. */
  pwshPath: z.string(),
})

/**
 * Refusal raised before any process exists, when the selected shell may not run
 * under the mode the caller resolved.
 *
 * A distinct type so the tool layer and the suites can assert the fail-closed
 * path rather than pattern-matching an error message.
 */
export class ShellSelectionRefusedError extends Error {
  /**
   * @param entry - the selected catalog entry.
   * @param mode - the sandbox mode the call resolved.
   * @param reason - the measured reason confinement is impossible.
   */
  constructor(entry, mode, reason) {
    super(
      `dsh-shell-select: refusing to run. The selected shell (${entry.label}) cannot be confined by the `
      + `sandbox on this platform, and this call resolved to "${mode}" mode. ${reason} `
      + 'Select a shell that supports confinement, switch this session to danger-full-access to run '
      + 'deliberately unconfined, or change the session mode. This plugin never falls back to another '
      + 'shell and never silently drops the sandbox.',
    )
    this.name = 'ShellSelectionRefusedError'
    this.shellId = entry.id
    this.mode = mode
  }
}

/** The local executor class this platform seats under the selector. */
const PLATFORM_BASE = process.platform === 'win32' ? PwshLocalExecutor : LocalBashExecutor

/** The platform word matching the local process, used before the seam answers. */
function localPlatform() {
  return process.platform === 'win32' ? 'windows' : 'posix'
}

/**
 * Shell executor over the harness's own local process machinery.
 *
 * Registered as `ctx.shell`. Tool calls pass the calling session's resolved
 * policy; lower-level callers fall back to the deployment policy.
 */
export class ShellSelectExecutor extends PLATFORM_BASE {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  /** Schema the loader validates the composition entry against. */
  static Config = ShellSelectConfig

  // Cordis hands services through a Proxy, so ECMAScript `#private` members
  // cannot be read from an instance method (a getter's `this` is the proxy, not
  // the instance). Internal state is therefore plain, documented fields.

  /**
   * The currently authoritative `shell-select` section: the live settings scope
   * once one is mounted, otherwise the composition entry.
   */
  shellSettings

  /**
   * Last known selection facts, for the synchronous surfaces — the model-facing
   * description and the tool's per-call metadata.
   *
   * Execution never reads this: the gate resolves afresh on every call, so a
   * stale entry can make the description briefly wrong but can never make a
   * command run through a shell the user did not select.
   */
  selection = { platform: localPlatform(), entry: undefined, pending: true }

  /**
   * Resolves once the first {@link ShellSelectExecutor.refreshSelection} settles.
   *
   * The constructor seeds a provisional selection so the label and syntax are
   * never empty, then refines it asynchronously because finding an executable
   * goes through the subprocess seam. Consumers that need the settled answer
   * rather than the provisional one await this.
   */
  ready = Promise.resolve()

  /** Per-process confinement facts retained until settlement, keyed by handle. */
  processFacts = new Map()

  /**
   * @param ctx - plugin context carrying subprocess, sandbox, and sandbox policy.
   * @param config - schema-validated composition entry.
   */
  constructor(ctx, config) {
    super(ctx, config)
    this.shellSettings = () => config
    // Seed the entry from the settings and the local platform so a first read
    // already knows the label, the syntax, and the confinement facts. Only the
    // resolved executable waits for the seam.
    this.selection = { platform: localPlatform(), entry: this.provisionalEntry(localPlatform()), pending: true }
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SHELL_SELECT_NAMESPACE, ShellSelectConfig, config, {
        setSource: (current) => { this.shellSettings = current },
        // The gate re-reads the seam's platform and the executable on every
        // call, so a change invalidates nothing but the cached description.
        onChange: () => { this.ready = this.refreshSelection() },
      })
    })
    this.ready = this.refreshSelection()
  }

  /**
   * The entry the settings name, read without touching the execution world.
   * @param platform - the platform to look the entry up on.
   * @returns the entry, or undefined when the settings name one this platform lacks.
   */
  provisionalEntry(platform) {
    const requested = this.shellSettings().shell
    if (requested !== AUTO_SHELL) return findEntry(platform, requested)
    // `auto` cannot be answered synchronously: the platform's own default shell
    // comes from the seam. The first catalog entry is the provisional answer.
    return catalogFor(platform)[0]
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  get sandboxMode() {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /**
   * The current `shell-select` section: the live user layer resolved over the
   * composition entry and the schema defaults.
   */
  get selectSettings() {
    return this.shellSettings()
  }

  /** The platform word the execution world reports, defaulting to the local process. */
  get executionPlatform() {
    return this.selection.platform
  }

  /**
   * The configured executable override for an entry.
   *
   * The pre-existing `shell.pwshPath` setting keeps working for PowerShell
   * entries, so a user who already configured it does not configure the same
   * path twice.
   * @param entry - the catalog entry being resolved.
   * @returns the explicit path, or undefined for discovery.
   */
  configuredPathFor(entry) {
    const settings = this.selectSettings
    if (typeof settings.executable === 'string' && settings.executable.trim().length > 0) return settings.executable
    if (entry.dialect !== 'powershell') return undefined
    const inherited = settings.pwshPath
    return typeof inherited === 'string' && inherited.length > 0 ? inherited : undefined
  }

  /** Ask the execution world for its platform, falling back to the local process. */
  async executionPlatformNow() {
    try {
      const environment = await this.ctx.subprocess.terminalEnvironment()
      return environment.platform
    } catch {
      // A provider that cannot answer keeps the local process's platform, which
      // is the same answer the shipped local providers give.
      return localPlatform()
    }
  }

  /**
   * Resolve the selected catalog entry, following `auto` when the settings ask
   * for the platform's own default.
   *
   * `auto` reuses the harness's answer to "which shell belongs here":
   * `ctx.subprocess.terminalEnvironment().defaultShell` is `%ComSpec%` on
   * Windows and `$SHELL` on POSIX. When its basename names a catalog entry, that
   * entry wins; otherwise the first entry that actually resolves does.
   * @param platform - the execution platform.
   * @param signal - cancellation of the entry probes.
   * @returns the entry, or undefined when the settings name one this platform lacks.
   */
  async resolveEntry(platform, signal) {
    const requested = this.shellSettings().shell
    if (requested !== AUTO_SHELL) return findEntry(platform, requested)
    const entries = catalogFor(platform)
    let defaultShell
    try {
      defaultShell = (await this.ctx.subprocess.terminalEnvironment(signal)).defaultShell
    } catch {
      // A provider that cannot report a default leaves the resolution to the
      // availability walk below.
      defaultShell = undefined
    }
    if (typeof defaultShell === 'string' && defaultShell.length > 0) {
      const leaf = basename(defaultShell).toLowerCase()
      const named = entries.find(entry =>
        entry.candidates(process.env).some(candidate => basename(candidate).toLowerCase() === leaf))
      if (named !== undefined) return named
    }
    for (const entry of entries) {
      const inspection = await inspectShell(this.ctx, { entry, configuredPath: undefined, env: undefined, signal })
      if (inspection.available === true) return entry
    }
    return undefined
  }

  /**
   * Refresh the cached selection facts from the execution world.
   * @returns the refreshed cache entry.
   */
  async refreshSelection() {
    const settings = this.selectSettings
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, undefined)
    if (entry === undefined) {
      this.selection = {
        platform,
        detail: `no shell named ${JSON.stringify(settings.shell)} exists on ${platform}`,
      }
      return this.selection
    }
    const inspection = await inspectShell(this.ctx, {
      entry,
      configuredPath: this.configuredPathFor(entry),
      env: undefined,
    })
    this.selection = { platform, entry, ...inspection }
    return this.selection
  }

  /**
   * Describe the selection for the model-facing description and the tool's
   * per-call metadata. Synchronous, from the cache.
   * @returns the selected shell's identity, executable, syntax, and confinement facts.
   */
  describeShell() {
    const { platform, entry, available, path, detail, pending } = this.selection
    if (entry === undefined) {
      return { platform, available: false, detail: detail ?? 'no shell selected', syntax: '', confineable: false }
    }
    const capability = entry.confineable ?? { confined: true }
    return {
      platform,
      id: entry.id,
      label: entry.label,
      dialect: entry.dialect,
      available: available === true,
      // Absent means "not resolved yet", which is a different fact from
      // "resolved and unusable": the first is transient, the second is a refusal.
      ...available === true ? { executable: path } : available === false ? { detail } : { pending: pending === true },
      syntax: entry.syntax,
      confineable: capability.confined,
      ...capability.confined ? {} : { confineReason: capability.reason },
    }
  }

  /**
   * Re-read every catalog entry on the execution platform, for the status card.
   * @param options - optional environment for candidate enumeration.
   * @returns the fresh catalog rows.
   */
  async describeCatalog(options = {}) {
    const platform = await this.executionPlatformNow()
    const resolved = await this.resolveEntry(platform, undefined)
    return inspectCatalog(this.ctx, platform, {
      selectedId: resolved?.id,
      configuredPath: this.shellSettings().executable,
      env: options.env,
    })
  }

  /**
   * Resolve a request into a spec: the inherited defaulting, the per-call
   * sandbox policy, and the transport environment the chosen dialect needs.
   *
   * Deliberately free of refusals. Every check that can fail lives in `run` and
   * `start`, because finding an executable is asynchronous.
   * @param request - the caller's request.
   * @returns the spec to hand to `run`/`start`.
   */
  resolve(request) {
    const base = super.resolve(request)
    return { ...base, sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  /**
   * Refuse or clear one call, before confinement and before any process exists.
   *
   * Order is deliberate: the platform and the entry decide whether the request
   * is even expressible, confinement decides whether it may run, and only then
   * are the working directory and the executable resolved.
   * @param spec - the spec about to run.
   * @returns the entry, its resolved executable, and the platform.
   * @throws {ShellSelectionRefusedError} when the mode cannot be enforced for this shell.
   * @throws {Error} when the selection, the working directory, or the executable is unusable.
   */
  async gate(spec) {
    const settings = this.selectSettings
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, spec.signal)
    if (entry === undefined) {
      throw new Error(
        `dsh-shell-select: the selected shell ${JSON.stringify(settings.shell)} does not exist on ${platform}. `
        + `Available: ${catalogFor(platform).map(candidate => candidate.id).join(', ')}`,
      )
    }
    if (settings.loginShell === true && entry.dialect !== 'bash' && entry.dialect !== 'wsl') {
      throw new Error(
        `dsh-shell-select: "loginShell" applies to bash-family shells only; ${entry.label} uses the `
        + `${entry.dialect} dialect`,
      )
    }
    const policy = spec.sandboxPolicy
    if (policy === undefined) {
      throw new Error('dsh-shell-select: refusing to run without a resolved sandbox policy')
    }
    const confinement = checkConfinement(entry, policy.mode)
    if (!confinement.ok) throw new ShellSelectionRefusedError(entry, policy.mode, confinement.reason)
    requireWorkingDirectory(spec.workdir, platform)
    const resolved = await resolveShell(this.ctx, {
      entry,
      configuredPath: this.configuredPathFor(entry),
      env: undefined,
      signal: spec.signal,
    })
    this.selection = { platform, entry, available: true, path: resolved.path, source: resolved.source }
    // The gate stamps the transport environment because only it knows the
    // resolved entry, and `resolve()` cannot: choosing a shell may require
    // probing the execution world. Stamping here keeps one home for the fact.
    const transport = transportEnv(entry.dialect, spec.command)
    const stamped = transport === undefined ? spec : { ...spec, env: { ...spec.env, ...transport } }
    return { platform, entry, executable: resolved.path, spec: stamped }
  }

  /** Build one call's argv from the gate's answer. */
  invocationFor(spec, gated) {
    const settings = this.selectSettings
    return buildInvocation(gated.entry.dialect, {
      executable: gated.executable,
      command: spec.command,
      ...gated.entry.dialect === 'wsl' ? {
        windowsCwd: spec.workdir,
        mountRoot: settings.wslMountRoot,
        distro: settings.wslDistro,
      } : {},
      loginShell: settings.loginShell,
    })
  }

  /**
   * Run one command, confined unless the mode is `danger-full-access`.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}.
   * @returns the foreground result with its sandbox facts.
   */
  async run(spec) {
    const gated = await this.gate(spec)
    const { spec: gatedSpec, entry, executable } = gated
    const mode = gatedSpec.sandboxPolicy.mode
    const argv = this.invocationFor(gatedSpec, { entry, executable }).argv
    if (mode === 'danger-full-access') {
      const { result } = await this.runArgv(gatedSpec, argv)
      return { ...result, sandbox: { mode, denied: false } }
    }
    let confined
    let result
    let spawnRequested
    try {
      ({ result, spawnRequested } = await this.runArgv(gatedSpec, async (signal) => {
        const prepared = await this.ctx.sandbox.confine(argv, { ...gatedSpec.sandboxPolicy, mode }, signal)
        signal.throwIfAborted()
        confined = prepared
        return prepared.argv
      }))
    } catch (error) {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (gatedSpec.signal?.aborted === true) gatedSpec.signal.throwIfAborted()
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], gatedSpec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    if (!spawnRequested) return { ...result, sandbox: { mode, denied: false } }
    const facts = confined
    // Runner failure outranks denial because the command did not run.
    const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, facts.runnerFailureRules)
    if (runnerFailure !== undefined) throw new SandboxUnavailableError(mode, runnerFailure.detail)
    return {
      ...result,
      sandbox: {
        mode,
        denied: matchesSignature(result.exitCode, result.stderr.text, facts.denialSignatures),
        enforcement: facts.enforcement,
      },
    }
  }

  /**
   * Start one background command, confined unless the mode is `danger-full-access`.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}.
   * @returns the live process handle.
   */
  async start(spec) {
    const gated = await this.gate(spec)
    const { spec: gatedSpec, entry, executable } = gated
    const mode = gatedSpec.sandboxPolicy.mode
    const argv = this.invocationFor(gatedSpec, { entry, executable }).argv
    if (mode === 'danger-full-access') return this.startArgv(gatedSpec, argv)
    const confined = await this.ctx.sandbox.confine(argv, { ...gatedSpec.sandboxPolicy, mode }, gatedSpec.signal)
    gatedSpec.signal?.throwIfAborted()
    let proc
    try {
      proc = this.startArgv(gatedSpec, confined.argv)
    } catch (error) {
      if (isRunnerSpawnFailure(error, confined.argv[0], gatedSpec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    this.processFacts.set(proc, {
      mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: gatedSpec.workdir,
    })
    return proc
  }

  /**
   * Stamp per-process sandbox facts before `done` settles.
   * @param proc - the settled process handle.
   * @param stderr - the process's retained stderr tail.
   * @param providerRejected - whether the subprocess promise rejected without an outcome.
   * @param providerError - the provider rejection reason, which may itself be undefined.
   */
  onProcessDone(proc, stderr, providerRejected, providerError) {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }
}

export default ShellSelectExecutor
