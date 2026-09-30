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
    baseURI: 'http://127.0.0.1:3080/',
    body: { appendChild() {} },
    createRange: options.createRange,
    createElement: options.createElement,
    execCommand: options.execCommand,
    dispatchEvent: options.dispatchDocumentEvent,
    addEventListener: options.addDocumentListener ?? (() => {}),
    removeEventListener: options.removeDocumentListener ?? (() => {}),
  }
  runInNewContext(script, {
    window, document, URL, fetch: options.fetch, MutationObserver: options.MutationObserver,
    AbortController: options.AbortController, setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
  })
  assert.equal(loaded.id, 'dsh-file-to-chat')
  const plugin = loaded.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (child, container) => ({ child, container }) }
    throw Error(`Unexpected browser import: ${name}`)
  })
  assert.equal(Array.from(plugin.inject).join(','), 'slots')
  plugin.apply({ slots: {
    inject(key, callback) {
      assert.ok(['conversation.input.dock', 'sidebar.right.tab.document.actions'].includes(key))
      callback()
    },
    register(meta, render) {
      assert.ok(['conversation.input.dock', 'sidebar.right.tab.document.actions'].includes(meta.name))
      components.set(meta.name, render)
      return () => {}
    },
  } })
  assert.equal(components.size, 2)
  assert.equal(components.has('sidebar.right.tab.document.actions'), true)
  return { components, window, document }
}

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
  assert.equal(portal.child.props.style.top, 888)
  assert.equal(portal.child.props.style.fontSize, 12)
  const item = portal.child.children[0]
  assert.equal(item.children[0].type, 'svg')
  assert.equal(item.children[1].children[0], '加入到对话框')
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
  assert.deepEqual(portal.child.children.map((item) => item.children[1].children[0]), ['加入到对话框', '新建文件'])
  assert.equal(portal.child.children[0].children[0].type, 'svg')
  await portal.child.children[1].props.onClick()
  assert.equal(created, true)
  assert.equal(calls.length, 0)
})

test('shared menu renders icons for file import and paste contributions', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const { components } = loadPlugin({
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail } },
    dispatchDocumentEvent(event) {
      if (event.type === 'dsh-file-tree-menu') {
        event.detail.items.push({ label: '添加文件…', icon: 'upload', onClick() {} })
        event.detail.items.push({ label: '粘贴', icon: 'paste', onClick() {} })
      }
    },
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, fn) => { listeners.set(name, fn) },
  })
  const render = components.get('conversation.input.dock')
  const inputActions = { captureInsertion: () => ({}), insertText() {} }
  render({ inputActions })
  effects[0]()
  const row = {
    closest: () => ({}),
    getAttribute: (key) => key === 'data-files-entry' ? 'directory' : '/work/docs',
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector.startsWith('li[') ? row : null },
    clientX: 30, clientY: 50, preventDefault() {}, stopPropagation() {},
  })
  const items = render({ inputActions }).child.children
  assert.deepEqual(items.slice(1).map((item) => item.children[1].children[0]), ['添加文件…', '粘贴'])
  for (const item of items.slice(1)) {
    assert.equal(item.children[0].type, 'svg')
    assert.ok(item.children[0].children[0].props.d)
  }
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
    querySelector: (selector) => selector === '[data-textpreview-body]' ? body :
      selector === '[data-textpreview-path]' ? { getAttribute: (attribute) => attribute === 'title' ? path : null } : null,
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

test('preview toolbar no longer registers an add-to-chat button', () => {
  const { components } = loadPlugin()
  assert.equal(components.has('sidebar.right.tab.document.actions'), true)
  assert.equal(components.has('sidebar.right.tab.document.action'), false)
})

test('right-click on selected code lines offers one action to insert the selected-line reference', async () => {
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
  await Promise.resolve()
  const portal = render({ inputActions })
  assert.equal(portal.child.children.length, 1)
  const item = portal.child.children[0]
  assert.equal(item.children[0].type, 'svg')
  assert.equal(item.children[1].children[0], '加入选中行到对话框')
  item.props.onClick()
  assert.deepEqual(calls[0], ['C:/my work/src/main.go 第 2–3 行 ', span])
})

test('generic text preview falls back to counting selected lines and offers insertion', async () => {
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
  await Promise.resolve()
  const portal = render({ inputActions })
  assert.equal(portal.child.children.length, 1)
  const item = portal.child.children[0]
  assert.equal(item.children[0].type, 'svg')
  assert.equal(item.children[1].children[0], '加入选中行到对话框')
  item.props.onClick()
  assert.deepEqual(calls, ['/tmp/sample.txt 第 2–3 行 '])
})

test('selection from outside the preview does not open the reference menu', () => {
  let menu = null
  const effects = []
  const listeners = new Map()
  const { preview, selection, body } = previewSelection('plain', [2, 3])
  body.contains = () => false
  const { components } = loadPlugin({
    getSelection: () => selection,
    useState: () => [menu, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
  })
  components.get('conversation.input.dock')({ inputActions: { captureInsertion() { throw Error('unexpected') } } })
  effects[0]()
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    preventDefault() { throw Error('unexpected') },
  })
  assert.equal(menu, null)
})

test('prefetched Markdown list source is mapped synchronously at right-click', async () => {
  const path = '/tmp/README.en.md'
  const source = '# DSH File Write\n\n## Usage\n\n- Choose **编辑源文件** (Edit source) in the viewer selector to edit text files with automatic saving. `.md` and `.markdown` files use this source editor too.\n- Right-click a **directory** for **新建文件** (New file).\n'
  const paragraph = { tagName: 'P', textContent: 'Choose 编辑源文件 (Edit source) in the viewer selector to edit text files with automatic saving. .md and .markdown files use this source editor too.' }
  const node = { nodeType: 3, parentElement: { closest: () => paragraph } }
  const markdown = { contains: (item) => item === paragraph, querySelectorAll: () => [] }
  const body = { contains: (item) => item === node, querySelector: () => markdown }
  const preview = {
    querySelector: (selector) => selector === '[data-textpreview-body]' ? body :
      selector === '[data-textpreview-path]' ? { getAttribute: () => path } : null,
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({
    startContainer: node, endContainer: node, toString: () => 'files with automatic saving',
  }) }
  let menu = null
  const effects = []
  const listeners = new Map()
  let fetches = 0
  const { components } = loadPlugin({
    getSelection: () => selection,
    useState: (initial) => [initial, (value) => { menu = value }],
    useRef: () => ({ current: { closest: () => preview } }),
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
    fetch: async (url) => { fetches++; assert.match(url, /api\/file\?path=/); return {
      ok: true, headers: { get: () => null }, text: async () => source,
    } },
  })
  const sourceAction = components.get('sidebar.right.tab.document.actions')
  const marker = sourceAction({ absolutePath: path })
  assert.equal(marker.props['data-file-to-chat-source'], '')
  effects[0]()
  const render = components.get('conversation.input.dock')
  const insertions = []
  const actions = { captureInsertion: () => ({}), insertText: (text) => insertions.push(text) }
  render({ inputActions: actions })
  effects[1]()
  const rightClick = () => listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    clientX: 20, clientY: 40, preventDefault() {}, stopPropagation() {},
  })
  rightClick()
  assert.equal(fetches, 1)
  assert.equal(menu.label, '加入到对话框') // not ready, immediate fallback
  await new Promise((resolve) => setImmediate(resolve))
  rightClick()
  assert.equal(fetches, 1) // no fetch on right-click
  assert.equal(menu.label, '加入选中行到对话框')
  assert.equal(menu.items[0].text, `${path} 第 5 行 `)
})

test('numbered Markdown heading plus paragraph maps to source lines even when the selection ends at the next code block', async () => {
  const path = '/tmp/stage0.md'
  const source = [
    '## 6. 第四步：Close 不是 Flush', '', 'Close 本身不会导致 Flush。', '', '---', '',
    '## 7. 一个完整、可运行的阶段 0 示例', '',
    '下面的程序完成：创建数据库 → 写入 → 读取 → 关闭。', '',
    '```go', 'package main', '```', '',
  ].join('\n')
  const heading = { tagName: 'H2', textContent: '7. 一个完整、可运行的阶段 0 示例' }
  const paragraph = { tagName: 'P', textContent: '下面的程序完成：创建数据库 → 写入 → 读取 → 关闭。' }
  const startNode = { nodeType: 3, parentElement: { closest: () => heading } }
  const codeText = { nodeType: 3, parentElement: { closest: () => null } }
  const codeBlock = { contains: (node) => node === codeText, querySelector: () => ({ textContent: 'package main\n' }) }
  const markdown = {
    contains: (item) => item === heading || item === paragraph,
    querySelectorAll: (selector) => selector === '[data-code-block-content]' ? [codeBlock] : [heading, paragraph],
  }
  const body = { contains: (item) => item === startNode || item === codeText, querySelector: () => markdown }
  const preview = {
    querySelector: (selector) => selector === '[data-textpreview-body]' ? body :
      selector === '[data-textpreview-path]' ? { getAttribute: () => path } : null,
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({
    startContainer: startNode, startOffset: 0, endContainer: codeText, endOffset: 0,
    intersectsNode: (node) => node === heading || node === paragraph || node === codeBlock,
    toString: () => '7. 一个完整、可运行的阶段 0 示例\n下面的程序完成：创建数据库 → 写入 → 读取 → 关闭。\n',
  }) }
  let menu
  const effects = []
  const listeners = new Map()
  const { components } = loadPlugin({
    getSelection: () => selection,
    useRef: () => ({ current: { closest: () => preview } }),
    useState: (initial) => [initial, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
    fetch: async () => ({ ok: true, headers: { get: () => null }, text: async () => source }),
  })
  components.get('sidebar.right.tab.document.actions')({ absolutePath: path })
  effects[0]()
  components.get('conversation.input.dock')({ inputActions: { captureInsertion: () => ({}) } })
  effects[1]()
  await new Promise((resolve) => setImmediate(resolve))
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    clientX: 20, clientY: 40, preventDefault() {}, stopPropagation() {},
  })
  assert.equal(menu.label, '加入选中行到对话框')
  assert.equal(menu.items[0].text, `${path} 第 7–9 行 `)
})

test('ambiguous repeated Markdown blocks do not invent a source line', async () => {
  const path = '/tmp/duplicate.md'
  const paragraph = { tagName: 'P', textContent: 'Repeated paragraph' }
  const node = { nodeType: 3, parentElement: { closest: () => paragraph } }
  const markdown = { contains: (item) => item === paragraph, querySelectorAll: () => [], textContent: 'Repeated paragraph' }
  const body = { contains: (item) => item === node, querySelector: () => markdown }
  const preview = {
    querySelector: (selector) => selector === '[data-textpreview-body]' ? body :
      selector === '[data-textpreview-path]' ? { getAttribute: () => path } : null,
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({
    startContainer: node, endContainer: node, toString: () => 'paragraph',
  }) }
  let menu
  const effects = []
  const listeners = new Map()
  let fetches = 0
  const { components } = loadPlugin({
    getSelection: () => selection,
    useRef: () => ({ current: { closest: () => preview } }),
    useState: (initial) => [initial, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
    fetch: async () => { fetches++; return {
      ok: true, headers: { get: () => null }, text: async () => 'Repeated paragraph\n\nRepeated paragraph\n',
    } },
  })
  components.get('sidebar.right.tab.document.actions')({ absolutePath: path })
  effects[0]()
  const render = components.get('conversation.input.dock')
  render({ inputActions: { captureInsertion: () => ({}) } })
  effects[1]()
  await new Promise((resolve) => setImmediate(resolve))
  listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    clientX: 20, clientY: 40, preventDefault() {}, stopPropagation() {},
  })
  assert.equal(fetches, 1)
  assert.equal(menu.label, '加入到对话框')
  assert.equal(menu.items[0].text, `${path} `)
})

test('Markdown preview changes invalidate cached lines before background reload', async () => {
  const path = '/tmp/updated.md'
  const paragraph = { tagName: 'P', textContent: 'First paragraph' }
  const node = { nodeType: 3, parentElement: { closest: () => paragraph } }
  const markdown = { contains: (item) => item === paragraph, querySelectorAll: () => [], textContent: 'First paragraph' }
  const body = { contains: (item) => item === node, querySelector: () => markdown }
  const preview = {
    querySelector: (selector) => selector === '[data-textpreview-body]' ? body :
      selector === '[data-textpreview-path]' ? { getAttribute: () => path } : null,
    getBoundingClientRect: () => ({ left: 20, bottom: 50 }),
  }
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({
    startContainer: node, endContainer: node, toString: () => 'First paragraph',
  }) }
  const effects = []
  const listeners = new Map()
  let mutation, timer, menu, fetches = 0
  const { components } = loadPlugin({
    getSelection: () => selection,
    useRef: () => ({ current: { closest: () => preview } }),
    useState: (initial) => [initial, (value) => { menu = value }],
    useEffect: (effect) => { effects.push(effect) },
    addDocumentListener: (name, handler) => { listeners.set(name, handler) },
    setTimeout: (fn) => { timer = fn; return 1 },
    clearTimeout: () => { timer = null },
    MutationObserver: class { constructor(fn) { mutation = fn } observe() {} disconnect() {} },
    fetch: async () => { fetches++; return {
      ok: true, headers: { get: () => null }, text: async () => 'First paragraph\n',
    } },
  })
  components.get('sidebar.right.tab.document.actions')({ absolutePath: path })
  const dispose = effects[0]()
  const render = components.get('conversation.input.dock')
  render({ inputActions: { captureInsertion: () => ({}) } })
  effects[1]()
  const rightClick = () => listeners.get('contextmenu')({
    target: { closest: (selector) => selector === '[data-textpreview-url]' ? preview : null },
    clientX: 20, clientY: 40, preventDefault() {}, stopPropagation() {},
  })
  await new Promise((resolve) => setImmediate(resolve))
  rightClick()
  assert.equal(menu.label, '加入选中行到对话框')
  markdown.textContent = 'Second paragraph'
  mutation()
  rightClick()
  assert.equal(menu.label, '加入到对话框')
  assert.equal(fetches, 1)
  timer()
  assert.equal(fetches, 2)
  dispose()
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
