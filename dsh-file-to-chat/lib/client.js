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

    // Selection must stay inside ONE text document body. Prefer the preview's
    // absolute line markers; fall back to line breaks for other text renderers.
    function selectedLines(preview, selection = window.getSelection?.()) {
      const body = preview?.querySelector('[data-textpreview-body]')
      if (!body || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null

      const plainLines = [...body.querySelectorAll('[data-textpreview-line]')]
      const markedLines = plainLines.length ? [] : [...body.querySelectorAll('[data-code-line], [data-line-number]')]
      const code = plainLines.length === 0 && markedLines.length === 0
        ? body.querySelector('[data-code-preview] [data-code-block-content]')
        : null
      const codeLines = [...(code?.querySelectorAll('.line') ?? [])]
      const lineNodes = plainLines.length ? plainLines : markedLines.length ? markedLines : codeLines
      let start = Infinity
      let end = 0
      lineNodes.forEach((node, index) => {
        if (!range.intersectsNode(node)) return
        const explicit = node.getAttribute('data-textpreview-line')
          ?? node.getAttribute('data-code-line')
          ?? node.getAttribute('data-line-number')
        const number = explicit === null ? index + 1 : Number(explicit)
        if (Number.isSafeInteger(number) && number > 0) {
          start = Math.min(start, number)
          end = Math.max(end, number)
        }
      })
      if (end) return { start, end }

      // Some text renderers expose selectable text without per-line elements.
      // Count source newlines before and inside the selection in that case.
      try {
        const prefix = document.createRange()
        prefix.selectNodeContents(body)
        prefix.setEnd(range.startContainer, range.startOffset)
        const startLine = prefix.toString().split('\n').length
        const selectedText = range.toString()
        const endLine = (prefix.toString() + selectedText).split('\n').length
        return selectedText.length ? { start: startLine, end: Math.max(startLine, endLine) } : null
      } catch {
        return null
      }
    }

    function lineText(lines) {
      return lines ? ` 第 ${lines.start}${lines.end === lines.start ? '' : `–${lines.end}`} 行` : ''
    }

    function AddFileToChat({ absolutePath, inputActions }) {
      const pendingLines = useRef(null)
      const mention = pathForFile(absolutePath)
      const label = mention === undefined ? '文件路径无法安全引用' : '引用文件或选中行到对话'
      return h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        'data-file-to-chat': '',
        'data-file-to-chat-path': absolutePath,
        disabled: mention === undefined,
        // Capture BEFORE a toolbar click can collapse the browser text selection.
        onMouseDown(event) {
          pendingLines.current = selectedLines(event.currentTarget?.closest?.('[data-textpreview-url]'))
          event.preventDefault()
        },
        onClick(event) {
          if (mention === undefined) return
          const preview = event?.currentTarget?.closest?.('[data-textpreview-url]')
          const lines = selectedLines(preview) ?? pendingLines.current
          pendingLines.current = null
          const span = inputActions.captureInsertion()
          // Insertion is guarded by the draft revision; never overwrite a newer draft.
          inputActions.insertText(`${mention}${lineText(lines)} `, span)
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 4,
          border: 0,
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, currentColor)',
          cursor: mention === undefined ? 'not-allowed' : 'pointer',
        },
      }, h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', { d: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72' }),
      h('path', { d: 'M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72' }),
      ))
    }

    // FilesBody has no per-row action slot in rc.1. Delegate contextmenu from
    // a session-scoped invisible contribution, without replacing built-in views.
    function FileTreeContextMenu({ inputActions }) {
      const [menu, setMenu] = useState(null)

      useEffect(() => {
        function onContextMenu(event) {
          if (event.defaultPrevented) return
          const row = event.target?.closest?.('li[data-files-entry][data-files-path]')
          const kind = row?.getAttribute('data-files-entry')
          const inTree = row?.closest('[data-files-state="tree"]')
          const preview = event.target?.closest?.('[data-textpreview-url]')
          let mention
          let lines = null
          let label = '加入到对话框'
          let target = row
          if (inTree && (kind === 'file' || kind === 'directory')) {
            mention = pathForFile(row.getAttribute('data-files-path'), kind)
          } else if (preview) {
            lines = selectedLines(preview)
            if (lines === null) return // Do not replace the ordinary text context menu.
            const button = preview.querySelector('[data-file-to-chat-path]')
            mention = pathForFile(button?.getAttribute('data-file-to-chat-path'))
            label = '引用选中行到对话框'
            target = preview
          }
          if (mention === undefined) return
          event.preventDefault()
          event.stopPropagation()
          const rect = target.getBoundingClientRect()
          const x = event.clientX || rect.left
          const y = event.clientY || rect.bottom
          const reference = `${mention}${lineText(lines)}`
          const items = [{
            label: lines ? '加入选中行到对话框' : label,
            action: 'insert',
            text: `${reference} `,
          }]
          // Let independent plugins contribute to the same file-tree menu.
          // A separate contextmenu handler would race this capture listener.
          if (inTree && window.CustomEvent && document.dispatchEvent) {
            document.dispatchEvent(new window.CustomEvent('dsh-file-tree-menu', {
              detail: { event, row, kind, items },
            }))
          }
          setMenu({
            label: lines ? '加入选中行到对话框' : label,
            items,
            span: inputActions.captureInsertion(),
            x: Math.max(8, Math.min(x, window.innerWidth - 220)),
            y: Math.max(8, Math.min(y, window.innerHeight - 78)),
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
      // The slot declaration can arrive after this plugin: inject waits for it.
      ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'dsh-file-to-chat',
        }, AddFileToChat),
      )
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
