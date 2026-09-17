/**
 * Client-bundle contract for the settings card.
 *
 * The bundle is hand-written rather than emitted by the in-repo tsdown preset,
 * so nothing else verifies it. This suite loads it exactly the way the browser
 * module loader does — `window.__ModuleLoader__.load({ id, factory })` with a
 * `require` backed by the platform module table — then drives `apply` against a
 * stand-in slot registry and settings scope.
 *
 * The card is collapsed by default and writes only on Save, so the checks run
 * through a small render loop rather than reading one static tree: a stand-in
 * React that re-renders on a state set, and a stand-in scope whose writes the
 * tests can inspect. That is what lets the suite assert the things that would
 * otherwise only be visible in a browser — that choosing a shell stages it,
 * that Save emits one revision-fenced mutation, that Discard drops it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const bundlePath = join(fileURLToPath(new URL('..', import.meta.url)), 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** Shallow-compare two dependency lists. */
function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * A stand-in React that actually re-renders.
 *
 * Elements are plain data and hooks live in one array keyed by call order, which
 * is enough to drive the card's own state: `useState` re-renders on a set,
 * `useSyncExternalStore` re-renders when its observable publishes, and
 * `useEffect` runs when its dependencies move.
 */
function createHarness() {
  const hooks = []
  let cursor = 0
  let rerender = () => {}

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
        rerender()
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (previous !== undefined && sameDeps(previous, deps)) return
      hooks[index] = deps
      effect()
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++
      if (!(index in hooks)) {
        hooks[index] = true
        subscribe(() => { rerender() })
      }
      return getSnapshot()
    },
  }

  return {
    React,
    /**
     * Render a component, re-rendering whenever it sets state.
     * @returns a getter for the current tree.
     */
    mount(component, props) {
      let tree
      rerender = () => { cursor = 0; tree = component(props) }
      cursor = 0
      tree = component(props)
      return { get tree() { return tree } }
    },
  }
}

/** A minimal primitives stand-in; each primitive is a named function. */
function fakePrimitives() {
  const stub = name => {
    const component = (props, ...children) => ({ type: component, props: props ?? {}, children })
    Object.defineProperty(component, 'name', { value: name })
    return component
  }
  return { Tag: stub('Tag'), IconChevronDownOutline14: stub('IconChevronDownOutline14'), Menu: stub('Menu') }
}

/** Collect every rendered node, elements and text alike, depth first. */
function all(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) all(child, found)
    return found
  }
  if (node === null || node === undefined) return found
  if (typeof node !== 'object') { found.push(node); return found }
  found.push(node)
  for (const child of node.children ?? []) all(child, found)
  return found
}

/** Every rendered string. */
function texts(node) {
  return all(node).filter(entry => typeof entry === 'string')
}

/** Elements whose type or type name matches. */
function elements(node, name) {
  return all(node).filter(entry => typeof entry === 'object'
    && (entry.type === name || entry.type?.name === name))
}

/** Every button carrying a given class. */
function classButtons(node, className) {
  return elements(node, 'button').filter(entry =>
    String(entry.props.className ?? '').split(' ').includes(className))
}

/**
 * Load the bundle the way the browser loader does.
 *
 * The harness whose React object the bundle receives is returned with it: a
 * second harness would close over a different render loop, and every state set
 * the card makes would go nowhere.
 * @returns the registered id, the exports, and the harness that owns them.
 */
function loadBundle() {
  let registered
  const harness = createHarness()
  const platform = {
    react: harness.React,
    '@deepseek-ai/dsh-client-ui-primitives': fakePrimitives(),
  }
  globalThis.window = { __ModuleLoader__: { load: entry => { registered = entry } } }
  // The bundle is a closure factory by contract; it holds no module syntax.
  new Function('window', source)(globalThis.window)
  return {
    id: registered.id,
    harness,
    exports: registered.factory(specifier => {
      if (!(specifier in platform)) throw new Error(`unexpected platform import: ${specifier}`)
      return platform[specifier]
    }),
  }
}

/** A stand-in document that records the injected stylesheet. */
function fakeDocument() {
  const head = {
    children: [],
    appendChild(node) { head.children.push(node); return node },
  }
  return {
    head,
    getElementById: id => head.children.find(node => node.id === id) ?? null,
    createElement: () => ({
      id: '',
      textContent: '',
      remove() { head.children = head.children.filter(node => node !== this) },
    }),
  }
}

/**
 * A stand-in settings scope backed by one mutable section.
 *
 * `mutate` applies the ops the way the Host would, so a test can assert both the
 * wire call and the state the card then re-seeds from.
 */
function fakeScope(section = {}) {
  const listeners = new Set()
  const calls = []
  const notify = () => { for (const listener of [...listeners]) listener() }
  return {
    section,
    calls,
    getSnapshot: () => ({
      status: 'ready',
      value: { shell: 'auto', loginShell: false, wslMountRoot: '/mnt', ...section },
      user: section,
      base: {},
      revision: 7,
      writable: true,
      mode: 'host',
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (field, value) => { calls.push({ op: 'set', field, value }); section[field] = value; notify() },
    unset: (field) => { calls.push({ op: 'unset', field }); delete section[field]; notify() },
    async mutate(ops, revision) {
      calls.push({ mutate: ops, revision })
      for (const op of ops) {
        if (op.op === 'set') section[op.path[0]] = op.value
        else delete section[op.path[0]]
      }
      notify()
    },
  }
}

/** The status payload the host serves, in the shape the card reads. */
const STATUS = {
  active: { shell: 'auto', selected: 'cmd', platform: 'windows', mode: 'workspace-write', workspaceRoot: 'D:/work' },
  confinementVerified: true,
  shells: [
    { id: 'pwsh', label: 'PowerShell', dialect: 'powershell', selected: false, available: true, path: 'C:/pwsh.exe', version: '7.4.1', confineable: true, usableInMode: true, supportsLoginShell: false, supportsDistro: false },
    { id: 'cmd', label: 'Command Prompt (cmd.exe)', dialect: 'cmd', selected: true, available: true, path: 'C:/cmd.exe', confineable: true, usableInMode: true, supportsLoginShell: false, supportsDistro: false },
    { id: 'gitbash', label: 'Git Bash', dialect: 'bash', selected: false, available: true, path: 'D:/Git/bin/bash.exe', version: '5.2.15', confineable: false, confineReason: 'measured reason', usableInMode: false, supportsLoginShell: true, supportsDistro: false },
    { id: 'wsl', label: 'WSL Bash', dialect: 'wsl', selected: false, available: false, detail: 'not found', confineable: false, usableInMode: false, supportsLoginShell: true, supportsDistro: true },
  ],
}

/**
 * Mount the card against a fake registry, scope, and document.
 * @param options - the stored section and the status payload to serve.
 * @returns the mounted card plus the helpers a test drives it with.
 */
async function mountCard(options = {}) {
  const { exports, harness } = loadBundle()
  const document_ = fakeDocument()
  globalThis.document = document_
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => (url === '/dsh-shell-select/status'
      ? (options.status ?? STATUS)
      : { ok: true, stage: 'ran', shell: 'cmd', exitCode: 0, stdout: 'OK' }),
  })

  const scope = fakeScope(options.section ?? {})
  let registration
  let dictionary
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: (_ns, entries) => { dictionary = entries } },
    settingsScope: { bind: () => scope },
    slots: {
      inject: (_name, register) => { registration = register() },
      register: (o, c) => ({ options: o, component: c }),
    },
  }
  exports.apply(ctx)
  // The card reads the host's shell facts once when it is contributed, so the
  // tests wait for that read before driving the controls it fills in.
  await new Promise(resolve => setImmediate(resolve))
  const injected = registration.options.inject()
  // The real copy, so an assertion reads like the interface a user sees.
  const store = injected.hooks.shellSelect
  const props = {
    t: key => dictionary.en[key] ?? key,
    // The hook contract ui-slots establishes: a selector bound to
    // useSyncExternalStore over the injected observable. A stand-in that only
    // read the snapshot would never re-render.
    useShellSelect: selector => selector(harness.React.useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    )),
    ...injected,
  }
  const mounted = harness.mount(registration.component, props)

  return {
    document: document_,
    scope,
    props,
    get tree() { return mounted.tree },
    /** Click the header to expand or collapse. */
    toggle: () => { elements(mounted.tree, 'button')[0].props.onClick() },
    buttons: className => classButtons(mounted.tree, className),
    /** The dropdown the card renders, once it is expanded. */
    menu: () => elements(mounted.tree, 'Menu')[0],
    /** The trigger button the dropdown is anchored to. */
    trigger: () => elements(mounted.tree, 'Menu')[0]?.props.anchor,
    /** Every option id the dropdown offers, in order. */
    options: () => (elements(mounted.tree, 'Menu')[0]?.props.items ?? []).map(item => item.id),
    /** An option's rendered text, flattened. */
    optionText: id => {
      const item = elements(mounted.tree, 'Menu')[0]?.props.items.find(entry => entry.id === id)
      return item === undefined ? undefined : texts(all(item.label)).join('')
    },
    /** The option the dropdown reports as selected. */
    selectedOption: () => elements(mounted.tree, 'Menu')[0]?.props.selectedId,
    /** What the trigger reads. */
    triggerText: () => texts(all(elements(mounted.tree, 'Menu')[0]?.props.anchor)).join(''),
    /** Choose an option the way the dropdown reports a click. */
    select: id => {
      const menu = elements(mounted.tree, 'Menu')[0]
      assert.ok(menu, 'the dropdown is not rendered')
      menu.props.onSelect(id)
    },
    /** Whether the dropdown is on screen at all. */
    hasMenu: () => elements(mounted.tree, 'Menu').length > 0,
    save: () => { classButtons(mounted.tree, 'dsss-save')[0].props.onClick() },
    saveDisabled: () => classButtons(mounted.tree, 'dsss-save')[0].props.disabled,
    discard: () => { classButtons(mounted.tree, 'dsss-discard')[0].props.onClick() },
    snapshot: () => injected.hooks.shellSelect.getSnapshot(),
    text: () => texts(mounted.tree).join(' | '),
    settle: () => new Promise(resolve => setImmediate(resolve)),
  }
}

describe('client bundle', () => {
  it('registers under its package name, as the loader requires', async () => {
    const { id, exports } = loadBundle()
    assert.equal(id, 'dsh-shell-select')
    assert.equal(exports.name, 'dsh-shell-select')
    assert.equal(typeof exports.apply, 'function')
    assert.deepEqual(exports.inject, ['slots', 'settingsScope', 'locale'])
  })

  it('requires only platform modules', async () => {
    // Anything outside the platform table would fail to resolve in the browser.
    const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])
    assert.ok(required.length > 0)
    const platform = [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
    ]
    for (const specifier of required) assert.ok(platform.includes(specifier), `${specifier} is not a platform module`)
  })

  it('registers a card under the shell-select settings key', async () => {
    const { exports } = loadBundle()
    let registration
    const dictionaries = []
    const ctx = {
      effect: (fn) => fn(),
      locale: { register: (ns, entries) => { dictionaries.push({ ns, entries }) } },
      settingsScope: { bind: () => fakeScope() },
      slots: {
        inject: (_name, register) => { registration = register() },
        register: (o, c) => ({ options: o, component: c }),
      },
    }
    exports.apply(ctx)
    assert.equal(registration.options.name, 'settings.plugin.item')
    assert.equal(registration.options.key, 'shell-select', 'the key pairs the card with its host namespace')
    assert.equal(registration.options.locale, 'shell-select')
    assert.equal(dictionaries.length, 1)
    assert.ok(dictionaries[0].entries.en && dictionaries[0].entries.zh, 'both UI languages are covered')
  })

  it('injects a stylesheet built on the harness design tokens', async () => {
    // Styled like its sibling cards means using the same alias tokens rather
    // than literal colors, so a theme change carries.
    const card = await mountCard()
    const style = card.document.getElementById('dsh-shell-select-card-styles')
    assert.ok(style, 'the card injects its stylesheet once')
    for (const token of ['--dsw-alias-border-l4', '--dsw-alias-bg-layer-3', '--dsw-alias-label-primary',
      '--dsw-alias-brand-primary', '--dsw-alias-label-error']) {
      assert.ok(style.textContent.includes(token), `stylesheet must use ${token}`)
    }
    // Hover, focus, and reduced motion have no inline equivalent, which is why
    // the card carries a stylesheet at all.
    assert.ok(style.textContent.includes(':hover'))
    assert.ok(style.textContent.includes(':focus-visible'))
    assert.ok(style.textContent.includes('prefers-reduced-motion'))
  })
})

describe('collapsible card', () => {
  it('renders collapsed by default, like its sibling cards', async () => {
    const card = await mountCard()
    assert.ok(card.text().includes('Shell'), 'the header names the card')
    assert.ok(card.text().includes('Choose the shell every command runs in.'), 'the header describes it')
    assert.equal(card.hasMenu(), false, 'the dropdown is not rendered while collapsed')
    assert.equal(elements(card.tree, 'input').length, 0, 'fields are not rendered while collapsed')
    assert.equal(card.buttons('dsss-save').length, 0, 'the footer is not rendered while collapsed')
  })

  it('exposes the disclosure state to assistive technology', async () => {
    const card = await mountCard()
    const header = () => elements(card.tree, 'button')[0]
    assert.equal(header().props['aria-expanded'], false)
    assert.match(header().props['aria-label'], /Show settings/)
    card.toggle()
    assert.equal(header().props['aria-expanded'], true)
    assert.match(header().props['aria-label'], /Hide settings/)
  })

  it('shows the shell choices and the footer once expanded', async () => {
    const card = await mountCard()
    card.toggle()
    assert.deepEqual(card.options(),
      ['auto', 'pwsh', 'cmd', 'gitbash', 'wsl'])
    assert.equal(card.buttons('dsss-save').length, 1)
    assert.equal(card.buttons('dsss-discard').length, 1)
    assert.equal(card.buttons('dsss-tool').length, 2, 'test and refresh')
  })

  it('opens as a dropdown anchored to its trigger', async () => {
    const card = await mountCard()
    card.toggle()
    assert.equal(card.trigger().props['aria-haspopup'], 'menu', 'the trigger announces a menu')
    assert.equal(card.trigger().props['aria-expanded'], false)
    assert.equal(card.menu().props.open, false, 'the list starts closed')
    card.trigger().props.onClick()
    assert.equal(card.trigger().props['aria-expanded'], true)
    assert.equal(card.menu().props.open, true)
    // Choosing a row closes the list, which is the dropdown's own contract.
    card.select('cmd')
    assert.equal(card.menu().props.open, false)
  })

  it('shows the saved shell on the trigger and marks it in the list', async () => {
    const card = await mountCard()
    card.toggle()
    assert.equal(card.selectedOption(), 'auto')
    // The trigger reads the shell's name, and Automatic says what it resolves to.
    assert.match(card.triggerText(), /Automatic/)
    assert.match(texts(all(card.menu().props.items[0].label)).join(''), /resolves to Command Prompt/)
  })
})

describe('staged form', () => {
  it('starts clean, with Save and Discard disabled', async () => {
    const card = await mountCard()
    card.toggle()
    assert.equal(card.saveDisabled(), true, 'nothing staged means nothing to save')
    assert.equal(card.buttons('dsss-discard')[0].props.disabled, true)
    assert.ok(!card.text().includes('Unsaved'))
  })

  it('stages a shell choice without writing it', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    assert.deepEqual(card.scope.calls, [], 'a staged edit must not reach the host')
    assert.equal(card.selectedOption(), 'gitbash')
    assert.ok(card.text().includes('Unsaved'), 'the header reports unsaved edits')
    assert.equal(card.saveDisabled(), false)
  })

  it('keeps staged edits across collapsing, and marks them while collapsed', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    card.toggle()
    assert.equal(card.hasMenu(), false, 'collapsed again')
    assert.ok(card.text().includes('Unsaved'), 'a collapsed card still says it holds edits')
    card.toggle()
    assert.equal(card.selectedOption(), 'gitbash', 'the draft survived')
  })

  it('drops every staged edit on Discard', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    card.discard()
    assert.deepEqual(card.scope.calls, [])
    assert.equal(card.selectedOption(), 'auto', 'the stored value is auto')
    assert.ok(!card.text().includes('Unsaved'))
  })

  it('writes the staged edits as ONE revision-fenced mutation', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    card.save()
    assert.equal(card.scope.calls.length, 1, 'a save is a single write, not one per field')
    assert.equal(card.scope.calls[0].revision, 7, 'the revision the card read fences the write')
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['shell'], value: 'gitbash' }])
  })

  it('stages a cleared override as an unset, so the field re-inherits', async () => {
    const card = await mountCard({ section: { executable: 'D:/Git/bin/bash.exe' } })
    card.toggle()
    const reset = classButtons(card.tree, 'dsss-reset')[0]
    assert.ok(reset, 'an overridden field offers the reset')
    reset.props.onClick()
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'unset', path: ['executable'] }])
  })

  it('carries a staged boolean, not its text form', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    const checkbox = elements(card.tree, 'input').find(input => input.props.type === 'checkbox')
    checkbox.props.onChange({ target: { checked: true } })
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [
      { op: 'set', path: ['shell'], value: 'gitbash' },
      { op: 'set', path: ['loginShell'], value: true },
    ])
  })

  it('collapses after a save lands whole', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    card.save()
    await card.settle()
    assert.equal(card.hasMenu(), false, 'a completed save closes the card')
    assert.ok(!card.text().includes('Unsaved'))
  })

  it('keeps the card open and the edits staged when the host rejects the write', async () => {
    const card = await mountCard()
    card.scope.mutate = async () => { throw new Error('rejected') }
    card.toggle()
    card.select('gitbash')
    card.save()
    await card.settle()
    assert.ok(card.text().includes('did not accept these values'), 'the failure is reported')
    assert.ok(card.text().includes('Unsaved'), 'the staged edits are kept for correction')
    assert.equal(card.selectedOption(), 'gitbash')
  })
})

describe('the fields follow the staged selection', () => {
  const inputIds = card => elements(card.tree, 'input').map(input => input.props.id)

  it('offers the login-shell control only where it applies', async () => {
    const card = await mountCard()
    card.toggle()
    assert.equal(elements(card.tree, 'input').filter(input => input.props.type === 'checkbox').length, 0,
      'cmd takes no login flag')
    card.select('gitbash')
    assert.equal(elements(card.tree, 'input').filter(input => input.props.type === 'checkbox').length, 1)
  })

  it('offers the WSL controls only for the WSL shell', async () => {
    const card = await mountCard()
    card.toggle()
    assert.deepEqual(inputIds(card), ['dsss-executable'], 'only the executable field for cmd')
    card.select('wsl')
    assert.deepEqual(inputIds(card),
      ['dsss-executable', 'dsss-loginShell', 'dsss-wslDistro', 'dsss-wslMountRoot'],
      'the WSL shell also takes a login flag')
  })

  it('shows the facts of the staged shell, not the saved one', async () => {
    const card = await mountCard()
    card.toggle()
    assert.ok(card.text().includes('C:/cmd.exe'), 'the saved shell is cmd')
    card.select('gitbash')
    assert.ok(card.text().includes('D:/Git/bin/bash.exe'), 'the facts follow the draft')
    assert.ok(card.text().includes('measured reason'), 'including why it cannot be confined')
    assert.ok(card.text().includes('blocked by the current permission mode'))
  })

  it('warns when the host has not verified confinement on this platform', async () => {
    const card = await mountCard({
      status: { ...STATUS, active: { ...STATUS.active, platform: 'posix' }, confinementVerified: false },
    })
    card.toggle()
    assert.ok(card.text().includes('has not been verified by this plugin'))
  })
})

describe('staged validation', () => {
  it('blocks Save with a reason when a path with a separator is not absolute', async () => {
    const card = await mountCard()
    card.toggle()
    card.props.edit('executable', 'Git/bin/bash.exe')
    assert.equal(card.saveDisabled(), true, 'an invalid draft cannot be saved')
    assert.ok(card.text().includes('must be absolute, or the execution environment refuses it'), 'and the field says why')
    assert.deepEqual(card.scope.calls, [], 'nothing was written')
  })

  it('accepts an absolute path for the platform the host reported', async () => {
    const card = await mountCard()
    card.toggle()
    card.props.edit('executable', 'D:/Git/bin/bash.exe')
    assert.ok(!card.text().includes('must be absolute, or the execution environment refuses it'))
    assert.equal(card.saveDisabled(), false)
  })

  it('blocks a mount root that is not an absolute Linux path', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('wsl')
    card.props.edit('wslMountRoot', 'mnt')
    assert.equal(card.saveDisabled(), true)
    assert.ok(card.text().includes('must be an absolute Linux path'))
  })

  it('blocks a staged login flag on a shell that has no such flag', async () => {
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    const checkbox = elements(card.tree, 'input').find(input => input.props.type === 'checkbox')
    checkbox.props.onChange({ target: { checked: true } })
    assert.equal(card.saveDisabled(), false, 'bash takes a login flag')
    // Switching to a dialect with no login flag leaves the staged one standing.
    // The control that would clear it is not rendered for cmd, so the card
    // blocks the write rather than sending one the host refuses.
    card.select('cmd')
    assert.equal(card.saveDisabled(), true)
    assert.deepEqual(card.scope.calls, [])
  })
})
