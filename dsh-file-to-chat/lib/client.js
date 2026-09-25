// DSH Web's client-module format: register a lazy factory, not an ESM import.
// React is supplied by the browser's platform module table.
window.__ModuleLoader__.load({
  id: 'dsh-file-to-chat',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { createPortal } = require('react-dom')
    const module = { exports: {} }

    // Insert a plain path (not an @file reference) into the conversation.
    // Never append a line suffix to the path itself.
    function pathForFile(path, kind = 'file') {
      if (typeof path !== 'string' || path.length === 0) return undefined
      const normalized = path.replace(/\\/g, '/')
      const target = kind === 'directory' && !normalized.endsWith('/') ? `${normalized}/` : normalized
      if (/[\u0000-\u001f\u007f-\u009f]/u.test(target)) return undefined
      return target
    }

    // Rendered Markdown and some text viewers do not expose source positions.
    // Match the selected text against the original file instead of counting
    // visual DOM lines, which can include hidden Markdown syntax.
    function normalizeSourceText(value) {
      return value
        .replace(/!?(\[)([^\]]+)\]\([^)]*\)/gu, '$2')
        .replace(/(`+)(.*?)\1/gu, '$2')
        .replace(/[*_~]/gu, '')
        .replace(/<[^>]+>/gu, '')
        .replace(/\\([\\`*_[\](){}/>#+.!-])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim()
    }

    async function sourceLinesForSelection(preview, range) {
      const pathNode = preview.querySelector('[data-textpreview-path]')
      const path = pathNode?.getAttribute('title') || pathNode?.textContent?.trim()
      const selectedText = normalizeSourceText(range.toString().replace(/\r\n/gu, '\n'))
      if (!path || !selectedText || typeof fetch !== 'function') return null
      try {
        const url = new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI)
        const response = await fetch(url.href)
        if (!response.ok) return null
        const sourceLines = (await response.text()).split(/\r?\n/u)
        const normalized = sourceLines.map(normalizeSourceText)
        for (let start = 0; start < normalized.length; start++) {
          let joined = ''
          for (let end = start; end < normalized.length && end < start + 32; end++) {
            joined = normalizeSourceText(`${joined} ${normalized[end]}`)
            if (joined === selectedText) return { start: start + 1, end: end + 1 }
            if (joined.length > selectedText.length + 128) break
          }
          if (normalized[start] && normalized[start].includes(selectedText)) return { start: start + 1, end: start + 1 }
        }
      } catch (_) {}
      return null
    }

    async function sourceLinesForMarkdownCode(preview, code, range) {
      const pathNode = preview.querySelector('[data-textpreview-path]')
      const path = pathNode?.getAttribute('title') || pathNode?.textContent?.trim()
      const rendered = code.querySelector('pre')?.textContent?.replace(/\r\n/gu, '\n')
      const selectedText = range.toString().replace(/\r\n/gu, '\n').trim()
      if (!path || !rendered || !selectedText) return null
      const renderedLines = rendered.replace(/\n$/u, '').split('\n')
      const selectedLines = selectedText.split('\n').map((line) => line.trim())
      let selectedOffset = -1
      for (let i = 0; i <= renderedLines.length - selectedLines.length; i++) {
        if (selectedLines.every((line, offset) => renderedLines[i + offset].trim() === line)) {
          selectedOffset = i
          break
        }
      }
      if (selectedOffset < 0) return null
      try {
        const url = new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI)
        const response = await fetch(url.href)
        if (!response.ok) return null
        const lines = (await response.text()).split(/\r?\n/u)
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
        return matches.length === 1 ? { start: matches[0] + selectedOffset, end: matches[0] + selectedOffset + selectedLines.length - 1 } : null
      } catch (_) {
        return null
      }
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
        return code ? sourceLinesForMarkdownCode(preview, code, range) : sourceLinesForSelection(preview, range)
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
        return sourceLinesForSelection(preview, range)
      }
    }

    function lineText(lines) {
      return lines ? ` 第 ${lines.start}${lines.end === lines.start ? '' : `–${lines.end}`} 行` : ''
    }

    // FilesBody has no per-row action slot in rc.1. Delegate contextmenu from
    // a session-scoped invisible contribution, without replacing built-in views.
    function FileTreeContextMenu({ inputActions }) {
      const [menu, setMenu] = useState(null)

      useEffect(() => {
        function showMenu(event, target, mention, lines, label, items = [{
          label: lines ? '加入选中行到对话框' : label,
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
            y: Math.max(8, Math.min(y, window.innerHeight - 78)),
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
            const items = [{ label: '加入到对话框', action: 'insert', text: `${mention} ` }]
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
          // Source lookup is asynchronous. If exact mapping fails, keep the
          // file action available without a misleading line suffix.
          Promise.resolve(selectedLines(preview)).then((lines) => {
            showMenu(event, preview, mention, lines, '加入到对话框')
          })
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
          display: 'block',
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
      }, item.label))), document.body)
    }

    module.exports.inject = ['slots']
    module.exports.apply = function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-file-to-chat-context-menu',
        }, FileTreeContextMenu),
      )
    }
    return module.exports
  },
})
