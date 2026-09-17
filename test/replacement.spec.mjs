/**
 * The replacement contract: one model-facing shell tool, and no competing one
 * reaching a shell the user did not select.
 *
 * The load-bearing case is a preset. Patches address rows by id, and the shell
 * tools a session actually sees are re-mounted by agent presets inside the agent
 * realm — a patched bundle row cannot reach them. The guard can, so these tests
 * assert both halves: the guard denies every replaced name, and it leaves
 * unrelated tools alone.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { REPLACED_SHELL_TOOLS, SHELL_TOOL_NAME, registerShellToolReplacement } from '../src/tool.js'

/** A context exposing just enough `tools` for the guard. */
async function guardedContext() {
  const guards = []
  const ctx = new Context()
  await ctx.plugin({
    name: 'stub-tools',
    apply(context) {
      context.provide('tools', {
        guard(guard) {
          guards.push(guard)
          return () => { guards.splice(guards.indexOf(guard), 1) }
        },
      })
    },
  })
  return { ctx, guards }
}

describe('shell tool replacement', () => {
  it('denies every tool name the replacement supersedes', async () => {
    const { ctx, guards } = await guardedContext()
    registerShellToolReplacement(ctx)
    assert.equal(guards.length, 1, 'one guard covers every replaced name')
    for (const name of REPLACED_SHELL_TOOLS) {
      const reason = guards[0]({ name })
      assert.equal(typeof reason, 'string', `${name} must be denied`)
      assert.ok(reason.includes(name))
      assert.ok(reason.includes(SHELL_TOOL_NAME), 'the denial must name the replacement')
    }
  })

  it('covers the persistent variants, which claim the same names', async () => {
    const { ctx, guards } = await guardedContext()
    registerShellToolReplacement(ctx)
    // tool-bash-persistent and tool-pwsh-persistent register `bash` and `pwsh`
    // too, so the same two names cover the `minimal` preset.
    assert.deepEqual([...REPLACED_SHELL_TOOLS].sort(), ['bash', 'pwsh'])
  })

  it('allows the replacement tool and unrelated tools', async () => {
    const { ctx, guards } = await guardedContext()
    registerShellToolReplacement(ctx)
    for (const name of [SHELL_TOOL_NAME, 'read', 'write', 'job_output', 'run_code', 'terminal_send']) {
      assert.equal(guards[0]({ name }), undefined, `${name} must not be denied by this guard`)
    }
  })

  it('returns a disposer that unregisters the guard', async () => {
    const { ctx, guards } = await guardedContext()
    const dispose = registerShellToolReplacement(ctx)
    assert.equal(guards.length, 1)
    dispose()
    assert.equal(guards.length, 0)
  })
})
