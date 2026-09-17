/**
 * Real-process integration: the shipped subprocess provider, the shipped
 * sandbox provider, and the shells this host actually has.
 *
 * Unlike the stub suites, these tests assert what reaches the operating system:
 * the argv a shell receives, the working directory it really runs in, the
 * timeout and cancellation facts, the background read/kill cycle, and — for the
 * confinable shells — that the sandbox really denies a write outside the
 * workspace.
 *
 * Every fixture lives under `<workspace>/.test-tmp/`. The escape probe writes
 * only to a sibling fixture directory, and nothing here touches the user profile.
 * Tests for a shell this host does not have skip themselves with a reason.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ShellSelectConfig, ShellSelectExecutor } from '../src/executor.js'
import { catalogFor } from '../src/catalog.js'
import { makeFixture, removeFixture, StubSandboxPolicy } from './helpers.mjs'

const fixture = makeFixture('integration')
const workspace = join(fixture, 'ws space ünï')
const escapeDir = join(fixture, 'escape')
mkdirSync(workspace, { recursive: true })
mkdirSync(escapeDir, { recursive: true })
after(() => { removeFixture(fixture) })

const isWindows = process.platform === 'win32'

/**
 * Boot a composition on the real runtime and sandbox providers.
 * @param config - the shell-select entry.
 * @param mode - the sandbox mode every resolved spec carries.
 * @returns the executor and its context.
 */
async function boot(config, mode = 'workspace-write') {
  const ctx = new Context()
  await ctx.plugin(StubSandboxPolicy, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellSelectExecutor, ShellSelectConfig(config))
  const shell = ctx.shell
  await shell.ready
  return { ctx, shell }
}

/** Resolve and run one command in the fixture workspace. */
async function run(shell, command, options = {}) {
  const mode = options.mode ?? 'workspace-write'
  const spec = shell.resolve({
    command,
    workdir: options.workdir ?? workspace,
    sandboxPolicy: { mode, workspaceRoot: workspace },
    ...options.extra ?? {},
  })
  return shell.run(spec)
}

/** Whether a catalog entry resolves on this host's real execution world. */
async function available(shell, id) {
  const rows = await shell.describeCatalog()
  return rows.find(row => row.id === id)?.available === true
}

describe('shells this host provides', () => {
  // The catalog for the host's platform is the source of what to try; each case
  // skips itself when the shell is not installed.
  for (const id of ['cmd', 'pwsh', 'powershell', 'gitbash', 'wsl']) {
    it(`${id} runs a command when installed`, { skip: !isWindows && 'the Windows catalog is not this host' }, async (t) => {
      const { ctx, shell } = await boot({ shell: id })
      try {
        if (!await available(shell, id)) {
          t.skip(`${id} is not installed on this host`)
          return
        }
        // Git Bash and WSL cannot be confined, so the honest demonstration of
        // their execution is the full-access path the plugin allows them under.
        const confinable = shell.describeShell().confineable
        const mode = confinable ? 'workspace-write' : 'danger-full-access'
        const result = await run(shell, 'echo MARK-OK', { mode })
        assert.equal(result.exitCode, 0, `${id} stderr: ${result.stderr.text}`)
        assert.match(result.stdout.text, /MARK-OK/u)
        if (confinable) {
          assert.equal(result.sandbox.mode, 'workspace-write')
          assert.equal(result.sandbox.enforcement, 'partial')
        }
      } finally {
        await ctx.fiber?.dispose?.()
      }
    })
  }

  it('resolves auto to the harness\'s own shell for this platform', { skip: !isWindows && 'no Windows host' }, async () => {
    const { ctx, shell } = await boot({ shell: 'auto' })
    try {
      const describe = shell.describeShell()
      assert.equal(describe.platform, 'windows')
      // PowerShell, not cmd: this is the family the harness's Windows executor
      // runs, so installing the plugin does not change which shell an agent
      // gets. Which PowerShell depends on what this host has — 7 leads the
      // catalog, 5.1 is the fallback every Windows host carries.
      const preferred = await available(shell, 'pwsh') ? 'pwsh' : 'powershell'
      assert.equal(describe.id, preferred)
      assert.equal(describe.dialect, 'powershell')
      assert.notEqual(describe.id, 'cmd', 'auto must not downgrade to cmd')
      const result = await run(shell, 'Write-Output AUTO-OK')
      assert.equal(result.exitCode, 0, result.stderr.text)
      assert.match(result.stdout.text, /AUTO-OK/u)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe('working directories', () => {
  it('runs in a workspace whose path contains spaces and unicode', { skip: !isWindows && 'no Windows host' }, async () => {
    const { ctx, shell } = await boot({ shell: 'cmd' })
    try {
      const result = await run(shell, 'call echo [%CD%]')
      assert.equal(result.exitCode, 0, result.stderr.text)
      assert.match(result.stdout.text, /ws space/u)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('fails a missing working directory without spawning', { skip: !isWindows && 'no Windows host' }, async () => {
    const { ctx, shell } = await boot({ shell: 'cmd' })
    try {
      await assert.rejects(
        () => run(shell, 'echo hi', { workdir: join(fixture, 'absent') }),
        /working directory does not exist/u,
      )
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe('confinement is real', () => {
  for (const id of ['cmd', 'powershell']) {
    it(`${id} denies a write outside the workspace and allows one inside`, { skip: !isWindows && 'no Windows host' }, async (t) => {
      const { ctx, shell } = await boot({ shell: id })
      try {
        if (!await available(shell, id)) {
          t.skip(`${id} is not installed on this host`)
          return
        }
        const inside = join(workspace, `${id}-inside.txt`)
        const outside = join(escapeDir, `${id}-outside.txt`)
        rmSync(inside, { force: true })
        rmSync(outside, { force: true })
        const command = id === 'cmd'
          ? `echo ok> "${inside}" & echo no> "${outside}"`
          : `Set-Content -Path '${inside}' -Value ok; Set-Content -Path '${outside}' -Value no`
        const result = await run(shell, command)
        assert.ok(existsSync(inside), `the workspace write must succeed (stderr: ${result.stderr.text})`)
        assert.equal(existsSync(outside), false, 'the escape write must be denied')
        // The mode allows the workspace and denies the sibling.
        assert.equal(result.sandbox.denied, true, `expected a denial fact, stderr: ${result.stderr.text}`)
      } finally {
        await ctx.fiber?.dispose?.()
      }
    })
  }

  it('read-only denies a write inside the workspace too', { skip: !isWindows && 'no Windows host' }, async (t) => {
    const { ctx, shell } = await boot({ shell: 'cmd' }, 'read-only')
    try {
      if (!await available(shell, 'cmd')) {
        t.skip('cmd is not installed on this host')
        return
      }
      const target = join(workspace, 'read-only-probe.txt')
      rmSync(target, { force: true })
      const result = await run(shell, `echo nope> "${target}"`, { mode: 'read-only' })
      assert.equal(existsSync(target), false)
      assert.equal(result.sandbox.mode, 'read-only')
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('refuses an unconfineable shell before spawning', { skip: !isWindows && 'no Windows host' }, async (t) => {
    const { ctx, shell } = await boot({ shell: 'gitbash' })
    try {
      if (!await available(shell, 'gitbash')) {
        t.skip('gitbash is not installed on this host')
        return
      }
      const marker = join(workspace, 'gitbash-should-not-exist.txt')
      rmSync(marker, { force: true })
      await assert.rejects(
        () => run(shell, `echo x > "${marker}"`),
        /cannot be confined by the sandbox on this platform/u,
      )
      assert.equal(existsSync(marker), false)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe('timeout and cancellation', () => {
  it('reports a timeout and terminates the process', { skip: !isWindows && 'no Windows host' }, async (t) => {
    const { ctx, shell } = await boot({ shell: 'powershell' })
    try {
      if (!await available(shell, 'powershell')) {
        t.skip('powershell is not installed on this host')
        return
      }
      const started = Date.now()
      const result = await run(shell, 'Start-Sleep -Seconds 30', { extra: { timeoutMs: 1_500 } })
      assert.equal(result.timedOut, true)
      assert.equal(result.aborted, false)
      assert.equal(result.timeoutMs, 1_500)
      assert.ok(Date.now() - started < 25_000, 'the process must be killed at the deadline, not awaited')
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('reports caller cancellation distinctly from a timeout', { skip: !isWindows && 'no Windows host' }, async (t) => {
    const { ctx, shell } = await boot({ shell: 'powershell' })
    const controller = new AbortController()
    try {
      if (!await available(shell, 'powershell')) {
        t.skip('powershell is not installed on this host')
        return
      }
      const pending = run(shell, 'Start-Sleep -Seconds 30', { extra: { signal: controller.signal } })
      setTimeout(() => controller.abort(), 800)
      const result = await pending
      assert.equal(result.aborted, true)
      assert.equal(result.timedOut, false)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe('background execution', () => {
  it('starts, reads incrementally, and is killed through the handle', { skip: !isWindows && 'no Windows host' }, async (t) => {
    const { ctx, shell } = await boot({ shell: 'powershell' })
    try {
      if (!await available(shell, 'powershell')) {
        t.skip('powershell is not installed on this host')
        return
      }
      const spec = shell.resolve({
        command: 'Write-Output FIRST; Start-Sleep -Seconds 30; Write-Output SECOND',
        workdir: workspace,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
      })
      const proc = await shell.start(spec)
      assert.equal(proc.status, 'running')
      // Give the first write time to arrive, then read the delta.
      await new Promise(resolve => setTimeout(resolve, 4_000))
      assert.match(proc.readOutput().delta, /FIRST/u)
      assert.equal(proc.kill(), true)
      await proc.done
      assert.equal(proc.status, 'killed')
      // Consecutive reads are incremental: the first output is not re-delivered.
      assert.ok(!proc.readOutput().delta.includes('FIRST'))
      assert.equal(proc.sandbox.mode, 'workspace-write')
      assert.equal(proc.sandbox.enforcement, 'partial')
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('rejects an unconfineable shell before publishing a handle', { skip: !isWindows && 'no Windows host' }, async (t) => {
    const { ctx, shell } = await boot({ shell: 'wsl' })
    try {
      if (!await available(shell, 'wsl')) {
        t.skip('wsl is not installed on this host')
        return
      }
      await assert.rejects(
        () => shell.start(shell.resolve({
          command: 'echo hi',
          workdir: workspace,
          sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
        })),
        /cannot be confined by the sandbox on this platform/u,
      )
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe('catalog coverage of this host', () => {
  it('reports every Windows catalog entry through the real execution world', { skip: !isWindows && 'no Windows host' }, async () => {
    const { ctx, shell } = await boot({ shell: 'auto' })
    try {
      const rows = await shell.describeCatalog()
      assert.deepEqual(rows.map(row => row.id), catalogFor('windows').map(entry => entry.id))
      for (const row of rows) {
        assert.equal(typeof row.confineable, 'boolean')
        assert.ok(row.syntax.length > 0)
      }
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})
