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
 * A stand-in settings scope backed by one mutable section, over an optional
 * base layer: a value the user's layer does not set but the composition does.
 *
 * `mutate` applies the ops the way the Host would, so a test can assert both the
 * wire call and the state the card then re-seeds from.
 */
function fakeScope(section = {}, base = {}) {
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
      base,
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

/** The catalog rows the host serves, keyed by the shell they describe. */
const rows = {
  pwsh: { id: 'pwsh', label: 'PowerShell', dialect: 'powershell', available: true, path: 'C:/pwsh.exe', version: '7.4.1', confineable: true, confinement: { expected: 'confined', verified: true, observed: 'confirmed' }, usableInMode: true, supportsLoginShell: false, supportsDistro: false },
  cmd: { id: 'cmd', label: 'Command Prompt (cmd.exe)', dialect: 'cmd', available: true, path: 'C:/cmd.exe', confineable: true, confinement: { expected: 'confined', verified: true, observed: 'confirmed' }, usableInMode: true, supportsLoginShell: false, supportsDistro: false },
  gitbash: { id: 'gitbash', label: 'Git Bash', dialect: 'bash', available: true, path: 'D:/Git/bin/bash.exe', version: '5.2.15', confineable: false, confineReason: 'measured reason', confinement: { expected: 'unconfined', verified: true, reason: 'measured reason', observed: 'not-probed' }, usableInMode: false, supportsLoginShell: true, supportsDistro: false },
  wsl: { id: 'wsl', label: 'WSL Bash', dialect: 'wsl', available: false, detail: 'not found', confineable: false, confinement: { expected: 'unconfined', verified: true, observed: 'not-probed' }, usableInMode: false, supportsLoginShell: true, supportsDistro: true },
}

/**
 * The status payload the host serves, in the shape the card reads.
 *
 * This deployment's Automatic resolves to PowerShell, which is what
 * `active.selected` reports for the saved selection and what `auto` reports for
 * itself. The two are separate questions, and the payload can answer them
 * differently — {@link statusWithAuto} says so.
 */
const STATUS = {
  active: { shell: 'auto', selected: 'pwsh', platform: 'windows', mode: 'workspace-write', workspaceRoot: 'D:/work' },
  auto: { saved: { ...rows.pwsh, executable: '' }, withoutOverride: { ...rows.pwsh, executable: '' } },
  confinementVerified: true,
  shells: Object.values(rows).map(row => ({ ...row, selected: row.id === 'pwsh' })),
}

/**
 * The same payload with Automatic resolving to another shell.
 *
 * `saved` is what Automatic resolves to under the saved configuration, which an
 * executable override naming a shell changes; `withoutOverride` is what it
 * resolves to with no override in force, which is the configuration a shell
 * switch leaves staged.
 * @param saved - the row Automatic resolves to under the saved configuration.
 * @param options - the override that resolution was computed under, and the row
 *   Automatic resolves to without it.
 * @returns the payload.
 */
function statusWithAuto(saved, options = {}) {
  return {
    ...STATUS,
    auto: {
      saved: { ...saved, executable: options.executable ?? '' },
      withoutOverride: { ...(options.withoutOverride ?? saved), executable: '' },
    },
  }
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

  const scope = fakeScope(options.section ?? {}, options.base ?? {})
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
    assert.ok(card.text().includes('Shell selection'), 'the header names the card distinctly from the shipped Shell card')
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

  it('does not repeat the card name on its own row', async () => {
    // The list already holds the shipped card titled "Shell", so a second card
    // under the same word is ambiguous in the navigation; the row inside names
    // the setting rather than repeating the card's own name.
    const card = await mountCard()
    card.toggle()
    assert.ok(card.text().includes('Shell selection'))
    assert.ok(card.text().includes('Backend'))
    assert.ok(!card.text().includes('Shell | '), 'the row does not repeat the card name')
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
    assert.match(texts(all(card.menu().props.items[0].label)).join(''), /resolves to PowerShell/)
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

  it('clears an override as an explicit empty, so a lower layer cannot show through', async () => {
    const card = await mountCard({ section: { executable: 'D:/Git/bin/bash.exe' } })
    card.toggle()
    const reset = classButtons(card.tree, 'dsss-reset')[0]
    assert.ok(reset, 'an overridden field offers the reset')
    reset.props.onClick()
    card.save()
    // `executable` empty means "no override", so an unset would leave the
    // document's own value in force and the field would return on the re-seed.
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['executable'], value: '' }])
    assert.equal(card.snapshot().stored.executable, '', 'the effective value is empty')
  })

  it('shadows an inherited executable the user never set', async () => {
    // The value comes from the composition rather than the user's layer: there is
    // nothing of theirs to unset, and an `unset` would restore this exact path.
    const card = await mountCard({ base: { executable: 'D:/Git/bin/bash.exe' } })
    card.toggle()
    assert.ok(card.text().includes('Replaceable'), 'an inherited value is still an override in force')
    card.props.edit('executable', '')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['executable'], value: '' }])
    assert.equal(card.snapshot().stored.executable, '', 'the inherited path is shadowed, not revealed')
  })

  it('still unsets a field whose empty value means "inherit"', async () => {
    // `wslMountRoot` differs on purpose: empty there means "use the configured
    // default", so the layer below is what should show through again.
    const card = await mountCard({ section: { shell: 'wsl', wslMountRoot: '/opt/mnt' } })
    card.toggle()
    card.props.edit('wslMountRoot', '')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'unset', path: ['wslMountRoot'] }])
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
    card.scope.mutate = async () => { throw new Error('revision mismatch') }
    card.toggle()
    card.select('gitbash')
    card.save()
    await card.settle()
    assert.ok(card.text().includes('did not accept these values'), 'the failure is reported')
    assert.ok(card.text().includes('revision mismatch'), 'with the reason the host gave')
    assert.ok(card.text().includes('Unsaved'), 'the staged edits are kept for correction')
    assert.equal(card.selectedOption(), 'gitbash')
  })
})

describe('an override never follows the user to another shell', () => {
  it('clears a staged executable override when the shell changes, and says so', async () => {
    const card = await mountCard({ section: { executable: 'D:/Git/bin/bash.exe' } })
    card.toggle()
    assert.ok(card.text().includes('Replaceable'), 'the field reports its override')
    card.select('cmd')
    assert.match(card.text(), /Cleared because the shell changed: executable path/, 'the clear is announced')
    assert.ok(!card.text().includes('Replaceable'), 'the override is gone from the draft')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [
      { op: 'set', path: ['shell'], value: 'cmd' },
      { op: 'set', path: ['executable'], value: '' },
    ])
  })

  it('clears a launch option the new shell does not take, and says so', async () => {
    // The reported dead end: the flag survived the switch, validation refused the
    // write, and the checkbox that could clear it was not rendered for the new
    // shell — a disabled Save with nothing to press.
    const card = await mountCard()
    card.toggle()
    card.select('gitbash')
    const checkbox = elements(card.tree, 'input').find(input => input.props.type === 'checkbox')
    checkbox.props.onChange({ target: { checked: true } })
    assert.equal(card.saveDisabled(), false, 'bash takes a login flag')
    card.select('cmd')
    assert.match(card.text(), /Cleared because the shell changed: login-shell flag/, 'the clear is announced where the user acted')
    assert.equal(card.saveDisabled(), false, 'and Save stays reachable')
    card.save()
    // The flag was staged, never saved, so dropping it leaves nothing to write:
    // the point is that the incompatible value is gone rather than carried over.
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['shell'], value: 'cmd' }])
    assert.equal(card.snapshot().draft.loginShell, false)
  })

  it('keeps the login-shell control reachable when a staged value needs correcting', async () => {
    // A flag that arrived from elsewhere cannot be cleared on the way in, so the
    // control it needs has to be on screen even where the shell takes no such flag.
    const card = await mountCard({ section: { shell: 'cmd', loginShell: true } })
    card.toggle()
    const boxes = elements(card.tree, 'input').filter(input => input.props.type === 'checkbox')
    assert.equal(boxes.length, 1, 'the control is rendered for an incompatible staged value')
    assert.equal(card.saveDisabled(), true, 'which the host would still refuse')
    boxes[0].props.onChange({ target: { checked: false } })
    assert.equal(card.saveDisabled(), false, 'and unticking it is the way out')
  })

  it('clears a launch option that Automatic would not take either', async () => {
    // `auto` is not a row: what it runs is the resolved shell, so a flag staged
    // for Git Bash has to be judged against that shell. Judging it against
    // nothing let the card save a flag the host refuses, with Save enabled.
    const card = await mountCard({ section: { shell: 'cmd' } })
    card.toggle()
    card.select('gitbash')
    const box = elements(card.tree, 'input').find(input => input.props.type === 'checkbox')
    box.props.onChange({ target: { checked: true } })
    card.select('auto')
    assert.match(card.text(), /Cleared because the shell changed: login-shell flag/)
    // The draft now differs from the saved shell, so there is something to write
    // — and what would be written carries no flag the host refuses.
    assert.equal(card.saveDisabled(), false, 'and the refused write is gone, not merely blocked')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['shell'], value: 'auto' }])
  })

  it('blocks a login flag Automatic cannot take, with the control on screen', async () => {
    // The same check for a value that arrived from elsewhere: the resolved shell
    // takes no login flag, so the write is refused — and the box that clears it
    // is rendered, which is what keeps the refusal recoverable.
    const card = await mountCard({ section: { shell: 'auto', loginShell: true } })
    card.toggle()
    assert.equal(card.saveDisabled(), true, 'cmd is what auto resolves to here, and it takes no flag')
    assert.equal(elements(card.tree, 'input').filter(input => input.props.type === 'checkbox').length, 1)
  })

  it('clears a login flag Automatic resolves away from', async () => {
    // The reported sequence: Git Bash saved with the executable override that
    // names it, and a login flag staged for it. Switching to Automatic clears
    // that override, and the flag belongs to the resolution the override
    // produced: with no override, Automatic picks a shell that takes no login
    // flag, so the flag goes with it. Reading the saved SELECTION instead left
    // the flag staged and Save enabled for a write the host refuses.
    const card = await mountCard({
      section: { shell: 'gitbash', executable: 'D:/Git/bin/bash.exe', loginShell: true },
      status: {
        ...statusWithAuto(rows.gitbash, {
          executable: 'D:/Git/bin/bash.exe',
          withoutOverride: rows.pwsh,
        }),
        active: { ...STATUS.active, shell: 'gitbash', selected: 'gitbash' },
      },
    })
    card.toggle()
    card.select('auto')
    assert.match(card.text(), /Cleared because the shell changed: executable path, login-shell flag/)
    assert.ok(card.text().includes('C:/pwsh.exe'), 'and the facts describe what Automatic would run')
    assert.ok(!card.text().includes('D:/Git/bin/bash.exe'), 'not the shell the override named')
    assert.equal(card.saveDisabled(), false, 'the refused write is gone, not merely blocked')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [
      { op: 'set', path: ['shell'], value: 'auto' },
      { op: 'set', path: ['loginShell'], value: false },
      { op: 'set', path: ['executable'], value: '' },
    ])
  })

  it('keeps an override typed after the shell change', async () => {
    const card = await mountCard({ section: { executable: 'D:/Git/bin/bash.exe' } })
    card.toggle()
    card.select('cmd')
    card.props.edit('executable', 'C:/Windows/system32/cmd.exe')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [
      { op: 'set', path: ['shell'], value: 'cmd' },
      { op: 'set', path: ['executable'], value: 'C:/Windows/system32/cmd.exe' },
    ])
  })

  it('leaves an override alone when the shell is re-chosen as itself', async () => {
    const card = await mountCard({ section: { shell: 'cmd', executable: 'C:/Windows/system32/cmd.exe' } })
    card.toggle()
    card.select('cmd')
    assert.ok(card.text().includes('Replaceable'), 'the same shell is not a change of shell')
  })
})

describe('the host reads stay current', () => {
  it('never lets a slower status read overwrite a newer one', async () => {
    const card = await mountCard()
    /** Reads the test holds open, so it can settle them out of order. */
    const pending = []
    globalThis.fetch = url => new Promise(resolve => { pending.push({ url, resolve }) })
    const older = card.props.refreshStatus()
    const newer = card.props.refreshStatus()
    assert.equal(pending.length, 2)
    pending[1].resolve({ ok: true, json: async () => ({ ...STATUS, active: { ...STATUS.active, mode: 'newer' } }) })
    await newer
    pending[0].resolve({ ok: true, json: async () => ({ ...STATUS, active: { ...STATUS.active, mode: 'older' } }) })
    await older
    assert.equal(card.snapshot().status.active.mode, 'newer', 'the superseded response is discarded')
  })

  it('drops a test result whose selection has since been saved away', async () => {
    const card = await mountCard()
    card.toggle()
    await card.props.testShell()
    assert.ok(card.text().includes('exit 0'), 'the test result is shown')
    card.select('gitbash')
    card.save()
    await card.settle()
    // A completed save collapses the card, so the body is re-opened to read it.
    card.toggle()
    assert.ok(!card.text().includes('exit 0'), 'a result for the old selection is not left standing')
    assert.ok(card.text().includes('changed since this test ran'), 'and the card says why it went')
  })

  it('drops a result once a launch option changes, since the test ran without it', async () => {
    const card = await mountCard()
    card.toggle()
    await card.props.testShell()
    assert.ok(card.text().includes('exit 0'))
    card.select('gitbash')
    card.props.edit('loginShell', true)
    card.save()
    await card.settle()
    card.toggle()
    assert.ok(!card.text().includes('exit 0'), 'loginShell changes how the tested command ran')
    assert.ok(card.text().includes('changed since this test ran'))
  })

  it('drops a response that lands after the saved selection changed', async () => {
    // The reported sequence: start a test, save another shell, and let the first
    // response finish — it must not appear under the new selection.
    const card = await mountCard()
    card.toggle()
    const held = []
    globalThis.fetch = (url, options) => (options?.method === 'POST'
      ? new Promise(resolve => { held.push(resolve) })
      : Promise.resolve({ ok: true, json: async () => STATUS }))
    const running = card.props.testShell()
    card.select('gitbash')
    card.save()
    await card.settle()
    assert.equal(held.length, 1, 'the test response is still in flight')
    held[0]({ ok: true, json: async () => ({ ok: true, stage: 'ran', shell: 'cmd', exitCode: 0, stdout: 'OK' }) })
    await running
    card.toggle()
    assert.ok(!card.text().includes('exit 0'), 'a response for the previous selection is discarded')
  })

  it('lets another test start after a save discarded the one in flight', async () => {
    // The reported dead end: the in-flight response is invalidated and returns
    // early without clearing the spinner, so the button said "Testing…" forever.
    const card = await mountCard()
    card.toggle()
    const held = []
    globalThis.fetch = (url, options) => (options?.method === 'POST'
      ? new Promise(resolve => { held.push(resolve) })
      : Promise.resolve({ ok: true, json: async () => STATUS }))
    const first = card.props.testShell()
    card.select('gitbash')
    card.save()
    await card.settle()
    held[0]({ ok: true, json: async () => ({ ok: true, stage: 'ran', shell: 'cmd', exitCode: 0, stdout: 'OK' }) })
    await first
    assert.equal(card.snapshot().testing, false, 'the discarded run stops reporting itself as running')
    card.toggle()
    assert.equal(card.buttons('dsss-tool')[0].props.disabled, false, 'and the button can be pressed again')
    assert.ok(!card.text().includes('Testing'), 'the label is back to its resting state')

    globalThis.fetch = async (url, options) => ({
      ok: true,
      json: async () => (options?.method === 'POST'
        ? { ok: true, stage: 'ran', shell: 'gitbash', exitCode: 0, stdout: 'OK' }
        : STATUS),
    })
    await card.props.testShell()
    assert.equal(card.snapshot().testing, false)
    assert.ok(card.text().includes('gitbash'), 'the second run reports its own result')
  })

  it('drops a result when the document changes from elsewhere', async () => {
    const card = await mountCard()
    card.toggle()
    await card.props.testShell()
    assert.ok(card.text().includes('exit 0'))
    // Another window, or a hand-edited document.
    card.scope.set('loginShell', true)
    assert.ok(!card.text().includes('exit 0'), 'the saved configuration moved under the result')
    assert.ok(card.text().includes('changed since this test ran'))
  })

  it('re-reads the host status after a test, so the facts match what ran', async () => {
    const card = await mountCard()
    const urls = []
    const inner = globalThis.fetch
    globalThis.fetch = async (url, options) => { urls.push([url, options?.method ?? 'GET']); return inner(url, options) }
    card.toggle()
    await card.props.testShell()
    assert.deepEqual(urls, [['/dsh-shell-select/test', 'POST'], ['/dsh-shell-select/status', 'GET']])
  })
})

describe('Automatic is a first-class selection', () => {
  it('starts on Automatic and says what it resolves to', async () => {
    const card = await mountCard()
    card.toggle()
    assert.equal(card.selectedOption(), 'auto')
    assert.match(card.optionText('auto'), /resolves to PowerShell/)
  })

  it('describes Automatic by its own resolution, not by the saved selection', async () => {
    // The reported confusion: with Git Bash saved, Automatic described Git Bash,
    // because it read what the saved SELECTION resolved to. What Automatic runs
    // is its own question, and the host answers it here as PowerShell.
    const card = await mountCard({
      section: { shell: 'gitbash' },
      status: { ...STATUS, active: { ...STATUS.active, shell: 'gitbash', selected: 'gitbash' } },
    })
    card.toggle()
    assert.equal(card.selectedOption(), 'gitbash')
    assert.match(card.optionText('auto'), /resolves to PowerShell/, 'the option, before it is chosen')
    card.select('auto')
    assert.match(card.optionText('auto'), /resolves to PowerShell/)
    assert.ok(card.text().includes('C:/pwsh.exe'), 'the executable Automatic would run')
    assert.ok(!card.text().includes('D:/Git/bin/bash.exe'), 'not the saved selection\'s executable')
  })

  it('describes the Automatic option by the configuration choosing it produces', async () => {
    // An override naming a shell claims it under Automatic, so this deployment's
    // Automatic runs Git Bash while the override is in force — and choosing
    // Automatic is what drops that override. The option has to say what the
    // choice would run, not what the selection being left currently resolves to.
    const card = await mountCard({
      section: { shell: 'gitbash', executable: 'D:/Git/bin/bash.exe' },
      status: statusWithAuto(rows.gitbash, {
        executable: 'D:/Git/bin/bash.exe',
        withoutOverride: rows.pwsh,
      }),
    })
    card.toggle()
    assert.match(card.optionText('auto'), /resolves to PowerShell/)
    assert.ok(card.text().includes('D:/Git/bin/bash.exe'), 'the staged configuration still runs Git Bash')
  })

  it('shows Automatic\'s own facts, including what a call does with it', async () => {
    const card = await mountCard()
    card.toggle()
    const text = card.text()
    assert.ok(text.includes('C:/pwsh.exe'), 'the executable Automatic resolves to')
    assert.ok(text.includes('7.4.1'), 'its version')
    assert.ok(text.includes('sandbox: can be confined'), 'what the catalog expects')
    assert.ok(text.includes('observed: it ran under the sandbox'), 'and what was observed')
  })

  it('says an override is unresolved rather than naming a shell it would not run', async () => {
    // A path the host has not resolved describes no shell yet. Answering with
    // the saved selection's row would name a shell nothing would run, so the
    // card says it does not know instead.
    const card = await mountCard()
    card.toggle()
    card.props.edit('executable', 'D:/Git/bin/bash.exe')
    assert.match(card.optionText('auto'), /resolves to unknown/)
    assert.ok(card.text().includes('save to see which shell this executable path runs'))
    assert.ok(!card.text().includes('C:/pwsh.exe'), 'and it does not describe the saved selection instead')
  })

  it('returns to Automatic after another shell was saved', async () => {
    const card = await mountCard({ section: { shell: 'cmd' } })
    card.toggle()
    assert.equal(card.selectedOption(), 'cmd')
    card.select('auto')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['shell'], value: 'auto' }])
  })

  it('shows an interpreter where a shell has no version flag', async () => {
    const card = await mountCard({
      status: {
        ...statusWithAuto({ id: 'sh', label: 'POSIX sh', available: true, path: '/usr/bin/sh', interpreter: 'dash', confineable: true, confinement: { expected: 'confined', verified: false, observed: 'not-probed' }, usableInMode: true, supportsLoginShell: false, supportsDistro: false }),
        active: { ...STATUS.active, platform: 'posix', selected: 'sh' },
        shells: [{ id: 'sh', label: 'POSIX sh', available: true, path: '/usr/bin/sh', interpreter: 'dash', confineable: true, confinement: { expected: 'confined', verified: false, observed: 'not-probed' }, usableInMode: true, supportsLoginShell: false, supportsDistro: false }],
      },
    })
    card.toggle()
    assert.ok(card.text().includes('interpreter: dash'))
    assert.ok(card.text().includes('confirmed') === false, 'a posix row is not reported as observed')
  })
})

describe('field values keep their type', () => {
  it('keeps a text field a string even when it reads like a boolean', async () => {
    const card = await mountCard({ section: { executable: 'true' } })
    card.toggle()
    // The stored string is displayed as written, and an unchanged field writes
    // nothing — a document saying "true" is not a document saying `true`.
    const input = elements(card.tree, 'input').find(entry => entry.props.id === 'dsss-executable')
    assert.equal(input.props.value, 'true', 'the stored string is displayed as written')
    card.props.edit('executable', 'false')
    card.save()
    assert.deepEqual(card.scope.calls[0].mutate, [{ op: 'set', path: ['executable'], value: 'false' }])
    assert.equal(typeof card.scope.calls[0].mutate[0].value, 'string')
  })

  it('keeps the WSL distribution a string', async () => {
    const card = await mountCard({ section: { shell: 'wsl' } })
    card.toggle()
    card.props.edit('wslDistro', 'true')
    card.save()
    const distro = card.scope.calls[0].mutate.find(op => op.path[0] === 'wslDistro')
    assert.equal(typeof distro.value, 'string')
    assert.equal(distro.value, 'true')
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
    assert.ok(card.text().includes('C:/pwsh.exe'), 'the saved selection is Automatic, resolving to PowerShell')
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

  it('blocks a login flag the host would refuse, wherever it came from', async () => {
    const card = await mountCard({ section: { shell: 'cmd', loginShell: true } })
    card.toggle()
    assert.equal(card.saveDisabled(), true, 'the host refuses a login flag on cmd')
    assert.deepEqual(card.scope.calls, [], 'so nothing is written')
    assert.ok(card.text().includes('takes no login flag'), 'and the field carries the reason')
  })

  it('does not block a save on a mount root the card is not showing', async () => {
    // The same dead-end shape as the login flag: a value the user cannot reach
    // must not be the reason Save is refused.
    const card = await mountCard({ section: { shell: 'wsl', wslMountRoot: 'mnt' } })
    card.toggle()
    assert.equal(card.saveDisabled(), true, 'the field is on screen for WSL, so it is checked')
    card.select('cmd')
    assert.equal(card.saveDisabled(), false, 'hidden for cmd, so it cannot block the way out')
  })
})
