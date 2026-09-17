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
import { STATUS_ROUTE_PREFIX, buildStatus, registerStatusRoutes, runShellTest } from '../src/status.js'
import { makeContext, makeFixture, removeFixture, stubSandbox, stubSubprocess } from './helpers.mjs'

const fixture = makeFixture('status')
after(() => { removeFixture(fixture) })

const workspace = join(fixture, 'work')
mkdirSync(workspace, { recursive: true })

const WINDOWS_EXES = {
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
  const sandbox = stubSandbox()
  const context = await makeContext({ mode: options.mode ?? 'workspace-write', subprocess, sandbox, workspaceRoot: workspace })
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
  return { ctx: context, shell, routes, subprocess, sandbox }
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
    const { ctx, shell } = await mount({ shell: 'cmd' })
    const status = await buildStatus(ctx, shell)
    assert.equal(status.active.shell, 'cmd')
    assert.equal(status.active.selected, 'cmd')
    assert.equal(status.active.platform, 'windows')
    assert.equal(status.active.mode, 'workspace-write')
    assert.equal(status.active.workspaceRoot, workspace)
    assert.deepEqual(status.shells.map(row => row.id), ['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl'])
  })

  it('reports the resolved shell when the setting is auto', async () => {
    const { ctx, shell } = await mount({ shell: 'auto' }, { defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    const status = await buildStatus(ctx, shell)
    assert.equal(status.active.shell, 'auto')
    assert.equal(status.active.selected, 'cmd', 'the card shows what auto resolved to')
    assert.equal(status.shells.find(row => row.id === 'cmd').selected, true)
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

  it('reports an unresolvable shell as an executable problem, not a run problem', async () => {
    const { ctx, shell } = await mount({ shell: 'cmd' }, { resolvable: {} })
    const result = await runShellTest(ctx, shell)
    assert.equal(result.stage, 'executable')
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
