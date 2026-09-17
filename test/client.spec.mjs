/**
 * Client-bundle contract for the settings card.
 *
 * The bundle is hand-written rather than emitted by the in-repo tsdown preset,
 * so nothing else verifies it. This suite loads it exactly the way the browser
 * module loader does — `window.__ModuleLoader__.load({ id, factory })` with a
 * `require` backed by the platform module table — then drives `apply` against a
 * stand-in slot registry and settings scope and inspects the rendered tree.
 *
 * The React stand-in is deliberately minimal: this asserts the card's data
 * contract and copy, not React's behavior.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const bundlePath = join(fileURLToPath(new URL('..', import.meta.url)), 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** A minimal React stand-in: elements are plain data, hooks are inert. */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/** A minimal primitives stand-in: each primitive renders to a named component. */
function fakePrimitives() {
  const stub = name => {
    const component = (props, ...children) => ({ type: component, props: props ?? {}, children })
    Object.defineProperty(component, 'name', { value: name })
    return component
  }
  return { Button: stub('Button'), Input: stub('Input'), Pill: stub('Pill') }
}

/**
 * Load the bundle the way the browser loader does.
 * @returns the registered module's exports plus the id it registered under.
 */
function loadBundle() {
  let registered
  const platform = {
    react: fakeReact(),
    '@deepseek-ai/dsh-client-ui-primitives': fakePrimitives(),
  }
  globalThis.window = { __ModuleLoader__: { load: entry => { registered = entry } } }
  // The bundle is a closure factory by contract; there is no module syntax in it.
  new Function('window', source)(globalThis.window)
  const exports = registered.factory(specifier => {
    if (!(specifier in platform)) throw new Error(`unexpected platform import: ${specifier}`)
    return platform[specifier]
  })
  return { id: registered.id, exports }
}

/** Collect every rendered node type name in a tree. */
function typesIn(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) typesIn(child, found)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (typeof node.type === 'string') found.push(node.type)
  else if (typeof node.type === 'function') found.push(node.type.name)
  for (const child of node.children ?? []) typesIn(child, found)
  return found
}

/** Collect every string rendered in a tree. */
function textIn(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) textIn(child, found)
    return found
  }
  if (typeof node === 'string') { found.push(node); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  for (const child of node.children ?? []) textIn(child, found)
  return found
}

/** A fake client context recording every registration and scope write. */
function fakeClientContext() {
  const registrations = []
  const dictionaries = []
  const writes = []
  const scopeListeners = new Set()

  const makeScope = namespace => ({
    getSnapshot: () => ({
      status: 'ready',
      value: { shell: 'gitbash', loginShell: true },
      user: { shell: 'gitbash' },
      base: {},
      revision: 1,
      writable: true,
      mode: 'host',
    }),
    subscribe: (listener) => { scopeListeners.add(listener); return () => { scopeListeners.delete(listener) } },
    set: (field, value) => { writes.push({ namespace, op: 'set', field, value }) },
    unset: (field) => { writes.push({ namespace, op: 'unset', field }) },
    mutate: () => {},
  })

  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: (ns, entries) => { dictionaries.push({ ns, entries }) } },
    settingsScope: { bind: ({ namespace }) => makeScope(namespace) },
    slots: {
      inject: (name, register) => {
        // The registry accepts one registration or a generator yielding several;
        // the card contributes one.
        const produced = register()
        const entries = produced !== null && typeof produced === 'object' && Symbol.iterator in produced
          ? [...produced]
          : [produced]
        for (const entry of entries) {
          registrations.push({
            slot: name,
            options: entry.options ?? entry,
            component: entry.component ?? entry,
          })
        }
      },
      register: (options, component) => ({ options, component }),
    },
  }
  return { ctx, registrations, dictionaries, writes }
}

/** The status payload the host serves, in the shape the card reads. */
const STATUS = {
  active: { shell: 'gitbash', selected: 'gitbash', platform: 'windows', mode: 'workspace-write', workspaceRoot: 'D:\\work' },
  confinementVerified: true,
  shells: [
    { id: 'pwsh', label: 'PowerShell', dialect: 'powershell', selected: false, available: true, path: 'C:\\pwsh.exe', version: '7.4.1', confineable: true, usableInMode: true, supportsLoginShell: false, supportsDistro: false },
    { id: 'cmd', label: 'Command Prompt (cmd.exe)', dialect: 'cmd', selected: false, available: true, path: 'C:\\cmd.exe', confineable: true, usableInMode: true, supportsLoginShell: false, supportsDistro: false },
    { id: 'gitbash', label: 'Git Bash', dialect: 'bash', selected: true, available: true, path: 'D:\\Git\\bin\\bash.exe', version: '5.2.15', confineable: false, confineReason: 'measured reason', usableInMode: false, supportsLoginShell: true, supportsDistro: false },
    { id: 'wsl', label: 'WSL Bash', dialect: 'wsl', selected: false, available: false, detail: 'not found', confineable: false, usableInMode: false, supportsLoginShell: true, supportsDistro: true },
  ],
}

describe('client bundle', () => {
  it('registers under its package name, as the loader requires', () => {
    const { id, exports } = loadBundle()
    assert.equal(id, 'dsh-shell-select')
    assert.equal(exports.name, 'dsh-shell-select')
    assert.equal(typeof exports.apply, 'function')
    assert.deepEqual(exports.inject, ['slots', 'settingsScope', 'locale'])
  })

  it('requires only platform modules', () => {
    // Anything outside the platform table would fail to resolve in the browser.
    const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])
    assert.ok(required.length > 0)
    const platform = [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
    ]
    for (const specifier of required) {
      assert.ok(platform.includes(specifier), `${specifier} is not a platform module`)
    }
  })

  it('registers a card under the shell-select settings key', () => {
    const { exports } = loadBundle()
    const { ctx, registrations, dictionaries } = fakeClientContext()
    exports.apply(ctx)
    const card = registrations.find(entry => entry.slot === 'settings.plugin.item')
    assert.ok(card, 'the card must register into settings.plugin.item')
    assert.equal(card.options.key, 'shell-select', 'the key pairs the card with its host namespace')
    assert.equal(card.options.locale, 'shell-select')
    assert.equal(dictionaries.length, 1)
    assert.ok(dictionaries[0].entries.en && dictionaries[0].entries.zh, 'both UI languages are covered')
  })

  it('renders the shell list, the executable field, and the actions', () => {
    const { exports } = loadBundle()
    const { ctx, registrations } = fakeClientContext()
    exports.apply(ctx)
    const card = registrations.find(entry => entry.slot === 'settings.plugin.item')
    const injected = card.options.inject()
    assert.ok(injected.hooks.shellSelect, 'the card reads one hook snapshot')

    injected.hooks.shellSelect.set({
      settings: { value: { shell: 'gitbash' }, user: { shell: 'gitbash' }, base: {} },
      writable: true,
      status: STATUS,
      test: undefined,
    })

    const tree = card.component({
      t: key => key,
      useShellSelect: selector => selector(injected.hooks.shellSelect.getSnapshot()),
      ...injected,
    })
    const types = typesIn(tree)
    assert.ok(types.includes('Button'), 'the choices and actions render as buttons')
    assert.ok(types.includes('Input'), 'the executable-path field renders as an input')

    const text = textIn(tree).join(' | ')
    assert.match(text, /Git Bash/u)
    assert.match(text, /testShell|Test shell/u)
    assert.match(text, /windows/u, 'the platform is shown')
    // The blocked state is shown, not hidden: an unconfineable shell under a
    // confined mode must be visibly unusable before the model ever calls it.
    assert.match(text, /unconfineable/u)
    assert.match(text, /blockedInMode/u)
    assert.match(text, /measured reason/u)
  })

  it('marks a shell the host could not resolve, without hiding it', () => {
    const { exports } = loadBundle()
    const { ctx, registrations } = fakeClientContext()
    exports.apply(ctx)
    const card = registrations.find(entry => entry.slot === 'settings.plugin.item')
    const injected = card.options.inject()
    injected.hooks.shellSelect.set({
      settings: { value: { shell: 'gitbash' }, user: { shell: 'gitbash' }, base: {} },
      writable: true,
      status: STATUS,
      test: undefined,
    })
    const text = textIn(card.component({
      t: key => key,
      useShellSelect: selector => selector(injected.hooks.shellSelect.getSnapshot()),
      ...injected,
    })).join(' | ')
    assert.match(text, /notFound|not found/u, 'an absent shell is listed as not found')
  })

  it('warns when the host has not verified confinement on this platform', () => {
    const { exports } = loadBundle()
    const { ctx, registrations } = fakeClientContext()
    exports.apply(ctx)
    const card = registrations.find(entry => entry.slot === 'settings.plugin.item')
    const injected = card.options.inject()
    injected.hooks.shellSelect.set({
      settings: { value: { shell: 'bash' }, user: {}, base: {} },
      writable: true,
      status: { ...STATUS, active: { ...STATUS.active, platform: 'posix' }, confinementVerified: false },
      test: undefined,
    })
    const text = textIn(card.component({
      t: key => key,
      useShellSelect: selector => selector(injected.hooks.shellSelect.getSnapshot()),
      ...injected,
    })).join(' | ')
    assert.match(text, /confinementUnverified/u)
  })

  it('writes each field into the shell-select namespace', () => {
    const { exports } = loadBundle()
    const { ctx, registrations, writes } = fakeClientContext()
    exports.apply(ctx)
    const card = registrations.find(entry => entry.slot === 'settings.plugin.item')
    const injected = card.options.inject()
    injected.setField('shell', 'cmd')
    injected.setField('loginShell', 'true')
    injected.setField('executable', 'D:\\Git\\bin\\bash.exe')
    injected.unsetField('executable')
    assert.deepEqual(writes, [
      { namespace: 'shell-select', op: 'set', field: 'shell', value: 'cmd' },
      { namespace: 'shell-select', op: 'set', field: 'loginShell', value: true },
      { namespace: 'shell-select', op: 'set', field: 'executable', value: 'D:\\Git\\bin\\bash.exe' },
      { namespace: 'shell-select', op: 'unset', field: 'executable' },
    ])
  })
})
