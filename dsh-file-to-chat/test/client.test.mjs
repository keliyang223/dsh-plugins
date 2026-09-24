import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const script = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

function loadPlugin(options = {}) {
  let loaded
  const components = new Map()
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: options.useEffect ?? (() => {}),
    useRef: options.useRef ?? ((initial) => ({ current: initial })),
    useState: options.useState ?? ((initial) => [initial, () => {}]),
  }
  const window = {
    innerWidth: 780,
    innerHeight: 927,
    navigator: options.navigator ?? {},
    CustomEvent: options.CustomEvent,
    getSelection: options.getSelection ?? (() => null),
    addEventListener: options.addWindowListener ?? (() => {}),
    removeEventListener: options.removeWindowListener ?? (() => {}),
    __ModuleLoader__: { load: (entry) => { loaded = entry } },
  }
  const document = {
    body: { appendChild() {} },
    createRange: options.createRange,
    createElement: options.createElement,
    execCommand: options.execCommand,
    dispatchEvent: options.dispatchDocumentEvent,
    addEventListener: options.addDocumentListener ?? (() => {}),
    removeEventListener: options.removeDocumentListener ?? (() => {}),
  }
  runInNewContext(script, { window, document })
  assert.equal(loaded.id, 'dsh-file-to-chat')
  const plugin = loaded.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (child, container) => ({ child, container }) }
    throw Error(`Unexpected browser import: ${name}`)
  })
  assert.equal(Array.from(plugin.inject).join(','), 'slots')
  plugin.apply({ slots: {
    inject(key, callback) {
      assert.ok(['sidebar.right.tab.document.actions', 'conversation.input.dock'].includes(key))
      callback()
    },
    register(meta, render) {
      assert.equal(meta.name, meta.id === 'dsh-file-to-chat' ? 'sidebar.right.tab.document.actions' : 'conversation.input.dock')
      components.set(meta.name, render)
      return () => {}
    },
  } })
  assert.equal(components.size, 2)
  return { components, window, document }
}

function loadButton(path, actions) {
  const { components } = loadPlugin()
  return components.get('sidebar.right.tab.document.actions')({ absolutePath: path, inputActions: actions })
}

for (const [path, expected] of [
  ['C:\\work\\src\\app.ts', 'C:/work/src/app.ts '],
  ['C:\\my work\\src\\app.ts', 'C:/my work/src/app.ts '],
  ['/home/me/file.ts', '/home/me/file.ts '],
]) {
  test(`inserts ${expected} without submitting`, () => {
    const span = { start: 3, end: 3, draftRev: 2 }
    const calls = []
    const button = loadButton(path, {
      captureInsertion() { calls.push('capture'); return span },
      insertText(text, captured) { calls.push(['insert', text, captured]); return true },
    })
    assert.equal(button.type, 'button')
    assert.equal(button.props.disabled, false)
    let prevented = false
    button.props.onMouseDown({ preventDefault() { prevented = true } })
    button.props.onClick()
    assert.equal(prevented, true)
    assert.equal(calls[0], 'capture')
    assert.deepEqual(calls[1], ['insert', expected, span])
  })
}

test('refuses empty paths and paths containing control characters', () => {
  for (const path of ['/tmp/line\nbreak.ts', '']) {
    const button = loadButton(path, {
      captureInsertion() { throw Error('not called') },
      insertText() { throw Error('not called') },
    })
    assert.equal(button.props.disabled, true)
    button.props.onClick()
  }
})

test('right-click on a file row inserts its path but does not open the file', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const calls = []
  const span = { start: 4, end: 4, draftRev: 7 }
  const { components, document } = loadPlugin({
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
  })
  const render = components.get('conversation.input.dock')
  const actions = {
    captureInsertion() { calls.push('capture'); return span },
    insertText(text, guard) { calls.push(['insert', text, guard]); return true },
  }
  assert.equal(render({ inputActions: actions }), null)
  assert.equal(effects.length, 2)
  const dispose = effects[0]()
  const row = {
    closest(selector) { return selector === '[data-files-state="tree"]' ? {} : null },
    getAttribute(name) {
      if (name === 'data-files-entry') return 'file'
      assert.equal(name, 'data-files-path')
      return 'D:\\projects\\bolt\\.gitignore'
    },
    getBoundingClientRect() { return { left: 20, bottom: 50 } },
  }
  let prevented = false
  let stopped = false
  listeners.get('contextmenu')({
    defaultPrevented: false,
    target: { closest: () => row },
    clientX: 770, clientY: 900,
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
  })
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.equal(calls[0], 'capture')
  effects.length = 0
  const portal = render({ inputActions: actions })
  assert.equal(portal.container, document.body)
  assert.equal(portal.child.props.role, 'menu')
  assert.equal(portal.child.props.style.left, 560)
  assert.equal(portal.child.props.style.top, 849)
  assert.equal(portal.child.props.style.fontSize, 12)
  const item = portal.child.children[0]
  assert.equal(item.children[0], '加入到对话框')
  assert.equal(item.props.role, 'menuitem')
  item.props.onClick()
  assert.deepEqual(calls[1], ['insert', 'D:/projects/bolt/.gitignore ', span])
  assert.equal(menu, null)
  dispose()
})

test('tree context menu accepts a new-file contribution without losing add-to-chat', async () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  let created = false
  const calls = []
  const { components } = loadPlugin({
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail } },
    dispatchDocumentEvent(event) {
      if (event.type === 'dsh-file-tree-menu') {
        event.detail.items.push({ label: '新建文件', onClick: () => { created = true } })
      }
    },
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, fn) => { listeners.set(name, fn) },
  })
  const render = components.get('conversation.input.dock')
  const inputActions = { captureInsertion: () => ({}), insertText: (text) => { calls.push(text) } }
  render({ inputActions })
  effects[0]()
  const row = {
    closest: () => ({}),
    getAttribute: (key) => key === 'data-files-entry' ? 'directory' : '/work/docs',
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector.startsWith('li[') ? row : null },
    clientX: 30, clientY: 50,
    preventDefault() {}, stopPropagation() {},
  })
  const portal = render({ inputActions })
  assert.deepEqual(portal.child.children.map((item) => item.children[0]), ['加入到对话框', '新建文件'])
  await portal.child.children[1].props.onClick()
  assert.equal(created, true)
  assert.equal(calls.length, 0)
})

test('right-click ignores unrelated elements and unsafe file paths', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const { components } = loadPlugin({
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
  })
  components.get('conversation.input.dock')({
    inputActions: { captureInsertion() { throw Error('unexpected') } },
  })
  effects[0]()
  let prevented = false
  const fire = (row) => listeners.get('contextmenu')({
    target: { closest: (selector) => selector.startsWith('li[') ? row : null },
    preventDefault() { prevented = true },
    stopPropagation() {},
  })
  fire(null)
  fire({ closest: () => null, getAttribute: () => null })
  fire({
    closest: () => ({}),
    getAttribute: (key) => key === 'data-files-entry' ? 'file' : 'C:\\bad\npath',
  })
  assert.equal(menu, null)
  assert.equal(prevented, false)
})

test('right-click on a folder inserts a directory reference', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const calls = []
  const span = { draftRev: 9 }
  const { components } = loadPlugin({
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, fn) => { listeners.set(name, fn) },
  })
  const render = components.get('conversation.input.dock')
  const inputActions = {
    captureInsertion: () => span,
    insertText: (text, captured) => { calls.push([text, captured]); return true },
  }
  render({ inputActions })
  effects[0]()
  const row = {
    closest: () => ({}),
    getAttribute: (key) => key === 'data-files-entry' ? 'directory' : 'D:\\my work\\docs',
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  let prevented = false
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector.startsWith('li[') ? row : null },
    clientX: 50, clientY: 60,
    preventDefault: () => { prevented = true },
    stopPropagation: () => {},
  })
  assert.equal(prevented, true)
  const portal = render({ inputActions })
  portal.child.children[0].props.onClick()
  assert.deepEqual(calls[0], ['D:/my work/docs/ ', span])
})

function previewSelection(kind, selected, path = 'C:\\my work\\src\\main.go') {
  const startContainer = {}
  const endContainer = {}
  const nodes = [1, 2, 3, 4].map((number) => ({
    number,
    getAttribute: () => String(number + (kind === 'plain' ? 10 : 0)),
  }))
  const code = { querySelectorAll: (selector) => selector === '.line' ? nodes : [] }
  const body = {
    contains: (node) => node === startContainer || node === endContainer,
    querySelectorAll(selector) {
      if (selector === '[data-textpreview-line]' && kind === 'plain') return nodes
      if (selector === '[data-code-line], [data-line-number]') return []
      return []
    },
    querySelector: (selector) => selector === '[data-code-preview] [data-code-block-content]' && kind === 'code' ? code : null,
  }
  const preview = {
    querySelector: (selector) => selector === '[data-textpreview-body]' ? body : {
      getAttribute: () => path,
    },
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({
      startContainer, endContainer,
      intersectsNode: (node) => selected.includes(node.number),
      toString: () => kind === 'generic' ? 'second line\nthird line' : '',
    }),
  }
  return { preview, selection, body }
}

test('toolbar preserves selected plain-text source lines through its click', () => {
  const calls = []
  const span = { draftRev: 5 }
  const { preview, selection } = previewSelection('plain', [2, 3, 4])
  let currentSelection = selection
  const { components } = loadPlugin({ getSelection: () => currentSelection })
  const render = components.get('sidebar.right.tab.document.actions')
  const button = render({
    absolutePath: 'C:\\my work\\src\\main.go',
    inputActions: {
      captureInsertion: () => span,
      insertText: (text, captured) => { calls.push([text, captured]); return true },
    },
  })
  let prevented = false
  const currentTarget = { closest: () => preview }
  button.props.onMouseDown({ currentTarget, preventDefault: () => { prevented = true } })
  currentSelection = null // Browser could drop selection when the toolbar is clicked.
  button.props.onClick({ currentTarget })
  assert.equal(prevented, true)
  assert.deepEqual(calls[0], ['C:/my work/src/main.go 第 12–14 行 ', span])
})

test('right-click on selected code lines offers one action to insert the selected-line reference', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const calls = []
  const span = { draftRev: 9 }
  const { preview, selection } = previewSelection('code', [2, 3])
  const { components } = loadPlugin({
    getSelection: () => selection,
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, fn) => { listeners.set(name, fn) },
  })
  const render = components.get('conversation.input.dock')
  const inputActions = {
    captureInsertion: () => span,
    insertText: (text, captured) => { calls.push([text, captured]); return true },
  }
  render({ inputActions })
  effects[0]()
  let prevented = false
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    clientX: 70, clientY: 110,
    preventDefault: () => { prevented = true },
    stopPropagation: () => {},
  })
  assert.equal(prevented, true)
  const portal = render({ inputActions })
  assert.equal(portal.child.children.length, 1)
  const item = portal.child.children[0]
  assert.equal(item.children[0], '加入选中行到对话框')
  item.props.onClick()
  assert.deepEqual(calls[0], ['C:/my work/src/main.go 第 2–3 行 ', span])
})

test('generic text preview falls back to counting selected lines and offers insertion', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const { preview, selection } = previewSelection('generic', [], '/tmp/sample.txt')
  const calls = []
  const { components } = loadPlugin({
    getSelection: () => selection,
    createRange: () => ({
      selectNodeContents() {},
      setEnd() {},
      toString: () => 'first line\n',
    }),
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, fn) => { listeners.set(name, fn) },
  })
  const render = components.get('conversation.input.dock')
  const inputActions = {
    captureInsertion: () => ({}),
    insertText: (text) => { calls.push(text) },
  }
  render({ inputActions })
  effects[0]()
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    clientX: 30, clientY: 50,
    preventDefault() {},
    stopPropagation() {},
  })
  const portal = render({ inputActions })
  assert.equal(portal.child.children.length, 1)
  const item = portal.child.children[0]
  assert.equal(item.children[0], '加入选中行到对话框')
  item.props.onClick()
  assert.deepEqual(calls, ['/tmp/sample.txt 第 2–3 行 '])
})

test('selection from outside the preview does not add stale line numbers', () => {
  const { preview, selection, body } = previewSelection('plain', [2, 3])
  body.contains = () => false
  const calls = []
  const { components } = loadPlugin({ getSelection: () => selection })
  const button = components.get('sidebar.right.tab.document.actions')({
    absolutePath: 'C:\\repo\\a.go',
    inputActions: {
      captureInsertion: () => ({}),
      insertText: (text) => { calls.push(text); return true },
    },
  })
  button.props.onClick({ currentTarget: { closest: () => preview } })
  assert.deepEqual(calls, ['C:/repo/a.go '])
})

test('contains only a browser client entry and a no-op host entry', async () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), /name: dsh-file-to-chat/)
  const host = await import('../lib/index.js')
  assert.equal(host.apply(), undefined)
})
