/**
 * Status facts and the settings card's HTTP surface.
 *
 * The card needs facts the settings document cannot hold, because they describe
 * the machine rather than the user's choice: which shells resolve to which
 * executable, what version each reports, and whether the selected one can run
 * under the session's permission mode. Those are computed here and served over
 * two read-only routes.
 *
 * **Probes run fixed, plugin-owned argv, under the deployment's own confinement.**
 * {@link ./dialects.js} supplies the arguments and {@link ShellSelectExecutor.runProbe}
 * spawns them through the same `ctx.sandbox.confine` an ordinary command goes
 * through, so a configurable executable path cannot become an unrestricted
 * execution channel merely because the arguments are fixed. A row whose mode
 * cannot confine it is reported as not probed rather than started unconfined.
 *
 * Three facts are kept apart on purpose, because collapsing them is how a
 * settings card ends up claiming safety it has not observed:
 *
 * - `available` — the executable resolves at all;
 * - `confineable` — what the catalog expects the sandbox to be able to do with
 *   it on this platform, which is a claim, not a measurement;
 * - `confinement.observed` — what this machine actually did when the plugin
 *   asked the sandbox to run it.
 *
 * @module dsh-shell-select/status
 */

import { catalogFor, probeFor } from './catalog.js'
import { versionArgv, testCommand } from './dialects.js'
import { VERIFIED_CONFINEMENT_PLATFORMS } from './catalog.js'
import { ShellSelectionRefusedError } from './executor.js'

/** Route prefix both endpoints live under. */
export const STATUS_ROUTE_PREFIX = '/dsh-shell-select'

/** Deadline for one read-only version probe. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * Whether a request arrived over the loopback interface.
 *
 * Both routes are unauthenticated like every other host route, so they are kept
 * to the machine they describe. A deployment bound to `0.0.0.0` would otherwise
 * let any peer enumerate local shell paths.
 * @param req - the incoming request.
 * @returns whether the peer is this machine.
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response. */
function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * The first non-empty line of a probe's combined output.
 * @param probe - a settled probe.
 * @returns the line, or undefined when the probe printed nothing.
 */
function firstLine(probe) {
  return `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0)
}

/**
 * Turn one probe outcome into a row's reported facts.
 *
 * A non-zero exit is a failure even when the probe printed something: `dash`
 * answers `--version` with "Illegal option" on stderr and exit 2, and reporting
 * that as a version would describe the plugin's mistake as the shell's version.
 * @param probe - the outcome from {@link ShellSelectExecutor.runProbe}.
 * @param kind - `'version'` or `'interpreter'`, the answer the entry asked for.
 * @returns the reported fields: one of `version`, `interpreter`, or `versionError`,
 *   plus what the machine was observed to do.
 */
function probeFacts(probe, kind) {
  if (probe.started !== true) {
    return {
      versionError: probe.detail ?? 'the probe did not run',
      observed: probe.refused === true ? 'refused' : 'not-run',
    }
  }
  if (probe.runnerFailed === true) {
    return {
      versionError: `the sandbox runner could not start this shell: ${probe.detail}`,
      observed: 'runner-failed',
    }
  }
  // A confined run reports its enforcement; an unconfined one reports nothing.
  const observed = probe.denied === undefined && probe.enforcement === undefined ? 'ran-unconfined' : 'confirmed'
  if (probe.timedOut === true) {
    return { versionError: `the probe timed out after ${PROBE_TIMEOUT_MS} ms`, observed }
  }
  const line = firstLine(probe)
  if (probe.exitCode !== 0) {
    return {
      versionError: `exited with code ${String(probe.exitCode)}${line === undefined ? '' : `: ${line}`}`,
      observed,
    }
  }
  if (line === undefined) return { versionError: 'no output', observed }
  return { [kind === 'interpreter' ? 'interpreter' : 'version']: line, observed }
}

/**
 * Probe one resolvable row under the session's confinement.
 * @param executor - the mounted shell-select executor.
 * @param entry - the catalog entry behind the row, which owns the probe query.
 * @param row - the catalog row to probe.
 * @param policy - the resolved sandbox policy.
 * @param signal - cancellation for all probes.
 * @returns the row's probe facts.
 */
async function probeRow(executor, entry, row, policy, signal) {
  if (!row.confineable && policy.mode !== 'danger-full-access') {
    return {
      versionError: `not probed: ${row.label} cannot be confined under "${policy.mode}", `
        + 'and this plugin never runs a probe unconfined',
      observed: 'not-probed',
    }
  }
  const probe = probeFor(entry, row.path, versionArgv)
  return probeFacts(await executor.runProbe(probe.argv, signal), probe.kind)
}

/**
 * Assemble the card's status payload.
 * @param ctx - context carrying subprocess, sandbox policy, and the executor.
 * @param executor - the mounted shell-select executor.
 * @returns the selected shell, the resolved mode, and one row per catalog entry.
 */
export async function buildStatus(ctx, executor) {
  const platform = await executor.executionPlatformNow()
  const policy = ctx.sandboxPolicy.resolve()
  const rows = await executor.describeCatalog()
  const entries = new Map(catalogFor(platform).map(entry => [entry.id, entry]))
  const platformVerified = VERIFIED_CONFINEMENT_PLATFORMS.includes(platform)
  // Probes run in parallel: each is an independent short-lived process, and the
  // card is opened on demand rather than in any hot path.
  const probed = await Promise.all(rows.map(async row => {
    // Facts the card must not conflate: whether the binary runs at all, whether
    // the catalog expects the sandbox to be able to confine it, and whether this
    // machine was observed doing so. `usableInMode` answers only the second
    // combined with availability, so it stays a statement of expectation.
    const usableInMode = row.available === true
      && (row.confineable || policy.mode === 'danger-full-access')
    const confinement = {
      // The catalog's claim for this platform, and whether that claim was
      // measured here rather than reasoned about.
      expected: row.confineable ? 'confined' : 'unconfined',
      verified: platformVerified,
      ...row.confineReason === undefined ? {} : { reason: row.confineReason },
    }
    if (row.available !== true) {
      return { ...row, usableInMode, confinement: { ...confinement, observed: 'not-probed' } }
    }
    const probe = await probeRow(executor, entries.get(row.id), row, policy, probeSignal())
    return { ...row, ...probe, usableInMode, confinement: { ...confinement, observed: probe.observed } }
  }))
  return {
    active: {
      shell: executor.selectSettings.shell,
      // From the rows' own resolution, not the cached description: the card and
      // a call resolve the selection the same way.
      selected: rows.find(row => row.selected === true)?.id,
      platform,
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
    },
    // A platform-level statement: whether *any* confinement claim here was
    // measured by this plugin. Per-shell observation rides on each row.
    confinementVerified: platformVerified,
    shells: probed,
  }
}

/** A deadline for one probe, which never outlives the status read. */
function probeSignal() {
  return AbortSignal.timeout(PROBE_TIMEOUT_MS)
}

/**
 * Run the card's "Test shell" action.
 *
 * The command is a module constant, so this action carries no input. It runs
 * through the executor's normal decide/run path, which means it reports the same
 * refusal a model call would get when the shell cannot be confined — the test
 * never demonstrates a capability the tool itself would not grant.
 * @param ctx - context carrying the shell executor.
 * @param executor - the mounted shell-select executor.
 * @returns the test outcome, including the resolved mode and sandbox facts.
 */
export async function runShellTest(ctx, executor) {
  try {
    const decided = await executor.decide(executor.resolve({
      command: testCommand(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }))
    const result = await executor.run(decided.spec)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      stage: 'ran',
      // From the decision that produced the process, not from a separate read
      // of the selection.
      shell: decided.decision.shell.id,
      executable: decided.decision.shell.executable,
      mode: decided.spec.sandboxPolicy.mode,
      exitCode: result.exitCode,
      stdout: result.stdout.text.trim(),
      stderr: result.stderr.text.trim(),
      ...result.sandbox === undefined ? {} : {
        sandbox: {
          mode: result.sandbox.mode,
          denied: result.sandbox.denied,
          ...result.sandbox.enforcement === undefined ? {} : { enforcement: result.sandbox.enforcement },
          ...result.sandbox.runnerFailed === undefined ? {} : { runnerFailed: result.sandbox.runnerFailed },
        },
      },
    }
  } catch (error) {
    return {
      ok: false,
      // Two different failures with two different remedies: the selection could
      // not be resolved to a runnable shell at all, or it resolved and the
      // sandbox refused to run it.
      stage: error instanceof ShellSelectionRefusedError ? 'refused' : 'selection',
      shell: executor.describeShell().id,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Register the status and test routes on the host web server.
 * @param ctx - context carrying webServer, subprocess, sandboxPolicy, and the executor.
 * @param executor - the mounted shell-select executor.
 * @returns a disposer removing both routes.
 */
export function registerStatusRoutes(ctx, executor) {
  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: `${STATUS_ROUTE_PREFIX}/status`,
    async handler(req, res) {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'this endpoint is available over loopback only' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        sendJson(res, 200, await buildStatus(ctx, executor))
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  const disposeTest = ctx.webServer.register({
    kind: 'exact',
    path: `${STATUS_ROUTE_PREFIX}/test`,
    async handler(req, res) {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'this endpoint is available over loopback only' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        sendJson(res, 200, await runShellTest(ctx, executor))
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  return () => {
    disposeStatus()
    disposeTest()
  }
}
