// DSH Web's client-module format: register a lazy factory, not an ESM import.
// React is supplied by the browser's platform module table.
window.__ModuleLoader__.load({
  id: 'dsh-file-to-chat',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { createPortal } = require('react-dom')
    const module = { exports: {} }
    const markdownSources = new WeakMap()
    const MAX_SOURCE_LENGTH = 2 * 1024 * 1024
    const PRELOAD_DELAY = 100

    // Prefetch on opening/reloading a preview, NEVER during right-click. The
    // toolbar action slot is a list and does not replace the built-in renderer.
    function MarkdownSourceCache({ absolutePath }) {
      const ref = useRef(null)
      useEffect(() => {
        if (!/\.(?:md|markdown)$/iu.test(absolutePath || '')) return undefined
        const preview = ref.current?.closest?.('[data-textpreview-url]')
        if (!preview) return undefined
        const body = preview.querySelector('[data-textpreview-body]')
        if (!body) return undefined
        let active = true
        let controller = null
        let timer = null
        let sequence = 0
        let lastMarkdown = body.querySelector('[data-document-markdown]')
        let lastContent = lastMarkdown?.textContent
        const load = () => {
          const revision = ++sequence
          controller?.abort()
          controller = typeof AbortController === 'function' ? new AbortController() : null
          markdownSources.delete(preview)
          const path = preview.querySelector('[data-textpreview-path]')?.getAttribute('title') || absolutePath
          if (!path || typeof fetch !== 'function') return
          try {
            const url = new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI)
            fetch(url.href, controller ? { signal: controller.signal } : undefined).then(async (response) => {
              if (!response.ok || Number(response.headers?.get?.('content-length')) > MAX_SOURCE_LENGTH) return
              const text = await response.text()
              if (active && revision === sequence && text.length <= MAX_SOURCE_LENGTH) {
                markdownSources.set(preview, { path, text })
              }
            }).catch(() => {})
          } catch (_) { /* source unavailable: never guess a line */ }
        }
        const schedule = () => {
          // A preview re-render can replace text without changing its path.
          // Invalidate immediately; delayed reload coalesces streaming pages.
          markdownSources.delete(preview)
          ++sequence
          controller?.abort()
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => { timer = null; load() }, PRELOAD_DELAY)
        }
        load()
        // The preview can receive more pages or reload without changing path.
        // Only content mutations invalidate; the toolbar lives outside body.
        const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
          const next = body.querySelector('[data-document-markdown]')
          const content = next?.textContent
          if (next !== lastMarkdown || content !== lastContent) {
            lastMarkdown = next
            lastContent = content
            schedule()
          }
        }) : null
        observer?.observe(body, { childList: true, characterData: true, subtree: true })
        return () => {
          active = false
          ++sequence
          if (timer !== null) clearTimeout(timer)
          controller?.abort()
          observer?.disconnect()
          markdownSources.delete(preview)
        }
      }, [absolutePath])
      return /\.(?:md|markdown)$/iu.test(absolutePath || '')
        ? h('span', { ref, hidden: true, 'data-file-to-chat-source': '' }) : null
    }

    // Insert a plain path (not an @file reference) into the conversation.
    // Never append a line suffix to the path itself.
    function pathForFile(path, kind = 'file') {
      if (typeof path !== 'string' || path.length === 0) return undefined
      const normalized = path.replace(/\\/g, '/')
      const target = kind === 'directory' && !normalized.endsWith('/') ? `${normalized}/` : normalized
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(target)) return undefined
      return target
    }

    // A visible block is matched only against a UNIQUE complete source span.
    // This conservative subset covers ordinary headings, paragraphs and list
    // items; tables, footnotes or repeated text fall back to a path, not a guess.
    function normalizeSourceText(value) {
      return value
        .replace(/^(?: {0,3}#{1,6}[ \t]+|[ \t]*>[ \t]?|[ \t]*[-+*][ \t]+|[ \t]*\d+[.)][ \t]+)/gmu, '')
        .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, '$1')
        .replace(/(`+)(.*?)\1/gu, '$2')
        .replace(/[*_~]/gu, '')
        .replace(/<[^>]+>/gu, '')
        .replace(/\\([\\`*_[\](){}/>#+.!-])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim()
    }

    function sourceFor(preview) {
      const cached = markdownSources.get(preview)
      const pathNode = preview.querySelector('[data-textpreview-path]')
      const path = pathNode?.getAttribute('title') || pathNode?.textContent?.trim()
      return cached && cached.path === path ? cached.text : null
    }

    function blockFor(node, markdown) {
      const element = node?.nodeType === 3 ? node.parentElement : node
      const block = element?.closest?.('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th')
      return block && markdown.contains(block) ? block : null
    }

    function sourceBlock(source, block) {
      const text = normalizeSourceText(block.textContent || '')
      if (!text || text.length < 3 || /^(?:td|th)$/iu.test(block.tagName || '')) return null
      const lines = source.split(/\r\n|\r|\n/u)
      const matches = []
      for (let start = 0; start < lines.length; start++) {
        if (!normalizeSourceText(lines[start])) continue
        let chunk = ''
        for (let end = start; end < lines.length && end < start + 128; end++) {
          chunk += `${end === start ? '' : '\n'}${lines[end]}`
          const candidate = normalizeSourceText(chunk)
          if (candidate === text) {
            matches.push({ start: start + 1, end: end + 1 })
            break
          }
          if (candidate.length > text.length + 128) break
        }
        if (matches.length > 1) return null
      }
      return matches.length === 1 ? matches[0] : null
    }

    function sourceLinesForSelection(preview, range, markdown) {
      const source = sourceFor(preview)
      if (source === null || !range.toString().trim()) return null
      const first = blockFor(range.startContainer, markdown)
      const last = blockFor(range.endContainer, markdown)
      if (!first || !last) return null
      const start = sourceBlock(source, first)
      const end = first === last ? start : sourceBlock(source, last)
      if (!start || !end || start.start > end.end) return null
      return { start: start.start, end: end.end }
    }

    function sourceLinesForMarkdownCode(preview, code, range) {
      const source = sourceFor(preview)
      const rendered = code.querySelector('pre')?.textContent?.replace(/\r\n/gu, '\n')
      const selectedText = range.toString().replace(/\r\n/gu, '\n').trim()
      if (source === null || !rendered || !selectedText) return null
      const renderedLines = rendered.replace(/\n$/u, '').split('\n')
      const selectedLines = selectedText.split('\n').map((line) => line.trim())
      const offsets = []
      for (let i = 0; i <= renderedLines.length - selectedLines.length; i++) {
        if (selectedLines.every((line, offset) => renderedLines[i + offset].trim() === line)) offsets.push(i)
      }
      if (offsets.length !== 1) return null
      const lines = source.split(/\r\n|\r|\n/u)
      const matches = []
      for (let i = 0; i < lines.length; i++) {
        const open = /^( {0,3})(`{3,}|~{3,})[^\n]*$/u.exec(lines[i])
        if (!open) continue
        const close = new RegExp(`^ {0,3}${open[2][0]}{${open[2].length},}\\s*$`, 'u')
        let end = i + 1
        while (end < lines.length && !close.test(lines[end])) end++
        if (end < lines.length) {
          const body = lines.slice(i + 1, end).map((line) => line.slice(open[1].length).trim())
          if (body.length === renderedLines.length && body.every((line, index) => line === renderedLines[index].trim())) matches.push(i + 2)
        }
        i = end
      }
      return matches.length === 1 ? { start: matches[0] + offsets[0], end: matches[0] + offsets[0] + selectedLines.length - 1 } : null
    }

    function selectedLines(preview, selection = window.getSelection?.()) {
      const body = preview?.querySelector('[data-textpreview-body]')
      if (!body || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null
      const lineNumber = (node) => {
        for (const name of ['data-textpreview-line', 'data-source-line', 'data-line', 'data-code-line', 'data-line-number']) {
          const value = Number(node.getAttribute?.(name))
          if (Number.isSafeInteger(value) && value > 0) return value
        }
        return null
      }
      const selectedRange = (nodes) => {
        let start = Infinity
        let end = 0
        nodes.forEach((node) => {
          if (!range.intersectsNode(node)) return
          const number = lineNumber(node)
          if (number !== null) { start = Math.min(start, number); end = Math.max(end, number) }
        })
        return end ? { start, end } : null
      }
      const markdown = body.querySelector('[data-document-markdown]')
      if (markdown) {
        const code = [...markdown.querySelectorAll('[data-code-block-content]')]
          .find((node) => node.contains(range.startContainer) || node.contains(range.endContainer) || range.intersectsNode(node))
        // Markdown prose has no line metadata; map its selected text to source.
        return code ? sourceLinesForMarkdownCode(preview, code, range) : sourceLinesForSelection(preview, range, markdown)
      }
      const code = body.querySelector('[data-code-preview] [data-code-block-content]')
      const codeNodes = [...(code?.querySelectorAll('.line') ?? [])]
      if (codeNodes.some((node) => range.intersectsNode(node))) {
        const selected = codeNodes.flatMap((node, index) => range.intersectsNode(node) ? [index + 1] : [])
        return { start: selected[0], end: selected[selected.length - 1] }
      }
      const plainSelection = selectedRange([...body.querySelectorAll('[data-textpreview-line]')])
      if (plainSelection) return plainSelection
      try {
        const prefix = document.createRange()
        prefix.selectNodeContents(body)
        prefix.setEnd(range.startContainer, range.startOffset)
        const selectedText = range.toString()
        const start = prefix.toString().split('\n').length
        const end = (prefix.toString() + selectedText).split('\n').length
        return selectedText ? { start, end: Math.max(start, end) } : null
      } catch {
        return null
      }
    }

    function lineText(lines) {
      return lines ? ` 第 ${lines.start}${lines.end === lines.start ? '' : `–${lines.end}`} 行` : ''
    }

    // Small line icons keep the shared menu consistent without loading icon
    // fonts or depending on another plugin's runtime module.
    const menuIcons = {
      insert: 'M8 10h8m-8 4h5M5 20l3.5-3H17a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v10a3 3 0 0 0 1 3Z',
      createFile: 'M6 3h8l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 0v5h4M11 12v6m-3-3h6',
      createDirectory: 'M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2M3 7h18l-1.5 12a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2L3 7Zm9 4v6m-3-3h6',
      delete: 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6',
      rename: 'M4 20h4l11-11-4-4L4 16v4Zm9-13 4 4M4 20h16',
      upload: 'M12 16V3m-4 4 4-4 4 4M4 17v3h16v-3',
      paste: 'M8 4h2a2 2 0 0 1 4 0h2v3H8V4ZM6 7H5v14h14V7h-1',
    }
    function menuIcon(kind) {
      const graphic = menuIcons[kind]
      return graphic && h('svg', {
        'aria-hidden': true, viewBox: '0 0 24 24', width: 16, height: 16,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { flex: '0 0 16px', color: 'var(--dsw-alias-label-secondary, #666)' },
      }, h('path', { d: graphic }))
    }

    // FilesBody has no per-row action slot in rc.1. Delegate contextmenu from
    // a session-scoped invisible contribution, without replacing built-in views.
    function FileTreeContextMenu({ inputActions }) {
      const [menu, setMenu] = useState(null)

      useEffect(() => {
        function showMenu(event, target, mention, lines, label, items = [{
          label: lines ? '加入选中行到对话框' : label,
          icon: 'insert',
          action: 'insert',
          text: `${mention}${lineText(lines)} `,
        }]) {
          if (mention === undefined) return
          event.preventDefault()
          event.stopPropagation()
          const rect = target.getBoundingClientRect()
          const x = event.clientX || rect.left
          const y = event.clientY || rect.bottom
          setMenu({
            label: lines ? '加入选中行到对话框' : label,
            items,
            span: inputActions.captureInsertion(),
            x: Math.max(8, Math.min(x, window.innerWidth - 220)),
            y: Math.max(8, Math.min(y, window.innerHeight - (items.length * 27 + 12))),
          })
        }

        function previewForTarget(target) {
          const direct = target?.closest?.('[data-textpreview-url]')
          if (direct) return direct
          const body = target?.closest?.('[data-textpreview-body]')
          return body?.closest?.('[data-textpreview-url]') ?? body?.parentElement ?? null
        }

        function selectionIsInside(preview) {
          const selection = window.getSelection?.()
          const body = preview?.querySelector('[data-textpreview-body]')
          if (!body || !selection || selection.isCollapsed || selection.rangeCount === 0) return false
          const range = selection.getRangeAt(0)
          return body.contains(range.startContainer) && body.contains(range.endContainer)
        }

        function onContextMenu(event) {
          if (event.defaultPrevented) return
          const row = event.target?.closest?.('li[data-files-entry][data-files-path]')
          const kind = row?.getAttribute('data-files-entry')
          const inTree = row?.closest('[data-files-state="tree"]')
          if (inTree && (kind === 'file' || kind === 'directory')) {
            const mention = pathForFile(row.getAttribute('data-files-path'), kind)
            if (mention === undefined) return
            const items = [{ label: '加入到对话框', icon: 'insert', action: 'insert', text: `${mention} ` }]
            if (window.CustomEvent && document.dispatchEvent) {
              document.dispatchEvent(new window.CustomEvent('dsh-file-tree-menu', { detail: { event, row, kind, items } }))
            }
            showMenu(event, row, mention, null, '加入到对话框', items)
            return
          }

          const preview = previewForTarget(event.target)
          if (!preview) return
          const titleNode = preview.querySelector('[data-textpreview-path]')
          const mention = pathForFile(titleNode?.getAttribute('title') || titleNode?.textContent?.trim())
          if (mention === undefined) return
          if (!selectionIsInside(preview)) return
          event.preventDefault()
          event.stopPropagation()
          // Synchronous: no fetch or pending promise on right-click.
          // Unready or ambiguous source gets a path without invented lines.
          showMenu(event, preview, mention, selectedLines(preview), '加入到对话框')
        }
        document.addEventListener('contextmenu', onContextMenu, true)
        return () => document.removeEventListener('contextmenu', onContextMenu, true)
      }, [inputActions])

      useEffect(() => {
        if (menu === null) return
        function onPointerDown(event) {
          if (!event.target?.closest?.('[data-file-to-chat-menu]')) setMenu(null)
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') setMenu(null)
        }
        function onScroll() { setMenu(null) }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [menu])

      if (menu === null) return null
      return createPortal(h('div', {
        role: 'menu',
        'aria-label': menu.label,
        'data-file-to-chat-menu': '',
        style: {
          position: 'fixed',
          top: menu.y,
          left: menu.x,
          zIndex: 2147483647,
          padding: 3,
          minWidth: 148,
          background: 'var(--dsw-alias-bg-layer-2, #fff)',
          color: 'var(--dsw-alias-label-primary, #222)',
          border: '1px solid var(--dsw-alias-border-l1, #ddd)',
          borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0, 0, 0, .14)',
          fontSize: 12,
          lineHeight: '16px',
        },
      }, ...menu.items.map((item, index) => h('button', {
        type: 'button',
        role: 'menuitem',
        autoFocus: index === 0,
        'data-file-to-chat-menu-item': '',
        onMouseDown(event) { event.preventDefault() },
        async onClick() {
          if (typeof item.onClick === 'function') await item.onClick()
          else inputActions.insertText(item.text, menu.span)
          setMenu(null)
        },
        onMouseEnter(event) {
          event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, #eee)'
        },
        onMouseLeave(event) { event.currentTarget.style.background = 'transparent' },
        style: {
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '5px 8px',
          textAlign: 'left',
          background: 'transparent',
          color: 'inherit',
          border: 0,
          borderRadius: 4,
          cursor: 'pointer',
          font: 'inherit',
        },
      }, menuIcon(item.icon), h('span', null, item.label)))), document.body)
    }

    module.exports.inject = ['slots']
    module.exports.apply = function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-file-to-chat-context-menu',
        }, FileTreeContextMenu),
      )
      ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'dsh-file-to-chat-source-cache',
        }, MarkdownSourceCache),
      )
    }
    return module.exports
  },
})
