/**
 * Browser half of dsh-shell-select: the settings card.
 *
 * Written by hand rather than through the in-repo tsdown preset, because this
 * plugin lives outside the repository and needs no build step to stay
 * installable. The bundle has the same shape that preset emits: one
 * `window.__ModuleLoader__.load({ id, factory })` closure whose externals come
 * from the platform module table (`react`,
 * `@deepseek-ai/dsh-client-ui-primitives`). Everything else is inlined.
 *
 * The card edits one settings namespace, `shell-select`, and reads the shell
 * list from the host routes registered by `src/status.js`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-shell-select',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { Button, Input, Pill } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement

    /** Locale namespace owned by this card. */
    const NS = 'shell-select'

    /** Settings namespace owning the selection. */
    const SHELL_SELECT_NS = 'shell-select'

    /** Host routes serving the facts this card shows. */
    const STATUS_URL = '/dsh-shell-select/status'
    const TEST_URL = '/dsh-shell-select/test'

    /** Copy for both supported UI languages. */
    const en = {
      title: 'Shell',
      description: 'Choose the shell every command runs in. The selection applies to subsequent calls; it never changes a running command, and it never changes your permission mode.',
      shell: 'Shell',
      platform: 'Platform',
      notFound: 'not found',
      detected: 'detected',
      version: 'version',
      confineable: 'sandbox: can be confined',
      unconfineable: 'sandbox: cannot be confined',
      usableInMode: 'usable in the current permission mode',
      blockedInMode: 'blocked by the current permission mode',
      confinementUnverified: 'Confinement facts for this platform have not been verified by this plugin.',
      executablePath: 'Executable path (optional; leave empty to discover it)',
      reset: 'Clear override',
      testShell: 'Test shell',
      testing: 'Testing…',
      refresh: 'Refresh',
      statusFailed: 'Could not read shell status',
      loginShell: 'Run as a login shell (sources your profile scripts on every command)',
      wslDistro: 'WSL distribution (optional)',
      wslMountRoot: 'WSL mount root',
      activeMode: 'Permission mode',
    }
    const zh = {
      title: 'Shell',
      description: '选择命令运行所使用的 Shell。该选择仅对后续调用生效，不会影响正在运行的命令，也不会更改你的权限模式。',
      shell: 'Shell',
      platform: '平台',
      notFound: '未找到',
      detected: '已检测到',
      version: '版本',
      confineable: '沙箱：可被限制',
      unconfineable: '沙箱：无法被限制',
      usableInMode: '在当前权限模式下可用',
      blockedInMode: '被当前权限模式阻止',
      confinementUnverified: '本插件尚未验证该平台的沙箱限制行为。',
      executablePath: '可执行文件路径（可选；留空则自动检测）',
      reset: '清除覆盖',
      testShell: '测试 Shell',
      testing: '测试中…',
      refresh: '刷新',
      statusFailed: '无法读取 Shell 状态',
      loginShell: '以登录 Shell 运行（每条命令都会加载你的 profile 脚本）',
      wslDistro: 'WSL 发行版（可选）',
      wslMountRoot: 'WSL 挂载根目录',
      activeMode: '权限模式',
    }

    const CSS = {
      root: { display: 'flex', flexDirection: 'column', gap: '12px' },
      row: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', opacity: 0.7 },
      choices: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      facts: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px', opacity: 0.85 },
      hint: { fontSize: '12px', opacity: 0.65 },
      warn: { fontSize: '12px', opacity: 0.85 },
      error: { fontSize: '12px', color: 'var(--dsw-alias-text-danger, #d33)' },
      pre: { margin: 0, fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      actions: { display: 'flex', gap: '8px', alignItems: 'center' },
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

    /** Read one settings field as display text. */
    function valueOf(state, field) {
      const value = state?.user?.[field] ?? state?.base?.[field] ?? state?.value?.[field]
      return value === undefined || value === null ? '' : String(value)
    }

    /** The status row for one shell id, or undefined before the first fetch. */
    function rowFor(status, id) {
      return status?.shells?.find(row => row.id === id)
    }

    /**
     * Render the shell card.
     * @param props - locale copy, the card snapshot, and its actions.
     * @returns the card.
     */
    function ShellCard(props) {
      const { t } = props
      const state = props.useShellSelect(snapshot => snapshot)
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)

      const settings = state.settings
      const status = state.status
      const selected = valueOf(settings, 'shell') || status?.active?.shell || ''
      const row = rowFor(status, selected)
      const writable = state.writable !== false

      React.useEffect(() => {
        props.refreshStatus()
        // Refresh once per mount: the card is the only place these machine
        // facts are shown, and the host computes them on demand.
      }, [])

      const commit = (field, value) => {
        // An empty value means "no override": clearing the field restores
        // discovery instead of storing an empty path that would fail validation.
        if (value === '') props.unsetField(field)
        else props.setField(field, value)
      }

      const choices = (status?.shells ?? []).map(entry => h('div', {
        key: entry.id,
        style: { display: 'flex', flexDirection: 'column', gap: '2px' },
      },
      h(Button, {
        size: 'sm',
        variant: entry.id === selected ? 'primary' : 'outline',
        disabled: !writable || busy,
        onClick: () => { props.setField('shell', entry.id) },
      }, entry.available === true ? entry.label : `${entry.label} (${t('notFound')})`),
      h('span', {
        style: entry.available === true ? CSS.hint : CSS.error,
      }, entry.available === true ? (entry.version ?? '') : ''),
      ))

      const facts = []
      if (row !== undefined) {
        facts.push(h('div', { key: 'exe', style: CSS.facts },
          h('span', null, row.available === true
            ? `${t('detected')}: ${row.path}`
            : `${t('notFound')}: ${row.detail ?? ''}`),
          row.version !== undefined ? h('span', null, `${t('version')}: ${row.version}`) : null,
          row.versionError !== undefined ? h('span', { style: CSS.error }, row.versionError) : null,
        ))
        // Three separate facts, deliberately not merged into one status line:
        // installed, permitted under the current mode, and (from the test) what
        // the sandbox actually did.
        facts.push(h('div', {
          key: 'mode',
          style: row.usableInMode === false ? CSS.error : CSS.facts,
        },
        h('span', null, row.confineable ? t('confineable') : t('unconfineable')),
        h('span', null, `${t('activeMode')}: ${status?.active?.mode ?? 'unknown'}`),
        row.usableInMode === false ? h('span', null, t('blockedInMode')) : h('span', null, t('usableInMode')),
        row.confineReason !== undefined ? h('span', { style: CSS.hint }, row.confineReason) : null,
        ))
      } else if (status !== undefined && status.shells === undefined) {
        facts.push(h('div', { key: 'none', style: CSS.error }, `${t('statusFailed')}: ${status.error ?? ''}`))
      }
      if (status !== undefined && status.confinementVerified === false) {
        facts.push(h('div', { key: 'unverified', style: CSS.warn }, t('confinementUnverified')))
      }

      const currentPath = valueOf(settings, 'executable')
      const pathDraft = draft.executable ?? currentPath

      const testResult = state.test
      const testBlock = testResult === undefined ? null : h('div', {
        style: testResult.ok ? CSS.facts : CSS.error,
      }, h('pre', { style: CSS.pre }, JSON.stringify(testResult, null, 1)))

      return h('section', { style: CSS.root, 'aria-label': t('title') },
        h('strong', null, t('title')),
        h('p', { style: CSS.hint }, t('description')),
        h('span', { style: CSS.label }, `${t('platform')}: ${status?.active?.platform ?? '…'}`),
        h('div', { style: CSS.row },
          h('span', { style: CSS.label }, t('shell')),
          h('div', { style: CSS.choices }, choices.length > 0 ? choices : h('span', { style: CSS.hint }, '…')),
        ),
        facts.length > 0 ? h('div', { style: CSS.row }, facts) : null,
        h('div', { style: CSS.row },
          h('label', { style: CSS.label, htmlFor: 'shell-select-path' }, t('executablePath')),
          h('div', { style: CSS.actions },
            h(Input, {
              id: 'shell-select-path',
              disabled: !writable || busy,
              value: pathDraft,
              placeholder: row?.path ?? '',
              onChange: event => setDraft({ ...draft, executable: event.target.value }),
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                commit('executable', pathDraft)
              },
              onBlur: () => commit('executable', pathDraft),
            }),
            h(Button, {
              size: 'sm',
              variant: 'outline',
              disabled: !writable || busy || currentPath === '',
              onClick: () => { setDraft({ ...draft, executable: '' }); commit('executable', '') },
            }, t('reset')),
          ),
        ),
        row?.supportsLoginShell === true ? h('label', { style: { ...CSS.label, display: 'flex', gap: '6px' } },
          h('input', {
            type: 'checkbox',
            disabled: !writable || busy,
            checked: valueOf(settings, 'loginShell') === 'true',
            onChange: event => props.setField('loginShell', event.target.checked ? 'true' : 'false'),
          }),
          t('loginShell'),
        ) : null,
        row?.supportsDistro === true ? h('div', { style: CSS.row },
          h('label', { style: CSS.label, htmlFor: 'shell-select-distro' }, t('wslDistro')),
          h(Input, {
            id: 'shell-select-distro',
            disabled: !writable || busy,
            value: draft.wslDistro ?? valueOf(settings, 'wslDistro'),
            onChange: event => setDraft({ ...draft, wslDistro: event.target.value }),
            onBlur: () => commit('wslDistro', draft.wslDistro ?? valueOf(settings, 'wslDistro')),
          }),
        ) : null,
        row?.supportsDistro === true ? h('div', { style: CSS.row },
          h('label', { style: CSS.label, htmlFor: 'shell-select-mount' }, t('wslMountRoot')),
          h(Input, {
            id: 'shell-select-mount',
            disabled: !writable || busy,
            value: draft.wslMountRoot ?? valueOf(settings, 'wslMountRoot'),
            onChange: event => setDraft({ ...draft, wslMountRoot: event.target.value }),
            onBlur: () => commit('wslMountRoot', draft.wslMountRoot ?? valueOf(settings, 'wslMountRoot')),
          }),
        ) : null,
        h('div', { style: CSS.actions },
          h(Button, {
            size: 'sm',
            variant: 'primary',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              try { await props.testShell() } finally { setBusy(false) }
            },
          }, busy ? t('testing') : t('testShell')),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            disabled: busy,
            onClick: () => { props.refreshStatus() },
          }, t('refresh')),
          writable ? null : h(Pill, null, 'read-only'),
        ),
        testBlock,
      )
    }

    /** Services the card needs before it applies. */
    const inject = ['slots', 'settingsScope', 'locale']

    /**
     * Register the card.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-shell-select: card dictionaries')

      const scope = ctx.settingsScope.bind({ namespace: SHELL_SELECT_NS })
      const store = createStore({ settings: undefined, writable: true, status: undefined, test: undefined })

      /** Fold the settings scope into the one snapshot the card renders. */
      const publish = () => {
        const snapshot = scope.getSnapshot()
        store.set({
          ...store.getSnapshot(),
          settings: { value: snapshot.value, user: snapshot.user, base: snapshot.base },
          writable: snapshot.writable,
        })
      }

      const disposeScope = scope.subscribe(publish)
      publish()

      const refreshStatus = async () => {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } })
          const body = await response.json()
          store.set({ ...store.getSnapshot(), status: response.ok ? body : { error: body.error ?? response.status } })
        } catch (error) {
          store.set({ ...store.getSnapshot(), status: { error: String(error) } })
        }
      }

      const testShell = async () => {
        try {
          const response = await fetch(TEST_URL, { method: 'POST', headers: { accept: 'application/json' } })
          const body = await response.json()
          store.set({
            ...store.getSnapshot(),
            test: response.ok ? body : { ok: false, detail: body.error ?? String(response.status) },
          })
        } catch (error) {
          store.set({ ...store.getSnapshot(), test: { ok: false, detail: String(error) } })
        }
        await refreshStatus()
      }

      const actions = {
        setField: (field, value) => {
          // Booleans are stored as booleans; every other edited field is text.
          const typed = value === 'true' ? true : value === 'false' ? false : value
          void scope.set(field, typed)
        },
        unsetField: (field) => { void scope.unset(field) },
        refreshStatus,
        testShell,
      }

      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: SHELL_SELECT_NS,
        locale: NS,
        // Everything the card renders rides the one hook snapshot, so a scope
        // write and a status refresh publish through the same subscription.
        inject: () => ({ hooks: { shellSelect: store }, ...actions }),
      }, ShellCard))

      return () => { disposeScope() }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-shell-select'
    return module.exports
  },
})
