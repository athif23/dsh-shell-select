/**
 * The selection persists across restarts, and the plugin writes only its own
 * namespace.
 *
 * The settings file lives in an isolated fixture, never the real harness home:
 * these suites must not read or write the user's own configuration.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { SHELL_SELECT_NAMESPACE, ShellSelectConfig, ShellSelectExecutor } from '../src/executor.js'
import { makeContext, makeFixture, removeFixture, stubSubprocess } from './helpers.mjs'

const fixture = makeFixture('settings')
after(() => { removeFixture(fixture) })

const settingsPath = join(fixture, 'settings.yaml')

/** Executables the stub seam knows on this platform. */
const RESOLVABLE = {
  cmd: 'C:\\Windows\\system32\\cmd.exe',
  'D:\\Git\\bin\\bash.exe': 'D:\\Git\\bin\\bash.exe',
  'bash.exe': 'D:\\Git\\bin\\bash.exe',
}

/**
 * Boot a composition backed by the real file settings provider.
 * @param entry - composition entry values.
 * @returns the context and the executor.
 */
async function boot(entry = {}) {
  const ctx = await makeContext({ subprocess: stubSubprocess({ platform: 'windows', resolvable: RESOLVABLE }) })
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  await ctx.plugin(ShellSelectExecutor, ShellSelectConfig(entry))
  await ctx.shell.ready
  return { ctx, shell: ctx.shell }
}

describe('selection persistence', () => {
  it('writes the selection under its own namespace only', async () => {
    writeFileSync(settingsPath, [
      '# a comment the user wrote',
      'ui-theme:',
      '  preference: dark',
      '',
    ].join('\n'))

    const { ctx, shell } = await boot({ shell: 'cmd' })
    assert.equal(shell.describeShell().id, 'cmd')

    await ctx.settings.update(SHELL_SELECT_NAMESPACE, { shell: 'gitbash', loginShell: true })
    await ctx.fiber?.dispose?.()

    const document = readFileSync(settingsPath, 'utf8')
    assert.match(document, /^shell-select:/mu, `namespace missing from:\n${document}`)
    assert.match(document, /shell: gitbash/u)
    // The unrelated namespace and its comment survive: the provider diffs leaves
    // rather than rewriting the document.
    assert.match(document, /ui-theme:/u)
    assert.match(document, /preference: dark/u)
    assert.match(document, /# a comment the user wrote/u)
  })

  it('reads the persisted selection back on a fresh composition', async () => {
    writeFileSync(settingsPath, [
      // YAML plain scalars keep backslashes literal, so the document spells the
      // path exactly as the user would.
      'shell-select:',
      '  shell: gitbash',
      '  executable: D:\\Git\\bin\\bash.exe',
      '  loginShell: true',
      '',
    ].join('\n'))

    const { ctx, shell } = await boot({ shell: 'cmd' })
    // The stored user layer outranks the composition entry.
    assert.equal(shell.selectSettings.shell, 'gitbash')
    assert.equal(shell.selectSettings.loginShell, true)
    assert.equal(shell.selectSettings.executable, 'D:\\Git\\bin\\bash.exe')
    assert.equal(shell.describeShell().id, 'gitbash')
    await ctx.fiber?.dispose?.()
  })

  it('falls back to the composition entry when the document has no section', async () => {
    writeFileSync(settingsPath, 'ui-theme:\n  preference: dark\n')
    const { ctx, shell } = await boot({ shell: 'cmd' })
    assert.equal(shell.describeShell().id, 'cmd')
    await ctx.fiber?.dispose?.()
  })

  it('creates the document when none exists, without touching the harness home', async () => {
    const nested = join(fixture, 'nested')
    mkdirSync(nested, { recursive: true })
    const freshPath = join(nested, 'fresh-settings.yaml')
    const ctx = await makeContext({ subprocess: stubSubprocess({ platform: 'windows', resolvable: RESOLVABLE }) })
    await ctx.plugin(FileSettingsProvider, { path: freshPath, watch: false })
    await ctx.plugin(ShellSelectExecutor, ShellSelectConfig({ shell: 'cmd' }))
    await ctx.shell.ready
    await ctx.settings.update(SHELL_SELECT_NAMESPACE, { shell: 'gitbash' })
    assert.ok(existsSync(freshPath))
    // Nothing this suite creates may land outside the fixture.
    assert.ok(freshPath.startsWith(fixture))
    await ctx.fiber?.dispose?.()
  })

  it('applies a change to subsequent calls, not to specs already produced', async () => {
    writeFileSync(settingsPath, 'shell-select:\n  shell: cmd\n')
    const { ctx, shell } = await boot({ shell: 'cmd' })
    const before = shell.resolve({ command: 'x', workdir: fixture })
    assert.equal(before.sandboxPolicy.mode, 'workspace-write')

    await ctx.settings.update(SHELL_SELECT_NAMESPACE, { shell: 'gitbash' })
    // A live settings write refreshes the cached description through the
    // section's onChange hook.
    await shell.ready
    assert.equal(shell.describeShell().id, 'gitbash')
    // The already-produced spec is inert data: it keeps the policy it resolved
    // with, so a settings change cannot retroactively alter a call in flight.
    assert.equal(before.sandboxPolicy.mode, 'workspace-write')
    // And the new selection is a confined-mode refusal, not a silent switch.
    await assert.rejects(
      () => shell.run(shell.resolve({ command: 'y', workdir: fixture })),
      /cannot be confined by the sandbox on this platform/u,
    )
    await ctx.fiber?.dispose?.()
  })

  it('defaults to auto, so a stored document carries no platform-specific shell', async () => {
    writeFileSync(settingsPath, '{}\n')
    const { ctx, shell } = await boot()
    assert.equal(shell.selectSettings.shell, 'auto')
    // `auto` is what makes one settings document correct on every platform: a
    // stored `bash` would be wrong on Windows and a stored `cmd` wrong elsewhere.
    assert.ok(!readFileSync(settingsPath, 'utf8').includes('shell:'))
    await ctx.fiber?.dispose?.()
  })
})
