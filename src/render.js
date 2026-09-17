/**
 * Model-facing result rendering for the `shell` tool.
 *
 * The text the model reads stays free of shell chrome: the shell is already in
 * the tool description, and repeating it on every result would spend tokens on a
 * fact that does not change per call. The shell and the resolved working
 * directory reach the user instead through the call presentation and the
 * persisted result metadata, which is where "which shell actually ran this?"
 * belongs.
 *
 * Non-zero exits are reported, not errored: the model decides how to react.
 * Only infrastructure failures surface as errors, upstream of this module.
 *
 * @module dsh-shell-select/render
 */

import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * Shape one finished run into the text the model sees.
 * @param result - the completed foreground run from the executor.
 * @param escalationModes - escalation targets this composition advertises; a
 *   non-empty list adds the same-turn escalation hint after a denial marker.
 * @returns the model-facing text: output body, then any markers, each on its own line.
 */
export function renderShellResult(result, escalationModes = []) {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)

  let body = out
  if (err.length > 0) {
    // Single newline between sections (stdout usually ends with one already).
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (result.sandbox?.denied) {
    markers.push(sandboxDenialMarker(result.sandbox.mode))
    // Hint only when the composition exposes escalation, before the final exit marker.
    if (escalationModes.length > 0) markers.push(escalationHintMarker('command'))
  }
  // A command may trap the termination and exit 0 after timeout; still report interruption.
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Shape one background-process read into the `job_output` delta the model sees.
 * @param read - one incremental read from the process handle.
 * @param sandbox - settled sandbox facts, when this was a confined process.
 * @param escalationModes - escalation targets advertised by this composition.
 * @returns the delta text with any loss or sandbox notice appended.
 */
export function renderShellProcessRead(read, sandbox, escalationModes = []) {
  const notices = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter(path => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return read.delta
  const separator = read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''
  return `${read.delta}${separator}${notices.join('\n')}`
}

/**
 * The human-readable one-line identification of the shell that ran a call.
 * @param shell - the persisted `shell` fact block.
 * @returns e.g. `Git Bash — C:\\Program Files\\Git\\bin\\bash.exe`.
 */
export function describeShellFact(shell) {
  if (shell === undefined || shell === null) return undefined
  const label = typeof shell.label === 'string' ? shell.label : undefined
  if (label === undefined) return undefined
  return typeof shell.executable === 'string' ? `${label} — ${shell.executable}` : label
}
