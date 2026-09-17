/**
 * The gate and the model-facing description.
 *
 * These are the properties that separate this plugin from silently degrading
 * ones, so they are asserted at the strongest point available: a refused call
 * must produce *zero* spawn requests, not a spawn whose failure is converted
 * into a refusal afterwards.
 *
 * The gate resolves its executable through the subprocess seam, so a stubbed
 * seam lets every refusal path be driven deterministically, including the
 * Windows-only confinement refusals.
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ShellSelectConfig, ShellSelectExecutor, ShellSelectionRefusedError } from '../src/executor.js'
import { shellDescription } from '../src/tool.js'
import { makeContext, makeFixture, removeFixture, stubSandbox, stubSubprocess } from './helpers.mjs'

const fixture = makeFixture('executor')
after(() => { removeFixture(fixture) })

const workdir = join(fixture, 'work')
mkdirSync(workdir, { recursive: true })
const missingWorkdir = join(fixture, 'gone')

/** Executables the stub seam knows, per platform. */
const WINDOWS_EXES = {
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  cmd: 'C:\\Windows\\system32\\cmd.exe',
  'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe',
  'wsl.exe': 'C:\\Windows\\System32\\wsl.exe',
  'cmd.exe': 'C:\\Windows\\system32\\cmd.exe',
  'bash.exe': 'D:\\Git\\bin\\bash.exe',
  'pwsh.exe': 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
}

/** Mount the executor over the stubs. */
async function mount(config, options = {}) {
  const subprocess = stubSubprocess({
    platform: options.platform ?? 'windows',
    defaultShell: options.defaultShell,
    resolvable: options.resolvable ?? WINDOWS_EXES,
  })
  const sandbox = stubSandbox()
  const context = await makeContext({ ...options, subprocess, sandbox, workspaceRoot: fixture })
  await context.plugin(ShellSelectExecutor, ShellSelectConfig(config))
  const shell = context.shell
  // The constructor refines its provisional selection asynchronously because
  // resolution goes through the seam; asserting the settled answer waits for it.
  await shell.ready
  return { ctx: context, shell, subprocess, sandbox }
}

/** Run one command and return the recorded spawn, or the thrown error. */
async function attempt(shell, request) {
  try {
    return { result: await shell.run(shell.resolve(request)) }
  } catch (error) {
    return { error }
  }
}

describe('refuses before any process exists', () => {
  it('fails a shell this platform does not have', async () => {
    const { shell, subprocess } = await mount({ shell: 'gitbash' }, { platform: 'posix' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir })
    assert.match(error.message, /does not exist on posix/u)
    assert.match(error.message, /Available: zsh, bash, fish, sh, pwsh/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a shell whose executable resolves nowhere', async () => {
    const { shell, subprocess } = await mount({ shell: 'cmd' }, { resolvable: {} })
    const { error } = await attempt(shell, { command: 'echo hi', workdir })
    assert.match(error.message, /no Command Prompt \(cmd\.exe\) executable found/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a missing working directory', async () => {
    const { shell, subprocess } = await mount({ shell: 'cmd' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: missingWorkdir })
    assert.match(error.message, /working directory does not exist/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a working directory that is not absolute for this platform', async () => {
    const { shell, subprocess } = await mount({ shell: 'bash' }, { platform: 'posix' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: 'C:\\work' })
    assert.match(error.message, /must be an absolute posix path/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a blank working directory rather than defaulting one', async () => {
    const { shell, subprocess } = await mount({ shell: 'cmd' })
    const spec = shell.resolve({ command: 'echo hi' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: '' })
    assert.match(error.message, /without a working directory|absolute windows path/u)
    assert.equal(spec.workdir.length > 0, true, 'the executor still defaults a normal spec')
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a login shell asked of a dialect that has no such flag', async () => {
    const { shell, subprocess } = await mount({ shell: 'cmd', loginShell: true })
    const { error } = await attempt(shell, { command: 'echo hi', workdir })
    assert.match(error.message, /"loginShell" applies to bash-family shells only/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('refuses an unresolved sandbox policy, even on a forged spec', async () => {
    const { shell, subprocess } = await mount({ shell: 'cmd' })
    const spec = { ...shell.resolve({ command: 'x', workdir }), sandboxPolicy: undefined }
    await assert.rejects(() => shell.run(spec), /without a resolved sandbox policy/u)
    assert.equal(subprocess.spawns.length, 0)
  })
})

describe('unsupported permission modes fail closed', () => {
  for (const id of ['gitbash', 'wsl']) {
    for (const mode of ['read-only', 'workspace-write']) {
      it(`refuses ${id} under ${mode}`, async () => {
        const { shell, subprocess } = await mount({ shell: id })
        const { error } = await attempt(shell, {
          command: 'echo hi',
          workdir,
          sandboxPolicy: { mode, workspaceRoot: workdir },
        })
        assert.ok(error instanceof ShellSelectionRefusedError, `expected a refusal, got ${error}`)
        assert.equal(error.shellId, id)
        assert.equal(error.mode, mode)
        assert.equal(subprocess.spawns.length, 0)
      })
    }
  }

  it('names the shell, the mode, and the legal ways out in the refusal', async () => {
    const { shell } = await mount({ shell: 'wsl' })
    const { error } = await attempt(shell, {
      command: 'echo hi', workdir, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workdir },
    })
    assert.match(error.message, /WSL Bash/u)
    assert.match(error.message, /workspace-write/u)
    assert.match(error.message, /never falls back to another shell/u)
  })

  it('allows the same shell once the user has chosen danger-full-access', async () => {
    const { shell, subprocess } = await mount({ shell: 'gitbash' })
    const { result } = await attempt(shell, {
      command: 'echo hi', workdir, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
    })
    assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
    assert.equal(subprocess.spawns.length, 1)
  })
})

describe('never downgrades the permission mode', () => {
  it('passes the caller-resolved mode through unchanged', async () => {
    const { shell } = await mount({ shell: 'cmd' })
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
      const spec = shell.resolve({ command: 'x', workdir, sandboxPolicy: { mode, workspaceRoot: workdir } })
      assert.equal(spec.sandboxPolicy.mode, mode)
      assert.equal(spec.sandboxPolicy.workspaceRoot, workdir)
    }
  })

  it('confines a confinable shell rather than running around the sandbox', async () => {
    const { shell, sandbox, subprocess } = await mount({ shell: 'cmd' })
    await attempt(shell, {
      command: 'echo hi', workdir, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workdir },
    })
    assert.equal(sandbox.calls.length, 1, 'the mode must reach ctx.sandbox.confine')
    assert.equal(sandbox.calls[0].policy.mode, 'workspace-write')
    assert.equal(subprocess.spawns.length, 1)
  })

  it('never calls confine under danger-full-access', async () => {
    const { shell, sandbox } = await mount({ shell: 'cmd' })
    await attempt(shell, {
      command: 'echo hi', workdir, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
    })
    assert.equal(sandbox.calls.length, 0)
  })
})

describe('argv reaches the process per dialect', () => {
  it('spawns the selected shell with its own switches', async () => {
    const cases = [
      {
        shell: 'pwsh',
        head: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      },
      { shell: 'cmd', head: ['C:\\Windows\\system32\\cmd.exe', '/d', '/q', '/c'] },
      { shell: 'gitbash', head: ['D:\\Git\\bin\\bash.exe', '-c'] },
      { shell: 'wsl', head: ['C:\\Windows\\System32\\wsl.exe', '--cd'] },
    ]
    for (const testCase of cases) {
      const { shell, subprocess } = await mount({ shell: testCase.shell })
      await attempt(shell, {
        command: 'echo hi', workdir, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
      })
      assert.equal(subprocess.spawns.length, 1, testCase.shell)
      const spawn = subprocess.spawns[0]
      assert.deepEqual(spawn.argv.slice(0, testCase.head.length), testCase.head, testCase.shell)
      assert.equal(spawn.cwd, workdir, testCase.shell)
      if (testCase.shell === 'gitbash') {
        // Plain `-c` is already hermetic: bash sources its rc files only for an
        // interactive shell, so no extra flags are needed to stay out of them.
        assert.deepEqual(spawn.argv, ['D:\\Git\\bin\\bash.exe', '-c', 'echo hi'])
      }
      if (testCase.shell === 'cmd') {
        // The command text must arrive through the environment, never argv.
        assert.equal(spawn.env.DSH_SHELL_SELECT_COMMAND, 'echo hi')
        assert.ok(!spawn.argv.some(part => part.includes('echo hi')))
      }
      if (testCase.shell === 'wsl') {
        assert.ok(spawn.argv.includes('-e'))
        assert.ok(spawn.argv.includes('bash'))
      }
    }
  })

  it('adds the login flag only when asked', async () => {
    const { shell, subprocess } = await mount({ shell: 'gitbash', loginShell: true })
    await attempt(shell, {
      command: 'echo hi', workdir, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
    })
    assert.deepEqual(subprocess.spawns[0].argv, ['D:\\Git\\bin\\bash.exe', '-l', '-c', 'echo hi'])
  })
})

describe('auto selection', () => {
  it('follows the shell the execution world reports as its default', async () => {
    const { shell } = await mount(
      { shell: 'auto' },
      { defaultShell: 'C:\\Windows\\system32\\cmd.exe' },
    )
    assert.equal(shell.describeShell().id, 'cmd')
  })

  it('picks the first shell that resolves when the world reports no default', async () => {
    const { shell } = await mount({ shell: 'auto' }, { resolvable: { 'wsl.exe': 'C:\\Windows\\System32\\wsl.exe' } })
    assert.equal(shell.describeShell().id, 'wsl')
  })

  it('reports the resolved id rather than the word auto', async () => {
    const { shell } = await mount({ shell: 'auto' }, { defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    assert.equal(shell.describeShell().id, 'cmd')
    assert.notEqual(shell.describeShell().id, 'auto')
  })
})

describe('model-facing description follows the selection', () => {
  it('names the shell, its executable, and its platform', async () => {
    const cases = [
      { shell: 'pwsh', label: 'PowerShell', executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
      { shell: 'cmd', label: 'Command Prompt', executable: 'C:\\Windows\\system32\\cmd.exe' },
      { shell: 'gitbash', label: 'Git Bash', executable: 'D:\\Git\\bin\\bash.exe' },
      { shell: 'wsl', label: 'WSL Bash', executable: 'C:\\Windows\\System32\\wsl.exe' },
    ]
    for (const testCase of cases) {
      const { shell } = await mount({ shell: testCase.shell })
      const text = shellDescription(shell.describeShell(), true, ['workspace-write', 'danger-full-access'])
      assert.ok(text.includes(testCase.label), `${testCase.shell} label missing`)
      assert.ok(text.includes(testCase.executable), `${testCase.shell} executable missing`)
      assert.ok(text.includes('windows'), `${testCase.shell} platform missing`)
      assert.ok(text.includes('run_in_background'), testCase.shell)
    }
  })

  it('states the selected shell\'s own syntax conventions', async () => {
    const wsl = await mount({ shell: 'wsl' })
    assert.ok(shellDescription(wsl.shell.describeShell(), true, []).includes('/mnt/'))
    const cmd = await mount({ shell: 'cmd' })
    assert.ok(shellDescription(cmd.shell.describeShell(), true, []).includes('%NAME%'))
  })

  it('describes a POSIX selection from the POSIX catalog', async () => {
    const { shell } = await mount(
      { shell: 'fish' },
      { platform: 'posix', resolvable: { fish: '/usr/bin/fish' } },
    )
    const describe = shell.describeShell()
    assert.equal(describe.id, 'fish')
    assert.equal(describe.platform, 'posix')
    assert.equal(describe.executable, '/usr/bin/fish')
    assert.match(shellDescription(describe, true, []), /NOT POSIX/u)
  })

  it('warns instead of pretending when the shell cannot be resolved', async () => {
    const { shell } = await mount({ shell: 'bash' }, { platform: 'posix', resolvable: {} })
    const describe = shell.describeShell()
    assert.equal(describe.available, false)
    const text = shellDescription(describe, true, [])
    assert.match(text, /WARNING/u)
    assert.match(text, /Commands will be refused/u)
  })

  it('reports the confinement capability of the selected shell', async () => {
    const confinable = await mount({ shell: 'cmd' })
    assert.equal(confinable.shell.describeShell().confineable, true)
    const notConfinable = await mount({ shell: 'wsl' })
    const describe = notConfinable.shell.describeShell()
    assert.equal(describe.confineable, false)
    assert.match(describe.confineReason, /E_ACCESSDENIED/u)
  })

  it('omits the background sentence when background execution is disabled', async () => {
    const { shell } = await mount({ shell: 'cmd' })
    const text = shellDescription(shell.describeShell(), false, [])
    assert.ok(!text.includes('run_in_background'))
    assert.match(text, /Background execution is not available/u)
  })
})

describe('the selection is read live', () => {
  it('reflects a settings change on the next call without disturbing a resolved spec', async () => {
    const { shell, subprocess } = await mount({ shell: 'cmd' })
    const before = shell.resolve({ command: 'x', workdir })
    assert.equal(shell.describeShell().id, 'cmd')

    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    // A live settings write refreshes the cache through installSection's
    // onChange; this test bypasses the settings service, so it refreshes here.
    await shell.refreshSelection()
    assert.equal(shell.describeShell().id, 'pwsh')
    // The spec produced under the previous selection keeps its own policy; the
    // executor re-reads the selection per call, which is why the gate re-runs.
    assert.equal(before.sandboxPolicy.mode, 'workspace-write')

    await attempt(shell, {
      command: 'echo hi', workdir, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
    })
    assert.ok(subprocess.spawns[0].argv[0].toLowerCase().endsWith('pwsh.exe'), 'the next call used the new shell')
  })

  it('keeps shell.pwshPath working for PowerShell entries', async () => {
    const custom = 'D:\\tools\\pwsh.exe'
    const { shell } = await mount({ shell: 'pwsh', pwshPath: custom }, { resolvable: { [custom]: custom } })
    assert.equal(shell.describeShell().executable, custom)
  })

  it('lets the shell-select executable override win over shell.pwshPath', async () => {
    const custom = 'D:\\tools\\pwsh.exe'
    const other = 'E:\\other\\pwsh.exe'
    const { shell } = await mount(
      { shell: 'pwsh', pwshPath: other, executable: custom },
      { resolvable: { [custom]: custom, [other]: other } },
    )
    assert.equal(shell.describeShell().executable, custom)
  })
})
