/**
 * Resolution and validation.
 *
 * The load-bearing properties: resolution goes through the subprocess seam
 * rather than this plugin's filesystem calls, a configured path that fails is an
 * error instead of a cue to discover, discovery that finds nothing raises
 * instead of yielding a name for someone else to resolve later, and the working
 * directory rule follows the platform it is given.
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { findEntry } from '../src/catalog.js'
import { inspectCatalog, inspectShell, requireWorkingDirectory, resolveShell } from '../src/discovery.js'
import { makeContext, makeFixture, removeFixture, stubSubprocess } from './helpers.mjs'

const fixture = makeFixture('discovery')
after(() => { removeFixture(fixture) })

const workdir = join(fixture, 'work')
mkdirSync(workdir, { recursive: true })
const aFile = join(fixture, 'not-a-directory.txt')
writeFileSync(aFile, '')

/** A context whose seam resolves only the names in `resolvable`. */
async function contextWith(resolvable, platform = 'posix', defaultShell) {
  const subprocess = stubSubprocess({ resolvable, platform, defaultShell })
  const ctx = await makeContext({ subprocess, workspaceRoot: fixture })
  return { ctx, subprocess }
}

describe('resolveShell', () => {
  it('walks the catalog candidates in order and returns the first that resolves', async () => {
    // The seam resolves a bare NAME to the canonical path, so the stub's table
    // is keyed by name exactly as the real provider's PATH lookup answers.
    const { ctx, subprocess } = await contextWith({ bash: '/usr/bin/bash' })
    const resolved = await resolveShell(ctx, { entry: findEntry('posix', 'bash'), platform: 'posix', env: { PATH: '/usr/bin' } })
    assert.deepEqual(resolved, { path: '/usr/bin/bash', source: 'discovered' })
    // The entry's own candidate list was what got asked, in order.
    assert.deepEqual(subprocess.resolutions, ['bash'])
  })

  it('prefers a configured path and does not probe discovery', async () => {
    const { ctx, subprocess } = await contextWith({ '/opt/custom/bash': '/opt/custom/bash', bash: '/usr/bin/bash' })
    const resolved = await resolveShell(ctx, {
      entry: findEntry('posix', 'bash'),
      configuredPath: '/opt/custom/bash',
      platform: 'posix',
      env: {},
    })
    assert.deepEqual(resolved, { path: '/opt/custom/bash', source: 'configured' })
    assert.deepEqual(subprocess.resolutions, ['/opt/custom/bash'], 'discovery must not run')
  })

  it('fails a configured path instead of falling back to discovery', async () => {
    // `bash` would resolve perfectly well here; the configured value is what the
    // user asked for, so a wrong one is an error rather than a reason to guess.
    const { ctx, subprocess } = await contextWith({ bash: '/usr/bin/bash' })
    await assert.rejects(
      () => resolveShell(ctx, {
        entry: findEntry('posix', 'bash'), configuredPath: '/nope/bash', platform: 'posix', env: {},
      }),
      /configured executable for Bash is not an executable file/u,
    )
    assert.deepEqual(subprocess.resolutions, ['/nope/bash'])
  })

  it('fails a configured executable that is the wrong program for the entry', async () => {
    const { ctx } = await contextWith({ 'D:\\Git\\git-bash.exe': 'D:\\Git\\git-bash.exe' })
    await assert.rejects(
      () => resolveShell(ctx, {
        entry: findEntry('windows', 'gitbash'),
        configuredPath: 'D:\\Git\\git-bash.exe',
        platform: 'windows',
        env: {},
      }),
      /is not that shell — expected bash\.exe/u,
    )
  })

  it('fails an override that names a different catalog entry', async () => {
    // The rule that stops one shell's override from being paired with another
    // shell's launch arguments: a cmd.exe path can never be run as `cmd.exe -c`.
    const { ctx } = await contextWith({ 'C:\\Windows\\system32\\cmd.exe': 'C:\\Windows\\system32\\cmd.exe' })
    await assert.rejects(
      () => resolveShell(ctx, {
        entry: findEntry('windows', 'gitbash'),
        configuredPath: 'C:\\Windows\\system32\\cmd.exe',
        platform: 'windows',
        env: {},
      }),
      /expected bash\.exe, got cmd\.exe — that is Command Prompt \(cmd\.exe\)/u,
    )
  })

  it('raises when discovery finds nothing, naming every probed location', async () => {
    const { ctx } = await contextWith({})
    await assert.rejects(
      () => resolveShell(ctx, { entry: findEntry('posix', 'zsh'), platform: 'posix', env: {} }),
      /no Zsh executable found in the execution environment; set "executable"/u,
    )
  })

  it('never returns a bare name for something else to resolve later', async () => {
    const { ctx } = await contextWith({})
    await assert.rejects(() => resolveShell(ctx, { entry: findEntry('posix', 'sh'), platform: 'posix', env: {} }))
  })

  it('inspects without throwing', async () => {
    const found = await contextWith({ bash: '/bin/bash' })
    assert.deepEqual(
      await inspectShell(found.ctx, { entry: findEntry('posix', 'bash'), platform: 'posix', env: {} }),
      { available: true, path: '/bin/bash', source: 'discovered' },
    )
    const missing = await contextWith({})
    const inspection = await inspectShell(missing.ctx, { entry: findEntry('posix', 'bash'), platform: 'posix', env: {} })
    assert.equal(inspection.available, false)
    assert.match(inspection.detail, /no Bash executable found/u)
  })
})

describe('inspectCatalog', () => {
  it('reports one row per entry with the selection marked', async () => {
    const { ctx } = await contextWith({ bash: '/bin/bash', zsh: '/bin/zsh' })
    const rows = await inspectCatalog(ctx, 'posix', { selectedId: 'bash', overrideFor: () => undefined, env: {} })
    assert.deepEqual(rows.map(row => row.id), ['bash', 'zsh', 'fish', 'sh', 'pwsh'])
    assert.deepEqual(rows.filter(row => row.selected).map(row => row.id), ['bash'])
    assert.equal(rows.find(row => row.id === 'bash').available, true)
    assert.equal(rows.find(row => row.id === 'fish').available, false)
    assert.equal(rows.find(row => row.id === 'bash').confineable, true)
    assert.equal(rows.find(row => row.id === 'bash').supportsLoginShell, true)
  })

  it('applies the configured path to the selected entry only', async () => {
    // Otherwise one override would report the same file as four different shells.
    const { ctx, subprocess } = await contextWith({ '/opt/zsh': '/opt/zsh', bash: '/bin/bash' })
    const rows = await inspectCatalog(ctx, 'posix', { selectedId: 'zsh', overrideFor: (entry, selected) => selected ? '/opt/zsh' : undefined, env: {} })
    assert.equal(rows.find(row => row.id === 'zsh').path, '/opt/zsh')
    assert.equal(rows.find(row => row.id === 'bash').path, '/bin/bash')
    const overrideProbes = subprocess.resolutions.filter(entry => entry === '/opt/zsh').length
    assert.equal(overrideProbes, 1, 'the override is resolved for the selected entry only')
  })

  it('carries the measured refusal reason for an unconfineable Windows entry', async () => {
    const { ctx } = await contextWith({}, 'windows')
    const rows = await inspectCatalog(ctx, 'windows', { selectedId: 'cmd', overrideFor: () => undefined, env: {} })
    const gitbash = rows.find(row => row.id === 'gitbash')
    assert.equal(gitbash.confineable, false)
    assert.match(gitbash.confineReason, /MSYS2|restricted token/u)
    assert.equal(rows.find(row => row.id === 'cmd').confineable, true)
  })
})

describe('requireWorkingDirectory', () => {
  it('accepts a real directory on the platform it belongs to', () => {
    assert.equal(requireWorkingDirectory(workdir, 'windows'), workdir)
    assert.equal(requireWorkingDirectory(process.cwd(), 'windows'), process.cwd())
  })

  it('applies the platform absolute-path rule, not the host one', () => {
    // A POSIX path is not absolute to Windows, and a drive path is not absolute
    // to POSIX, whatever machine the check runs on.
    assert.throws(
      () => requireWorkingDirectory('/tmp', 'windows'),
      /must be an absolute windows path/u,
    )
    assert.throws(
      () => requireWorkingDirectory('C:\\work', 'posix'),
      /must be an absolute posix path/u,
    )
    assert.throws(() => requireWorkingDirectory('relative\\dir', 'windows'), /absolute windows path/u)
    assert.throws(() => requireWorkingDirectory('relative/dir', 'posix'), /absolute posix path/u)
  })

  it('refuses a missing directory and never substitutes another', () => {
    const gone = join(fixture, 'deleted')
    let captured
    try {
      requireWorkingDirectory(gone, 'windows')
    } catch (error) {
      captured = error
    }
    assert.match(captured?.message ?? '', /working directory does not exist/u)
    // The refusal names the directory that was asked for: a substitute would
    // have to appear in its place, which is what a check has to rule out.
    assert.ok(captured.message.includes(gone), 'the error must name the requested directory')
    assert.equal(requireWorkingDirectory(fixture, 'windows'), fixture, 'a real directory still passes')
  })

  it('refuses a file and an empty value', () => {
    assert.throws(() => requireWorkingDirectory(aFile, 'windows'), /not a directory/u)
    assert.throws(() => requireWorkingDirectory('', 'windows'), /without a working directory/u)
    assert.throws(() => requireWorkingDirectory(workdir, 'plan9'), /unknown platform/u)
  })
})
