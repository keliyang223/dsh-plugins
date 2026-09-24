// DSH Web client-module format: register a lazy factory, not an ESM import.
window.__ModuleLoader__.load({
  id: 'dsh-markdown',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { createPortal } = require('react-dom')
    const module = { exports: {} }
    const STORAGE_KEY = 'dsh-markdown.toc.visible'
    const PANEL_WIDTH = 236

    function readVisible() {
      try { return window.localStorage?.getItem(STORAGE_KEY) !== '0' } catch { return true }
    }

    function writeVisible(value) {
      try { window.localStorage?.setItem(STORAGE_KEY, value ? '1' : '0') } catch { /* storage is optional */ }
    }

    function isMarkdown(path) {
      return typeof path === 'string' && /\.(?:md|markdown)$/iu.test(path)
    }

    function slug(text, used) {
      let value = String(text || '').trim().toLowerCase()
        .replace(/\s+/gu, '-')
        .replace(/[^\p{L}\p{N}_-]/gu, '')
      if (!value) value = 'section'
      const base = value
      let suffix = 1
      while (used.has(value)) value = `${base}-${suffix++}`
      used.add(value)
      return value
    }

    function headingsIn(preview) {
      const nodes = [...(preview?.querySelectorAll?.('[data-document-markdown] h1, [data-document-markdown] h2, [data-document-markdown] h3, [data-document-markdown] h4, [data-document-markdown] h5, [data-document-markdown] h6') ?? [])]
      const used = new Set()
      return nodes.map((node, index) => {
        if (!node.id) node.id = slug(node.textContent, used)
        else used.add(node.id)
        return {
          id: node.id,
          level: Number(node.tagName.slice(1)),
          text: node.textContent.trim() || `标题 ${index + 1}`,
          node,
        }
      })
    }

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 28,
      height: 28,
      padding: '0 8px',
      border: 0,
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, currentColor)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 12,
    }

    function TocPanel({ preview, items, onClose }) {
      return h('aside', {
        'data-dsh-markdown-toc': '',
        'aria-label': '本页目录',
        style: {
          position: 'absolute',
          top: 38,
          right: 0,
          bottom: 0,
          width: PANEL_WIDTH,
          zIndex: 5,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))',
          borderLeft: '1px solid var(--dsw-alias-border-l1, #ddd)',
          color: 'var(--dsw-alias-label-primary, #222)',
          boxShadow: '-4px 0 12px rgba(0, 0, 0, .06)',
        },
      },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flex: '0 0 38px',
          padding: '0 8px 0 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #ddd)',
          fontSize: 12,
          fontWeight: 600,
        },
      },
      h('span', null, '本页目录'),
      h('button', {
        type: 'button',
        title: '隐藏目录',
        'aria-label': '隐藏目录',
        onClick: onClose,
        style: { ...buttonStyle, minWidth: 24, width: 24, padding: 0, height: 24 },
      }, '×')),
      h('nav', {
        style: { overflowY: 'auto', minHeight: 0, padding: '8px 6px 16px' },
      }, items.length ? items.map((item, index) => h('button', {
        key: `${item.id}-${index}`,
        type: 'button',
        title: item.text,
        'data-dsh-markdown-toc-item': item.id,
        onClick() { item.node.scrollIntoView?.({ behavior: 'smooth', block: 'start' }) },
        style: {
          display: 'block',
          boxSizing: 'border-box',
          width: '100%',
          overflow: 'hidden',
          padding: '5px 8px',
          paddingLeft: 8 + Math.max(0, item.level - 1) * 14,
          border: 0,
          borderRadius: 5,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, #666)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '17px',
          textAlign: 'left',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, item.text)) : h('div', {
        style: { padding: '8px', color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 12 },
      }, '暂无标题')))
    }

    function MarkdownTocAction({ absolutePath }) {
      const buttonRef = useRef(null)
      const [visible, setVisible] = useState(readVisible)
      const [preview, setPreview] = useState(null)
      const [items, setItems] = useState([])

      useEffect(() => {
        const next = buttonRef.current?.closest?.('[data-textpreview-url]')
        if (next) setPreview(next)
        return () => setPreview(null)
      }, [absolutePath])

      useEffect(() => {
        if (!visible || !preview) {
          setItems([])
          return undefined
        }
        const body = preview.querySelector?.('[data-textpreview-body]')
        if (!body) return undefined
        const previousPosition = preview.style.position
        const previousPadding = body.style.paddingRight
        if (!previousPosition || previousPosition === 'static') preview.style.position = 'relative'
        body.style.paddingRight = `${PANEL_WIDTH + 12}px`
        const refresh = () => setItems(headingsIn(preview))
        refresh()
        const observer = typeof MutationObserver === 'function'
          ? new MutationObserver(refresh)
          : null
        observer?.observe(preview, { childList: true, subtree: true, characterData: true })
        return () => {
          observer?.disconnect()
          body.style.paddingRight = previousPadding
          preview.style.position = previousPosition
        }
      }, [visible, preview])

      if (!isMarkdown(absolutePath)) return null
      const toggle = () => {
        const next = !visible
        setVisible(next)
        writeVisible(next)
        if (!preview) {
          const current = buttonRef.current?.closest?.('[data-textpreview-url]')
          if (current) setPreview(current)
        }
      }
      const panel = visible && preview ? createPortal(
        h(TocPanel, { preview, items, onClose: toggle }), preview,
      ) : null
      return h('span', null,
        h('button', {
          ref: buttonRef,
          type: 'button',
          title: visible ? '隐藏目录' : '显示目录',
          'aria-label': visible ? '隐藏目录' : '显示目录',
          'data-dsh-markdown-toc-toggle': '',
          'aria-pressed': visible,
          onClick: toggle,
          style: { ...buttonStyle, color: visible ? 'var(--dsw-alias-brand-primary, #367bf5)' : buttonStyle.color },
        }, '目录'),
        panel,
      )
    }

    module.exports.inject = ['slots']
    module.exports.apply = function apply(ctx) {
      ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'dsh-markdown-toc',
          order: 100,
        }, MarkdownTocAction),
      )
    }
    return module.exports
  },
})
