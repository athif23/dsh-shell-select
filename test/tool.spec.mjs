/**
 * The tool's per-call metadata and its decision ordering.
 *
 * The transcript records the shell, the executable, and the working directory of
 * the call, and a user reads that record to know what ran. So the fact block has
 * to come from the call's own decision rather than from the cached description
 * of the current selection: a settings write lands between the model's call and
 * the spawn, and the cached description can lag it by design.
 *
 * The tool is mounted over stubbed host services — `tools`, `jobs`,
 * `systemPrompt`, `shellEnv` — because only the shell executor and the decision
 * are under test here; the composition that supplies the rest is covered by the
 * integration suite.
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ShellSelectConfig, ShellSelectExecutor } from '../src/executor.js'
import { registerShellTool } from '../src/tool.js'
import { makeContext, makeFixture, removeFixture, stubSandbox, stubSubprocess } from './helpers.mjs'

const fixture = makeFixture('tool')
after(() => { removeFixture(fixture) })

const workdir = join(fixture, 'work')
mkdirSync(workdir, { recursive: true })

const WINDOWS_EXES = {
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  cmd: 'C:\\Windows\\system32\\cmd.exe',
  'cmd.exe': 'C:\\Windows\\system32\\cmd.exe',
  'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe',
  'bash.exe': 'D:\\Git\\bin\\bash.exe',
}

/**
 * Mount the executor plus the tool, over stubbed host services.
 * @param config - the shell-select composition entry.
 * @param options - the seam stand-in options.
 * @returns the tool definition, the executor, and the recorded host calls.
 */
async function mount(config, options = {}) {
  const subprocess = stubSubprocess({
    platform: options.platform ?? 'windows',
    resolvable: options.resolvable ?? WINDOWS_EXES,
    output: options.output,
    outcome: options.outcome,
    delayMsFor: options.delayMsFor,
    onResolve: options.onResolve,
  })
  const ctx = await makeContext({
    mode: options.mode ?? 'workspace-write',
    subprocess,
    sandbox: stubSandbox(),
    workspaceRoot: workdir,
  })
  const registered = []
  const starts = []
  const jobs = {
    start(spec) {
      starts.push(spec)
      return `job-${starts.length}`
    },
  }
  await ctx.plugin({
    name: 'stub-host-services',
    apply(inner) {
      inner.provide('tools', { register: definition => registered.push(definition) })
      inner.provide('jobs', jobs)
      inner.provide('systemPrompt', { section: () => {}, getSectionOrder: () => 0 })
      inner.provide('shellEnv', { collect: () => ({ DSH_TEST: '1' }) })
    },
  })
  await ctx.plugin(ShellSelectExecutor, ShellSelectConfig(config))
  const shell = ctx.shell
  await shell.ready
  registerShellTool(ctx, {
    describeShell: () => shell.describeShell(),
    backgroundEnabled: options.backgroundEnabled ?? true,
  })
  const definition = registered[0]
  assert.ok(definition, 'the tool registered itself')
  return { ctx, shell, subprocess, jobs, starts, definition }
}

/** Run one tool call with the arguments a model would send. */
function call(definition, args, options = {}) {
  const controller = new AbortController()
  if (options.aborted === true) controller.abort()
  return definition.execute({ description: 'run a command', ...args }, {
    signal: controller.signal,
    callId: 'call-1',
  })
}

describe('the result records the call that ran', () => {
  it('names the shell the decision selected, not a stale description', async () => {
    // The settings change and the description has not caught up: it refreshes
    // asynchronously. The call must still report what it ran.
    const { shell, subprocess, definition } = await mount({ shell: 'cmd' })
    assert.equal(shell.describeShell().id, 'cmd')
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })

    const result = await call(definition, { command: 'echo hi' })
    assert.equal(result.shell.shell, 'pwsh', 'the result carries the decided shell')
    assert.equal(result.shell.executable, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    assert.equal(result.shell.workdir, workdir)
    assert.ok(subprocess.spawns[0].argv[0].toLowerCase().endsWith('pwsh.exe'), 'and so did the process')
    assert.equal(shell.describeShell().id, 'cmd', 'the description is a separate, still-stale read')
  })

  it('records the executable and working directory the process really used', async () => {
    // Git Bash cannot be confined, so its argv is only reachable through the
    // full-access mode the plugin allows it under.
    const { subprocess, definition } = await mount(
      { shell: 'gitbash', loginShell: true },
      { mode: 'danger-full-access' },
    )
    const result = await call(definition, { command: 'echo hi' })
    const spawn = subprocess.spawns[0]
    assert.equal(result.shell.executable, spawn.argv[0])
    assert.equal(result.shell.workdir, spawn.cwd)
    assert.deepEqual(spawn.argv.slice(0, 3), ['D:\\Git\\bin\\bash.exe', '-l', '-c'])
  })

  it('keeps the decision when the settings change mid-resolution', async () => {
    // The seam resolves while the settings document is rewritten: one call must
    // not mix a shell from one revision with options from another.
    let shell
    const result = await mount({ shell: 'cmd', loginShell: false }, {
      onResolve: () => {
        shell.shellSettings = () => ShellSelectConfig({ shell: 'gitbash', loginShell: true })
      },
    }).then(async mounted => {
      shell = mounted.shell
      return call(mounted.definition, { command: 'echo hi' })
    })
    assert.equal(result.shell.shell, 'cmd')
  })
})

describe('background calls record their own decision', () => {
  it('reports the shell the job will run, not the cached description', async () => {
    const { shell, starts, definition } = await mount({ shell: 'cmd' })
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    const result = await call(definition, { command: 'echo hi', run_in_background: true })
    assert.equal(result.kind, 'background')
    assert.equal(result.jobId, 'job-1')
    assert.equal(result.shell.shell, 'pwsh')
    assert.equal(starts.length, 1)
  })

  it('runs the decided shell, not whatever is selected when the job starts', async () => {
    const { shell, subprocess, starts, definition } = await mount({ shell: 'cmd' })
    const result = await call(definition, { command: 'echo hi', run_in_background: true })
    assert.equal(result.shell.shell, 'cmd')
    // The job starts later, after the user has switched shells.
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    const job = starts[0]
    const proc = await job.run()
    await proc.done
    assert.ok(subprocess.spawns[0].argv[0].toLowerCase().endsWith('cmd.exe'),
      'the job spawns what the call decided')
  })

  it('refuses an unusable selection before admitting a job', async () => {
    const { shell, starts, subprocess, definition } = await mount({ shell: 'gitbash' })
    await assert.rejects(
      () => call(definition, { command: 'echo hi', run_in_background: true }),
      /cannot be confined by the sandbox on this platform/u,
    )
    assert.equal(starts.length, 0, 'no job is created for a call that cannot run')
    assert.equal(subprocess.spawns.length, 0)
  })

  it('rejects a background call on an aborted tool call before deciding', async () => {
    const { starts, subprocess, definition } = await mount({ shell: 'cmd' })
    await assert.rejects(
      () => call(definition, { command: 'echo hi', run_in_background: true }, { aborted: true }),
      /tool call aborted/u,
    )
    assert.equal(starts.length, 0)
    assert.equal(subprocess.spawns.length, 0)
  })
})

describe('the description states the selected shell', () => {
  it('names the shell and its syntax for the model', async () => {
    const { definition } = await mount({ shell: 'cmd' })
    assert.match(definition.description, /Command Prompt/u)
    assert.match(definition.description, /%NAME%/u)
  })
})
