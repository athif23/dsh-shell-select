/**
 * The `ctx.shell` provider for a user-selected shell.
 *
 * The process mechanics — deadlines, bounded and spilled output, the background
 * process handle, process-tree termination — are inherited from the harness's
 * own local executor for the running platform: `@deepseek-ai/dsh-pwsh-local` on
 * Windows, `@deepseek-ai/dsh-bash-local` elsewhere. Those two are deliberate
 * mirrors, so one subclass body drives either. This class replaces exactly two
 * things: **which argv** is built, and **the decision** that refuses a call
 * before any process exists.
 *
 * The decision is asynchronous because finding an executable goes through
 * `ctx.subprocess.resolveExecutable`, the only resolution that is correct in a
 * remote execution world. `resolve()` therefore performs only the defaulting and
 * the per-call policy stamping that must happen synchronously; every refusal
 * lives in {@link ShellSelectExecutor.decide}, ahead of confinement and ahead of
 * the spawn.
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
import { buildInvocation, transportEnv } from './dialects.js'
import { AUTO_SHELL, catalogFor, checkConfinement, entryClaiming, findEntry, programName } from './catalog.js'
import { inspectCatalog, inspectShell, requireWorkingDirectory, resolveShell } from './discovery.js'

/** Settings namespace owning the shell selection. */
export const SHELL_SELECT_NAMESPACE = 'shell-select'

/** Default SIGTERM→SIGKILL grace period; mirrors the local executors'. */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap; mirrors the local executors'. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Deadline for one plugin-owned version probe, in milliseconds. */
const PROBE_TIMEOUT_MS = 10_000

/** Per-stream cap for a probe's output: a version line is all it may return. */
const PROBE_MAX_BYTES = 8_192

/**
 * Symbol key under which a spawn-ready spec carries the decision it was built
 * from.
 *
 * Enumerable on purpose: the background path hands the spec on as
 * `{ ...spec, signal }`, and the spread has to carry the decision with it so
 * the job spawns exactly what was decided rather than deciding again.
 */
const DECIDED = Symbol('dsh-shell-select.decided')

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
 * One call's settings snapshot: the fields a call depends on, copied out of the
 * live settings section and frozen.
 *
 * Every step of one call — entry resolution, executable resolution, validation,
 * argv construction, launch options — reads this object rather than the live
 * section, so a settings write that lands while a call is being prepared changes
 * nothing about that call. The next call reads the next snapshot.
 * @param settings - the live `shell-select` section.
 * @returns the frozen snapshot.
 */
export function settingsSnapshot(settings) {
  const text = value => typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  return Object.freeze({
    shell: settings.shell,
    loginShell: settings.loginShell === true,
    executable: text(settings.executable),
    pwshPath: text(settings.pwshPath),
    wslDistro: text(settings.wslDistro),
    wslMountRoot: text(settings.wslMountRoot),
  })
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
   * description and the card's summary line.
   *
   * Owned by {@link ShellSelectExecutor.refreshSelection} alone: execution never
   * writes it and never reads it, so a stale entry can make the description
   * briefly wrong but can never make a command run through a shell the user did
   * not select, and can never make a result report one either.
   */
  selection = { platform: localPlatform(), entry: undefined, pending: true }

  /**
   * Id of the newest selection refresh. A refresh publishes only while it is
   * still the newest, so two overlapping refreshes cannot let an older, slower
   * answer overwrite a newer one.
   */
  selectionGeneration = 0

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
        // The next call reads the new section through a fresh snapshot; the
        // cached description and the card are refreshed from here.
        onChange: () => { this.ready = this.refreshSelection() },
      })
    })
    this.ready = this.refreshSelection()
  }

  /**
   * The entry the settings name, read without touching the execution world.
   * @param platform - the platform to look the entry up on.
   * @param settings - the settings snapshot to answer for.
   * @returns the entry, or undefined when the settings name one this platform lacks.
   */
  provisionalEntry(platform, settings = this.selectSettings) {
    const requested = settings.shell
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
   * The executable override in force for one entry.
   *
   * The pre-existing `shell.pwshPath` setting keeps working for PowerShell
   * entries, so a user who already configured it does not configure the same
   * path twice. The `executable` override names one shell — the selected one — so
   * it is applied to the selected entry and to no other row.
   * @param entry - the catalog entry being resolved.
   * @param settings - the settings snapshot in force.
   * @param selected - whether the entry is the one the settings select.
   * @returns the explicit path, or undefined for discovery.
   */
  overrideFor(entry, settings, selected) {
    if (selected && settings.executable !== undefined) return settings.executable
    if (entry.dialect !== 'powershell') return undefined
    return settings.pwshPath
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
   * The diagnostic for a selection that resolved to no catalog entry.
   *
   * A named shell that this platform lacks and an `auto` selection that found
   * nothing installed are different problems with different remedies, so they
   * get different sentences: telling a user that a shell named "auto" does not
   * exist on Windows describes the setting rather than the machine.
   * @param platform - the execution platform.
   * @param settings - the settings snapshot the answer is for.
   * @returns the message a refusal or the cached description reports.
   */
  unresolvedSelection(platform, settings = this.selectSettings) {
    const requested = settings.shell
    const known = catalogFor(platform).map(candidate => candidate.id).join(', ')
    if (requested === AUTO_SHELL) {
      return `no shell in the ${platform} catalog resolved in the execution environment `
        + `(tried: ${known}); set "shell" to one of them, or "executable" to an explicit path`
    }
    return `the selected shell ${JSON.stringify(requested)} does not exist on ${platform}. Available: ${known}`
  }

  /**
   * Resolve the selected catalog entry, following `auto` when the settings ask
   * for the platform's own default.
   *
   * `auto` must not change behavior for someone who installs this plugin onto a
   * working deployment, which is what fixes how it resolves:
   *
   * - On POSIX, `ctx.subprocess.terminalEnvironment().defaultShell` is the
   *   user's own login shell (`$SHELL`), a real preference, so a catalog entry
   *   matching its program name wins.
   * - On Windows the same field is `%ComSpec%`, which names the command
   *   interpreter rather than a preference — every Windows host reports
   *   `cmd.exe`. Preferring it would contradict the shell the harness's own
   *   Windows executor resolves (PowerShell) and would silently downgrade an
   *   existing deployment to cmd. Catalog order is the preference order there.
   *
   * Either way the first entry that actually resolves is the answer, so an
   * uninstalled preference is skipped rather than refused.
   * @param platform - the execution platform.
   * @param signal - cancellation of the entry probes.
   * @param settings - the settings snapshot this resolution answers for.
   * @returns the entry, or undefined when the settings name one this platform lacks.
   */
  async resolveEntry(platform, signal, settings = this.selectSettings) {
    const requested = settings.shell
    if (requested !== AUTO_SHELL) return findEntry(platform, requested)
    const entries = catalogFor(platform)

    // An explicit executable under `auto` names its own dialect: a user with
    // `/opt/custom/bash` means bash, not whichever row happens to lead the
    // catalog. Without this, `auto` plus an override would pair the override
    // with the wrong argument dialect.
    if (settings.executable !== undefined) {
      const claimed = entryClaiming(platform, programName(settings.executable))
      if (claimed !== undefined) return claimed
    }

    // POSIX only: there the execution world's `defaultShell` is the user's own
    // login shell (`$SHELL`), which is a real preference and wins — provided it
    // is installed, since an uninstalled preference must fall through to one
    // that works rather than produce an entry every call would refuse.
    //
    // On Windows the same field is `%ComSpec%`, which identifies the command
    // interpreter rather than a preference — every Windows host reports
    // cmd.exe. Preferring it would contradict the shell the harness itself
    // ships with (PowerShell), and would silently change behavior for anyone
    // installing this plugin onto a working deployment. There, catalog order is
    // the preference order, and the catalog puts PowerShell first because that
    // is what the harness's Windows executor resolves.
    if (platform === 'posix') {
      let defaultShell
      try {
        defaultShell = (await this.ctx.subprocess.terminalEnvironment(signal)).defaultShell
      } catch {
        // A provider that cannot report a default leaves the resolution to the
        // availability walk below.
        defaultShell = undefined
      }
      if (typeof defaultShell === 'string' && defaultShell.length > 0) {
        const preferred = entryClaiming(platform, programName(defaultShell))
        if (preferred !== undefined) {
          const inspection = await inspectShell(this.ctx, {
            entry: preferred, configuredPath: undefined, env: undefined, signal, platform,
          })
          if (inspection.available === true) return preferred
        }
      }
    }

    for (const entry of entries) {
      const inspection = await inspectShell(this.ctx, {
        entry, configuredPath: undefined, env: undefined, signal, platform,
      })
      if (inspection.available === true) return entry
    }
    return undefined
  }

  /**
   * Refresh the cached selection facts from the execution world.
   *
   * Overlapping refreshes are expected — a settings write during a first read,
   * or several writes in quick succession — so each call carries a generation
   * and only the newest publishes. An older refresh that settles later leaves
   * the newer facts in place instead of overwriting them.
   * @returns the published cache entry.
   */
  async refreshSelection() {
    const generation = ++this.selectionGeneration
    const settings = settingsSnapshot(this.selectSettings)
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, undefined, settings)
    const next = entry === undefined
      ? { platform, detail: this.unresolvedSelection(platform, settings) }
      : {
        platform,
        entry,
        ...await inspectShell(this.ctx, {
          entry,
          configuredPath: this.overrideFor(entry, settings, true),
          env: undefined,
          platform,
        }),
      }
    if (generation === this.selectionGeneration) this.selection = next
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
    const settings = settingsSnapshot(this.selectSettings)
    const selected = await this.resolveEntry(platform, undefined, settings)
    return inspectCatalog(this.ctx, platform, {
      selectedId: selected?.id,
      overrideFor: (entry, isSelected) => this.overrideFor(entry, settings, isSelected),
      env: options.env,
    })
  }

  /**
   * Resolve a request into a spec: the inherited defaulting, the per-call
   * sandbox policy, and the transport environment the chosen dialect needs.
   *
   * Deliberately free of refusals. Every check that can fail lives in
   * {@link ShellSelectExecutor.decide}, because finding an executable is
   * asynchronous.
   * @param request - the caller's request.
   * @returns the spec to hand to `decide`/`run`/`start`.
   */
  resolve(request) {
    const base = super.resolve(request)
    return { ...base, sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  /**
   * Decide one call, before confinement and before any process exists.
   *
   * Everything the call depends on is fixed here, from ONE settings snapshot:
   * the entry, the executable, the working-directory validation, the refusal for
   * an unenforceable mode, the launch options, and the argv. Callers that need
   * the facts before the process starts — the tool's per-call metadata — take
   * them from this decision, and `run`/`start` reuse the marked spec rather than
   * deciding again, so the facts and the process can never disagree.
   *
   * Order is deliberate: the platform and the entry decide whether the request
   * is even expressible, confinement decides whether it may run, and only then
   * are the working directory and the executable resolved.
   * @param spec - the spec about to run.
   * @returns the frozen decision and the spawn-ready spec carrying it.
   * @throws {ShellSelectionRefusedError} when the mode cannot be enforced for this shell.
   * @throws {Error} when the selection, the working directory, or the executable is unusable.
   */
  async decide(spec) {
    const settings = settingsSnapshot(this.selectSettings)
    const platform = await this.executionPlatformNow()
    const entry = await this.resolveEntry(platform, spec.signal, settings)
    if (entry === undefined) {
      throw new Error(`dsh-shell-select: ${this.unresolvedSelection(platform, settings)}`)
    }
    if (settings.loginShell && entry.dialect !== 'bash' && entry.dialect !== 'wsl') {
      throw new Error(
        `dsh-shell-select: "loginShell" applies to bash-family shells only; ${entry.label} uses the `
        + `${entry.dialect} dialect`,
      )
    }
    if (entry.dialect === 'wsl' && !String(settings.wslMountRoot ?? '').startsWith('/')) {
      throw new Error(
        'dsh-shell-select: "wslMountRoot" must be an absolute Linux path, got '
        + `${JSON.stringify(settings.wslMountRoot ?? null)}`,
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
      configuredPath: this.overrideFor(entry, settings, true),
      env: undefined,
      signal: spec.signal,
      platform,
    })
    const argv = buildInvocation(entry.dialect, {
      executable: resolved.path,
      command: spec.command,
      ...entry.dialect === 'wsl' ? {
        windowsCwd: spec.workdir,
        mountRoot: settings.wslMountRoot,
        distro: settings.wslDistro,
      } : {},
      loginShell: settings.loginShell,
    }).argv
    // The decision stamps the transport environment because only it knows the
    // resolved entry, and `resolve()` cannot: choosing a shell may require
    // probing the execution world. Stamping here keeps one home for the fact.
    const transport = transportEnv(entry.dialect, spec.command)
    const spawnSpec = transport === undefined ? spec : { ...spec, env: { ...spec.env, ...transport } }
    const capability = entry.confineable ?? { confined: true }
    const decision = Object.freeze({
      platform,
      entry,
      executable: resolved.path,
      source: resolved.source,
      argv,
      settings,
      shell: Object.freeze({
        id: entry.id,
        label: entry.label,
        dialect: entry.dialect,
        platform,
        executable: resolved.path,
        source: resolved.source,
        workdir: spec.workdir,
        loginShell: settings.loginShell,
        confineable: capability.confined,
      }),
    })
    return { decision, spec: { ...spawnSpec, [DECIDED]: decision } }
  }

  /**
   * The decision a spec carries, or a fresh one when it carries none.
   *
   * `run`/`start` are reachable without a prior `decide` — another caller may
   * hold only the seam's `resolve` — so both go through here. A spec that
   * already carries a decision is used exactly as decided: a settings write
   * between the decision and the spawn changes the next call, not this one.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}, decided or not.
   * @returns the decision and the spawn-ready spec.
   */
  async decideFor(spec) {
    const carried = spec[DECIDED]
    return carried === undefined ? await this.decide(spec) : { decision: carried, spec }
  }

  /**
   * Run one command, confined unless the mode is `danger-full-access`.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}.
   * @returns the foreground result with its sandbox facts.
   */
  async run(spec) {
    const { decision, spec: decidedSpec } = await this.decideFor(spec)
    const mode = decidedSpec.sandboxPolicy.mode
    if (mode === 'danger-full-access') {
      const { result } = await this.runArgv(decidedSpec, decision.argv)
      return { ...result, sandbox: { mode, denied: false } }
    }
    let confined
    let result
    let spawnRequested
    try {
      ({ result, spawnRequested } = await this.runArgv(decidedSpec, async (signal) => {
        const prepared = await this.ctx.sandbox.confine(decision.argv, { ...decidedSpec.sandboxPolicy, mode }, signal)
        signal.throwIfAborted()
        confined = prepared
        return prepared.argv
      }))
    } catch (error) {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (decidedSpec.signal?.aborted === true) decidedSpec.signal.throwIfAborted()
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], decidedSpec.workdir)) {
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
   * Run one plugin-owned argv — a version probe — for the settings card.
   *
   * The probe is not special-cased past the sandbox: it goes through the same
   * `ctx.sandbox.confine` an ordinary command does, under the deployment's own
   * resolved policy, and when the mode cannot confine the executable it is
   * refused and reported rather than started unconfined. That keeps a
   * configurable executable path from becoming an unrestricted execution
   * channel just because the arguments are fixed.
   *
   * `danger-full-access` is the one case with no confinement to apply, exactly
   * as for an ordinary command: the user chose unconfined execution for this
   * deployment.
   * @param argv - the fixed argv to run; never carries caller or model input.
   * @param signal - cancellation for the probe.
   * @returns the settled facts: the exit status, the output, and what was observed.
   */
  async runProbe(argv, signal) {
    const platform = await this.executionPlatformNow()
    const policy = this.ctx.sandboxPolicy.resolve()
    // The sandbox grants access to the policy's workspace, so that is where a
    // probe runs. A workspace that does not exist is reported, never replaced
    // with another directory.
    let workdir
    try {
      workdir = requireWorkingDirectory(policy.workspaceRoot, platform)
    } catch (error) {
      return { started: false, detail: `probe not run: ${error instanceof Error ? error.message : String(error)}` }
    }
    const probeSpec = this.resolve({
      command: '',
      workdir,
      timeoutMs: PROBE_TIMEOUT_MS,
      stdoutMaxBytes: PROBE_MAX_BYTES,
      ...signal === undefined ? {} : { signal },
    })
    let result
    let spawnRequested
    let confined
    try {
      if (policy.mode === 'danger-full-access') {
        ({ result, spawnRequested } = await this.runArgv(probeSpec, argv))
      } else {
        ({ result, spawnRequested } = await this.runArgv(probeSpec, async (innerSignal) => {
          const prepared = await this.ctx.sandbox.confine(argv, policy, innerSignal)
          innerSignal.throwIfAborted()
          confined = prepared
          return prepared.argv
        }))
      }
    } catch (error) {
      // fail closed: a probe the policy cannot confine is reported, not run.
      return {
        started: false,
        mode: policy.mode,
        detail: error instanceof Error ? error.message : String(error),
        ...error instanceof SandboxUnavailableError ? { refused: true } : {},
      }
    }
    if (!spawnRequested) {
      return { started: false, mode: policy.mode, detail: `the probe timed out after ${PROBE_TIMEOUT_MS} ms` }
    }
    const facts = confined
    if (facts !== undefined) {
      const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, facts.runnerFailureRules)
      if (runnerFailure !== undefined) {
        return {
          started: true,
          mode: policy.mode,
          runnerFailed: true,
          enforcement: facts.enforcement,
          detail: runnerFailure.detail,
        }
      }
    }
    return {
      started: true,
      mode: policy.mode,
      exitCode: result.exitCode,
      stdout: result.stdout.text.replace(/\0/gu, ''),
      stderr: result.stderr.text.replace(/\0/gu, ''),
      ...facts === undefined ? {} : {
        enforcement: facts.enforcement,
        denied: matchesSignature(result.exitCode, result.stderr.text, facts.denialSignatures),
      },
      ...result.timedOut ? { timedOut: true } : {},
    }
  }

  /**
   * Start one background command, confined unless the mode is `danger-full-access`.
   * @param spec - a spec from {@link ShellSelectExecutor.resolve}, decided or not.
   * @returns the live process handle.
   */
  async start(spec) {
    const { decision, spec: decidedSpec } = await this.decideFor(spec)
    const mode = decidedSpec.sandboxPolicy.mode
    if (mode === 'danger-full-access') return this.startArgv(decidedSpec, decision.argv)
    const confined = await this.ctx.sandbox.confine(
      decision.argv,
      { ...decidedSpec.sandboxPolicy, mode },
      decidedSpec.signal,
    )
    decidedSpec.signal?.throwIfAborted()
    let proc
    try {
      proc = this.startArgv(decidedSpec, confined.argv)
    } catch (error) {
      if (isRunnerSpawnFailure(error, confined.argv[0], decidedSpec.workdir)) {
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
      workdir: decidedSpec.workdir,
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
