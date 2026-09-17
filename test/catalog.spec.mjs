/**
 * The catalog and the argument dialects.
 *
 * Both platforms' catalogs are exercised here, on whichever platform the suite
 * runs. The catalog is a pure function of `(platform, env)`, so the POSIX rows
 * are verified as logic even where the shells they name cannot run; what that
 * does and does not establish is recorded in the README.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { candidatePwshPaths } from '@deepseek-ai/dsh-pwsh-local'
import {
  AUTO_SHELL,
  PLATFORMS,
  VERIFIED_CONFINEMENT_PLATFORMS,
  catalogFor,
  checkConfinement,
  checkIdentity,
  entryClaiming,
  findEntry,
} from '../src/catalog.js'
import {
  CMD_COMMAND_ENV,
  buildInvocation,
  testCommand,
  toLinuxPath,
  transportEnv,
  versionArgv,
} from '../src/dialects.js'

/** A synthetic Windows environment so candidate derivation is a pure function. */
const WINDOWS_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  PATH: 'C:\\Windows\\System32;C:\\Windows\\WindowsApps;D:\\Git\\cmd;"C:\\Quoted Dir"',
}

describe('catalog shape', () => {
  it('lists the shells each platform actually has', () => {
    assert.deepEqual(catalogFor('windows').map(entry => entry.id), ['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl'])
    assert.deepEqual(catalogFor('posix').map(entry => entry.id), ['bash', 'zsh', 'fish', 'sh', 'pwsh'])
  })

  it('rejects an unknown platform rather than guessing one', () => {
    assert.throws(() => catalogFor('plan9'), /unknown platform/u)
    assert.deepEqual([...PLATFORMS], ['windows', 'posix'])
  })

  it('keeps auto out of the selectable ids', () => {
    for (const platform of PLATFORMS) {
      assert.ok(!catalogFor(platform).some(entry => entry.id === AUTO_SHELL))
    }
  })

  it('finds entries by id and reports a miss', () => {
    assert.equal(findEntry('posix', 'bash').dialect, 'bash')
    assert.equal(findEntry('windows', 'bash'), undefined, 'bare bash is ambiguous on Windows')
    assert.equal(findEntry('posix', 'wsl'), undefined)
  })

  it('gives every entry a substantive, dialect-accurate syntax note', () => {
    for (const platform of PLATFORMS) {
      for (const entry of catalogFor(platform)) {
        assert.ok(entry.syntax.length > 40, `${platform}/${entry.id} needs a real syntax note`)
        assert.equal(typeof entry.label, 'string')
        assert.ok(['bash', 'powershell', 'cmd', 'wsl'].includes(entry.dialect))
      }
    }
    // The convention the model most easily gets wrong.
    assert.ok(findEntry('windows', 'wsl').syntax.includes('/mnt/'))
    assert.ok(findEntry('windows', 'cmd').syntax.includes('%NAME%'))
    assert.ok(findEntry('posix', 'fish').syntax.includes('NOT POSIX'))
  })
})

describe('the catalog names shells, not paths', () => {
  it('probes only bare names on POSIX', () => {
    for (const entry of catalogFor('posix')) {
      for (const candidate of entry.candidates({ PATH: '/usr/bin:/bin' })) {
        assert.ok(!candidate.includes('/'), `${entry.id} hardcodes a path: ${candidate}`)
        assert.ok(!candidate.includes('\\'), `${entry.id} hardcodes a Windows path: ${candidate}`)
      }
    }
  })

  it('derives every Windows candidate from the environment or from the harness list', () => {
    // Which absolute candidates appear must follow from PATH/SystemRoot/ComSpec
    // and from the harness's own candidatePwshPaths, never from a literal baked
    // into this plugin.
    const withEnv = catalogFor('windows').flatMap(entry => entry.candidates(WINDOWS_ENV))
    assert.ok(withEnv.some(candidate => candidate.toLowerCase() === 'd:\\git\\bin\\bash.exe'), 'Git root from PATH')
    assert.ok(withEnv.some(candidate => candidate.toLowerCase() === 'c:\\quoted dir\\bash.exe'), 'quotes stripped')
    assert.ok(withEnv.includes('cmd.exe'), 'the bare name is always probed')
    assert.ok(withEnv.includes('wsl.exe'))

    // With an empty environment, every absolute candidate that survives must be
    // one the HARNESS contributes: this plugin invents none of its own.
    const harnessKnown = new Set(candidatePwshPaths({}).map(candidate => candidate.toLowerCase()))
    for (const entry of catalogFor('windows')) {
      for (const candidate of entry.candidates({})) {
        if (!/^[A-Za-z]:/u.test(candidate)) continue
        assert.ok(
          harnessKnown.has(candidate.toLowerCase()),
          `${entry.id} invents an absolute path the harness does not name: ${candidate}`,
        )
      }
    }
  })

  it('never proposes a git-bash.exe GUI launcher, and refuses one if configured', () => {
    const gitbash = findEntry('windows', 'gitbash')
    for (const candidate of gitbash.candidates(WINDOWS_ENV)) {
      assert.ok(!candidate.toLowerCase().endsWith('git-bash.exe'), candidate)
    }
    assert.equal(checkIdentity(gitbash, 'D:\\Git\\bin\\bash.exe', 'windows').ok, true)
    const refused = checkIdentity(gitbash, 'D:\\Git\\git-bash.exe', 'windows')
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /expected bash\.exe/u)
  })

  it('excludes the WSL launcher and Store shims from the Git Bash PATH scan', () => {
    for (const candidate of findEntry('windows', 'gitbash').candidates(WINDOWS_ENV)) {
      const lower = candidate.toLowerCase()
      assert.ok(!lower.includes('system32'), candidate)
      assert.ok(!lower.includes('windowsapps'), candidate)
    }
  })
})

describe('the identity guard pairs a program with its own launch arguments', () => {
  it('accepts the entry\'s own program name', () => {
    assert.deepEqual(checkIdentity(findEntry('posix', 'bash'), '/usr/bin/bash', 'posix'), { ok: true })
    assert.deepEqual(checkIdentity(findEntry('windows', 'cmd'), 'C:\\Windows\\system32\\cmd.exe', 'windows'), { ok: true })
  })

  it('accepts a program name no entry claims', () => {
    // An override naming a shell this catalog does not know is the user saying
    // which shell their binary is; refusing it would break relocated or renamed
    // installs without preventing any wrong pairing.
    assert.deepEqual(checkIdentity(findEntry('posix', 'bash'), '/opt/tools/mysh', 'posix'), { ok: true })
    assert.deepEqual(checkIdentity(findEntry('windows', 'cmd'), 'C:\\tools\\renamed-cmd.exe', 'windows'), { ok: true })
    // Git Bash is the one entry stricter than that rule: it must be the real
    // bash.exe, because the sibling git-bash.exe launches a GUI window instead
    // of running the command.
    const launcher = checkIdentity(findEntry('windows', 'gitbash'), 'D:\\Git\\git-bash.exe', 'windows')
    assert.equal(launcher.ok, false)
    assert.match(launcher.detail, /expected bash\.exe/u)
  })

  it('refuses a program that another catalog entry names, and says which', () => {
    for (const [entryId, path, platform, expected] of [
      ['bash', '/usr/bin/dash', 'posix', /that is POSIX sh/u],
      ['gitbash', 'C:\\Windows\\system32\\cmd.exe', 'windows', /that is Command Prompt \(cmd\.exe\)/u],
      ['pwsh', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'windows', /that is Windows PowerShell 5\.1/u],
      ['cmd', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'windows', /that is PowerShell/u],
      ['gitbash', 'C:\\Windows\\System32\\wsl.exe', 'windows', /that is WSL Bash/u],
    ]) {
      const verdict = checkIdentity(findEntry(platform, entryId), path, platform)
      assert.equal(verdict.ok, false, `${entryId} must refuse ${path}`)
      assert.match(verdict.detail, expected, `${entryId} must name the shell the path belongs to`)
    }
  })

  it('claims a program name only when exactly one entry names it', () => {
    assert.equal(entryClaiming('posix', 'bash').id, 'bash')
    assert.equal(entryClaiming('posix', 'dash').id, 'sh')
    assert.equal(entryClaiming('windows', 'powershell.exe').id, 'powershell')
    assert.equal(entryClaiming('posix', 'mysh'), undefined)
    // Case-insensitively, because Windows and macOS filesystems are.
    assert.equal(entryClaiming('windows', 'CMD.EXE').id, 'cmd')
  })
})

describe('dialect argument construction', () => {
  it('passes a bash command as one argv element, non-interactive by default', () => {
    assert.deepEqual(
      buildInvocation('bash', { executable: '/bin/bash', command: 'echo hi' }).argv,
      ['/bin/bash', '-c', 'echo hi'],
    )
  })

  it('runs a bash login shell only when asked', () => {
    assert.deepEqual(
      buildInvocation('bash', { executable: '/bin/bash', command: 'echo hi', loginShell: true }).argv,
      ['/bin/bash', '-l', '-c', 'echo hi'],
    )
  })

  it('runs PowerShell profile-free and pins UTF-8 output', () => {
    const invocation = buildInvocation('powershell', { executable: 'C:\\pwsh.exe', command: 'Write-Output hi' })
    assert.deepEqual(invocation.argv.slice(0, 5), [
      'C:\\pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    ])
    assert.match(invocation.argv[5], /OutputEncoding/u)
    assert.ok(invocation.argv[5].endsWith('Write-Output hi'))
  })

  it('carries a cmd command in the environment, leaving argv quote-free', () => {
    const invocation = buildInvocation('cmd', {
      executable: 'C:\\Windows\\System32\\cmd.exe',
      command: 'echo hi> "C:\\dir with space\\out.txt"',
    })
    assert.deepEqual(invocation.argv, ['C:\\Windows\\System32\\cmd.exe', '/d', '/q', '/c', `%${CMD_COMMAND_ENV}%`])
    assert.equal(invocation.env[CMD_COMMAND_ENV], 'echo hi> "C:\\dir with space\\out.txt"')
    for (const element of invocation.argv) assert.ok(!element.includes('"'))
    assert.deepEqual(transportEnv('cmd', 'x'), { [CMD_COMMAND_ENV]: 'x' })
    for (const dialect of ['bash', 'powershell', 'wsl']) assert.equal(transportEnv(dialect, 'x'), undefined)
  })

  it('translates the WSL working directory and keeps every argument separate', () => {
    const invocation = buildInvocation('wsl', {
      executable: 'C:\\Windows\\System32\\wsl.exe',
      command: 'echo hi',
      windowsCwd: 'D:\\Athif\\projects\\thing',
      mountRoot: '/mnt',
      distro: 'Ubuntu',
    })
    assert.deepEqual(invocation.argv, [
      'C:\\Windows\\System32\\wsl.exe',
      '-d', 'Ubuntu',
      '--cd', '/mnt/d/Athif/projects/thing',
      '-e', 'bash', '-c', 'echo hi',
    ])
  })

  it('refuses a WSL directory with no mount-namespace equivalent', () => {
    assert.throws(
      () => buildInvocation('wsl', {
        executable: 'wsl.exe', command: 'ls', windowsCwd: '\\\\server\\share', mountRoot: '/mnt',
      }),
      /cannot translate/u,
    )
  })

  it('maps drive letters case-insensitively and keeps spaces and unicode', () => {
    assert.equal(toLinuxPath('D:\\Athif\\my projects\\ünï', '/mnt'), '/mnt/d/Athif/my projects/ünï')
    assert.equal(toLinuxPath('c:/Work', '/mnt'), '/mnt/c/Work')
    assert.throws(() => toLinuxPath('\\\\?\\C:\\x', '/mnt'), /cannot translate/u)
  })

  it('rejects an unknown dialect instead of falling back to one', () => {
    assert.throws(() => buildInvocation('nushell', { executable: 'x', command: 'y' }), /unknown dialect/u)
    assert.throws(() => versionArgv('nushell', 'x'), /unknown dialect/u)
  })

  it('probes versions with fixed, dialect-appropriate arguments', () => {
    assert.deepEqual(versionArgv('bash', '/bin/bash'), ['/bin/bash', '--version'])
    assert.deepEqual(versionArgv('cmd', 'cmd.exe'), ['cmd.exe', '/d', '/q', '/c', 'ver'])
    assert.ok(versionArgv('powershell', 'p.exe').includes('-NoProfile'))
    assert.deepEqual(versionArgv('wsl', 'wsl.exe'), ['wsl.exe', '--version'])
  })

  it('carries no input in the test command', () => {
    assert.match(testCommand(), /^echo [A-Z-]+$/u)
  })
})

describe('confinement facts', () => {
  it('refuses the shells the Windows ACL runner was measured not to start', () => {
    for (const id of ['gitbash', 'wsl']) {
      const entry = findEntry('windows', id)
      for (const mode of ['read-only', 'workspace-write']) {
        const verdict = checkConfinement(entry, mode)
        assert.equal(verdict.ok, false, `${id} under ${mode}`)
        assert.ok(verdict.reason.length > 20)
      }
      assert.equal(checkConfinement(entry, 'danger-full-access').ok, true)
      assert.equal(checkConfinement(entry, 'danger-full-access').confined, false)
    }
  })

  it('allows the shells the Windows sandbox was measured to confine', () => {
    for (const id of ['pwsh', 'powershell', 'cmd']) {
      const verdict = checkConfinement(findEntry('windows', id), 'read-only')
      assert.equal(verdict.ok, true, id)
      assert.equal(verdict.confined, true, id)
    }
  })

  it('treats every POSIX entry as confineable and records that this is unverified here', () => {
    for (const entry of catalogFor('posix')) {
      assert.equal(checkConfinement(entry, 'read-only').ok, true, entry.id)
    }
    assert.deepEqual([...VERIFIED_CONFINEMENT_PLATFORMS], ['windows'])
  })

  it('never treats an entry as confined under danger-full-access', () => {
    for (const platform of PLATFORMS) {
      for (const entry of catalogFor(platform)) {
        assert.equal(checkConfinement(entry, 'danger-full-access').confined, false)
      }
    }
  })
})
