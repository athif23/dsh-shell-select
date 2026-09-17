/**
 * Argument dialects: how one command text becomes the argv a shell family is
 * launched with.
 *
 * A dialect is chosen by what the shell IS, not by the platform it runs on:
 * `bash` on Linux and `bash.exe` from Git for Windows take the same flags, and
 * PowerShell takes the same flags on every platform it ships for. Platform
 * differences live in {@link ./catalog.js} (which shells exist and how they are
 * named there), so this module stays a pure function of its inputs.
 *
 * Every dialect receives the command as ONE argv element or one environment
 * value. Nothing is concatenated into a command string, so no argument needs a
 * second round of quoting.
 *
 * @module dsh-shell-select/dialects
 */

/**
 * Environment variable carrying a cmd.exe command string.
 *
 * `cmd.exe` re-parses its raw command line with its own rules and does not
 * understand the `\"` escaping the subprocess seam applies to any argv element
 * containing whitespace, so a `cmd /c` argv element holding a quoted path
 * arrives as `\"C:\path\"` and fails with "The filename, directory name, or
 * volume label syntax is incorrect". Passing the text through an environment
 * variable makes cmd expand it after tokenizing, so quotes, redirection, `&`
 * and `|` all reach cmd's parser intact. Measured in
 * `test/cmd-command-transport.spec.mjs`.
 *
 * The cost of the transport is that cmd substitutes the variable once and does
 * not rescan the result, so a `%NAME%` in the command stays literal; writing
 * `call` re-enables expansion. The model-facing description says so.
 */
export const CMD_COMMAND_ENV = 'DSH_SHELL_SELECT_COMMAND'

/**
 * PowerShell UTF-8 output pinning, prepended to every PowerShell command.
 *
 * The subprocess collector decodes output as UTF-8, but Windows PowerShell 5.1
 * writes the console OEM code page by default, which garbles non-ASCII output.
 * The statements ride on line 1 so PowerShell error line numbers stay accurate.
 * Same statement `@deepseek-ai/dsh-pwsh-local` uses.
 */
export const POWERSHELL_ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Dialect ids, one per argument convention this plugin knows how to build. */
export const DIALECTS = Object.freeze(['bash', 'powershell', 'cmd', 'wsl'])

/**
 * Translate a Windows drive path into the WSL mount namespace.
 * @param windowsPath - an absolute `X:\...` or `X:/...` path.
 * @param mountRoot - the distribution's mount root, e.g. `/mnt`.
 * @returns the equivalent Linux path.
 * @throws {Error} when the path has no drive letter (UNC shares and device paths
 *   have no `/mnt` equivalent, so guessing one would run the command in the
 *   wrong directory).
 */
export function toLinuxPath(windowsPath, mountRoot) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(windowsPath)
  if (match === null) {
    throw new Error(
      `dsh-shell-select: cannot translate ${JSON.stringify(windowsPath)} into the WSL mount namespace: `
      + 'only drive-letter paths (C:\\..., D:\\...) have a mount equivalent',
    )
  }
  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/\\/gu, '/')
  return `${mountRoot}/${drive}${rest.length > 0 ? `/${rest}` : ''}`
}

/**
 * The bash-family argument vector for one command.
 *
 * Plain `-c` is inert with respect to user configuration: bash sources
 * `~/.bashrc` only for interactive shells, so a non-interactive `bash -c` reads
 * no rc file. `-l` is the opt-in that sources the login profile, and `--rcfile`
 * is deliberately unused because a per-call rc file would be configuration
 * execution by another name.
 * @param command - the command text.
 * @param loginShell - whether to run as a login shell.
 * @returns argv entries placed after the shell executable.
 */
export function bashArguments(command, loginShell) {
  return loginShell ? ['-l', '-c', command] : ['-c', command]
}

/**
 * The environment entries a dialect's transport needs, which are known from the
 * command text alone.
 *
 * Separate from {@link buildInvocation} because the executor stamps them onto
 * the spec during `resolve()`, before the executable has been found, while the
 * argv can only be built once it has.
 * @param dialect - one {@link DIALECTS} member.
 * @param command - the command text.
 * @returns the transport environment, or undefined when the dialect needs none.
 */
export function transportEnv(dialect, command) {
  if (dialect !== 'cmd') return undefined
  return { [CMD_COMMAND_ENV]: command }
}

/**
 * Build the argv for one dialect.
 * @param dialect - one {@link DIALECTS} member.
 * @param options - resolved executable, command text, and dialect settings.
 * @returns the argv to spawn plus any environment the transport needs.
 * @throws {Error} for an unknown dialect or an untranslatable WSL directory.
 */
export function buildInvocation(dialect, options) {
  const { executable, command } = options
  switch (dialect) {
    case 'bash':
      return { argv: [executable, ...bashArguments(command, options.loginShell === true)] }
    case 'powershell':
      return {
        argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `${POWERSHELL_ENCODING_PREAMBLE}${command}`],
      }
    case 'cmd':
      // `%NAME%` expands after cmd tokenizes the line, so the text reaches cmd's
      // parser intact; see {@link CMD_COMMAND_ENV}.
      return {
        argv: [executable, '/d', '/q', '/c', `%${CMD_COMMAND_ENV}%`],
        env: transportEnv(dialect, command),
      }
    case 'wsl': {
      const distro = options.distro
      return {
        argv: [
          executable,
          ...distro !== undefined && distro.length > 0 ? ['-d', distro] : [],
          '--cd', toLinuxPath(options.windowsCwd, options.mountRoot),
          '-e', 'bash', ...bashArguments(command, options.loginShell === true),
        ],
      }
    }
    default:
      throw new Error(`dsh-shell-select: unknown dialect ${JSON.stringify(dialect)}`)
  }
}

/**
 * The argv probing a shell's version. Fixed plugin-owned arguments only — no
 * caller or model input reaches a probe.
 * @param dialect - one {@link DIALECTS} member.
 * @param executable - the resolved executable.
 * @returns argv for a harmless version query.
 */
export function versionArgv(dialect, executable) {
  switch (dialect) {
    case 'bash':
      return [executable, '--version']
    case 'powershell':
      return [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
    case 'cmd':
      return [executable, '/d', '/q', '/c', 'ver']
    case 'wsl':
      return [executable, '--version']
    default:
      throw new Error(`dsh-shell-select: unknown dialect ${JSON.stringify(dialect)}`)
  }
}

/** Marker the "Test shell" action prints, so its output is self-identifying. */
export const TEST_MARKER = 'DSH-SHELL-SELECT-TEST-OK'

/**
 * The fixed command the settings card's "Test shell" action runs.
 *
 * A module constant rather than a parameter: the action then has no input to
 * carry, so the HTTP route that triggers it cannot be turned into a command
 * channel. `echo` is a builtin in every shell this plugin can drive.
 * @returns a command that only prints {@link TEST_MARKER}.
 */
export function testCommand() {
  return `echo ${TEST_MARKER}`
}
