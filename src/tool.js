/**
 * The one model-facing shell tool.
 *
 * There is exactly one tool (`shell`) and no per-call shell argument: the shell
 * is a user setting, so a model cannot reach past it to a different one. The
 * description is a getter re-read at every assembly, so a settings change shows
 * up in the next model step rather than at the next restart, and the syntax it
 * states is the selected shell's own.
 *
 * Background execution registers process handles with `ctx.jobs`; their work
 * uses job cancellation rather than the tool-call signal after an id returns.
 * Sandbox escalation goes through the shared `approveEscalation` sequence, so
 * this tool contributes only its own composition guard and approval ingredients.
 *
 * @module dsh-shell-select/tool
 */

import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { isAbsolute, sep } from 'node:path'
import { renderShellProcessRead, renderShellResult, describeShellFact } from './render.js'

/** Tool name registered on `ctx.tools`. */
export const SHELL_TOOL_NAME = 'shell'

/**
 * Tool names this plugin replaces.
 *
 * Several composition layers can mount a shell tool: the base bundle mounts
 * `tool-bash`/`tool-pwsh`, the web-app bundle disables them and the agent
 * presets re-mount them inside each agent's realm, and the `minimal` preset
 * mounts the persistent variants that claim the same two names. A patch can
 * only disable rows it can address by id, so the presets would each keep
 * offering a shell of their own.
 *
 * These are denied instead, which is layer-independent by construction: a guard
 * is consulted for every call regardless of which composition registered the
 * tool, and a guard's denial cannot be turned back into permission by listener
 * order. The denial names the replacement, so the model redirects rather than
 * retries.
 */
export const REPLACED_SHELL_TOOLS = Object.freeze(['bash', 'pwsh'])

/**
 * Deny every competing shell tool, whoever registered it.
 *
 * Without this the model would see two shell tools in a preset session and
 * could run commands through one whose shell the user never selected.
 * @param ctx - a plain (deployment-plane) plugin context carrying `tools`.
 * @returns the exact disposer that unregisters the guard.
 */
export function registerShellToolReplacement(ctx) {
  return ctx.tools.guard(exec => REPLACED_SHELL_TOOLS.includes(exec.name)
    ? `"${exec.name}" is not available in this deployment: the session shell is a user setting, and the `
      + `"${SHELL_TOOL_NAME}" tool is the only route to it. Run the command through "${SHELL_TOOL_NAME}" instead.`
    : undefined)
}

/**
 * Map a settled background process onto the generic task-outcome vocabulary.
 * @param proc - the settled process handle.
 * @returns the outcome for the `ctx.jobs` registration.
 */
function processOutcome(proc) {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing a partial process.
 * @param start - starts the process with job-owned cancellation.
 * @param renderOutput - consumes output from a published process.
 * @returns synchronous job hooks whose completion includes preparation and process settlement.
 */
function processJob(start, renderOutput) {
  const controller = new AbortController()
  let process
  const done = (async () => {
    try {
      process = await start(controller.signal)
      try {
        if (controller.signal.aborted) process.kill()
      } finally {
        await process.done
      }
      return processOutcome(process)
    } catch (error) {
      return {
        status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      process?.kill()
    },
    done,
    readOutput: () => process === undefined ? '' : renderOutput(process),
  }
}

/**
 * Describe the tool's current shell for the model.
 *
 * The shell identity and its syntax are per-deployment facts the model needs
 * before it writes a command, so they belong here rather than in a prompt
 * section: the description is what the model reads when choosing how to write
 * the command, and it is recomputed from live settings on every assembly.
 * @param describe - a fresh `describeShell()` result.
 * @param backgroundEnabled - whether `run_in_background` is advertised.
 * @param escalationModes - escalation targets this composition advertises.
 * @returns the tool description for the next model step.
 */
export function shellDescription(describe, backgroundEnabled, escalationModes) {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const identity = describe.available
    ? `The shell for this session is ${describe.label}, invoked as ${describe.executable} (${describe.platform}). ${describe.syntax}`
    : describe.pending === true
      // The executable is still being resolved; the shell itself is known.
      ? `The shell for this session is ${describe.label} (${describe.platform}). ${describe.syntax}`
      : `WARNING: the configured shell is not available: ${describe.detail} Commands will be refused until the `
        + '"shell-select" settings name a working executable. '
  const base = `Execute a command in the session's configured shell and return its stdout/stderr. ${identity}`
    + 'Each call runs in a fresh, stateless process: no state (working directory, variables, functions) persists between calls — '
    + 'pass `workdir` instead of changing directory. Non-zero exits are reported as `[exit code: N]`. '
    + 'Current harness environment facts are exposed through managed `DSH_*` variables; inspect them when needed. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — '
    + 'a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
  if (escalationModes.length === 0) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the '
    + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
    + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
    + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
    + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
    + 'approval prompt raised by that retry is how the user consents. If the session states approval '
    + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
    + 'Never escalate speculatively. A rejected escalation is final for that command — stop and explain, '
    + 'never work around it — but it does not forbid attempting or escalating other commands later.'
}

/**
 * Validate the args the schema cannot express.
 * @param command - the command text.
 * @param description - the required human description.
 * @param timeoutMs - optional per-call timeout.
 * @param sandboxPermissions - optional escalation target.
 * @param justification - optional escalation justification.
 */
function validateShellArgs(command, description, timeoutMs, sandboxPermissions, justification) {
  if (command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
  if (description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(timeoutMs)}`)
  }
  validateEscalationArgs(sandboxPermissions, justification)
}

/**
 * Register the `shell` tool.
 * @param ctx - plugin context carrying tools, shell, jobs, approval, and the prompt registry.
 * @param options - composition knobs and the live shell-description source.
 */
export function registerShellTool(ctx, options) {
  const { describeShell, backgroundEnabled } = options
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error(`${SHELL_TOOL_NAME}: the mounted executor confines but ctx.sandboxPolicy is missing`)
  }

  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = exec =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE anything
   * executes. Escalating the mode cannot make an unconfineable shell
   * confineable, so a refused shell stays refused.
   */
  const approveShellEscalation = (mode, justification, exec, standingPolicy) => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode: standingPolicy.mode, subject: 'command' },
      { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: SHELL_TOOL_NAME, signal: exec.signal },
    )
  }

  /**
   * Resolve an explicit workdir first, making a relative one session-workspace-relative.
   * A resolved sandbox-policy root wins so workdir and confinement use the
   * exact same per-call identity.
   */
  const resolveWorkdir = (modelWorkdir, exec, policyWorkspaceRoot) => {
    const sessionCwd = policyWorkspaceRoot ?? exec.agent?.session.header.cwd
    if (modelWorkdir === undefined) return sessionCwd
    if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) return `${sessionCwd}${sep}${modelWorkdir}`
    return modelWorkdir
  }

  /**
   * The `shell` fact block persisted with every result.
   *
   * Taken from the call's own decision, so the transcript records the shell,
   * executable, and working directory that actually produced the process — even
   * when the selection changed between the model's call and the spawn.
   * @param decision - the decision `decide` returned for this call.
   * @returns the fact block for the tool result.
   */
  const decisionFact = decision => ({
    shell: decision.shell.id,
    label: decision.shell.label,
    platform: decision.shell.platform,
    executable: decision.shell.executable,
    workdir: decision.shell.workdir,
  })

  /**
   * The same fact block for the *call preview*, before the decision exists.
   *
   * A preview can only read the cached description, because nothing is decided
   * yet; it is what the card shows while the command is running, and the result
   * replaces it with the decision's own facts.
   */
  const previewFact = () => {
    const describe = describeShell()
    return {
      shell: describe.id,
      label: describe.label,
      platform: describe.platform,
      ...describe.available ? { executable: describe.executable } : {},
    }
  }

  const definition = defineTool({
    name: SHELL_TOOL_NAME,
    description: shellDescription(describeShell(), backgroundEnabled, escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: 'The command to execute, written in the syntax of the shell named in this tool description.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status".',
      },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
      workdir: { type: 'string', description: 'Absolute working directory for this command. Defaults to the session workspace; a relative path is resolved against it. The directory must exist — it is never substituted.' },
      ...backgroundEnabled ? {
        run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string',
          enum: [...escalationModes],
          description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
        },
        justification: {
          type: 'string',
          description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
              shell: { type: 'object', additionalProperties: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              timeoutMs: { type: 'number', required: true },
              shell: { type: 'object', additionalProperties: true },
              stdout: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              sandbox: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true },
                  denied: { type: 'boolean', required: true },
                  enforcement: { type: 'string' },
                  runnerFailed: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      // Persisted per-call metadata: the UI's call details read the shell that
      // actually ran, not whichever shell is selected when the card renders.
      presentationMeta: (_args, value) => (value.shell === undefined ? {} : { shell: value.shell }),
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}`
          : renderShellResult(value, escalationModes),
      }],
    },
    async execute(args, exec) {
      validateShellArgs(args.command, args.description, args.timeoutMs, args.sandbox_permissions, args.justification)
      const standingPolicy = resolveSandboxPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveShellEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        dshEnv: ctx.shellEnv.collect(exec),
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }

      if (args.run_in_background === true) {
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        // The caller owns cancellation until ctx.jobs commits detached ownership.
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // Decided before admission: the job spawns exactly what the result
        // names, and a refused selection fails the call instead of creating a
        // job that fails on its first tick. The job's own controller owns
        // cancellation, so the spec carries no tool-call signal.
        const decided = await ctx.shell.decide(ctx.shell.resolve(request))
        // Task preflight finishes before the starter can spawn a process.
        const id = jobs.start({
          kind: SHELL_TOOL_NAME,
          label: args.command,
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => processJob(
            signal => ctx.shell.start({ ...decided.spec, signal }),
            proc => renderShellProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
          ),
        })
        return { kind: 'background', jobId: id, shell: decisionFact(decided.decision) }
      }

      // One decision for this call: it refuses an unusable selection before any
      // process exists, and it fixes the shell, the executable, and the argv
      // that `run` then spawns, so the reported facts cannot drift from it.
      const decided = await ctx.shell.decide(ctx.shell.resolve({ ...request, signal: exec.signal }))
      const result = await ctx.shell.run(decided.spec)
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return {
        kind: 'foreground',
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        timeoutMs: result.timeoutMs,
        shell: decisionFact(decided.decision),
        stdout: {
          text: result.stdout.text,
          truncated: result.stdout.truncated,
          ...result.stdout.spillPath !== undefined ? { spillPath: result.stdout.spillPath } : {},
        },
        stderr: {
          text: result.stderr.text,
          truncated: result.stderr.truncated,
          ...result.stderr.spillPath !== undefined ? { spillPath: result.stderr.spillPath } : {},
        },
        ...result.sandbox !== undefined ? {
          sandbox: {
            mode: result.sandbox.mode,
            denied: result.sandbox.denied,
            ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
            ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
          },
        } : {},
      }
    },
    // The call card names the shell and the working directory up front, so a
    // user reading the transcript sees which shell will run the command. This is
    // the cached selection: the call has not been decided yet.
    presentCall: (args) => {
      const shell = describeShellFact(previewFact())
      return args.run_in_background === true
        ? {
          card: 'generic',
          title: args.command,
          kind: 'execute',
          rawInput: args.command,
          content: [{ type: 'text', text: `${args.description}${shell === undefined ? '' : ` — ${shell}`}` }],
        }
        : {
          card: 'terminal',
          title: args.command,
          description: `${args.description}${shell === undefined ? '' : ` — ${shell}`}`,
          ...args.workdir !== undefined ? { cwd: args.workdir } : {},
        }
    },
    presentResult: (args, result) => {
      const block = result.content.length === 1 ? result.content[0] : undefined
      if (block === undefined || block.type !== 'text') return undefined
      const raw = block.text
      if (args.run_in_background === true || result.isError) {
        return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/u, '')}\n\`\`\`` }] }
      }
      // The exit marker becomes the card's exit pill, so it leaves the output body.
      const { body, ...exit } = parseExitStatus(raw)
      return { card: 'terminal', output: body, ...exit }
    },
  })

  // Re-read at every assembly so the model's description tracks the setting.
  Object.defineProperty(definition, 'description', {
    enumerable: true,
    get: () => shellDescription(describeShell(), backgroundEnabled, escalationModes),
  })

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: `tool:${SHELL_TOOL_NAME}`,
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: `Check the [exit code: N] marker on every ${SHELL_TOOL_NAME} result; investigate failures before moving on.`,
  })

  ctx.tools.register(definition)
}
