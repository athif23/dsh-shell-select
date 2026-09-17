/**
 * Status facts and the settings card's HTTP surface.
 *
 * The card needs facts the settings document cannot hold, because they describe
 * the machine rather than the user's choice: which shells resolve to which
 * executable, what version each reports, and whether the selected one can run
 * under the session's permission mode. Those are computed here and served over
 * two read-only routes.
 *
 * **Probes run fixed, plugin-owned argv.** {@link probeVersion} spawns a version
 * query through `ctx.subprocess` and never carries user, model, or request
 * input, so the routes above it cannot be turned into a command channel. The
 * probe is deliberately unconfined: it reports environment facts, and a version
 * query the sandbox refused would report the sandbox rather than the shell.
 *
 * @module dsh-shell-select/status
 */

import { versionArgv, testCommand } from './dialects.js'
import { VERIFIED_CONFINEMENT_PLATFORMS } from './catalog.js'

/** Route prefix both endpoints live under. */
export const STATUS_ROUTE_PREFIX = '/dsh-shell-select'

/** Deadline for one read-only version probe. */
const PROBE_TIMEOUT_MS = 10_000

/** Grace period handed to the subprocess provider for probe termination. */
const PROBE_GRACE_MS = 2_000

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
 * Run one shell's fixed version query.
 * @param ctx - context carrying the subprocess service.
 * @param dialect - the entry's argument dialect.
 * @param executable - the resolved executable path.
 * @returns the first non-empty output line, or a diagnostic when the probe failed.
 */
async function probeVersion(ctx, dialect, executable) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('probe timed out')) }, PROBE_TIMEOUT_MS)
  try {
    const handle = ctx.subprocess.spawn({
      argv: versionArgv(dialect, executable),
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8_192 },
        stderr: { maxBytes: 8_192 },
      },
      graceMs: PROBE_GRACE_MS,
      signal: controller.signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    const lines = `${stdout}\n${stderr}`.replace(/\0/gu, '').split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
    if (outcome.exitCode !== 0 && lines.length === 0) {
      return { ok: false, detail: `exited with code ${String(outcome.exitCode)}` }
    }
    return lines.length > 0 ? { ok: true, version: lines[0] } : { ok: false, detail: 'no output' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
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
  // Probes run in parallel: each is an independent short-lived process, and the
  // card is opened on demand rather than in any hot path.
  const probed = await Promise.all(rows.map(async row => {
    // Two distinct facts the card must not conflate: whether the binary runs at
    // all, and whether it may run under the mode this session resolved. Both
    // are reported for every row, so an absent shell is still answered rather
    // than left undefined for the card to guess at.
    const usableInMode = row.available === true
      && (row.confineable || policy.mode === 'danger-full-access')
    if (row.available !== true) return { ...row, usableInMode }
    const version = await probeVersion(ctx, row.dialect, row.path)
    return {
      ...row,
      ...version.ok ? { version: version.version } : { versionError: version.detail },
      usableInMode,
    }
  }))
  return {
    active: {
      shell: executor.selectSettings.shell,
      selected: executor.describeShell().id,
      platform,
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
    },
    confinementVerified: VERIFIED_CONFINEMENT_PLATFORMS.includes(platform),
    shells: probed,
  }
}

/**
 * Run the card's "Test shell" action.
 *
 * The command is a module constant, so this action carries no input. It runs
 * through the executor's normal resolve/run path, which means it reports the
 * same refusal a model call would get when the shell cannot be confined — the
 * test never demonstrates a capability the tool itself would not grant.
 * @param ctx - context carrying the shell executor.
 * @param executor - the mounted shell-select executor.
 * @returns the test outcome, including the resolved mode and sandbox facts.
 */
export async function runShellTest(ctx, executor) {
  const describe = executor.describeShell()
  if (!describe.available) return { ok: false, stage: 'executable', detail: describe.detail }
  try {
    const spec = ctx.shell.resolve({ command: testCommand(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const result = await ctx.shell.run(spec)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      stage: 'ran',
      shell: describe.id,
      executable: describe.executable,
      mode: spec.sandboxPolicy.mode,
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
      stage: 'refused',
      shell: describe.id,
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
