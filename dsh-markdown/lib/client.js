// DSH Web client-module format: register a lazy factory, not an ESM import.
window.__ModuleLoader__.load({
  id: 'dsh-markdown',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { createPortal } = require('react-dom')
    const module = { exports: {} }
    const STORAGE_KEY = 'dsh-markdown.toc.visible'
    const WIDTH_KEY = 'dsh-markdown.toc.width'
    const PANEL_WIDTH = 236
    const MIN_PANEL_WIDTH = 64
    const MIN_BODY_WIDTH = 80
    const READING_OFFSET = 80

    function readVisible() {
      try { return window.localStorage?.getItem(STORAGE_KEY) !== '0' } catch { return true }
    }

    function writeVisible(value) {
      try { window.localStorage?.setItem(STORAGE_KEY, value ? '1' : '0') } catch { /* storage is optional */ }
    }

    function readWidth() {
      try {
        const width = Number(window.localStorage?.getItem(WIDTH_KEY))
        return Number.isFinite(width) && width >= MIN_PANEL_WIDTH ? width : PANEL_WIDTH
      } catch { return PANEL_WIDTH }
    }

    function writeWidth(value) {
      try { window.localStorage?.setItem(WIDTH_KEY, String(value)) } catch { /* storage is optional */ }
    }

    function availableWidth(preview) {
      return preview?.clientWidth || preview?.getBoundingClientRect?.().width || PANEL_WIDTH + MIN_BODY_WIDTH
    }

    function clampWidth(width, preview) {
      const available = availableWidth(preview)
      return Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(width, Math.max(MIN_PANEL_WIDTH, available - MIN_BODY_WIDTH))))
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

    // Compare heading positions against the actual DSH scrollport, rather than
    // against the independent scrollable list of TOC entries.
    function readingState(body, items) {
      const max = Math.max(0, body.scrollHeight - body.clientHeight)
      const top = Math.max(0, body.scrollTop)
      const marker = body.getBoundingClientRect().top + Math.min(READING_OFFSET, body.clientHeight / 3)
      let active = items.length ? 0 : -1
      for (let i = 0; i < items.length; i++) {
        if (items[i].node.getBoundingClientRect().top <= marker) active = i
        else break
      }
      // The final heading may never reach the reading marker: the scrollport
      // stops at the document's end first. Still make its TOC entry current.
      if (max > 0 && top >= max - 1 && items.length) active = items.length - 1
      return { active, progress: max ? Math.round(Math.min(1, top / max) * 100) : 100 }
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

    function TocPanel({ items, active, progress, width, maxWidth, onResizeStart, onResizeMove, onResizeEnd, onResizeKey, onClose }) {
      const activeRef = useRef(null)
      useEffect(() => {
        const entry = activeRef.current
        if (!entry) return
        // Scroll only the TOC list, not the document preview, and keep the
        // current section near the middle instead of pinning it to the bottom.
        const nav = entry.parentElement
        const entryRect = entry.getBoundingClientRect()
        const navRect = nav.getBoundingClientRect()
        nav.scrollTop += entryRect.top - navRect.top + (entryRect.height - nav.clientHeight) / 2
      }, [active])
      return h('aside', {
        'data-dsh-markdown-toc': '',
        'aria-label': '本页目录',
        style: {
          position: 'absolute',
          top: 38,
          right: 0,
          bottom: 0,
          width,
          zIndex: 5,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))',
          borderLeft: '1px solid var(--dsw-alias-border-l1, #ddd)',
          color: 'var(--dsw-alias-label-primary, #222)',
        },
      },
      h('div', {
        'data-dsh-markdown-toc-resize': '',
        role: 'separator',
        tabIndex: 0,
        'aria-label': '调整目录宽度',
        'aria-orientation': 'vertical',
        'aria-valuemin': MIN_PANEL_WIDTH,
        'aria-valuemax': maxWidth,
        'aria-valuenow': width,
        title: '拖动或使用方向键调整目录宽度',
        onPointerDown: onResizeStart,
        onPointerMove: onResizeMove,
        onPointerUp: onResizeEnd,
        onPointerCancel: onResizeEnd,
        onKeyDown: onResizeKey,
        style: {
          position: 'absolute',
          left: -5,
          top: 0,
          bottom: 0,
          width: 10,
          zIndex: 1,
          cursor: 'col-resize',
          touchAction: 'none',
          background: 'transparent',
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute', top: '50%', left: 3, width: 3, height: 44,
          transform: 'translateY(-50%)', borderRadius: 3,
          background: 'var(--dsw-alias-border-l1, #bbb)', pointerEvents: 'none',
        },
      })),
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
        style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0, padding: '8px 6px 16px' },
      }, items.length ? items.map((item, index) => h('button', {
        key: `${item.id}-${index}`,
        ref: index === active ? activeRef : undefined,
        type: 'button',
        title: item.text,
        'aria-current': index === active ? 'location' : undefined,
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
          borderLeft: index === active ? '3px solid var(--dsw-alias-brand-primary, #367bf5)' : '3px solid transparent',
          borderRadius: 5,
          background: index === active ? 'var(--dsw-alias-interactive-bg-hover, #eaf1ff)' : 'transparent',
          color: index === active ? 'var(--dsw-alias-brand-primary, #367bf5)' : 'var(--dsw-alias-label-secondary, #666)',
          cursor: 'pointer',
          font: 'inherit',
          fontWeight: index === active ? 600 : 400,
          fontSize: 12,
          lineHeight: '17px',
          textAlign: 'left',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
      }, item.text)) : h('div', {
        style: { padding: '8px', color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: 12 },
      }, '暂无标题')),
      h('div', {
        'data-dsh-markdown-reading-progress': progress,
        role: 'progressbar',
        'aria-label': '文件阅读进度',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': progress,
        style: { flex: 'none', padding: '8px 12px', borderTop: '1px solid var(--dsw-alias-border-l1, #ddd)', fontSize: 11 },
      },
      h('div', { style: { height: 3, borderRadius: 3, background: 'var(--dsw-alias-border-l1, #ddd)', overflow: 'hidden' } },
        h('div', { style: { width: `${progress}%`, height: '100%', background: 'var(--dsw-alias-brand-primary, #367bf5)' } })),
      h('div', { style: { marginTop: 3, textAlign: 'right', color: 'var(--dsw-alias-label-secondary, #666)' } }, `${progress}%`)))
    }

    function MarkdownTocAction({ absolutePath }) {
      const buttonRef = useRef(null)
      const [visible, setVisible] = useState(readVisible)
      const [preview, setPreview] = useState(null)
      const [items, setItems] = useState([])
      const [reading, setReading] = useState({ active: -1, progress: 0 })
      const [width, setWidth] = useState(readWidth)
      const dragRef = useRef(null)
      const widthRef = useRef(width)
      widthRef.current = width

      const resizeTo = (nextWidth, save = false) => {
        if (!preview) return
        const next = clampWidth(nextWidth, preview)
        widthRef.current = next
        setWidth(next)
        const body = preview.querySelector?.('[data-textpreview-body]')
        if (body) body.style.marginRight = `${next}px`
        if (save) writeWidth(next)
      }
      const onResizeStart = (event) => {
        if (event.button !== 0 || !preview) return
        event.preventDefault()
        dragRef.current = { x: event.clientX, width: widthRef.current, pointerId: event.pointerId }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      const onResizeMove = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        resizeTo(drag.width + drag.x - event.clientX)
      }
      const onResizeEnd = (event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        onResizeMove(event)
        dragRef.current = null
        writeWidth(widthRef.current)
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }
      const onResizeKey = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        resizeTo(widthRef.current + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 10), true)
      }

      useEffect(() => {
        const next = buttonRef.current?.closest?.('[data-textpreview-url]')
        if (next) setPreview(next)
        return () => setPreview(null)
      }, [absolutePath])

      useEffect(() => {
        if (!visible || !preview || !isMarkdown(absolutePath)) {
          setItems([])
          return undefined
        }
        const body = preview.querySelector?.('[data-textpreview-body]')
        if (!body) return undefined
        const previousPosition = preview.style.position
        const previousMargin = body.style.marginRight
        const previousMinWidth = body.style.minWidth
        if (!previousPosition || previousPosition === 'static') preview.style.position = 'relative'
        // DSH scrolls [data-textpreview-body]. Shrink that flex item, so its
        // native scrollbar sits LEFT of the TOC instead of behind the overlay.
        const initialWidth = clampWidth(widthRef.current, preview)
        widthRef.current = initialWidth
        setWidth(initialWidth)
        body.style.marginRight = `${initialWidth}px`
        body.style.minWidth = '0'
        let currentItems = []
        const updateReading = () => setReading(readingState(body, currentItems))
        const refresh = () => {
          currentItems = headingsIn(preview)
          setItems(currentItems)
          updateReading()
        }
        refresh()
        body.addEventListener('scroll', updateReading, { passive: true })
        const observer = typeof MutationObserver === 'function' ? new MutationObserver(refresh) : null
        const markdown = preview.querySelector?.('[data-document-markdown]')
        observer?.observe(body, { childList: true, subtree: true, characterData: true })
        // Images and viewport changes affect both heading positions and total height.
        const onLayoutResize = () => {
          const next = clampWidth(widthRef.current, preview)
          if (next !== widthRef.current) {
            widthRef.current = next
            setWidth(next)
            body.style.marginRight = `${next}px`
          }
          updateReading()
        }
        const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(onLayoutResize) : null
        resize?.observe(preview)
        resize?.observe(body)
        if (markdown) resize?.observe(markdown)
        window.addEventListener?.('resize', onLayoutResize)
        return () => {
          observer?.disconnect()
          resize?.disconnect()
          body.removeEventListener('scroll', updateReading)
          window.removeEventListener?.('resize', onLayoutResize)
          dragRef.current = null
          body.style.marginRight = previousMargin
          body.style.minWidth = previousMinWidth
          preview.style.position = previousPosition
        }
      }, [visible, preview, absolutePath])

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
        h(TocPanel, {
          items, active: reading.active, progress: reading.progress, width,
          maxWidth: Math.max(MIN_PANEL_WIDTH, availableWidth(preview) - MIN_BODY_WIDTH),
          onResizeStart, onResizeMove, onResizeEnd, onResizeKey, onClose: toggle,
        }), preview,
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
