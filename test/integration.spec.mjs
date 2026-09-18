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
 * Both platform lanes are written here, and each runs on its own platform. A
 * required shell of the host's lane never skips: its absence is a failure of the
 * lane, not a fact about the machine. An optional shell skips with the reason
 * printed. See `test/lanes.mjs` for the sets and `platform-lanes.spec.mjs` for
 * the assertion that they still name real catalog entries.
 *
 * Every fixture lives under `<workspace>/.test-tmp/`. The escape probe writes
 * only to a sibling fixture directory, and nothing here touches the user profile.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ShellSelectConfig, ShellSelectExecutor } from '../src/executor.js'
import { catalogFor, findEntry } from '../src/catalog.js'
import { toLinuxPath } from '../src/dialects.js'
import { laneFor } from './lanes.mjs'
import { TEST_TMP_ENV, makeFixture, removeFixture, StubSandboxPolicy } from './helpers.mjs'

const fixture = makeFixture('integration')
const workspace = join(fixture, 'ws space ünï')
const escapeDir = join(fixture, 'escape')
mkdirSync(workspace, { recursive: true })
mkdirSync(escapeDir, { recursive: true })
after(() => { removeFixture(fixture) })

const HOST_PLATFORM = process.platform === 'win32' ? 'windows' : 'posix'
const LANE = laneFor(HOST_PLATFORM)
const OTHER_PLATFORM = HOST_PLATFORM === 'windows' ? 'posix' : 'windows'
const OTHER_LANE_SKIP = `this host is ${HOST_PLATFORM}; its lane is written but ${OTHER_PLATFORM} execution is not this machine`

/** Paths one dialect's commands use, in that dialect's own namespace. */
function pathsFor(dialect) {
  const inside = join(workspace, 'written-inside.txt')
  const outside = join(escapeDir, 'written-outside.txt')
  if (dialect !== 'wsl') return { inside, outside }
  // The WSL lane writes from inside the distribution, where the workspace is a
  // mounted Windows drive.
  return { inside: toLinuxPath(inside, '/mnt'), outside: toLinuxPath(outside, '/mnt') }
}

/**
 * The commands the behavior cases need, per argument dialect.
 * @param dialect - one entry's dialect.
 * @returns the named commands, and the paths the write cases use.
 */
function scriptsFor(dialect) {
  const paths = pathsFor(dialect)
  switch (dialect) {
    case 'cmd':
      return {
        paths,
        chain: '&',
        echo: 'echo MARK-OK',
        where: 'call echo [%CD%]',
        writeInside: `echo ok>"${paths.inside}"`,
        writeOutside: `echo no>"${paths.outside}"`,
        writeOnly: `echo nope>"${paths.inside}"`,
        slow: 'ping -n 40 127.0.0.1 >nul',
        staged: 'echo FIRST & ping -n 40 127.0.0.1 >nul & echo SECOND',
      }
    case 'powershell':
      return {
        paths,
        chain: ';',
        echo: 'Write-Output MARK-OK',
        where: '(Get-Location).Path',
        writeInside: `Set-Content -Path '${paths.inside}' -Value ok`,
        writeOutside: `Set-Content -Path '${paths.outside}' -Value no`,
        writeOnly: `Set-Content -Path '${paths.inside}' -Value nope`,
        slow: 'Start-Sleep -Seconds 40',
        staged: 'Write-Output FIRST; Start-Sleep -Seconds 40; Write-Output SECOND',
      }
    case 'bash':
    case 'wsl':
      return {
        paths,
        chain: ';',
        echo: 'echo MARK-OK',
        where: 'pwd',
        writeInside: `printf ok > '${paths.inside}'`,
        writeOutside: `printf no > '${paths.outside}'`,
        writeOnly: `printf nope > '${paths.inside}'`,
        slow: 'sleep 40',
        staged: 'echo FIRST; sleep 40; echo SECOND',
      }
    default:
      throw new Error(`integration suite: no scripts for dialect ${JSON.stringify(dialect)}`)
  }
}

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

/** Whether the catalog refuses to confine an entry on this platform. */
function cannotConfine(id) {
  return findEntry(HOST_PLATFORM, id)?.confineable?.confined === false
}

/**
 * Whether the escape probe writes outside everything the mode grants.
 *
 * `workspace-write` grants the workspace, and on POSIX it grants `/tmp` as well:
 * the Linux runner chain's profiles list it writable, and bubblewrap mounts a
 * private one there. An escape directory inside a granted root cannot test a
 * denial, because the write succeeds for a reason that has nothing to do with
 * the plugin: it is a fact about where the fixture lives. The scratch root is
 * the operator's choice, so the skip message asks for a different one.
 * @returns true when the escape directory is outside every granted root.
 */
function escapeOutsideGrants() {
  if (HOST_PLATFORM !== 'posix') return true
  const real = realpathSync(escapeDir)
  return !['/tmp', '/private/tmp'].some(root => real === root || real.startsWith(`${root}/`))
}

/**
 * Whether an optional shell can actually run a command on this host.
 *
 * `available()` only means the shell's executable resolves, which is not the
 * same fact: the WSL launcher ships with Windows whether or not a distribution
 * is installed behind it, so the launcher has to be asked before that entry's
 * case can mean anything. A host that cannot run the shell skips with the reason
 * it gave rather than failing the lane.
 * @param shell - the booted executor, for the resolved executable.
 * @param id - the catalog entry id.
 * @returns undefined when the shell can run, else the reason to skip with.
 */
async function unrunnable(shell, id) {
  if (id !== 'wsl') return undefined
  const path = (await shell.describeCatalog()).find(entry => entry.id === id)?.path
  if (path === undefined) return `${id} is not installed on this host`
  const listed = spawnSync(path, ['-l', '-q'], { timeout: 20_000 })
  // `wsl.exe` writes UTF-16LE, whether it is listing a distribution or saying
  // that there is none.
  const names = String(listed.stdout ?? '').toString('utf16le').replace(/\0/gu, '').trim()
  if (names.length > 0) return undefined
  return `${id} has no distribution installed (wsl -l -q exited ${String(listed.status)})`
}

/**
 * The mode one shell's cases run under: the mode it would really run under,
 * since an unconfineable shell is only reachable through full access.
 * @param id - the catalog entry id.
 * @returns the sandbox mode.
 */
async function caseMode(id) {
  if (cannotConfine(id)) return 'danger-full-access'
  return laneMode()
}

/**
 * The confined mode this host can actually enforce, probed once per run.
 *
 * A host with no usable sandbox backend is a fact about the host, not a defect
 * in the plugin: the plugin refuses there, which the confinement case asserts.
 * The cases that are about *driving the shell* then run under full access rather
 * than failing for an unrelated reason.
 * @returns `'workspace-write'` when confinement works here, else `'danger-full-access'`.
 */
let laneModeProbe
async function laneMode() {
  if (laneModeProbe === undefined) {
    const { ctx, shell } = await boot({ shell: LANE.command })
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.command).dialect)
      await run(shell, script.echo)
      laneModeProbe = 'workspace-write'
    } catch (error) {
      if (error.name !== 'SandboxUnavailableError') throw error
      laneModeProbe = 'danger-full-access'
    } finally {
      await ctx.fiber?.dispose?.()
    }
  }
  return laneModeProbe
}

describe(`${HOST_PLATFORM} lane: the required shells`, () => {
  // Required shells never skip. A POSIX host without bash, or a Windows host
  // without cmd.exe, is a broken lane and must be reported as one.
  for (const id of LANE.required) {
    it(`${id} runs a command`, async () => {
      const { ctx, shell } = await boot({ shell: id })
      try {
        const entry = findEntry(HOST_PLATFORM, id)
        const script = scriptsFor(entry.dialect)
        const mode = await caseMode(id)
        const result = await run(shell, script.echo, { mode })
        assert.equal(result.exitCode, 0, `${id} stderr: ${result.stderr.text}`)
        assert.match(result.stdout.text, /MARK-OK/u)
        if (mode !== 'danger-full-access') {
          assert.equal(result.sandbox.mode, mode)
          assert.ok(result.sandbox.enforcement !== undefined, 'a confined run reports its enforcement')
        }
      } finally {
        await ctx.fiber?.dispose?.()
      }
    })
  }
})

describe(`${HOST_PLATFORM} lane: the optional shells`, () => {
  // Optional shells may be absent on a real host, so each case skips with the
  // reason rather than failing the lane.
  for (const id of LANE.optional) {
    it(`${id} runs a command when installed`, async (t) => {
      const { ctx, shell } = await boot({ shell: id })
      try {
        if (!await available(shell, id)) {
          t.skip(`${id} is not installed on this host`)
          return
        }
        const unrunnableReason = await unrunnable(shell, id)
        if (unrunnableReason !== undefined) {
          t.skip(unrunnableReason)
          return
        }
        const script = scriptsFor(findEntry(HOST_PLATFORM, id).dialect)
        const result = await run(shell, script.echo, { mode: await caseMode(id) })
        assert.equal(result.exitCode, 0, `${id} stderr: ${result.stderr.text}`)
        assert.match(result.stdout.text, /MARK-OK/u)
      } finally {
        await ctx.fiber?.dispose?.()
      }
    })
  }
})

describe(`${HOST_PLATFORM} lane: working directories`, () => {
  it('runs in a workspace whose path contains spaces and unicode', async () => {
    const { ctx, shell } = await boot({ shell: LANE.command })
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.command).dialect)
      const result = await run(shell, script.where, { mode: await caseMode(LANE.command) })
      assert.equal(result.exitCode, 0, result.stderr.text)
      assert.match(result.stdout.text, /ws space/u)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('fails a missing working directory without spawning', async () => {
    const { ctx, shell, } = await boot({ shell: LANE.command })
    try {
      await assert.rejects(
        () => run(shell, 'echo hi', { workdir: join(fixture, 'absent') }),
        /working directory does not exist/u,
      )
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('fails a working directory that is not absolute for this platform', async () => {
    const { ctx, shell } = await boot({ shell: LANE.command })
    try {
      await assert.rejects(
        () => run(shell, 'echo hi', { workdir: HOST_PLATFORM === 'windows' ? '/tmp' : 'C:\\work' }),
        /must be an absolute/u,
      )
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe(`${HOST_PLATFORM} lane: confinement`, () => {
  it(`${LANE.command} denies a write outside the workspace and allows one inside`, async (t) => {
    const { ctx, shell } = await boot({ shell: LANE.command })
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.command).dialect)
      rmSync(script.paths.inside, { force: true })
      rmSync(script.paths.outside, { force: true })
      let result
      try {
        result = await run(shell, `${script.writeInside} ${script.chain} ${script.writeOutside}`)
      } catch (error) {
        // No usable backend on this host: refusing is the correct answer, and
        // the escape write must not have happened.
        assert.equal(error.name, 'SandboxUnavailableError', String(error))
        assert.equal(existsSync(script.paths.outside), false)
        return
      }
      assert.ok(existsSync(script.paths.inside), `the workspace write must succeed (stderr: ${result.stderr.text})`)
      // The half of this claim that is the plugin's: the command went through
      // `ctx.sandbox.confine` and ran under the confining mode. A run that
      // reported `danger-full-access` here would be the plugin bypassing the
      // sandbox, and no host fact excuses that.
      assert.equal(result.sandbox.mode, 'workspace-write')
      assert.ok(result.sandbox.enforcement !== undefined, 'a confined run reports its enforcement')
      const measurement = `enforcement: ${result.sandbox.enforcement}, stderr: ${result.stderr.text}`
      if (!existsSync(script.paths.outside)) {
        // The escape write was denied, which is the outcome this case is for.
        if (HOST_PLATFORM === 'windows') assert.equal(result.sandbox.enforcement, 'partial')
        return
      }
      if (!escapeOutsideGrants()) {
        // The fixture sits inside a root this mode grants, so the write landing
        // there is what the grant allows and says nothing about the plugin.
        t.skip(`this run's scratch root is under /tmp, which the POSIX workspace-write profile grants writable; `
          + `name one outside it (${TEST_TMP_ENV}) to assert the denial`)
        return
      }
      assert.fail(`the escape write must be denied (${measurement})`)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('read-only denies a write inside the workspace too', async () => {
    const { ctx, shell } = await boot({ shell: LANE.command }, 'read-only')
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.command).dialect)
      rmSync(script.paths.inside, { force: true })
      let result
      try {
        result = await run(shell, script.writeOnly, { mode: 'read-only' })
      } catch (error) {
        assert.equal(error.name, 'SandboxUnavailableError', String(error))
        assert.equal(existsSync(script.paths.inside), false)
        return
      }
      assert.equal(existsSync(script.paths.inside), false)
      assert.equal(result.sandbox.mode, 'read-only')
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  for (const id of ['gitbash', 'wsl']) {
    it(`refuses the unconfineable ${id} before spawning`, { skip: HOST_PLATFORM === 'windows' ? false : OTHER_LANE_SKIP }, async (t) => {
      const { ctx, shell } = await boot({ shell: id })
      try {
        if (!await available(shell, id)) {
          t.skip(`${id} is not installed on this host`)
          return
        }
        const script = scriptsFor(findEntry('windows', id).dialect)
        rmSync(script.paths.inside, { force: true })
        await assert.rejects(
          () => run(shell, script.writeOnly),
          /cannot be confined by the sandbox on this platform/u,
        )
        assert.equal(existsSync(script.paths.inside), false, 'nothing may have run')
      } finally {
        await ctx.fiber?.dispose?.()
      }
    })
  }
})

describe(`${HOST_PLATFORM} lane: timeout and cancellation`, () => {
  it('reports a timeout and terminates the process', async () => {
    const { ctx, shell } = await boot({ shell: LANE.driver })
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.driver).dialect)
      const started = Date.now()
      const result = await run(shell, script.slow, { mode: await laneMode(), extra: { timeoutMs: 1_500 } })
      assert.equal(result.timedOut, true)
      assert.equal(result.aborted, false)
      assert.equal(result.timeoutMs, 1_500)
      assert.ok(Date.now() - started < 25_000, 'the process must be killed at the deadline, not awaited')
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('reports caller cancellation distinctly from a timeout', async () => {
    const { ctx, shell } = await boot({ shell: LANE.driver })
    const controller = new AbortController()
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.driver).dialect)
      const pending = run(shell, script.slow, { mode: await laneMode(), extra: { signal: controller.signal } })
      setTimeout(() => controller.abort(), 800)
      const result = await pending
      assert.equal(result.aborted, true)
      assert.equal(result.timedOut, false)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe(`${HOST_PLATFORM} lane: background execution`, () => {
  it('starts, reads incrementally, and is killed through the handle', async () => {
    const { ctx, shell } = await boot({ shell: LANE.driver })
    try {
      const script = scriptsFor(findEntry(HOST_PLATFORM, LANE.driver).dialect)
      const spec = shell.resolve({
        command: script.staged,
        workdir: workspace,
        sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace },
      })
      const mode = await laneMode()
      const proc = await shell.start({ ...spec, sandboxPolicy: { ...spec.sandboxPolicy, mode } })
      assert.equal(proc.status, 'running')
      // Give the first write time to arrive, then read the delta.
      await new Promise(resolve => { setTimeout(resolve, 4_000) })
      assert.match(proc.readOutput().delta, /FIRST/u)
      assert.equal(proc.kill(), true)
      await proc.done
      assert.equal(proc.status, 'killed')
      // Consecutive reads are incremental: the first output is not re-delivered.
      assert.ok(!proc.readOutput().delta.includes('FIRST'))
      assert.equal(proc.sandbox.mode, mode)
      if (mode !== 'danger-full-access') {
        assert.ok(proc.sandbox.enforcement !== undefined, 'a confined background process reports its enforcement')
      }
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })

  it('rejects an unconfineable shell before publishing a handle', { skip: HOST_PLATFORM === 'windows' ? false : OTHER_LANE_SKIP }, async (t) => {
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

describe(`${HOST_PLATFORM} lane: auto selection`, () => {
  it('resolves to a shell this host has, and runs it', async () => {
    const { ctx, shell } = await boot({ shell: 'auto' })
    try {
      const describe = shell.describeShell()
      assert.equal(describe.platform, HOST_PLATFORM)
      assert.equal(describe.available, true, describe.detail)
      // The resolved entry must be one of this platform's own catalog rows.
      assert.ok(catalogFor(HOST_PLATFORM).some(entry => entry.id === describe.id))
      if (HOST_PLATFORM === 'windows') {
        // PowerShell, not cmd: this is the family the harness's Windows executor
        // runs, so installing the plugin does not change which shell an agent
        // gets. Which PowerShell depends on what this host has — 7 leads the
        // catalog, 5.1 is the fallback every Windows host carries.
        const preferred = await available(shell, 'pwsh') ? 'pwsh' : 'powershell'
        assert.equal(describe.id, preferred)
        assert.equal(describe.dialect, 'powershell')
        assert.notEqual(describe.id, 'cmd', 'auto must not downgrade to cmd')
      } else {
        // `$SHELL` when it names a catalog entry, otherwise catalog order. Both
        // answers are installed shells, which is the property that matters.
        assert.ok(['bash', 'zsh', 'fish', 'sh', 'pwsh'].includes(describe.id))
      }
      const script = scriptsFor(describe.dialect)
      const result = await run(shell, script.echo, { mode: await caseMode(describe.id) })
      assert.equal(result.exitCode, 0, result.stderr.text)
      assert.match(result.stdout.text, /MARK-OK/u)
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})

describe(`${HOST_PLATFORM} lane: catalog coverage of this host`, () => {
  it('reports every entry of this platform through the real execution world', async () => {
    const { ctx, shell } = await boot({ shell: 'auto' })
    try {
      const rows = await shell.describeCatalog()
      assert.deepEqual(rows.map(row => row.id), catalogFor(HOST_PLATFORM).map(entry => entry.id))
      for (const row of rows) {
        assert.equal(typeof row.confineable, 'boolean')
        assert.ok(row.syntax.length > 0)
      }
    } finally {
      await ctx.fiber?.dispose?.()
    }
  })
})
