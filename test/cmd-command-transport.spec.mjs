/**
 * Why `cmd.exe` receives its command through an environment variable.
 *
 * This is the one dialect decision that looks arbitrary until you measure it, so
 * it is pinned by measurement: the direct form is shown to corrupt a quoted path
 * (the property that forces the transport), and the shipped form is shown to
 * carry quotes, spaces, redirection, and `&` through intact.
 *
 * Real processes, real `cmd.exe`, fixtures under `<workspace>/.test-tmp/`. The
 * suite skips itself on a host with no cmd.exe.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CMD_COMMAND_ENV, buildInvocation } from '../src/dialects.js'
import { findEntry } from '../src/catalog.js'
import { makeFixture, removeFixture } from './helpers.mjs'

const fixture = makeFixture('cmd-transport')
const workspace = join(fixture, 'ws space ünï')
mkdirSync(workspace, { recursive: true })
after(() => { removeFixture(fixture) })

const CMD = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
const skip = existsSync(CMD) ? false : 'no cmd.exe on this host'

/** Spawn one argv through the shipped subprocess provider, unconfined. */
async function spawn(argv, env) {
  const ctx = new Context()
  const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
  await ctx.plugin(LocalSubprocessRuntime)
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: workspace,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32_000 }, stderr: { maxBytes: 32_000 } },
      graceMs: 2_000,
      ...env === undefined ? {} : { env },
    })
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      stdout: (handle.collected.stdout?.readFrom(0).text ?? '').replace(/\0/gu, '').trim(),
      stderr: (handle.collected.stderr?.readFrom(0).text ?? '').replace(/\0/gu, '').trim(),
    }
  } finally {
    await ctx.fiber?.dispose?.()
  }
}

/** The shipped cmd invocation for one command. */
function cmdInvocation(command) {
  return buildInvocation('cmd', { executable: CMD, command })
}

describe('cmd command transport', () => {
  it('corrupts a quoted path when the command travels in argv', { skip }, async () => {
    const target = join(workspace, 'direct.txt')
    rmSync(target, { force: true })
    // The direct form: the command is an argv element, so the subprocess seam
    // escapes its quotes as \" for CommandLineToArgvW — which cmd does not
    // understand.
    const result = await spawn([CMD, '/d', '/q', '/c', `echo hi> "${target}"`])
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stderr, /filename, directory name, or volume label syntax is incorrect/iu)
    assert.equal(existsSync(target), false, 'the write must not have happened')
  })

  it('carries the same command intact through the environment', { skip }, async () => {
    const target = join(workspace, 'transported.txt')
    rmSync(target, { force: true })
    const invocation = cmdInvocation(`echo hi> "${target}"`)
    const result = await spawn(invocation.argv, invocation.env)
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.equal(existsSync(target), true)
    assert.match(readFileSync(target, 'utf8'), /hi/u)
  })

  it('preserves redirection, chaining, and spaces in arguments', { skip }, async () => {
    const first = join(workspace, 'one.txt')
    const second = join(workspace, 'two.txt')
    rmSync(first, { force: true })
    rmSync(second, { force: true })
    const invocation = cmdInvocation(`echo first> "${first}" & echo second> "${second}"`)
    const result = await spawn(invocation.argv, invocation.env)
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.equal(existsSync(first), true)
    assert.equal(existsSync(second), true)
  })

  it('does not expand cmd variables, and documents how to opt in', { skip }, async () => {
    // The measured cost of the environment transport: cmd substitutes the
    // variable ONCE and does not rescan the result, so a `%NAME%` in the command
    // text stays literal. Pinned here because it is the one cmd behavior this
    // adapter changes, and the model-facing description tells the model to write
    // `call ...` when it needs expansion.
    const invocation = cmdInvocation('echo [%CD%]')
    const literal = await spawn(invocation.argv, invocation.env)
    assert.equal(literal.exitCode, 0, `stderr: ${literal.stderr}`)
    assert.equal(literal.stdout, '[%CD%]')
  })

  it('expands cmd variables once the command opts in through call', { skip }, async () => {
    const invocation = cmdInvocation('call echo [%CD%]')
    const result = await spawn(invocation.argv, invocation.env)
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.match(result.stdout, /\[[A-Z]:\\.*cmd-transport-[^\\]*\\ws space/u)
    assert.ok(!result.stdout.includes('%CD%'), 'call must actually expand the variable')
  })

  it('round-trips ASCII output exactly, which is what the tool relies on', { skip }, async () => {
    // Deliberately NOT asserting how non-ASCII output is decoded: cmd's output
    // encoding follows the console code page, which is process-external state
    // that varies with how the harness was launched. The README records the
    // caveat; pinning it here would produce a test that passes or fails by
    // environment. What must hold unconditionally is exact ASCII.
    const invocation = cmdInvocation('echo plain-ascii-ok')
    const result = await spawn(invocation.argv, invocation.env)
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.equal(result.stdout, 'plain-ascii-ok')
  })

  it('does not run chcp, which would mutate shared console state', { skip }, () => {
    // `chcp` changes the code page of the console the child shares with the
    // host, so running it to "fix" encoding would change state outside the
    // command. Documented rather than attempted.
    for (const command of ['echo hi', 'call echo [%CD%]']) {
      assert.ok(!cmdInvocation(command).argv.join(' ').includes('chcp'))
    }
  })

  it('keeps every argv element free of double quotes', { skip }, () => {
    const invocation = cmdInvocation('echo "a quoted string" > "C:\\some path\\file.txt"')
    for (const element of invocation.argv) {
      assert.ok(!element.includes('"'), `argv element carries a quote: ${element}`)
    }
    assert.equal(invocation.env[CMD_COMMAND_ENV], 'echo "a quoted string" > "C:\\some path\\file.txt"')
  })

  it('writes a Unicode-named file through the transport', { skip }, async () => {
    const target = join(workspace, 'ünïcödé-ôut.txt')
    rmSync(target, { force: true })
    const invocation = cmdInvocation(`echo ok> "${target}"`)
    const result = await spawn(invocation.argv, invocation.env)
    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
    assert.equal(existsSync(target), true)
  })

  it('documents the limitation where the model will read it', { skip }, () => {
    const syntax = findEntry('windows', 'cmd').syntax
    assert.match(syntax, /NOT expanded/u)
    assert.match(syntax, /call /u)
  })
})
