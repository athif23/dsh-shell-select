/**
 * Browser half of dsh-shell-select: the settings card.
 *
 * Written by hand rather than through the in-repo tsdown preset, because this
 * plugin lives outside the repository and needs no build step to stay
 * installable. It reproduces what that preset gives an in-repo card, by the
 * same means:
 *
 * - one `window.__ModuleLoader__.load({ id, factory })` closure whose externals
 *   come from the platform module table (`react`,
 *   `@deepseek-ai/dsh-client-ui-primitives`);
 * - one scoped stylesheet injected at factory execution, the way the preset
 *   injects its compiled CSS.
 *
 * The stylesheet exists rather than inline styles because half of what makes a
 * card look native — `:hover`, `:focus-visible`, transitions, and
 * `prefers-reduced-motion` — has no inline equivalent. Its rules are copied from
 * the shipped plugin card (`client/ui-settings-plugins/PluginCard.module.css`
 * and `fields.module.css`) and use the same `--dsw-alias-*` tokens, so this card
 * sits in the same list as its siblings without reading as foreign.
 *
 * The form stages edits and writes them on Save, matching the shipped cards: a
 * control reports what the user picked, and Save is the single point where a
 * draft becomes a document mutation. The staged writes go out as ONE
 * revision-fenced `mutate`, so a save lands whole or not at all.
 */

window.__ModuleLoader__.load({
  id: 'dsh-shell-select',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { Tag, IconChevronDownOutline14, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement

    /** Locale namespace owned by this card. */
    const NS = 'shell-select'

    /** Settings namespace owning the selection. */
    const SHELL_SELECT_NS = 'shell-select'

    /** Host routes serving the facts this card shows. */
    const STATUS_URL = '/dsh-shell-select/status'
    const TEST_URL = '/dsh-shell-select/test'

    /** The selection value meaning "whichever shell this platform ships with". */
    const AUTO = 'auto'

    /**
     * The staged text fields and whether an empty draft means "inherit".
     *
     * Clearing a path is how a user drops an override, so it stages an `unset`
     * and the field re-inherits the composition layer. `shell` and `loginShell`
     * are absent because they always carry a value: unsetting them would fall
     * back to the composition entry, which is not what a user who picked `cmd`
     * or unticked a box asked for.
     */
    const TEXT_FIELDS = [
      { field: 'executable', label: 'executable', hint: 'executableHint', emptyMeansInherit: true },
      { field: 'wslDistro', label: 'wslDistro', hint: 'wslDistroHint', emptyMeansInherit: true },
      { field: 'wslMountRoot', label: 'wslMountRoot', hint: 'wslMountRootHint', emptyMeansInherit: true },
    ]

    /** Copy for both supported UI languages. */
    const en = {
      title: 'Shell',
      description: 'Choose the shell every command runs in.',
      unsaved: 'Unsaved',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      readOnly: 'This deployment stores settings read-only.',
      expand: 'Show settings',
      collapse: 'Hide settings',
      platform: 'Platform',
      shell: 'Shell',
      currentShell: 'saved',
      auto: 'Automatic',
      autoResolves: 'resolves to',
      notFound: 'not found',
      detected: 'Detected',
      version: 'version',
      mode: 'Permission mode',
      confineable: 'sandbox: can be confined',
      unconfineable: 'sandbox: cannot be confined',
      usableInMode: 'usable in the current permission mode',
      blockedInMode: 'blocked by the current permission mode',
      confinementUnverified: 'Confinement on this platform has not been verified by this plugin.',
      executable: 'Executable path',
      executableHint: 'Leave empty to discover it. Takes effect when you save.',
      clearOverride: 'Clear override',
      replaceable: 'Replaceable',
      loginShell: 'Run as a login shell',
      loginShellHint: 'Sources your profile scripts on every command. Off by default.',
      wslDistro: 'WSL distribution',
      wslDistroHint: 'Leave empty to use the distribution\u2019s default.',
      wslMountRoot: 'WSL mount root',
      wslMountRootHint: 'Where the distribution mounts Windows drives. Default /mnt.',
      testShell: 'Test shell',
      testing: 'Testing…',
      refresh: 'Refresh',
      statusFailed: 'Could not read shell status',
      testSaved: 'Test runs the saved selection, not the edits staged here.',
      invalid: 'Invalid',
      invalidAbsolute: 'A path containing a separator must be absolute, or the execution environment refuses it.',
      invalidLoginShell: 'This shell takes no login flag; that applies to bash-family shells only.',
      invalidMountRoot: 'The mount root must be an absolute Linux path.',
    }
    const zh = {
      title: 'Shell',
      description: '选择命令运行所使用的 Shell。',
      unsaved: '未保存',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      readOnly: '本部署的设置为只读。',
      expand: '展开设置',
      collapse: '收起设置',
      platform: '平台',
      shell: 'Shell',
      currentShell: '已保存',
      auto: '自动',
      autoResolves: '解析为',
      notFound: '未找到',
      detected: '已检测到',
      version: '版本',
      mode: '权限模式',
      confineable: '沙箱：可被限制',
      unconfineable: '沙箱：无法被限制',
      usableInMode: '在当前权限模式下可用',
      blockedInMode: '被当前权限模式阻止',
      confinementUnverified: '本插件尚未验证该平台的沙箱限制行为。',
      executable: '可执行文件路径',
      executableHint: '留空则自动检测。保存后生效。',
      clearOverride: '清除覆盖',
      replaceable: '可替换',
      loginShell: '以登录 Shell 运行',
      loginShellHint: '每条命令都会加载你的 profile 脚本。默认关闭。',
      wslDistro: 'WSL 发行版',
      wslDistroHint: '留空则使用该发行版的默认值。',
      wslMountRoot: 'WSL 挂载根目录',
      wslMountRootHint: '该发行版挂载 Windows 磁盘的位置。默认 /mnt。',
      testShell: '测试 Shell',
      testing: '测试中…',
      refresh: '刷新',
      statusFailed: '无法读取 Shell 状态',
      testSaved: '测试针对已保存的选择，而不是这里暂存的修改。',
      invalid: '无效',
      invalidAbsolute: '含路径分隔符的路径必须是绝对路径，否则执行环境会拒绝它。',
      invalidLoginShell: '该 Shell 不接受登录参数；它只适用于 bash 系列。',
      invalidMountRoot: '挂载根目录必须是绝对 Linux 路径。',
    }

    /**
     * The card's stylesheet.
     *
     * Geometry, palette, and durations are the shipped plugin card's, so this
     * card matches its siblings. Two things are this card's own: press feedback
     * on its controls (a `scale(.97)` on `:active`, whose transition is removed
     * under `prefers-reduced-motion` rather than left to animate), and the
     * choice buttons, which no sibling card has.
     */
    const CSS_TEXT = `
.dsss-card {
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dsss-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dsss-cardOpen { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dsss-header {
  width: 100%; appearance: none; border: 0; background: none;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-radius: 12px;
}
.dsss-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsss-headText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsss-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.dsss-description { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsss-chevron { flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s; }
.dsss-chevronOpen { transform: rotate(180deg); }
.dsss-pending { flex: none; }
.dsss-body { border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.dsss-readOnly { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }

.dsss-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dsss-field + .dsss-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsss-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsss-label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsss-grow { flex: 1; min-width: 0; }
.dsss-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dsss-check input { margin: 0; }
.dsss-badges { display: inline-flex; align-items: center; gap: 8px; }
.dsss-reset {
  border: none; background: none; padding: 0; font: inherit;
  font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsss-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dsss-reset:disabled { cursor: default; }
.dsss-input {
  height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary);
}
.dsss-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsss-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dsss-inputInvalid { border-color: var(--dsw-alias-label-error); }
.dsss-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsss-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }

/* Selector row: the label and its description on the left, the trigger on the
   right. The shipped Enter-behavior row's layout and trigger, so a dropdown in
   this card is the same control as a dropdown anywhere else in Settings. */
.dsss-row { display: flex; align-items: center; gap: 8px; }
.dsss-rowText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 24px; }
.dsss-rowTitle { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsss-rowDesc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsss-selector {
  display: inline-flex; align-items: center; gap: 12px;
  max-width: 240px;
  height: 36px; padding: 0 14px;
  border: none; border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: transform .16s cubic-bezier(.23, 1, .32, 1), background .16s;
}
.dsss-selector > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsss-selector:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsss-selector:active:not(:disabled) { transform: scale(.97); }
.dsss-selector:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsss-selector:disabled { opacity: .4; cursor: default; }
.dsss-chevron { flex: none; }
/* An option's own fact, quieter than its name: the version it reports, or that
   it is not installed. Truncates with the label, never wraps. */
.dsss-optMeta { color: var(--dsw-alias-label-tertiary); }

.dsss-facts { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsss-factsQuiet { color: var(--dsw-alias-label-tertiary); }
.dsss-factsError { color: var(--dsw-alias-label-error); }

.dsss-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 12px 0 0; }
.dsss-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 12px 0 4px; border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsss-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-error); }
.dsss-discard, .dsss-save, .dsss-tool {
  appearance: none; border: 1px solid transparent; border-radius: 8px;
  padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  transition: transform .16s cubic-bezier(.23, 1, .32, 1), color .16s, border-color .16s, background .16s;
}
.dsss-discard, .dsss-tool { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
.dsss-discard:hover:not(:disabled), .dsss-tool:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed);
}
.dsss-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dsss-discard:active:not(:disabled), .dsss-save:active:not(:disabled), .dsss-tool:active:not(:disabled) { transform: scale(.97); }
.dsss-discard:disabled, .dsss-save:disabled, .dsss-tool:disabled { opacity: .4; cursor: default; }
.dsss-discard:focus-visible, .dsss-save:focus-visible, .dsss-tool:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
}
.dsss-test { margin: 8px 0 0; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.dsss-testOk { color: var(--dsw-alias-label-secondary); }
.dsss-testBad { color: var(--dsw-alias-label-error); }

/* Press feedback is feedback, not motion: keep the scale, drop the animation. */
@media (prefers-reduced-motion: reduce) {
  .dsss-selector, .dsss-discard, .dsss-save, .dsss-tool { transition-duration: 0ms; }
}
`

    /** Id of the injected stylesheet, so a second activation reuses it. */
    const STYLE_ID = 'dsh-shell-select-card-styles'

    /** Inject the card's stylesheet once per document. */
    function ensureStylesheet() {
      const dom = globalThis.document
      if (dom === undefined || dom.head === null || dom.head === undefined) return
      if (dom.getElementById(STYLE_ID) !== null) return
      const style = dom.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      dom.head.appendChild(style)
    }

    /** Read one stored settings field as display text. */
    function storedText(snapshot, field) {
      const value = snapshot?.user?.[field] ?? snapshot?.base?.[field] ?? snapshot?.value?.[field]
      return value === undefined || value === null ? '' : String(value)
    }

    /** Read one stored settings field as a boolean. */
    function storedFlag(snapshot, field) {
      const value = snapshot?.user?.[field] ?? snapshot?.base?.[field] ?? snapshot?.value?.[field]
      return value === true || value === 'true'
    }

    /**
     * Whether a path is absolute on the execution platform.
     *
     * The rule the execution environment applies, not a guess: an absolute
     * Windows path is a drive path or a UNC share, and a POSIX path starts at the
     * root. A separator-bearing path that fails this is rejected by
     * `ctx.subprocess.resolveExecutable` before any shell runs.
     */
    function isAbsoluteFor(platform, path) {
      return platform === 'windows'
        ? /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
        : path.startsWith('/')
    }

    /** The catalog row for one shell id, or undefined before the first fetch. */
    function rowFor(status, id) {
      return status?.shells?.find(row => row.id === id)
    }

    /** The staged form's value at rest: every field with its stored fallback. */
    function draftFrom(snapshot) {
      return {
        shell: storedText(snapshot, 'shell') || AUTO,
        executable: storedText(snapshot, 'executable'),
        loginShell: storedFlag(snapshot, 'loginShell'),
        wslDistro: storedText(snapshot, 'wslDistro'),
        wslMountRoot: storedText(snapshot, 'wslMountRoot'),
      }
    }

    /** The revision-fenced ops one save writes, empty when nothing changed. */
    function saveOps(draft, stored) {
      const ops = []
      if (draft.shell !== stored.shell) ops.push({ op: 'set', path: ['shell'], value: draft.shell })
      if (draft.loginShell !== stored.loginShell) {
        ops.push({ op: 'set', path: ['loginShell'], value: draft.loginShell })
      }
      for (const { field, emptyMeansInherit } of TEXT_FIELDS) {
        const next = draft[field].trim()
        if (next === stored[field].trim()) continue
        if (next.length === 0 && emptyMeansInherit) ops.push({ op: 'unset', path: [field] })
        else ops.push({ op: 'set', path: [field], value: next })
      }
      return ops
    }

    /**
     * What a save of this draft could not write.
     *
     * Each check mirrors a refusal the Host would otherwise raise, so Save can
     * be blocked with the reason at the field instead of staging a write that
     * comes back rejected.
     * @param draft - the staged selection.
     * @param status - the last status payload, which carries the platform and
     *   the per-shell facts the checks need.
     * @returns field name to locale key, empty when the draft is writable.
     */
    function planFailures(draft, status) {
      const platform = status?.active?.platform
      const failures = {}
      const executable = draft.executable.trim()
      const mountRoot = draft.wslMountRoot.trim()
      const selected = rowFor(status, draft.shell)

      if (executable.length > 0 && /[\\/]/u.test(executable)
        && platform !== undefined && !isAbsoluteFor(platform, executable)) {
        failures.executable = 'invalidAbsolute'
      }
      if (mountRoot.length > 0 && !mountRoot.startsWith('/')) {
        failures.wslMountRoot = 'invalidMountRoot'
      }
      // The Host refuses a login flag on a dialect that has no such flag, so a
      // staged one is blocked here rather than written and rejected there.
      if (draft.loginShell && selected !== undefined && selected.supportsLoginShell !== true) {
        failures.loginShell = 'invalidLoginShell'
      }
      return failures
    }

    /** One observable the slot hook can subscribe to. */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * The card's form: staged drafts over a bound settings scope, plus the two
     * host reads its controls need.
     *
     * `stored` re-seeds from the scope on every publish so the form always
     * describes what the document holds, and `draft` re-seeds from it on
     * discard and on a completed save.
     */
    class CardController {
      /** @param scope - the bound `shell-select` settings scope. */
      constructor(scope) {
        this.scope = scope
        this.store = createStore({
          available: false,
          writable: false,
          saving: false,
          testing: false,
          failed: false,
          draft: draftFrom(undefined),
          stored: draftFrom(undefined),
          dirty: false,
          failures: {},
          snapshot: undefined,
          status: undefined,
          test: undefined,
        })
        this.dispose = scope.subscribe(() => { this.publish() })
        this.publish()
      }

      /** Re-seed the form from the scope and republish. */
      publish() {
        const snapshot = this.scope.getSnapshot()
        const current = this.store.getSnapshot()
        const stored = draftFrom(snapshot)
        // A write from elsewhere — another window, a hand-edited document —
        // re-seeds the draft only while the user holds nothing of their own, so
        // it can never silently discard staged edits.
        const draft = current.dirty ? current.draft : stored
        const failures = planFailures(draft, current.status)
        this.store.set({
          ...current,
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          snapshot,
          stored,
          draft,
          failures,
          dirty: saveOps(draft, stored).length > 0,
        })
      }

      /** Stage one draft change. */
      edit(field, value) {
        const current = this.store.getSnapshot()
        if (!current.writable || current.saving) return
        const draft = { ...current.draft, [field]: value }
        this.store.set({
          ...current,
          draft,
          failures: planFailures(draft, current.status),
          dirty: saveOps(draft, current.stored).length > 0,
          failed: false,
        })
      }

      /** Drop every staged edit. */
      discard() {
        const current = this.store.getSnapshot()
        this.store.set({ ...current, draft: current.stored, dirty: false, failures: {}, failed: false })
      }

      /** Write the staged edits as one revision-fenced mutation. */
      async save() {
        const current = this.store.getSnapshot()
        const ops = saveOps(current.draft, current.stored)
        if (ops.length === 0 || Object.keys(current.failures).length > 0 || current.saving || !current.writable) return
        this.store.set({ ...current, saving: true, failed: false })
        try {
          await this.scope.mutate(ops, current.snapshot?.revision)
          // The scope's subscription republishes on commit, re-seeding draft
          // and stored from what the Host accepted.
          this.store.set({ ...this.store.getSnapshot(), saving: false })
          await this.refreshStatus()
        } catch {
          // The staged values stay in place for correction, and the draft stays
          // dirty so the header keeps reporting unsaved edits.
          this.store.set({ ...this.store.getSnapshot(), saving: false, failed: true })
        }
      }

      /** Re-read the host's shell facts. */
      async refreshStatus() {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          const body = await response.json()
          const current = this.store.getSnapshot()
          const status = response.ok ? body : { error: body.error ?? response.status }
          this.store.set({ ...current, status, failures: planFailures(current.draft, status) })
          this.publish()
        } catch (error) {
          this.store.set({ ...this.store.getSnapshot(), status: { error: String(error) } })
        }
      }

      /** Run the host's fixed test command against the saved selection. */
      async testShell() {
        this.store.set({ ...this.store.getSnapshot(), testing: true })
        try {
          const response = await fetch(TEST_URL, { method: 'POST', headers: { accept: 'application/json' } })
          const body = await response.json()
          this.store.set({
            ...this.store.getSnapshot(),
            testing: false,
            test: response.ok ? body : { ok: false, detail: body.error ?? String(response.status) },
          })
        } catch (error) {
          this.store.set({ ...this.store.getSnapshot(), testing: false, test: { ok: false, detail: String(error) } })
        }
        await this.refreshStatus()
      }
    }

    /**
     * Render the shell card.
     * @param props - locale copy, the card snapshot, and its actions.
     * @returns the card.
     */
    function ShellCard(props) {
      const { t } = props
      const state = props.useShellSelect(snapshot => snapshot)
      const [open, setOpen] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const saveStarted = React.useRef(false)
      const { draft, stored, status, failures, writable, dirty, saving, failed } = state

      // Collapse only after a save lands whole; a rejected write keeps its
      // diagnostics and staged edits visible for correction. The shipped plugin
      // card applies the same rule.
      React.useEffect(() => {
        if (saving) { saveStarted.current = true; return }
        if (!saveStarted.current) return
        saveStarted.current = false
        if (!dirty && !failed) setOpen(false)
      }, [dirty, failed, saving])

      if (!state.available) return null

      // `auto` is a setting value with no catalog row of its own, so what it
      // currently resolves to is what the facts should describe.
      const resolvedId = status?.active?.selected
      const selected = rowFor(status, draft.shell)
        ?? (draft.shell === AUTO ? rowFor(status, resolvedId) : undefined)
      const savedRow = rowFor(status, stored.shell)
        ?? (stored.shell === AUTO ? rowFor(status, resolvedId) : undefined)
      const invalid = Object.keys(failures).length > 0
      const blocked = !dirty || invalid || saving || !writable
      const platform = status?.active?.platform
      const interactive = writable && !saving

      /** One option's label: the shell's name, then its own fact more quietly. */
      const optionLabel = (name, meta) => meta === undefined || meta.length === 0
        ? name
        : h('span', null, name, h('span', { className: 'dsss-optMeta' }, ` · ${meta}`))

      // Every catalog row carries its own resolution, so an uninstalled shell is
      // still offered — it reads as not found, and it is a legitimate choice
      // when an explicit path is about to be given for it.
      const shellOptions = [
        {
          id: AUTO,
          label: optionLabel(t('auto'), t('autoResolves') + ' ' + (rowFor(status, resolvedId)?.label ?? '…')),
        },
        ...(status?.shells ?? []).map(row => ({
          id: row.id,
          label: optionLabel(row.label, row.available === true
            ? (row.version ?? row.path ?? '')
            : t('notFound')),
        })),
      ]

      /** What the trigger reads: the selected shell's name, nothing more. */
      const triggerLabel = draft.shell === AUTO
        ? t('auto')
        : (rowFor(status, draft.shell)?.label ?? draft.shell)

      // The facts follow the DRAFT selection, because every catalog row carries
      // its own resolution: picking a shell shows what it would resolve to
      // before the save, which is the point of choosing here.
      const facts = []
      if (selected !== undefined) {
        facts.push(h('span', { key: 'exe', className: selected.available === true ? undefined : 'dsss-factsError' },
          selected.available === true
            ? `${t('detected')}: ${selected.path}`
            : `${t('notFound')}: ${selected.detail ?? ''}`))
        if (selected.version !== undefined) {
          facts.push(h('span', { key: 'ver' }, `${t('version')}: ${selected.version}`))
        }
        if (selected.versionError !== undefined) {
          facts.push(h('span', { key: 'verr', className: 'dsss-factsError' }, selected.versionError))
        }
        facts.push(h('span', { key: 'conf' }, selected.confineable ? t('confineable') : t('unconfineable')))
        if (selected.confineable === false && selected.confineReason !== undefined) {
          facts.push(h('span', { key: 'why', className: 'dsss-factsQuiet' }, selected.confineReason))
        }
        facts.push(h('span', { key: 'mode' }, `${t('mode')}: ${status?.active?.mode ?? ''}`))
        facts.push(h('span', {
          key: 'usable',
          className: selected.usableInMode === false ? 'dsss-factsError' : undefined,
        }, selected.usableInMode === false ? t('blockedInMode') : t('usableInMode')))
      } else if (status !== undefined && status.shells === undefined) {
        facts.push(h('span', { key: 'none', className: 'dsss-factsError' },
          `${t('statusFailed')}${status.error === undefined ? '' : `: ${status.error}`}`))
      }

      const textField = spec => {
        const name = spec.field
        const overridden = stored[name].length > 0
        return h('div', { className: 'dsss-field', key: name },
          h('div', { className: 'dsss-head' },
            h('label', { className: 'dsss-label dsss-grow', htmlFor: `dsss-${name}` }, t(spec.label)),
            overridden
              ? h('span', { className: 'dsss-badges' },
                h(Tag, { tone: 'neutral' }, t('replaceable')),
                h('button', {
                  type: 'button',
                  className: 'dsss-reset',
                  disabled: !interactive,
                  onClick: () => { props.edit(name, '') },
                }, t('clearOverride')),
              )
              : null,
          ),
          h('input', {
            id: `dsss-${name}`,
            className: failures[name] === undefined ? 'dsss-input' : 'dsss-input dsss-inputInvalid',
            type: 'text',
            value: draft[name],
            placeholder: selected?.path ?? '',
            disabled: !interactive,
            ...failures[name] === undefined ? {} : { 'aria-invalid': true },
            onChange: event => { props.edit(name, event.target.value) },
          }),
          h('p', { className: failures[name] === undefined ? 'dsss-hint' : 'dsss-invalid' },
            t(failures[name] ?? spec.hint)),
        )
      }

      const test = state.test
      const testBlock = test === undefined ? null : h('p', {
        className: test.ok ? 'dsss-test dsss-testOk' : 'dsss-test dsss-testBad',
      }, test.ok
        ? `${test.shell ?? ''} → exit ${String(test.exitCode ?? '')}\n${String(test.stdout ?? '')}`.trim()
        : `${test.stage ?? ''}: ${test.detail ?? ''}`.trim())

      return h('li', { className: open ? 'dsss-card dsss-cardOpen' : 'dsss-card' },
        h('button', {
          type: 'button',
          className: 'dsss-header',
          'aria-expanded': open,
          'aria-label': `${t(open ? 'collapse' : 'expand')}: ${t('title')}`,
          onClick: () => { setOpen(!open) },
        },
        h('span', { className: 'dsss-headText' },
          h('span', { className: 'dsss-name' }, t('title')),
          h('span', { className: 'dsss-description' }, t('description')),
        ),
        dirty ? h(Tag, { tone: 'neutral', className: 'dsss-pending' }, t('unsaved')) : null,
        h(IconChevronDownOutline14, { className: open ? 'dsss-chevron dsss-chevronOpen' : 'dsss-chevron' }),
        ),
        open
          ? h('div', { className: 'dsss-body' },
            !writable ? h('p', { className: 'dsss-readOnly', role: 'status' }, t('readOnly')) : null,

            h('div', { className: 'dsss-field' },
              h('div', { className: 'dsss-row' },
                h('div', { className: 'dsss-rowText' },
                  h('div', { className: 'dsss-rowTitle' }, t('shell')),
                  h('div', { className: 'dsss-rowDesc' }, [
                    `${t('platform')}: ${platform ?? '…'}`,
                    // Compared as setting VALUES: `auto` and a shell that auto
                    // happens to resolve to are different settings, even though
                    // they name the same catalog row.
                    stored.shell === draft.shell
                      ? ''
                      : ` · ${t('currentShell')}: ${savedRow?.label ?? stored.shell}`,
                  ].join('')),
                ),
                h(Menu, {
                  open: menuOpen,
                  onClose: () => { setMenuOpen(false) },
                  items: shellOptions,
                  selectedId: draft.shell,
                  onSelect: (id) => {
                    setMenuOpen(false)
                    props.edit('shell', id)
                  },
                  align: 'end',
                  // Portalled: the settings panel scrolls, and an in-place list
                  // would be cropped by it.
                  portal: true,
                  anchor: h('button', {
                    type: 'button',
                    className: 'dsss-selector',
                    'aria-haspopup': 'menu',
                    'aria-expanded': menuOpen,
                    disabled: !interactive,
                    onClick: () => { setMenuOpen(!menuOpen) },
                  },
                  h('span', null, triggerLabel),
                  h(IconChevronDownOutline14, { className: 'dsss-chevron' }),
                  ),
                }),
              ),
              h('div', { className: 'dsss-facts' }, facts),
              status?.confinementVerified === false
                ? h('p', { className: 'dsss-hint' }, t('confinementUnverified'))
                : null,
            ),

            textField(TEXT_FIELDS[0]),

            selected?.supportsLoginShell === true
              ? h('div', { className: 'dsss-field', key: 'loginShell' },
                h('label', { className: 'dsss-label dsss-check' },
                  h('input', {
                    id: 'dsss-loginShell',
                    type: 'checkbox',
                    disabled: !interactive,
                    checked: draft.loginShell,
                    onChange: event => { props.edit('loginShell', event.target.checked) },
                  }),
                  h('span', null, t('loginShell')),
                ),
                h('p', { className: failures.loginShell === undefined ? 'dsss-hint' : 'dsss-invalid' },
                  t(failures.loginShell ?? 'loginShellHint')),
              )
              : null,

            selected?.supportsDistro === true ? textField(TEXT_FIELDS[1]) : null,
            selected?.supportsDistro === true ? textField(TEXT_FIELDS[2]) : null,

            h('div', { className: 'dsss-tools' },
              h('button', {
                type: 'button',
                className: 'dsss-tool',
                disabled: state.testing === true,
                onClick: () => { void props.testShell() },
              }, t(state.testing === true ? 'testing' : 'testShell')),
              h('button', {
                type: 'button',
                className: 'dsss-tool',
                onClick: () => { void props.refreshStatus() },
              }, t('refresh')),
              dirty ? h('span', { className: 'dsss-hint' }, t('testSaved')) : null,
            ),
            testBlock,

            h('div', { className: 'dsss-footer' },
              failed ? h('p', { className: 'dsss-failed', role: 'status' }, t('saveFailed')) : null,
              h('button', {
                type: 'button',
                className: 'dsss-discard',
                disabled: !dirty || saving,
                onClick: () => { props.discard() },
              }, t('discard')),
              h('button', {
                type: 'button',
                className: 'dsss-save',
                disabled: blocked,
                onClick: () => { void props.save() },
              }, t(saving ? 'saving' : 'save')),
            ),
          )
          : null,
      )
    }

    /** Services the card needs before it applies. */
    const inject = ['slots', 'settingsScope', 'locale']

    /**
     * Register the card.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        ensureStylesheet()
        return () => { globalThis.document?.getElementById(STYLE_ID)?.remove() }
      }, 'dsh-shell-select: card stylesheet')
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-shell-select: card dictionaries')

      const scope = ctx.settingsScope.bind({ namespace: SHELL_SELECT_NS })
      const controller = new CardController(scope)
      // The shell list, the resolved paths, and the confinement facts come from
      // the host, so they are read once when the card is contributed rather than
      // on every expand: opening a card is a reading gesture, and a fetch per
      // disclosure would make it feel like one.
      void controller.refreshStatus()

      const actions = {
        edit: (field, value) => { controller.edit(field, value) },
        discard: () => { controller.discard() },
        save: () => controller.save(),
        testShell: () => controller.testShell(),
        refreshStatus: () => controller.refreshStatus(),
      }

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: SHELL_SELECT_NS,
        locale: NS,
        // Everything the card renders rides the one hook snapshot, so a scope
        // write and a host read publish through the same subscription.
        inject: () => ({ hooks: { shellSelect: controller.store }, ...actions }),
      }, ShellCard))

      return () => { controller.dispose() }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-shell-select'
    return module.exports
  },
})
