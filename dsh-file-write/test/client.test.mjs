import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(join(import.meta.dirname, '../lib/client.js'), 'utf8')

function loadClient({ workspaceFiles, call = async () => ({ ok: true, value: { absolutePath: '/work/a.md', version: 'v2' } }) } = {}) {
  const slots = new Map()
  const slotMetadata = new Map()
  const listeners = new Map()
  const registrations = []
  const requests = []
  const timers = new Map()
  let nextTimer = 0
  const previewBody = {
    style: { position: '' }, scrollTop: 0, children: [],
    appendChild(child) { this.children.push(child) },
  }
  let reloads = 0
  const preview = {
    getAttribute: key => key === 'data-textpreview-url' ? 'dsh-resource://file/session/s1/a.md' : null,
    querySelector: selector => selector === '[data-textpreview-body]' ? previewBody :
      selector === '[data-textpreview-tool="reload"]' ? { click() { reloads++ } } : null,
  }
  const document = {
    body: {},
    querySelector: () => null,
    querySelectorAll: () => [preview],
    createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    addEventListener(type, fn) {
      const handlers = listeners.get(type) ?? []
      handlers.push(fn)
      listeners.set(type, handlers)
    },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter(x => x !== fn)) },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event) },
  }
  const states = []
  const refs = []
  let index = 0
  let effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const slot = index++
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
      return [states[slot], next => { states[slot] = next }]
    },
    useRef(initial) {
      const slot = index++
      return refs[slot] ??= { current: initial }
    },
    useEffect(fn) { index++; effects.push(fn) },
  }
  const window = { innerWidth: 800, innerHeight: 600, __ModuleLoader__: { load(entry) { window.entry = entry } } }
  runInNewContext(source, { window, document, TextDecoder, Uint8Array, ArrayBuffer, AbortController, WeakSet, console,
    setTimeout: (fn, delay) => { assert.equal(delay, 600); const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: (id) => timers.delete(id),
  })
  const exports = window.entry.factory(name => name === 'react' ? react : { createPortal: child => ({ type: 'portal', child }) })
  const ctx = {
    documentPreviews: { register(def) { registrations.push(def); return () => {} } },
    connection: { rpc: { call(...args) { requests.push(args); return call(...args) } } },
    remote: { workspaceFiles },
    effect: fn => fn(),
    slots: {
      inject(_name, fn) { fn() },
      register(meta, render) { slots.set(meta.name, render); slotMetadata.set(meta.name, meta); return () => {} },
    },
  }
  exports.apply(new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'remote' && !exports.inject.includes('remote')) {
        throw new Error('cannot get property "remote" without inject')
      }
      return Reflect.get(target, property, receiver)
    },
  }))
  function renderComponent(component, props) {
    index = 0
    effects = []
    const value = component(props)
    return { value, effects: [...effects] }
  }
  return { slots, slotMetadata, registrations, requests, document, window, previewBody,
    flushTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()) },
    get timers() { return timers.size }, get reloads() { return reloads }, renderComponent }
}

function all(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) all(child, predicate, out)
  if (node.type === 'portal') all(node.child, predicate, out)
  return out
}

const is = (type, key) => node => node.type === type && (key === undefined || key in (node.props ?? {}))

function directoryEvent(path = '/work', kind = 'directory') {
  const tree = { getAttribute: key => key === 'data-files-root' ? '/work' : null }
  const row = {
    getAttribute: key => key === 'data-files-entry' ? kind : path,
    closest: key => key === '[data-files-state="tree"]' ? tree : null,
  }
  return {
    target: { closest: key => key.startsWith('li[') ? row : key === '[data-files-state="tree"]' ? tree : null },
    clientX: 5, clientY: 5, preventDefault() {},
  }
}

test('registers the source editor for text files', () => {
  const client = loadClient({ workspaceFiles: { readBytes() {} } })
  assert.equal(client.registrations.length, 1)
  const definition = client.registrations[0]
  assert.equal(definition.id, 'dsh-file-write/editor')
  assert.deepEqual(Array.from(definition.extensions.slice(0, 3)), ['md', 'markdown', 'txt'])
  assert.equal(definition.loading, 'renderer')
  assert.equal(client.slots.has('sidebar.right.tab.document'), true)
  assert.equal(client.slots.has('sidebar.right.tab.document.action'), false)
  assert.equal(client.slots.has('conversation.input.dock'), true)
})

test('reads a single byte snapshot and saves only its matching version', async () => {
  let resolveRead
  const workspaceFiles = { readBytes(_session, _path, _options) {
    return new Promise(resolve => { resolveRead = resolve })
  } }
  const client = loadClient({ workspaceFiles })
  const wrapped = client.slots.get('sidebar.right.tab.document')({
    resourceAddress: 'dsh-resource://file/session/s1/a.md',
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
  })
  const editor = wrapped.type
  const props = {
    ...wrapped.props,
    useResource: () => ({ status: 'live', value: { version: 'v1' } }),
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
  }
  let view = client.renderComponent(editor, props)
  assert.equal(all(view.value, is('textarea'))[0].props.disabled, true)
  view.effects[1]() // Load the renderer-owned snapshot.
  await Promise.resolve()
  resolveRead({ ok: true, value: {
    data: new TextEncoder().encode('# before\n').buffer, version: 'v1', absolutePath: '/work/a.md', bytes: 9, offset: 0, eof: true,
  } })
  await new Promise(resolve => setImmediate(resolve))
  view = client.renderComponent(editor, props)
  const textarea = all(view.value, is('textarea'))[0]
  assert.equal(textarea.props.value, '# before\n')
  textarea.props.onChange({ target: { value: '# after\n' } })
  view = client.renderComponent(editor, props)
  assert.equal(all(view.value, is('button', 'data-file-write-save')).length, 0)
  assert.equal(client.requests.length, 0)
  view.effects[3]() // Debounced automatic save.
  assert.equal(client.timers, 1)
  client.flushTimers()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0][2].args.sessionId, 's1')
  assert.equal(client.requests[0][2].args.path, '/work/a.md')
  assert.equal(client.requests[0][2].args.expectedVersion, 'v1')
  assert.equal(client.requests[0][2].args.text, '# after\n')
})

test('autosave serializes edits and retains newer text typed during a pending save', async () => {
  let resolveFirst
  const client = loadClient({
    workspaceFiles: { readBytes: async () => ({ ok: true, value: {
      data: new TextEncoder().encode('a'), version: 'v1', absolutePath: '/work/a.md', bytes: 1, offset: 0, eof: true,
    } }) },
    call: (...args) => client.requests.length === 1
      ? new Promise(resolve => { resolveFirst = resolve })
      : { ok: true, value: { version: 'v3' } },
  })
  const wrapped = client.slots.get('sidebar.right.tab.document')({
    resourceAddress: 'dsh-resource://file/session/s1/a.md',
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
  })
  const signal = new AbortController().signal
  const props = { ...wrapped.props, useResource: () => ({ status: 'live', value: { version: 'v1' } }),
    useTabInfo: () => ({ tab: { signal } }) }
  let view = client.renderComponent(wrapped.type, props)
  view.effects[1]()
  await new Promise(resolve => setImmediate(resolve))
  view = client.renderComponent(wrapped.type, props)
  all(view.value, is('textarea'))[0].props.onChange({ target: { value: 'ab' } })
  view = client.renderComponent(wrapped.type, props)
  view.effects[3]()
  client.flushTimers()

  view = client.renderComponent(wrapped.type, props)
  all(view.value, is('textarea'))[0].props.onChange({ target: { value: 'abc' } })
  view = client.renderComponent(wrapped.type, props)
  view.effects[3]()
  assert.equal(client.timers, 0)
  assert.equal(client.requests.length, 1)
  resolveFirst({ ok: true, value: { version: 'v2' } })
  await new Promise(resolve => setImmediate(resolve))
  view = client.renderComponent(wrapped.type, props)
  assert.equal(all(view.value, is('textarea'))[0].props.value, 'abc')
  view.effects[3]()
  client.flushTimers()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(client.requests.map(request => [request[2].args.text, request[2].args.expectedVersion]),
    [['ab', 'v1'], ['abc', 'v2']])
  view = client.renderComponent(wrapped.type, props)
  assert.equal(all(view.value, is('span', 'data-file-write-status'))[0].children[0], '已保存')
})

test('failed autosave preserves draft without retrying until the next edit', async () => {
  const client = loadClient({
    workspaceFiles: { readBytes: async () => ({ ok: true, value: {
      data: new TextEncoder().encode('a'), version: 'v1', absolutePath: '/work/a.md', bytes: 1, offset: 0, eof: true,
    } }) },
    call: async () => ({ ok: false, error: { code: 'file-write/unavailable', message: '写入失败' } }),
  })
  const wrapped = client.slots.get('sidebar.right.tab.document')({
    resourceAddress: 'dsh-resource://file/session/s1/a.md',
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
  })
  const props = { ...wrapped.props, useResource: () => ({ status: 'live', value: { version: 'v1' } }),
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }) }
  let view = client.renderComponent(wrapped.type, props)
  view.effects[1]()
  await new Promise(resolve => setImmediate(resolve))
  view = client.renderComponent(wrapped.type, props)
  all(view.value, is('textarea'))[0].props.onChange({ target: { value: 'ab' } })
  view = client.renderComponent(wrapped.type, props)
  view.effects[3]()
  client.flushTimers()

  await new Promise(resolve => setImmediate(resolve))
  view = client.renderComponent(wrapped.type, props)
  view.effects[3]()
  assert.equal(client.timers, 0)
  assert.equal(client.requests.length, 1)
  assert.equal(all(view.value, is('textarea'))[0].props.value, 'ab')
  assert.equal(all(view.value, is('span', 'data-file-write-status'))[0].children[0], '保存失败')
  all(view.value, is('textarea'))[0].props.onChange({ target: { value: 'abc' } })
  view = client.renderComponent(wrapped.type, props)
  view.effects[3]()
  assert.equal(client.timers, 1)
})


test('background renderer reload leaves an initialized editor active', async () => {
  let resolveRefresh
  let reads = 0
  const client = loadClient({ workspaceFiles: { readBytes: () => ++reads === 1
    ? Promise.resolve({ ok: true, value: {
      data: new TextEncoder().encode('a'), version: 'v1', absolutePath: '/work/a.md', bytes: 1, offset: 0, eof: true,
    } })
    : new Promise(resolve => { resolveRefresh = resolve }),
  } })
  const wrapped = client.slots.get('sidebar.right.tab.document')({
    resourceAddress: 'dsh-resource://file/session/s1/a.md',
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
  })
  const props = { ...wrapped.props, useResource: () => ({ status: 'live', value: { version: 'v1' } }),
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }) }
  let view = client.renderComponent(wrapped.type, props)
  view.effects[1]()
  await new Promise(resolve => setImmediate(resolve))
  view = client.renderComponent(wrapped.type, props)
  assert.equal(all(view.value, is('textarea'))[0].props.disabled, false)
  const refreshed = { ...props, content: { kind: 'renderer', revision: 2, loaded() {}, failed() {} } }
  view = client.renderComponent(wrapped.type, refreshed)
  view.effects[1]()
  await Promise.resolve()
  assert.equal(typeof resolveRefresh, 'function')
  view = client.renderComponent(wrapped.type, refreshed)
  assert.equal(all(view.value, is('textarea'))[0].props.disabled, false)
  assert.equal(all(view.value, is('textarea'))[0].props.value, 'a')
  resolveRefresh({ ok: true, value: {
    data: new TextEncoder().encode('a'), version: 'v1', absolutePath: '/work/a.md', bytes: 1, offset: 0, eof: true,
  } })
  await new Promise(resolve => setImmediate(resolve))
})


test('incomplete byte reads never expose a saveable blank editor', async () => {
  const client = loadClient({ workspaceFiles: { readBytes: async () => ({ ok: true, value: {
    data: new Uint8Array(), version: 'v1', absolutePath: '/work/a.md', bytes: 10, offset: 0, eof: false,
  } }) } })
  const wrapped = client.slots.get('sidebar.right.tab.document')({
    resourceAddress: 'dsh-resource://file/session/s1/a.md',
    content: { kind: 'renderer', revision: 1, loaded() {}, failed() {} },
  })
  const props = { ...wrapped.props,
    useResource: () => ({ status: 'live', value: { version: 'v1' } }),
    useTabInfo: () => ({ tab: { signal: new AbortController().signal } }),
  }
  const first = client.renderComponent(wrapped.type, props)
  first.effects[1]()
  await new Promise(resolve => setImmediate(resolve))
  const view = client.renderComponent(wrapped.type, props).value
  assert.equal(all(view, is('textarea'))[0].props.disabled, true)
  assert.equal(all(view, is('button', 'data-file-write-save')).length, 0)
  assert.equal(client.timers, 0)
  assert.match(all(view, is('span', 'data-file-write-status'))[0].children[0], /不完整/)
})

test('bridges new-file menu item and calls exclusive create with chosen name', async () => {
  const client = loadClient()
  const wrapped = client.slots.get('conversation.input.dock')({ session: { sessionId: 's1' } })
  let view = client.renderComponent(wrapped.type, wrapped.props)
  view.effects[1]() // Register menu bridge and fallback.
  const event = directoryEvent('/work/docs')
  const items = [{ label: '加入到对话框' }]
  client.document.dispatchEvent({ type: 'dsh-file-tree-menu', detail: { event, items } })
  assert.deepEqual(items.map(item => item.label), ['加入到对话框', '新建文件', '删除文件'])
  items[1].onClick()
  view = client.renderComponent(wrapped.type, wrapped.props)
  const input = all(view.value, is('input', 'data-file-write-name'))[0]
  input.props.onChange({ target: { value: 'a.md' } })
  view = client.renderComponent(wrapped.type, wrapped.props)
  const form = all(view.value, is('form'))[0]
  await form.props.onSubmit({ preventDefault() {} })
  assert.equal(client.requests.length, 1)
  assert.equal(client.requests[0][1], 'fileWrite/create')
  assert.equal(client.requests[0][2].args.sessionId, 's1')
  assert.equal(client.requests[0][2].args.directory, '/work/docs')
  assert.equal(client.requests[0][2].args.basename, 'a.md')
  assert.equal(client.requests[0][2].args.text, '')
})

test('ordinary file right-click offers delete only and confirms before requesting it', async () => {
  const client = loadClient({ call: async () => ({ ok: true, value: { absolutePath: '/work/a.md', kind: 'file' } }) })
  const wrapped = client.slots.get('conversation.input.dock')({ session: { id: 's1' } })
  let view = client.renderComponent(wrapped.type, wrapped.props)
  view.effects[1]()
  const event = directoryEvent('/work/a.md', 'file')
  const items = [{ label: '加入到对话框' }]
  client.document.dispatchEvent({ type: 'dsh-file-tree-menu', detail: { event, items } })
  assert.deepEqual(items.map(item => item.label), ['加入到对话框', '删除文件'])
  assert.equal(client.requests.length, 0)
  items[1].onClick()
  view = client.renderComponent(wrapped.type, wrapped.props)
  assert.equal(client.requests.length, 0)
  const dialog = all(view.value, is('form')).find(node => node.props['aria-label'] === '确认删除')
  assert.ok(dialog)
  assert.equal(all(dialog, is('small'))[0].children[0], '/work/a.md')
  await dialog.props.onSubmit({ preventDefault() {} })
  assert.equal(client.requests[0][1], 'fileWrite/delete')
  assert.equal(client.requests[0][2].args.sessionId, 's1')
  assert.equal(client.requests[0][2].args.path, '/work/a.md')
  assert.equal(client.requests[0][2].args.kind, 'file')
})

test('directory deletion warns about recursively removing all contents', async () => {
  const client = loadClient()
  const wrapped = client.slots.get('conversation.input.dock')({ session: { id: 's1' } })
  const view = client.renderComponent(wrapped.type, wrapped.props)
  view.effects[1]()
  const items = []
  client.document.dispatchEvent({ type: 'dsh-file-tree-menu', detail: {
    event: directoryEvent('/work/sub'), items,
  } })
  assert.deepEqual(items.map(item => item.label), ['新建文件', '删除文件'])
  items[1].onClick()
  const dialog = all(client.renderComponent(wrapped.type, wrapped.props).value, is('form'))
    .find(node => node.props['aria-label'] === '确认删除')
  assert.match(all(dialog, is('span'))[0].children[0], /递归删除目录/)
  assert.equal(client.requests.length, 0)
})
