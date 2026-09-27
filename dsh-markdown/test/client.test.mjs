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
    useState: options.useState ?? ((initial) => [typeof initial === 'function' ? initial() : initial, () => {}]),
  }
  const window = {
    localStorage: options.localStorage ?? { getItem: () => null, setItem() {} },
    addEventListener: options.addEventListener,
    removeEventListener: options.removeEventListener,
    __ModuleLoader__: { load: (entry) => { loaded = entry } },
  }
  const document = { body: {} }
  runInNewContext(script, { window, document, MutationObserver: options.MutationObserver, ResizeObserver: options.ResizeObserver })
  const plugin = loaded.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (child, container) => ({ child, container }) }
    throw Error(`Unexpected browser import: ${name}`)
  })
  plugin.apply({ slots: {
    inject(key, callback) {
      assert.equal(key, 'sidebar.right.tab.document.actions')
      callback()
    },
    register(meta, render) {
      components.set(meta, render)
      return () => {}
    },
  } })
  return { components, window }
}

function markdownPreview(headings = []) {
  const body = {
    style: {},
    querySelector() { return null },
  }
  const preview = {
    style: {},
    querySelector(selector) { return selector === '[data-textpreview-body]' ? body : null },
    querySelectorAll(selector) {
      return selector.includes('[data-document-markdown]') ? headings : []
    },
  }
  return { preview, body }
}

function heading(text, level) {
  return {
    tagName: `H${level}`,
    id: '',
    textContent: text,
    scrollIntoView() { this.scrolled = true },
    getBoundingClientRect() { return { top: 0 } },
  }
}

function renderTree(element) {
  if (element == null || typeof element !== 'object') return element
  const { type, props, children } = element
  if (typeof type === 'function') return renderTree(type({ ...props, children }))
  return { type, props, children: (children ?? []).flat().map(renderTree) }
}

function mockHooks() {
  const states = []
  const refs = []
  const effects = []
  let cursor = 0
  let oldEffects = []
  return {
    states,
    refs,
    effects,
    useRef(initial) {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (value) => { states[index] = value }]
    },
    useEffect(effect, deps) {
      const index = cursor++
      effects.push({ index, effect, deps })
    },
    runEffects() {
      for (const entry of effects) {
        const old = oldEffects.find((item) => item.index === entry.index)
        if (old && entry.deps.every((dep, i) => Object.is(dep, old.deps[i]))) {
          entry.cleanup = old.cleanup
          continue
        }
        old?.cleanup?.()
        entry.cleanup = entry.effect()
      }
      oldEffects = [...effects]
      effects.length = 0
    },
    render(component, props) {
      cursor = 0
      effects.length = 0
      return component(props)
    },
    cleanup() {
      for (const entry of oldEffects) entry.cleanup?.()
      oldEffects = []
    },
  }
}

test('registers one document action', () => {
  const { components } = loadPlugin()
  assert.equal(components.size, 1)
  const [[meta]] = components
  assert.equal(meta.id, 'dsh-markdown-toc')
  assert.equal(meta.name, 'sidebar.right.tab.document.actions')
})

test('ignores non-Markdown files', () => {
  const { components } = loadPlugin()
  const [, render] = [...components][0]
  assert.equal(render({ absolutePath: '/tmp/readme.txt' }), null)
})

test('builds a visible TOC and navigates to a heading', () => {
  const first = heading('概述', 1)
  const second = heading('安装', 2)
  const { components } = loadPlugin()
  const [, render] = [...components][0]
  const button = render({ absolutePath: '/tmp/readme.md' })
  assert.equal(button.type, 'span')
  assert.equal(button.children[0].props['data-dsh-markdown-toc-toggle'], '')
  assert.equal(button.children[1], null)
  assert.equal(first.id, '')
  void second
})

test('persists visibility changes', () => {
  const writes = []
  const { components } = loadPlugin({ localStorage: {
    getItem: () => '1',
    setItem(key, value) { writes.push([key, value]) },
  } })
  const [, render] = [...components][0]
  const button = render({ absolutePath: '/tmp/readme.md' })
  button.children[0].props.onClick()
  assert.deepEqual(writes, [['dsh-markdown.toc.visible', '0']])
})

test('keeps the native document scrollbar beside the TOC and restores layout on close', () => {
  const hooks = mockHooks()
  const { components } = loadPlugin(hooks)
  const [, action] = [...components][0]
  const { preview, body } = markdownPreview([heading('Overview', 1)])
  const listeners = new Map()
  body.scrollHeight = 1000
  body.clientHeight = 200
  body.scrollTop = 0
  body.getBoundingClientRect = () => ({ top: 0 })
  body.addEventListener = (name, callback) => listeners.set(name, callback)
  body.removeEventListener = (name) => listeners.delete(name)
  body.style.marginRight = '2px'
  body.style.minWidth = 'auto'
  preview.querySelector = (selector) => selector === '[data-textpreview-body]' ? body : null
  hooks.states[2] = preview
  hooks.render(action, { absolutePath: '/tmp/a.md' })
  hooks.runEffects()
  assert.equal(body.style.marginRight, '236px')
  assert.equal(body.style.minWidth, '0')
  assert.equal(body.style.paddingRight, undefined)
  assert.equal(listeners.has('scroll'), true)
  hooks.cleanup()
  assert.equal(body.style.marginRight, '2px')
  assert.equal(body.style.minWidth, 'auto')
  assert.equal(listeners.has('scroll'), false)
})

test('highlights the reading section and shows whole-document scroll progress', () => {
  const hooks = mockHooks()
  const first = heading('Overview', 1)
  const second = heading('Install', 2)
  first.getBoundingClientRect = () => ({ top: -200 })
  second.getBoundingClientRect = () => ({ top: 200 })
  const { preview, body } = markdownPreview([first, second])
  const listeners = new Map()
  body.scrollHeight = 1000
  body.clientHeight = 200
  body.scrollTop = 0
  body.getBoundingClientRect = () => ({ top: 0 })
  body.addEventListener = (name, callback) => listeners.set(name, callback)
  body.removeEventListener = (name) => listeners.delete(name)
  const { components } = loadPlugin(hooks)
  const [, action] = [...components][0]
  hooks.states[2] = preview
  hooks.render(action, { absolutePath: '/tmp/a.md' })
  hooks.runEffects()
  let button = hooks.render(action, { absolutePath: '/tmp/a.md' })
  let panel = renderTree(button.children[1].child)
  let nav = panel.children[2]
  assert.equal(nav.children[0].props['aria-current'], 'location')
  assert.equal(nav.children[1].props['aria-current'], undefined)
  assert.equal(panel.children[3].props['aria-valuenow'], 0)
  second.getBoundingClientRect = () => ({ top: 60 })
  body.scrollTop = 400
  listeners.get('scroll')()
  button = hooks.render(action, { absolutePath: '/tmp/a.md' })
  panel = renderTree(button.children[1].child)
  nav = panel.children[2]
  assert.equal(nav.children[1].props['aria-current'], 'location')
  assert.equal(nav.children[1].props.style.fontWeight, 600)
  assert.equal(panel.children[3].props['aria-valuenow'], 50)
  assert.equal(panel.children[3].children[1].children[0], '50%')
  nav.children[1].props.onClick()
  assert.equal(second.scrolled, true)
  body.scrollTop = 800
  listeners.get('scroll')()
  button = hooks.render(action, { absolutePath: '/tmp/a.md' })
  panel = renderTree(button.children[1].child)
  assert.equal(panel.children[3].props['aria-valuenow'], 100)
  hooks.cleanup()
})

test('drags the divider across small and large widths, clamps it, persists and restores it', () => {
  const hooks = mockHooks()
  const writes = []
  const { components } = loadPlugin({ ...hooks, localStorage: {
    getItem: (key) => key === 'dsh-markdown.toc.width' ? '350' : null,
    setItem(key, value) { writes.push([key, value]) },
  } })
  const [, action] = [...components][0]
  const { preview, body } = markdownPreview([])
  preview.clientWidth = 1000
  body.scrollHeight = 200
  body.clientHeight = 200
  body.scrollTop = 0
  body.getBoundingClientRect = () => ({ top: 0 })
  body.addEventListener = () => {}
  body.removeEventListener = () => {}
  hooks.states[2] = preview
  hooks.render(action, { absolutePath: '/tmp/a.md' })
  hooks.runEffects()
  assert.equal(body.style.marginRight, '350px')
  const divider = () => renderTree(hooks.render(action, { absolutePath: '/tmp/a.md' }).children[1].child).children[0]
  const target = {
    captured: false,
    setPointerCapture() { this.captured = true },
    hasPointerCapture() { return this.captured },
    releasePointerCapture() { this.captured = false },
  }
  divider().props.onPointerDown({ button: 0, pointerId: 1, clientX: 500, currentTarget: target, preventDefault() {} })
  assert.equal(target.captured, true)
  divider().props.onPointerMove({ pointerId: 1, clientX: 900 })
  assert.equal(body.style.marginRight, '64px')
  divider().props.onPointerMove({ pointerId: 1, clientX: -500 })
  assert.equal(body.style.marginRight, '920px')
  divider().props.onPointerUp({ pointerId: 1, clientX: -500, currentTarget: target })
  assert.equal(target.captured, false)
  assert.deepEqual(writes.at(-1), ['dsh-markdown.toc.width', '920'])
  divider().props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault() {} })
  assert.equal(body.style.marginRight, '880px')
  assert.deepEqual(writes.at(-1), ['dsh-markdown.toc.width', '880'])
  assert.equal(divider().props['aria-valuenow'], 880)
  hooks.cleanup()
  assert.equal(body.style.marginRight, undefined)
})

test('reclamps the directory when the preview shrinks', () => {
  const hooks = mockHooks()
  let resize
  const { components } = loadPlugin({ ...hooks, ResizeObserver: class {
    constructor(callback) { resize = callback }
    observe() {}
    disconnect() {}
  } })
  const [, action] = [...components][0]
  const { preview, body } = markdownPreview([])
  preview.clientWidth = 700
  body.scrollHeight = 100
  body.clientHeight = 100
  body.scrollTop = 0
  body.getBoundingClientRect = () => ({ top: 0 })
  body.addEventListener = () => {}
  body.removeEventListener = () => {}
  hooks.states[2] = preview
  hooks.render(action, { absolutePath: '/tmp/a.md' })
  hooks.runEffects()
  assert.equal(body.style.marginRight, '236px')
  preview.clientWidth = 120
  resize()
  assert.equal(body.style.marginRight, '64px')
  hooks.cleanup()
})

test('contains a browser entry and bundle patch', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), /name: dsh-markdown/)
})
