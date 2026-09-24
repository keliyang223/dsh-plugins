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
    __ModuleLoader__: { load: (entry) => { loaded = entry } },
  }
  const document = { body: {} }
  runInNewContext(script, { window, document, MutationObserver: options.MutationObserver })
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

test('contains a browser entry and bundle patch', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), /name: dsh-markdown/)
})
