/**
 * The settings card's host surface: status facts, the test action, and the
 * loopback restriction.
 *
 * The card is the only place a user sees "installed" versus "usable in this
 * permission mode" versus "actually confined", so the distinctions those three
 * facts carry are asserted here rather than left to the view.
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ShellSelectConfig, ShellSelectExecutor } from '../src/executor.js'
import { localPlatform } from '../src/catalog.js'
import { STATUS_ROUTE_PREFIX, buildStatus, registerStatusRoutes, runShellTest } from '../src/status.js'
import { makeContext, makeFixture, removeFixture, stubSandbox, stubSubprocess, workdirFor } from './helpers.mjs'

const fixture = makeFixture('status')
after(() => { removeFixture(fixture) })

const workspace = join(fixture, 'work')
mkdirSync(workspace, { recursive: true })

const WINDOWS_EXES = {
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  cmd: 'C:\\Windows\\system32\\cmd.exe',
  'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe',
  'bash.exe': 'D:\\Git\\bin\\bash.exe',
  'wsl.exe': 'C:\\Windows\\System32\\wsl.exe',
  'cmd.exe': 'C:\\Windows\\system32\\cmd.exe',
}

/** Mount the executor plus a web server stand-in that records registered routes. */
async function mount(config, options = {}) {
  const subprocess = stubSubprocess({
    platform: options.platform ?? 'windows',
    resolvable: options.resolvable ?? WINDOWS_EXES,
    defaultShell: options.defaultShell,
    output: options.output,
    outcome: options.outcome,
  })
  const sandbox = options.sandbox ?? stubSandbox()
  // The policy's workspace root is the directory a probe runs in, so it follows
  // the platform the composition is asked about, not this host's shape.
  const policyRoot = options.workspaceRoot
    ?? workdirFor(options.platform ?? 'windows', workspace)
  const context = await makeContext({
    mode: options.mode ?? 'workspace-write',
    subprocess,
    sandbox,
    workspaceRoot: policyRoot,
  })
  const routes = new Map()
  await context.plugin({
    name: 'stub-webserver',
    apply(inner) {
      inner.provide('webServer', {
        register(route) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      })
    },
  })
  await context.plugin(ShellSelectExecutor, ShellSelectConfig(config))
  const shell = context.shell
  await shell.ready
  return { ctx: context, shell, routes, subprocess, sandbox, policyRoot }
}

/** Invoke a registered route with a minimal request/response pair. */
async function call(route, options = {}) {
  const chunks = []
  const req = {
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }
  const res = {
    statusCode: 0,
    headers: undefined,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    end(body) { if (body !== undefined) chunks.push(body) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  return { status: res.statusCode, body: text.length === 0 ? undefined : JSON.parse(text) }
}

describe('status payload', () => {
  it('reports the selected shell, the platform, and the resolved mode', async () => {
    const { ctx, shell, policyRoot } = await mount({ shell: 'cmd' })
    const status = await buildStatus(ctx, shell)
    assert.equal(status.active.shell, 'cmd')
    assert.equal(status.active.selected, 'cmd')
    assert.equal(status.active.platform, 'windows')
    assert.equal(status.active.mode, 'workspace-write')
    assert.equal(status.active.workspaceRoot, policyRoot)
    assert.deepEqual(status.shells.map(row => row.id), ['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl'])
  })

  it('reports the resolved shell when the setting is auto', async () => {
    const { ctx, shell } = await mount({ shell: 'auto' }, { defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    const status = await buildStatus(ctx, shell)
    assert.equal(status.active.shell, 'auto', 'the setting is reported as written')
    assert.equal(status.active.selected, 'pwsh', 'the card shows what auto resolved to')
    assert.equal(status.shells.find(row => row.id === 'pwsh').selected, true)
  })

  it('keeps "installed" and "usable in this mode" as separate facts', async () => {
    const { ctx, shell } = await mount({ shell: 'cmd' })
    const status = await buildStatus(ctx, shell)
    const cmd = status.shells.find(row => row.id === 'cmd')
    const gitbash = status.shells.find(row => row.id === 'gitbash')

    assert.equal(cmd.available, true)
    assert.equal(cmd.confineable, true)
    assert.equal(cmd.usableInMode, true)

    // Git Bash resolves on this host, cannot be confined, and is therefore
    // unusable under a confined mode — three facts, not one status word.
    assert.equal(gitbash.available, true)
    assert.equal(gitbash.confineable, false)
    assert.equal(gitbash.usableInMode, false)
    assert.match(gitbash.confineReason, /MSYS2|restricted token/u)
  })

  it('marks an unconfineable shell usable once the mode is full access', async () => {
    const { ctx, shell } = await mount({ shell: 'gitbash' }, { mode: 'danger-full-access' })
    const status = await buildStatus(ctx, shell)
    const gitbash = status.shells.find(row => row.id === 'gitbash')
    assert.equal(gitbash.confineable, false, 'capability does not change with the mode')
    assert.equal(gitbash.usableInMode, true, 'usability does')
  })

  it('reports the version each resolvable shell prints', async () => {
    const { ctx, shell } = await mount({ shell: 'cmd' }, { output: { stdout: 'Microsoft Windows [Version 10]\n' } })
    const status = await buildStatus(ctx, shell)
    assert.equal(status.shells.find(row => row.id === 'cmd').version, 'Microsoft Windows [Version 10]')
  })

  it('probes every resolvable shell through confinement, never around it', async () => {
    const { ctx, shell, sandbox } = await mount(
      { shell: 'cmd' },
      { output: { stdout: 'Microsoft Windows [Version 10]\n' } },
    )
    const status = await buildStatus(ctx, shell)
    assert.equal(status.shells.find(row => row.id === 'cmd').version, 'Microsoft Windows [Version 10]')
    const probed = status.shells.filter(row => row.available === true)
    // Git Bash is resolvable and unconfineable, so it is not probed at all.
    const probedRows = probed.filter(row => row.confineable)
    assert.equal(sandbox.calls.length, probedRows.length, 'every probe went through ctx.sandbox.confine')
    for (const call of sandbox.calls) {
      assert.equal(call.policy.mode, 'workspace-write', 'the deployment policy, not a relaxation')
    }
  })

  it('never probes an executable whose workspace cannot be validated', async () => {
    // A missing workspace is a local fact, so it is caught on this host's own
    // platform — the case a typo has to be caught in.
    const host = localPlatform()
    const { ctx, shell, subprocess } = await mount(
      host === 'windows' ? { shell: 'cmd' } : { shell: 'bash' },
      {
        platform: host,
        workspaceRoot: join(fixture, 'gone'),
        resolvable: host === 'windows' ? WINDOWS_EXES : { bash: '/bin/bash' },
      },
    )
    const status = await buildStatus(ctx, shell)
    const row = status.shells.find(entry => entry.id === (host === 'windows' ? 'cmd' : 'bash'))
    assert.match(row.versionError, /probe not run: .*working directory does not exist/u)
    assert.equal(subprocess.spawns.length, 0, 'a probe stops before spawning, like a command does')
  })

  it('does not probe a shell the current mode cannot confine', async () => {
    // A configurable executable path must not become an unrestricted execution
    // channel just because the probe's arguments are fixed.
    const { ctx, shell, sandbox } = await mount({ shell: 'cmd' })
    const status = await buildStatus(ctx, shell)
    const gitbash = status.shells.find(row => row.id === 'gitbash')
    assert.equal(gitbash.available, true)
    assert.match(gitbash.versionError, /not probed: Git Bash cannot be confined under "workspace-write"/u)
    assert.equal(gitbash.confinement.observed, 'not-probed')
    assert.equal(sandbox.calls.some(call => call.argv[0].toLowerCase().endsWith('bash.exe')), false,
      'the unconfineable shell was never spawned')
  })

  it('reports a confined probe as observed confinement, per shell', async () => {
    const { ctx, shell } = await mount({ shell: 'cmd' })
    const status = await buildStatus(ctx, shell)
    const cmd = status.shells.find(row => row.id === 'cmd')
    // The catalog's claim, whether it was measured on this platform, and what
    // this machine was seen to do — three facts, not one word.
    assert.deepEqual(cmd.confinement, { expected: 'confined', verified: true, observed: 'confirmed' })
    const gitbash = status.shells.find(row => row.id === 'gitbash')
    assert.equal(gitbash.confinement.expected, 'unconfined')
    assert.match(gitbash.confinement.reason, /MSYS2|restricted token/u)
  })

  it('reports a probe that ran without confinement as unconfined, not verified', async () => {
    const { ctx, shell } = await mount({ shell: 'gitbash' }, { mode: 'danger-full-access' })
    const status = await buildStatus(ctx, shell)
    const gitbash = status.shells.find(row => row.id === 'gitbash')
    assert.equal(gitbash.confineable, false, 'the capability does not change with the mode')
    assert.equal(gitbash.usableInMode, true)
    assert.equal(gitbash.confinement.observed, 'ran-unconfined',
      'the probe ran, and the row must not present that as confinement')
  })

  it('treats a non-zero probe exit as a failure even when it printed something', async () => {
    // `dash` answers `--version` with "Illegal option" on stderr and exit 2.
    const { ctx, shell } = await mount({ shell: 'cmd' },
      { outcome: { exitCode: 2, signal: null }, output: { stderr: 'sh: 0: Illegal option --\n' } })
    const status = await buildStatus(ctx, shell)
    const cmd = status.shells.find(row => row.id === 'cmd')
    assert.equal(cmd.version, undefined, 'the error text must never be reported as a version')
    assert.match(cmd.versionError, /exited with code 2: sh: 0: Illegal option --/u)
  })

  it('asks a POSIX sh for its interpreter instead of a version flag it may not have', async () => {
    // The stub's execution platform is posix while the host is Windows, so only
    // a root path is both absolutely-posix and a directory the local check can
    // stat; the probe's own validation is what this case is exercising.
    const { ctx, shell } = await mount(
      { shell: 'sh' },
      {
        platform: 'posix',
        resolvable: { sh: '/usr/bin/sh' },
        output: { stdout: 'dash\n' },
        workspaceRoot: '/',
      },
    )
    const status = await buildStatus(ctx, shell)
    const sh = status.shells.find(row => row.id === 'sh')
    assert.equal(sh.interpreter, 'dash')
    assert.equal(sh.version, undefined)
  })

  it('reports a probe the runner could not start as a runner failure', async () => {
    const sandbox = stubSandbox({
      confine: () => Promise.resolve({
        argv: ['/runner', 'wrap'],
        enforcement: 'partial',
        denialSignatures: [],
        runnerFailureRules: [{ fatalSignatures: ['runner could not start'] }],
      }),
    })
    const { ctx, shell } = await mount({ shell: 'cmd' }, {
      sandbox,
      outcome: { exitCode: 127, signal: null },
      output: { stderr: 'runner could not start\n' },
    })
    const status = await buildStatus(ctx, shell)
    const cmd = status.shells.find(row => row.id === 'cmd')
    assert.equal(cmd.confinement.observed, 'runner-failed')
    assert.match(cmd.versionError, /the sandbox runner could not start this shell/u)
  })

  it('surfaces a probe failure without failing the whole payload', async () => {
    const { ctx, shell } = await mount({ shell: 'cmd' }, { outcome: { exitCode: 1, signal: null } })
    const status = await buildStatus(ctx, shell)
    const cmd = status.shells.find(row => row.id === 'cmd')
    assert.equal(cmd.available, true)
    assert.ok(cmd.versionError !== undefined)
  })

  it('records whether this platform\'s confinement facts were verified here', async () => {
    const windows = await mount({ shell: 'cmd' })
    assert.equal((await buildStatus(windows.ctx, windows.shell)).confinementVerified, true)

    const posix = await mount(
      { shell: 'bash' },
      { platform: 'posix', resolvable: { bash: '/bin/bash' } },
    )
    const status = await buildStatus(posix.ctx, posix.shell)
    assert.equal(status.confinementVerified, false, 'the POSIX rows are the harness\'s documented behavior, not a measurement made here')
  })
})

describe('test action', () => {
  it('runs the fixed command through the configured shell', async () => {
    const { ctx, shell, sandbox } = await mount({ shell: 'cmd' })
    const result = await runShellTest(ctx, shell)
    assert.equal(result.ok, true)
    assert.equal(result.stage, 'ran')
    assert.equal(result.shell, 'cmd')
    assert.equal(result.mode, 'workspace-write')
    assert.equal(result.sandbox.enforcement, 'partial')
    assert.equal(sandbox.calls.length, 1, 'the test must go through confinement, not around it')
  })

  it('reports the refusal instead of demonstrating an unconfineable shell', async () => {
    const { ctx, shell, subprocess } = await mount({ shell: 'gitbash' })
    const result = await runShellTest(ctx, shell)
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'refused')
    assert.match(result.detail, /cannot be confined/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('reports an unresolvable shell as a selection problem, not a run problem', async () => {
    const { ctx, shell } = await mount({ shell: 'cmd' }, { resolvable: {} })
    const result = await runShellTest(ctx, shell)
    assert.equal(result.stage, 'selection')
    assert.match(result.detail, /no Command Prompt \(cmd\.exe\) executable found/u)
  })
})

describe('routes', () => {
  it('registers both endpoints under the plugin prefix and disposes them', async () => {
    const { ctx, shell, routes } = await mount({ shell: 'cmd' })
    const dispose = registerStatusRoutes(ctx, shell)
    assert.deepEqual([...routes.keys()].sort(), [
      `${STATUS_ROUTE_PREFIX}/status`,
      `${STATUS_ROUTE_PREFIX}/test`,
    ])
    dispose()
    assert.equal(routes.size, 0)
  })

  it('refuses a non-loopback peer on both endpoints', async () => {
    const { ctx, shell, routes } = await mount({ shell: 'cmd' })
    registerStatusRoutes(ctx, shell)
    for (const path of [`${STATUS_ROUTE_PREFIX}/status`, `${STATUS_ROUTE_PREFIX}/test`]) {
      const response = await call(routes.get(path), { method: 'POST', remoteAddress: '10.0.0.7' })
      assert.equal(response.status, 403)
    }
  })

  it('accepts loopback in every address form the platform reports', async () => {
    const { ctx, shell, routes } = await mount({ shell: 'cmd' })
    registerStatusRoutes(ctx, shell)
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const response = await call(routes.get(`${STATUS_ROUTE_PREFIX}/status`), { remoteAddress })
      assert.equal(response.status, 200, remoteAddress)
      assert.equal(response.body.active.selected, 'cmd')
    }
  })

  it('rejects the wrong method on each endpoint', async () => {
    const { ctx, shell, routes } = await mount({ shell: 'cmd' })
    registerStatusRoutes(ctx, shell)
    assert.equal((await call(routes.get(`${STATUS_ROUTE_PREFIX}/status`), { method: 'POST' })).status, 405)
    assert.equal((await call(routes.get(`${STATUS_ROUTE_PREFIX}/test`), { method: 'GET' })).status, 405)
  })

  it('runs the test action over its POST endpoint', async () => {
    const { ctx, shell, routes } = await mount({ shell: 'cmd' })
    registerStatusRoutes(ctx, shell)
    const response = await call(routes.get(`${STATUS_ROUTE_PREFIX}/test`), { method: 'POST' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
  })
})
