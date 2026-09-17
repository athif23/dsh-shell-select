/**
 * dsh-shell-select — one model-facing `shell` tool over a shell the user
 * selects.
 *
 * The plugin mounts three things and nothing else:
 *
 * 1. {@link ShellSelectExecutor} as `ctx.shell`, replacing whichever local
 *    executor the platform composed. Every route that already goes through that
 *    seam — the shell tool, hook commands, the tmux probe — then uses the
 *    selected shell.
 * 2. The single `shell` tool, which supersedes the shipped `bash`/`pwsh` tools.
 *    The composition patch disables the rows it can address, and a global tool
 *    guard denies the two names wherever a preset re-mounts them, so no second
 *    shell tool competes for the model's attention and none bypasses the
 *    selection.
 * 3. Two loopback-only HTTP routes the Web settings card reads.
 *
 * The shell is a user setting, so there is no per-call shell argument and the
 * model cannot select a different one. When the selected shell cannot be
 * confined under the session's permission mode, the executor refuses before any
 * process exists.
 *
 * @module dsh-shell-select
 */

import { ShellSelectConfig, ShellSelectExecutor } from './src/executor.js'
import { registerShellTool, registerShellToolReplacement } from './src/tool.js'
import { registerStatusRoutes } from './src/status.js'

/** Cordis plugin name. */
export const name = 'dsh-shell-select'

/**
 * Services this plugin needs before it applies.
 *
 * `shell` is deliberately absent: this plugin provides it, so listing it would
 * make the plugin wait on itself.
 */
export const inject = ['tools', 'systemPrompt', 'shellEnv', 'sandbox', 'sandboxPolicy']

/**
 * Mount the executor, the tool, and the card's routes.
 * @param ctx - plugin context.
 * @param config - composition entry; every field is also a `shell-select` setting.
 */
export function apply(ctx, config) {
  // Schema-applied here as well as by the loader: the inherited local executor
  // validates numeric fields in its constructor, so defaults must already exist
  // when this plugin is mounted programmatically (tests, embeddings).
  const entry = ShellSelectConfig(config ?? {})
  ctx.plugin(ShellSelectExecutor, entry)

  // Registered on the plugin's own (deployment-plane) context so the denial
  // covers every agent scope, including the shell tools a preset re-mounts.
  registerShellToolReplacement(ctx)

  ctx.inject(['shell', 'tools', 'systemPrompt', 'shellEnv', 'sandboxPolicy'], (scope) => {
    registerShellTool(scope, {
      describeShell: () => scope.shell.describeShell(),
      backgroundEnabled: entry.enableRunInBackground,
    })
  })

  // The card is optional: a headless composition has no web server and must
  // still get the executor and the tool. Every service the routes touch is named
  // here — a Cordis context refuses a service it did not inject, so an omitted
  // name would surface as a runtime error from a route rather than as a missing
  // dependency at load.
  ctx.inject(['webServer', 'shell', 'subprocess', 'sandboxPolicy'], (scope) => {
    scope.effect(
      () => registerStatusRoutes(scope, scope.shell),
      'dsh-shell-select: settings-card routes',
    )
  })
}
