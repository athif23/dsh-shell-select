/**
 * The decision and the model-facing description.
 *
 * These are the properties that separate this plugin from silently degrading
 * ones, so they are asserted at the strongest point available: a refused call
 * must produce *zero* spawn requests, not a spawn whose failure is converted
 * into a refusal afterwards.
 *
 * The decision resolves its executable through the subprocess seam, so a stubbed
 * seam lets every refusal path be driven deterministically, including the
 * Windows-only confinement refusals. Each case is handed the working directory
 * shaped for the platform it simulates (`mount(...).wd`), so a simulated Windows
 * composition runs the same assertions on a POSIX host as on a Windows one;
 * `test/helpers.mjs#workdirFor` says why.
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ShellSelectConfig, ShellSelectExecutor, ShellSelectionRefusedError } from '../src/executor.js'
import { localPlatform } from '../src/catalog.js'
import { shellDescription } from '../src/tool.js'
import { makeContext, makeFixture, removeFixture, stubSandbox, stubSubprocess, workdirFor } from './helpers.mjs'

const fixture = makeFixture('executor')
after(() => { removeFixture(fixture) })

/** This host's real fixture directory, for cases that simulate this host. */
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

/**
 * This host's own platform, a shell it has there, and the executables the stub
 * knows for them.
 *
 * The working-directory existence rule is checked only for the platform this
 * process runs on — a local `stat` cannot answer for another machine — so a case
 * that depends on it has to run as this host, with a fixture path of this host's
 * own shape.
 */
const host = localPlatform() === 'windows'
  ? { platform: 'windows', shell: 'cmd', resolvable: WINDOWS_EXES }
  : { platform: 'posix', shell: 'bash', resolvable: { bash: '/bin/bash' } }

/** Mount the executor over the stubs. */
async function mount(config, options = {}) {
  const subprocess = stubSubprocess({
    platform: options.platform ?? 'windows',
    defaultShell: options.defaultShell,
    resolvable: options.resolvable ?? WINDOWS_EXES,
    delayMsFor: options.delayMsFor,
    onResolve: options.onResolve,
  })
  const sandbox = stubSandbox()
  const context = await makeContext({ ...options, subprocess, sandbox, workspaceRoot: fixture })
  await context.plugin(ShellSelectExecutor, ShellSelectConfig(config))
  const shell = context.shell
  // The constructor refines its provisional selection asynchronously because
  // resolution goes through the seam; asserting the settled answer waits for it.
  await shell.ready
  // The workdir a case must pass: shaped for the platform it simulates, so a
  // simulated Windows composition on a POSIX host is not handed a POSIX path.
  return {
    ctx: context,
    shell,
    subprocess,
    sandbox,
    wd: workdirFor(options.platform ?? 'windows', workdir),
  }
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
    const { shell, subprocess, wd } = await mount({ shell: 'gitbash' }, { platform: 'posix' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: wd })
    assert.match(error.message, /does not exist on posix/u)
    assert.match(error.message, /Available: bash, zsh, fish, sh, pwsh/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a shell whose executable resolves nowhere', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' }, { resolvable: {} })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: wd })
    assert.match(error.message, /no Command Prompt \(cmd\.exe\) executable found/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a missing working directory', async () => {
    // Existence is a fact about one filesystem, so this case runs on the platform
    // this process is on, with a fixture path of that platform's own shape: the
    // existence rule is what must refuse, and a path shaped for another platform
    // would be refused by the shape rule before it was ever looked for.
    const { shell, subprocess } = await mount(
      { shell: host.shell },
      { platform: host.platform, resolvable: host.resolvable },
    )
    const { error } = await attempt(shell, { command: 'echo hi', workdir: missingWorkdir })
    assert.match(error.message, /working directory does not exist/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a working directory shaped for another platform', async () => {
    // The shape rule is a pure function of the platform, so it answers the same
    // way on every host — this POSIX path is refused by a Windows composition
    // wherever the suite runs.
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: '/tmp/work' })
    assert.match(error.message, /must be an absolute windows path/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a working directory that is not absolute for this platform', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'bash' }, { platform: 'posix' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: 'C:\\work' })
    assert.match(error.message, /must be an absolute posix path/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a blank working directory rather than defaulting one', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const spec = shell.resolve({ command: 'echo hi' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: '' })
    assert.match(error.message, /without a working directory|absolute windows path/u)
    assert.equal(spec.workdir.length > 0, true, 'the executor still defaults a normal spec')
    assert.equal(subprocess.spawns.length, 0)
  })

  it('fails a login shell asked of a dialect that has no such flag', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd', loginShell: true })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: wd })
    assert.match(error.message, /"loginShell" applies to bash-family shells only/u)
    assert.equal(subprocess.spawns.length, 0)
  })

  it('refuses an unresolved sandbox policy, even on a forged spec', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const spec = { ...shell.resolve({ command: 'x', workdir: wd }), sandboxPolicy: undefined }
    await assert.rejects(() => shell.run(spec), /without a resolved sandbox policy/u)
    assert.equal(subprocess.spawns.length, 0)
  })
})

describe('unsupported permission modes fail closed', () => {
  for (const id of ['gitbash', 'wsl']) {
    for (const mode of ['read-only', 'workspace-write']) {
      it(`refuses ${id} under ${mode}`, async () => {
        const { shell, subprocess, wd } = await mount({ shell: id })
        const { error } = await attempt(shell, {
          command: 'echo hi',
          workdir: wd,
          sandboxPolicy: { mode, workspaceRoot: wd },
        })
        assert.ok(error instanceof ShellSelectionRefusedError, `expected a refusal, got ${error}`)
        assert.equal(error.shellId, id)
        assert.equal(error.mode, mode)
        assert.equal(subprocess.spawns.length, 0)
      })
    }
  }

  it('names the shell, the mode, and the legal ways out in the refusal', async () => {
    const { shell, wd } = await mount({ shell: 'wsl' })
    const { error } = await attempt(shell, {
      command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: wd },
    })
    assert.match(error.message, /WSL Bash/u)
    assert.match(error.message, /workspace-write/u)
    assert.match(error.message, /never falls back to another shell/u)
  })

  it('allows the same shell once the user has chosen danger-full-access', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'gitbash' })
    const { result } = await attempt(shell, {
      command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: wd },
    })
    assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
    assert.equal(subprocess.spawns.length, 1)
  })
})

describe('never downgrades the permission mode', () => {
  it('passes the caller-resolved mode through unchanged', async () => {
    const { shell, wd } = await mount({ shell: 'cmd' })
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
      const spec = shell.resolve({ command: 'x', workdir: wd, sandboxPolicy: { mode, workspaceRoot: wd } })
      assert.equal(spec.sandboxPolicy.mode, mode)
      assert.equal(spec.sandboxPolicy.workspaceRoot, wd)
    }
  })

  it('confines a confinable shell rather than running around the sandbox', async () => {
    const { shell, sandbox, subprocess, wd } = await mount({ shell: 'cmd' })
    await attempt(shell, {
      command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: wd },
    })
    assert.equal(sandbox.calls.length, 1, 'the mode must reach ctx.sandbox.confine')
    assert.equal(sandbox.calls[0].policy.mode, 'workspace-write')
    assert.equal(subprocess.spawns.length, 1)
  })

  it('never calls confine under danger-full-access', async () => {
    const { shell, sandbox, wd } = await mount({ shell: 'cmd' })
    await attempt(shell, {
      command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: wd },
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
      const { shell, subprocess, wd } = await mount({ shell: testCase.shell })
      await attempt(shell, {
        command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: wd },
      })
      assert.equal(subprocess.spawns.length, 1, testCase.shell)
      const spawn = subprocess.spawns[0]
      assert.deepEqual(spawn.argv.slice(0, testCase.head.length), testCase.head, testCase.shell)
      assert.equal(spawn.cwd, wd, testCase.shell)
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
    const { shell, subprocess, wd } = await mount({ shell: 'gitbash', loginShell: true })
    await attempt(shell, {
      command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: wd },
    })
    assert.deepEqual(subprocess.spawns[0].argv, ['D:\\Git\\bin\\bash.exe', '-l', '-c', 'echo hi'])
  })
})

describe('one immutable decision per call', () => {
  /** The full-access policy the argv assertions use, so nothing is confined. The
   * root is only carried, never validated here, so it names the fixture itself. */
  const policy = mode => ({ mode, workspaceRoot: workdir })

  it('decides the entry, the executable, and the launch options together', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'gitbash', loginShell: true })
    const decided = await shell.decide(shell.resolve({
      command: 'echo hi',
      workdir: wd,
      sandboxPolicy: policy('danger-full-access'),
    }))
    assert.equal(decided.decision.shell.id, 'gitbash')
    assert.equal(decided.decision.executable, 'D:\\Git\\bin\\bash.exe')
    assert.deepEqual(decided.decision.argv, ['D:\\Git\\bin\\bash.exe', '-l', '-c', 'echo hi'])
    await shell.run(decided.spec)
    assert.deepEqual(subprocess.spawns[0].argv, decided.decision.argv,
      'the spawn is the decision, not a second reading of the settings')
  })

  it('keeps the decided shell when the settings change before the spawn', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const decided = await shell.decide(shell.resolve({
      command: 'echo hi', workdir: wd, sandboxPolicy: policy('danger-full-access'),
    }))
    // The settings document is rewritten between the decision and the spawn.
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh', loginShell: true })
    await shell.run(decided.spec)
    assert.ok(subprocess.spawns[0].argv[0].toLowerCase().endsWith('cmd.exe'), 'the decided shell ran')
    assert.equal(subprocess.spawns.length, 1, 'and nothing else ran')
  })

  it('keeps the decided launch options when the settings change before the spawn', async () => {
    // A mixed call — one shell's executable with another revision's flags — is
    // what a per-field re-read would produce.
    const { shell, subprocess, wd } = await mount({ shell: 'gitbash', loginShell: true })
    const decided = await shell.decide(shell.resolve({
      command: 'echo hi', workdir: wd, sandboxPolicy: policy('danger-full-access'),
    }))
    shell.shellSettings = () => ShellSelectConfig({ shell: 'gitbash', loginShell: false })
    await shell.run(decided.spec)
    assert.deepEqual(subprocess.spawns[0].argv, ['D:\\Git\\bin\\bash.exe', '-l', '-c', 'echo hi'])
  })

  it('starts a background process from the decision it was given', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const decided = await shell.decide(shell.resolve({
      command: 'echo hi', workdir: wd, sandboxPolicy: policy('danger-full-access'),
    }))
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    const proc = await shell.start({ ...decided.spec, signal: undefined })
    await proc.done
    assert.ok(subprocess.spawns[0].argv[0].toLowerCase().endsWith('cmd.exe'))
  })

  it('reads the next call from the next snapshot', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const first = await shell.decide(shell.resolve({
      command: 'echo hi', workdir: wd, sandboxPolicy: policy('danger-full-access'),
    }))
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    const second = await shell.decide(shell.resolve({
      command: 'echo hi', workdir: wd, sandboxPolicy: policy('danger-full-access'),
    }))
    assert.equal(first.decision.shell.id, 'cmd')
    assert.equal(second.decision.shell.id, 'pwsh')
    await shell.run(first.spec)
    await shell.run(second.spec)
    assert.deepEqual(
      subprocess.spawns.map(spawn => spawn.argv[0].toLowerCase().endsWith('cmd.exe') ? 'cmd' : 'pwsh'),
      ['cmd', 'pwsh'],
    )
  })
})

describe('races between a call and the selection', () => {
  it('does not let an in-flight call overwrite a refreshed description', async () => {
    // The call resolves slowly through the seam; meanwhile the selection moves
    // on and the description refreshes. The finishing call describes itself, not
    // the selection.
    const { shell, wd } = await mount({ shell: 'cmd' }, {
      delayMsFor: command => command.toLowerCase().endsWith('cmd.exe') ? 40 : 0,
    })
    const pending = shell.run(shell.resolve({
      command: 'echo hi',
      workdir: wd,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: wd },
    }))
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    await shell.refreshSelection()
    assert.equal(shell.describeShell().id, 'pwsh')
    await pending
    assert.equal(shell.describeShell().id, 'pwsh', 'the finished call left the description alone')
  })

  it('never lets an older selection refresh overwrite a newer one', async () => {
    // Two refreshes overlap and the older one settles last, which is what a
    // settings write during the first read produces. The newest answer must
    // stand, in the cache the description is built from.
    const { shell, wd } = await mount({ shell: 'cmd' }, {
      delayMsFor: command => command.toLowerCase().endsWith('cmd.exe') ? 60 : 0,
    })
    const older = shell.refreshSelection()
    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    const newer = shell.refreshSelection()
    assert.equal((await newer).entry.id, 'pwsh')
    assert.equal((await older).entry.id, 'pwsh', 'the slow, superseded answer does not publish')
    assert.equal(shell.describeShell().id, 'pwsh')
  })

  it('publishes several concurrent refreshes as the newest one', async () => {
    const { shell, wd } = await mount({ shell: 'cmd' }, {
      delayMsFor: command => command.toLowerCase().endsWith('cmd.exe') ? 30 : 0,
    })
    const first = shell.refreshSelection()
    const second = shell.refreshSelection()
    shell.shellSettings = () => ShellSelectConfig({ shell: 'powershell' })
    const third = shell.refreshSelection()
    const settled = await Promise.all([first, second, third])
    assert.deepEqual(settled.map(selection => selection.entry.id), ['powershell', 'powershell', 'powershell'])
  })
})

describe('auto selection', () => {
  it('takes the catalog preference on Windows, not %ComSpec%', async () => {
    // Every Windows host reports cmd.exe as its default shell, so following it
    // would silently downgrade a deployment that the harness ships running
    // PowerShell. Catalog order decides instead.
    const { shell, wd } = await mount({ shell: 'auto' }, { defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    assert.equal(shell.describeShell().id, 'pwsh', 'PowerShell 7 leads the Windows catalog')
  })

  it('follows $SHELL on POSIX, where it is a real preference', async () => {
    const { shell, wd } = await mount(
      { shell: 'auto' },
      { platform: 'posix', defaultShell: '/usr/bin/fish', resolvable: { bash: '/bin/bash', fish: '/usr/bin/fish' } },
    )
    assert.equal(shell.describeShell().id, 'fish')
  })

  it('falls through to the catalog when the preferred shell is not installed', async () => {
    const { shell, wd } = await mount(
      { shell: 'auto' },
      { platform: 'posix', defaultShell: '/usr/bin/fish', resolvable: { bash: '/bin/bash' } },
    )
    assert.equal(shell.describeShell().id, 'bash', 'an uninstalled preference is skipped, not refused')
  })

  it('picks the first shell that resolves when nothing is preferred', async () => {
    const { shell, wd } = await mount({ shell: 'auto' }, { resolvable: { 'wsl.exe': 'C:\\Windows\\System32\\wsl.exe' } })
    assert.equal(shell.describeShell().id, 'wsl')
  })

  it('describes an empty catalog as a machine problem, not a bad setting', async () => {
    // `auto` is not a shell name, so telling the user that "auto" does not exist
    // on Windows describes the setting instead of the machine — and sends them
    // looking for a typo that is not there.
    const { shell, wd } = await mount({ shell: 'auto' }, { resolvable: {} })
    const describe = shell.describeShell()
    assert.equal(describe.available, false)
    assert.match(describe.detail, /no shell in the windows catalog resolved/u)
    assert.ok(!describe.detail.includes('"auto"'), 'the setting is not reported as a missing shell')
    assert.match(describe.detail, /set "shell" to one of them, or "executable"/u)

    const { error } = await attempt(shell, { command: 'echo hi', workdir: wd })
    assert.match(error.message, /no shell in the windows catalog resolved/u)
    assert.ok(!error.message.includes('"auto"'))
  })

  it('still names a genuinely unknown shell', async () => {
    const { shell, wd } = await mount({ shell: 'gitbash' }, { platform: 'posix' })
    const { error } = await attempt(shell, { command: 'echo hi', workdir: wd })
    assert.match(error.message, /the selected shell "gitbash" does not exist on posix/u)
  })

  it('reports the resolved id rather than the word auto', async () => {
    const { shell, wd } = await mount({ shell: 'auto' }, { defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    assert.equal(shell.describeShell().id, 'pwsh')
    assert.notEqual(shell.describeShell().id, 'auto')
  })

  it('reproduces the harness default on each platform', async () => {
    // The property that matters for anyone installing this onto a working
    // deployment: `auto` must not change which shell runs.
    const windows = await mount({ shell: 'auto' }, { defaultShell: 'C:\\Windows\\system32\\cmd.exe' })
    assert.match(windows.shell.describeShell().dialect, /powershell/u)
    const posix = await mount(
      { shell: 'auto' },
      { platform: 'posix', defaultShell: '/bin/bash', resolvable: { bash: '/bin/bash' } },
    )
    assert.equal(posix.shell.describeShell().id, 'bash')
  })
})

describe('auto resolves for itself, not through the selection', () => {
  /** The policy a decision needs; the root is carried, never validated here. */
  const policy = mode => ({ mode, workspaceRoot: workdir })

  /** What a call under the current settings would actually run. */
  async function decidedShell(mounted) {
    const decided = await mounted.shell.decide(mounted.shell.resolve({
      command: 'echo hi', workdir: mounted.wd, sandboxPolicy: policy('danger-full-access'),
    }))
    return decided.decision.shell
  }

  it('names the shell the machine picks while another one is selected', async () => {
    // An explicit selection and Automatic are different questions: Git Bash is
    // selected here, and the catalog order — not the selection — decides what
    // Automatic would run.
    const mounted = await mount({ shell: 'gitbash' })
    const auto = await mounted.shell.resolveAuto()
    assert.equal(auto.entry.id, 'pwsh')
    assert.equal(auto.available, true)
    assert.equal(auto.path, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    assert.equal(auto.source, 'discovered')
    assert.equal(mounted.shell.describeShell().id, 'gitbash', 'the selection is unchanged by asking')
  })

  it('lets an executable override name the shell auto runs', async () => {
    // `resolveEntry` gives an override that names a shell the claim, so the two
    // configurations the card distinguishes — with and without the override —
    // resolve differently, and the override's own path is what runs.
    const mounted = await mount({ shell: 'cmd' })
    const withOverride = await mounted.shell.resolveAuto({ executable: 'D:\\Git\\bin\\bash.exe' })
    assert.equal(withOverride.entry.id, 'gitbash')
    assert.equal(withOverride.path, 'D:\\Git\\bin\\bash.exe')
    assert.equal(withOverride.source, 'configured')
    const without = await mounted.shell.resolveAuto({ executable: '' })
    assert.equal(without.entry.id, 'pwsh')
    assert.notEqual(without.path, withOverride.path)
  })

  it('follows the world\'s preference where it is a real one', async () => {
    const mounted = await mount(
      { shell: 'cmd' },
      { platform: 'posix', defaultShell: '/usr/bin/fish', resolvable: { bash: '/bin/bash', fish: '/usr/bin/fish' } },
    )
    assert.equal((await mounted.shell.resolveAuto()).entry.id, 'fish')
  })

  it('reports a machine with nothing to pick rather than a shell name', async () => {
    const mounted = await mount({ shell: 'cmd' }, { resolvable: {} })
    const auto = await mounted.shell.resolveAuto()
    assert.equal(auto.entry, undefined)
    assert.equal(auto.available, false)
    assert.match(auto.detail, /no shell in the windows catalog resolved/u)
    assert.ok(!auto.detail.includes('"auto"'), 'the setting is not reported as a missing shell')
  })

  it('is what a call would run when the selection is auto', async () => {
    // The property the card depends on: what it shows for Automatic is the shell
    // a command resolves to, and the executable it resolves to, for the same
    // configuration.
    for (const config of [
      { shell: 'auto' },
      { shell: 'auto', executable: 'D:\\Git\\bin\\bash.exe' },
      { shell: 'auto', executable: 'D:\\Git\\bin\\bash.exe', loginShell: true },
    ]) {
      const mounted = await mount(config)
      const auto = await mounted.shell.resolveAuto()
      const shell = await decidedShell(mounted)
      assert.equal(auto.entry.id, shell.id, JSON.stringify(config))
      assert.equal(auto.path, shell.executable, JSON.stringify(config))
    }
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
      const { shell, wd } = await mount({ shell: testCase.shell })
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
    const { shell, wd } = await mount(
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
    const { shell, wd } = await mount({ shell: 'bash' }, { platform: 'posix', resolvable: {} })
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
    const { shell, wd } = await mount({ shell: 'cmd' })
    const text = shellDescription(shell.describeShell(), false, [])
    assert.ok(!text.includes('run_in_background'))
    assert.match(text, /Background execution is not available/u)
  })
})

describe('the selection is read live', () => {
  it('reflects a settings change on the next call without disturbing a resolved spec', async () => {
    const { shell, subprocess, wd } = await mount({ shell: 'cmd' })
    const before = shell.resolve({ command: 'x', workdir: wd })
    assert.equal(shell.describeShell().id, 'cmd')

    shell.shellSettings = () => ShellSelectConfig({ shell: 'pwsh' })
    // A live settings write refreshes the cache through installSection's
    // onChange; this test bypasses the settings service, so it refreshes here.
    await shell.refreshSelection()
    assert.equal(shell.describeShell().id, 'pwsh')
    // The spec produced under the previous selection keeps its own policy; the
    // executor decides afresh per call, which is what makes the next call use
    // the new shell.
    assert.equal(before.sandboxPolicy.mode, 'workspace-write')

    await attempt(shell, {
      command: 'echo hi', workdir: wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: wd },
    })
    assert.ok(subprocess.spawns[0].argv[0].toLowerCase().endsWith('pwsh.exe'), 'the next call used the new shell')
  })
  it('keeps shell.pwshPath working for PowerShell entries', async () => {
    const custom = 'D:\\tools\\pwsh.exe'
    const { shell, wd } = await mount({ shell: 'pwsh', pwshPath: custom }, { resolvable: { [custom]: custom } })
    assert.equal(shell.describeShell().executable, custom)
  })

  it('resolves the same executable for the card and for a call', async () => {
    // The card's rows and the decision a call makes apply one override rule, so
    // what the settings surface reports as effective is what a command runs —
    // including the inherited `shell.pwshPath` an existing deployment set.
    const custom = 'D:\\tools\\pwsh.exe'
    const viaInherited = await mount(
      { shell: 'pwsh', pwshPath: custom },
      { resolvable: { [custom]: custom } },
    )
    const inheritedRows = await viaInherited.shell.describeCatalog()
    const inheritedCall = await viaInherited.shell.decide(viaInherited.shell.resolve({
      command: 'x', workdir: viaInherited.wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: viaInherited.wd },
    }))
    assert.equal(inheritedRows.find(row => row.id === 'pwsh').path, custom)
    assert.equal(inheritedCall.decision.executable, custom)

    const override = 'C:\\tools\\cmd.exe'
    const viaOverride = await mount({ shell: 'cmd', executable: override }, { resolvable: { [override]: override } })
    const overrideRows = await viaOverride.shell.describeCatalog()
    const overrideCall = await viaOverride.shell.decide(viaOverride.shell.resolve({
      command: 'x', workdir: viaOverride.wd, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: viaOverride.wd },
    }))
    assert.equal(overrideRows.find(row => row.id === 'cmd').path, override)
    assert.equal(overrideCall.decision.executable, override)
    // The override names one shell, so no other row reports it as its own.
    assert.ok(overrideRows.filter(row => row.path === override).length === 1)
  })

  it('lets the shell-select executable override win over shell.pwshPath', async () => {
    const custom = 'D:\\tools\\pwsh.exe'
    const other = 'E:\\other\\pwsh.exe'
    const { shell, wd } = await mount(
      { shell: 'pwsh', pwshPath: other, executable: custom },
      { resolvable: { [custom]: custom, [other]: other } },
    )
    assert.equal(shell.describeShell().executable, custom)
  })
})
