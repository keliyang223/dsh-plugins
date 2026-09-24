// DSH Web client modules register lazy factories; React comes from the platform table.
window.__ModuleLoader__.load({
  id: 'dsh-file-write',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { createPortal } = require('react-dom')
    const module = { exports: {} }
    const EDITOR_ID = 'dsh-file-write/editor'
    const MARKDOWN_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'
    const drafts = new Map()
    const inlineMarkdown = new Map()
    const inlineListeners = new Set()
    const inlineKey = (sessionId, path) => JSON.stringify([sessionId, path])
    function toggleMarkdown(sessionId, path) {
      if (!sessionId || !path) return
      const key = inlineKey(sessionId, path)
      if (inlineMarkdown.has(key)) inlineMarkdown.delete(key)
      else inlineMarkdown.set(key, true)
      for (const listener of inlineListeners) listener()
    }
    const editorStyle = {
      boxSizing: 'border-box', width: '100%', minHeight: 240, flex: '1 1 auto', resize: 'none',
      padding: 12, border: 0, outline: 'none', background: 'transparent', color: 'inherit',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre', tabSize: 2,
    }
    const buttonStyle = {
      cursor: 'pointer', padding: '5px 10px', borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1, #ccc)',
      background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'inherit',
    }

    function failureMessage(error) {
      const code = error?.code
      if (code && /conflict|version|changed|stale/u.test(code)) return '文件已在别处更改。保留了你的草稿；请复制草稿、重新加载文件后再合并。'
      return error?.message || '操作失败，请重试。'
    }
    function isConflict(error) {
      return /conflict|version|changed|stale/u.test(error?.code || '')
    }
    function valueOf(result) {
      if (result?.ok === false) throw result.error || new Error('操作失败')
      return result?.ok === true ? result.value : result
    }
    function Editor({ resourceAddress, content, useResource, useTabInfo, fileWrite, workspaceFiles, inline = false, onSaved }) {
      const contentValue = content || { kind: 'text', text: '', pages: [], eof: true }
      const metadata = (typeof useResource === 'function' ? useResource(resourceAddress || undefined) : null) || { status: 'none', value: null }
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : { tab: {} }
      const { tab = {} } = tabInfo || {}
      const safeSignal = tab.signal || { aborted: false, throwIfAborted() {} }
      const effectiveAddress = resourceAddress || tab.contentId || tab.resourceAddress
      const parsedSession = typeof effectiveAddress === 'string' && /^dsh-resource:\/\/file\/session\/([^/]+)\/(.+)/u.exec(effectiveAddress)
      let fileSession = null
      let filePath = null
      try {
        if (parsedSession) {
          fileSession = decodeURIComponent(parsedSession[1])
          filePath = parsedSession[2].split('/').map(decodeURIComponent).join('/')
        }
      } catch { /* An invalid file address cannot be edited. */ }
      const observedVersion = metadata.status === 'live' ? metadata.value?.version : undefined
      const revision = contentValue.kind === 'renderer' ? contentValue.revision : undefined
      const resourceVersion = metadata.value?.version
      const [draft, setDraft] = useState(() => drafts.get(effectiveAddress) || null)
      const [loading, setLoading] = useState(true)
      const [readError, setReadError] = useState('')
      const draftRef = useRef(draft)
      draftRef.current = draft
      const activeRef = useRef(true)
      useEffect(() => {
        activeRef.current = true
        return () => { activeRef.current = false }
      }, [])
      function update(next) {
        draftRef.current = next
        drafts.set(effectiveAddress, next)
        if (activeRef.current) setDraft(next)
      }
      // Read bytes and version together from one Host snapshot. The document
      // preview's paged text and resource metadata are independent observations;
      // they MUST NOT be paired to form a CAS save token.
      useEffect(() => {
        if ((!inline && contentValue.kind !== 'renderer') || !fileSession || !filePath || !workspaceFiles?.readBytes) {
          setLoading(false)
          setReadError('无法读取当前文件；请使用工作区文件树打开并重试。')
          return
        }
        const controller = new AbortController()
        setLoading(true)
        setReadError('')
        Promise.resolve().then(() => workspaceFiles.readBytes(fileSession, filePath, {}, controller.signal)).then((response) => {
          if (controller.signal.aborted || safeSignal.aborted) return
          try {
            const result = valueOf(response)
            const raw = result?.data
            const bytes = raw instanceof Uint8Array ? raw :
              raw instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && raw instanceof SharedArrayBuffer) ? new Uint8Array(raw) : null
            if (!bytes || result.offset !== 0 || result.eof !== true ||
              result.bytes !== bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024)
              throw new Error('文件超过 2 MiB 编辑限制，或读取结果不完整。')
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            if (text.includes('\u0000')) throw new Error('无法编辑二进制文件。')
            if (typeof result.version !== 'string' || !result.version || !result.absolutePath)
              throw new Error('文件版本或路径不可用。')
            const previous = draftRef.current
            if (!previous) {
              update({ text, baseText: text, version: result.version, path: result.absolutePath,
                conflict: false, error: '', saving: false })
            } else if (previous.version !== result.version || previous.path !== result.absolutePath) {
              if (previous.text !== previous.baseText) {
                update({ ...previous, conflict: true, error: '文件版本已更改。草稿已保留；请手动合并。' })
              } else {
                update({ text, baseText: text, version: result.version, path: result.absolutePath,
                  conflict: false, error: '', saving: false })
              }
            }
            setLoading(false)
            if (contentValue.kind === 'renderer') contentValue.loaded(result.version)
          } catch (error) {
            setReadError(failureMessage(error))
            setLoading(false)
            if (contentValue.kind === 'renderer') contentValue.failed()
          }
        }, (error) => {
          if (controller.signal.aborted || safeSignal.aborted) return
          setReadError(failureMessage(error))
          setLoading(false)
          if (content.kind === 'renderer') content.failed()
        })
        return () => controller.abort()
      }, [revision, effectiveAddress, fileSession, filePath, workspaceFiles, safeSignal, inline, contentValue.kind])
      // Resource observations are only a conflict signal; never a save token.
      // A metadata frame from before our initial byte read can be stale, so
      // only compare versions after seeing the matching version in the stream.
      const sawMatchingResource = useRef(false)
      if (resourceVersion === draft?.version && draft?.version) sawMatchingResource.current = true
      useEffect(() => {
        const before = draftRef.current
        if (!before || !sawMatchingResource.current || !observedVersion || before.saving || before.conflict ||
          observedVersion === before.version || observedVersion === before.priorVersion) return
        update({ ...before, conflict: true, error: '文件在外部发生更改。草稿已保留，请重新加载并合并。' })
      }, [observedVersion, draft?.version, draft?.priorVersion, draft?.saving])
      const ready = !!draft && !loading && !readError && !!fileSession && !safeSignal.aborted
      const dirty = !!draft && draft.text !== draft.baseText
      const blocked = !ready || draft.conflict || draft.saving || !dirty || !fileWrite?.save
      async function save() {
        const before = draftRef.current
        if (!ready || !before || before.saving || before.conflict ||
          before.text === before.baseText || !fileWrite?.save || safeSignal.aborted) return
        if (sawMatchingResource.current && observedVersion && observedVersion !== before.version && observedVersion !== before.priorVersion) {
          update({ ...before, conflict: true, error: '文件版本已更改；请先重新加载并合并。' })
          return
        }
        const text = before.text
        update({ ...before, saving: true, error: '' })
        try {
          const result = valueOf(await fileWrite.save(fileSession, before.path, text, before.version, safeSignal))
          if (safeSignal.aborted) return
          if (typeof result?.version !== 'string' || !result.version) throw new Error('保存响应缺少文件版本')
          const latest = draftRef.current
          if (latest?.path !== before.path) return
          update({ ...latest, baseText: text, version: result.version, priorVersion: before.version,
            saving: false, conflict: false, error: '' })
          onSaved?.()
        } catch (error) {
          if (safeSignal.aborted) return
          const latest = draftRef.current
          if (latest?.path !== before.path) return
          update({ ...latest, saving: false, conflict: isConflict(error), error: failureMessage(error) })
        }
      }
      return h('section', {
        'data-file-write-editor': '', style: {
          display: 'flex', flexDirection: 'column', minHeight: 280, height: '100%', color: 'var(--dsw-alias-label-primary, #222)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' } },
        h('strong', { style: { fontSize: 12 } }, inline ? '编辑 Markdown' : '编辑源文件'),
        h('span', { 'data-file-write-status': '', role: 'status', style: { fontSize: 12, flex: 1 } },
          readError || (!ready ? '正在完整读取文件…' : draft?.conflict ? '版本冲突' : draft?.saving ? '正在保存…' : dirty ? '未保存' : '已保存')),
        h('button', { type: 'button', style: buttonStyle, disabled: blocked, onClick: save, 'data-file-write-save': '' }, '保存'),
        inline && h('button', { type: 'button', style: buttonStyle, onClick: () => {
          if (dirty && !window.confirm('修改尚未保存，返回预览后草稿会暂存。确认返回？')) return
          toggleMarkdown(fileSession, filePath)
        }, 'data-file-write-markdown-close': '' }, '返回预览')),
      draft?.error && h('p', { role: 'alert', style: { color: '#c44', margin: '0 12px 8px' } }, draft.error),
      draft?.conflict && h('p', { style: { margin: '0 12px 8px', fontSize: 12 } },
        '草稿仍在编辑框中。请复制草稿，然后使用上方预览工具栏的重新加载按钮；不会强制覆盖远端文件。'),
      h('textarea', {
        'aria-label': '编辑文件内容', 'data-file-write-textarea': '', spellCheck: false,
        style: editorStyle, disabled: !ready,
        value: draft?.text || '',
        onChange(event) {
          const current = draftRef.current
          if (current && ready) update({ ...current, text: event.target.value, error: current.conflict ? current.error : '' })
        },
      }))
    }

    function MarkdownInlineAction({ useTabInfo, content, fileWrite, workspaceFiles }) {
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : { tab: {} }
      const { tab = {} } = tabInfo || {}
      const [enabled, setEnabled] = useState(false)
      const [host, setHost] = useState(null)
      const hostRef = useRef(null)
      const address = tab?.contentId || tab?.resourceAddress
      const match = typeof address === 'string' && /^dsh-resource:\/\/file\/session\/([^/]+)\/(.+)/u.exec(address)
      let sessionId = null
      let path = null
      try {
        if (match) {
          sessionId = decodeURIComponent(match[1])
          path = match[2].split('/').map(decodeURIComponent).join('/')
        }
      } catch { /* Invalid resource addresses are not writable. */ }
      const key = inlineKey(sessionId, path)
      useEffect(() => {
        const update = () => setEnabled(inlineMarkdown.has(key))
        inlineListeners.add(update)
        update()
        return () => { inlineListeners.delete(update) }
      }, [key])
      useEffect(() => {
        if (!enabled || !address) return
        const preview = Array.from(document.querySelectorAll('[data-textpreview-url]'))
          .find((node) => node.getAttribute('data-textpreview-url') === address)
        const body = preview?.querySelector('[data-textpreview-body]')
        if (!body) return
        const overlay = document.createElement('div')
        overlay.setAttribute('data-file-write-markdown-overlay', '')
        overlay.style.cssText = 'position:sticky;top:0;left:0;width:100%;height:100%;min-height:280px;z-index:2;background:var(--dsw-alias-bg-layer-2,#fff);overflow:auto;'
        const previous = body.style.position
        body.style.position = 'relative'
        body.appendChild(overlay)
        body.scrollTop = 0
        hostRef.current = overlay
        setHost(overlay)
        return () => {
          hostRef.current = null
          overlay.remove()
          body.style.position = previous
        }
      }, [enabled, address])
      if (!match || !sessionId || !path || content?.kind !== 'text') return null
      return h('span', { 'data-file-write-markdown-action': '', style: { display: 'inline-flex' } },
        h('button', { type: 'button', style: buttonStyle, 'data-file-write-markdown-toggle': '',
          onClick: () => {
            const draft = drafts.get(address)
            if (enabled && draft?.text !== draft?.baseText &&
              !window.confirm('修改尚未保存，返回预览后草稿会暂存。确认返回？')) return
            toggleMarkdown(sessionId, path)
          } }, enabled ? '预览' : '编辑 Markdown'),
        enabled && host && hostRef.current === host && createPortal(h(Editor, { resourceAddress: address,
          content, useResource: () => ({ status: 'none', value: null }), useTabInfo,
          fileWrite, workspaceFiles, inline: true, onSaved: () => {
            const preview = Array.from(document.querySelectorAll('[data-textpreview-url]'))
              .find((node) => node.getAttribute('data-textpreview-url') === address)
            preview?.querySelector('[data-textpreview-tool="reload"]')?.click()
            toggleMarkdown(sessionId, path)
          } }), host))
    }

    function treeTarget(event) {
      const row = event.target?.closest?.('li[data-files-entry][data-files-path]')
      const tree = row?.closest?.('[data-files-state="tree"]') || event.target?.closest?.('[data-files-state="tree"]')
      if (!tree) return null
      const kind = row?.getAttribute('data-files-entry')
      if (row && kind !== 'directory' && kind !== 'file') return null
      const path = row?.getAttribute('data-files-path') || tree.getAttribute('data-files-root')
      if (!path) return null
      return { path, kind: kind || 'root', tree }
    }
    function basenameValid(name) {
      return name !== '' && name !== '.' && name !== '..' && name.trim() === name &&
        !/[/\\\u0000-\u001f\u007f]/u.test(name)
    }
    function FileTreeCreate({ session, fileWrite }) {
      const sessionId = session?.id || session?.sessionId || session?.header?.id || session?.session?.id || session?.session?.sessionId || session?.session?.header?.id
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const [name, setName] = useState('')
      const [error, setError] = useState('')
      const [pending, setPending] = useState(false)
      const bridgeSeen = useRef(new WeakSet())
      const abortRef = useRef(null)
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false; abortRef.current?.abort() }, [])
      function openCreate(directory) {
        setMenu(null)
        setDialog(directory)
        setName('')
        setError('')
      }
      function openDelete(target) {
        setMenu(null)
        setDeleting(target)
        setError('')
      }
      useEffect(() => {
        function onBridge(e) {
          const detail = e.detail
          const target = detail?.event && treeTarget(detail.event)
          if (!target || !Array.isArray(detail.items)) return
          bridgeSeen.current.add(detail.event)
          if (target.kind === 'directory') {
            detail.items.push({ label: '新建文件', onClick: () => openCreate(target.path) })
          }
          if (target.kind === 'directory' || target.kind === 'file') {
            detail.items.push({ label: '删除文件', onClick: () => openDelete(target) })
          }
        }
        function onContextMenu(event) {
          const target = treeTarget(event)
          if (!target || target.kind === 'root' || bridgeSeen.current.has(event) || event.defaultPrevented) return
          // The other plugin intercepts during capture and stops propagation;
          // bubble only runs when no other menu handled this tree event.
          event.preventDefault()
          setMenu({ target, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 170)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 85)) })
        }
        document.addEventListener('dsh-file-tree-menu', onBridge)
        document.addEventListener('contextmenu', onContextMenu)
        return () => {
          document.removeEventListener('dsh-file-tree-menu', onBridge)
          document.removeEventListener('contextmenu', onContextMenu)
        }
      }, [])
      useEffect(() => {
        if (!menu) return
        const dismiss = (event) => { if (!event.target?.closest?.('[data-file-write-menu]')) setMenu(null) }
        const escape = (event) => { if (event.key === 'Escape') setMenu(null) }
        document.addEventListener('pointerdown', dismiss, true)
        document.addEventListener('keydown', escape, true)
        return () => {
          document.removeEventListener('pointerdown', dismiss, true)
          document.removeEventListener('keydown', escape, true)
        }
      }, [menu])
      async function create(event) {
        event.preventDefault()
        if (pending) return
        if (!basenameValid(name)) { setError('请输入有效文件名（不能包含路径分隔符）。'); return }
        if (!fileWrite?.create || !sessionId) { setError('当前会话的文件写入服务不可用。'); return }
        setPending(true)
        setError('')
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const result = valueOf(await fileWrite.create(sessionId, dialog, name, '', controller.signal))
          if (!mounted.current || controller.signal.aborted) return
          if (!result?.absolutePath || !result?.version) throw new Error('创建响应缺少路径或版本')
          setDialog(null)
          // The built-in tree reload button uses its own directory watcher; request
          // a refresh as a best effort if the current tree is still on screen.
          document.querySelector('[data-files-state="tree"] [data-files-reload]')?.click()
        } catch (failure) {
          if (mounted.current && !controller.signal.aborted) setError(failureMessage(failure))
        } finally {
          if (mounted.current) setPending(false)
          if (abortRef.current === controller) abortRef.current = null
        }
      }
      async function removeEntry(event) {
        event.preventDefault()
        if (pending || !deleting) return
        if (!fileWrite?.delete || !sessionId) { setError('当前会话的文件删除服务不可用。'); return }
        setPending(true)
        setError('')
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const result = valueOf(await fileWrite.delete(sessionId, deleting.path, deleting.kind, controller.signal))
          if (!mounted.current || controller.signal.aborted) return
          if (typeof result?.absolutePath !== 'string' || result.kind !== deleting.kind) {
            throw new Error('删除响应与目标不匹配')
          }
          setDeleting(null)
          document.querySelector('[data-files-state="tree"] [data-files-reload]')?.click()
        } catch (failure) {
          if (mounted.current && !controller.signal.aborted) setError(failure?.message || '删除失败，请重试。')
        } finally {
          if (mounted.current) setPending(false)
          if (abortRef.current === controller) abortRef.current = null
        }
      }
      return h('span', { 'data-file-write-tree-contribution': '', style: { display: 'none' } },
        menu && createPortal(h('div', {
          role: 'menu', 'aria-label': '文件操作', 'data-file-write-menu': '',
          style: { position: 'fixed', zIndex: 2147483647, top: menu.y, left: menu.x,
            padding: 4, background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
            border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: 6, boxShadow: '0 4px 12px #0003' },
        }, menu.target.kind === 'directory' && h('button', {
          type: 'button', role: 'menuitem', autoFocus: true, style: buttonStyle,
          onClick: () => openCreate(menu.target.path) }, '新建文件'),
        (menu.target.kind === 'directory' || menu.target.kind === 'file') && h('button', {
          type: 'button', role: 'menuitem', autoFocus: menu.target.kind === 'file', style: buttonStyle,
          onClick: () => openDelete(menu.target) }, '删除文件')), document.body),
        dialog !== null && createPortal(h('div', {
          role: 'presentation', 'data-file-write-dialog': '',
          style: { position: 'fixed', inset: 0, zIndex: 2147483647, background: '#0008', display: 'grid', placeItems: 'center' },
        }, h('form', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '新建文件', onSubmit: create,
          style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, width: 'min(360px, 90vw)',
            background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', borderRadius: 8 } },
        h('strong', null, '新建文件'),
        h('small', { title: dialog, style: { overflowWrap: 'anywhere' } }, `目录：${dialog}`),
        h('label', null, '文件名 ', h('input', { autoFocus: true, required: true, value: name,
          disabled: pending, onChange: (event) => setName(event.target.value), 'data-file-write-name': '',
          style: { boxSizing: 'border-box', width: '100%', padding: 6 } })),
        error && h('span', { role: 'alert', style: { color: '#c44' } }, error),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: buttonStyle, disabled: pending,
            onClick: () => setDialog(null) }, '取消'),
          h('button', { type: 'submit', style: buttonStyle, disabled: pending || !basenameValid(name),
            'data-file-write-create': '' }, pending ? '创建中…' : '创建')))), document.body),
        deleting && createPortal(h('div', {
          role: 'presentation', 'data-file-write-delete-dialog': '',
          style: { position: 'fixed', inset: 0, zIndex: 2147483647, background: '#0008', display: 'grid', placeItems: 'center' },
        }, h('form', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '确认删除', onSubmit: removeEntry,
          style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, width: 'min(420px, 90vw)',
            background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', borderRadius: 8 } },
        h('strong', null, `确认删除${deleting.kind === 'directory' ? '目录' : '文件'}？`),
        h('small', { style: { overflowWrap: 'anywhere' } }, deleting.path),
        h('span', null, deleting.kind === 'directory' ? '将递归删除目录及其中所有内容，无法撤销。' : '删除后无法撤销。'),
        error && h('span', { role: 'alert', style: { color: '#c44' } }, error),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: buttonStyle, disabled: pending,
            onClick: () => setDeleting(null) }, '取消'),
          h('button', { type: 'submit', style: buttonStyle, disabled: pending,
            'data-file-write-delete': '' }, pending ? '删除中…' : '确认删除')))), document.body))
    }

    module.exports.inject = ['slots', 'documentPreviews', 'connection', 'remote.workspaceFiles']
    module.exports.apply = function apply(ctx) {
      const id = EDITOR_ID
      // This plugin's Host endpoints are not part of the generated Remote table.
      // Use the existing gateway connection, preserving its Result envelope.
      const fileWrite = {
        create(sessionId, directory, basename, text, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/create',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, directory, basename, text } }, signal)
        },
        save(sessionId, path, text, expectedVersion, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/save',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, path, text, expectedVersion } }, signal)
        },
        delete(sessionId, path, kind, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/delete',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, path, kind } }, signal)
        },
      }
      ctx.effect(() => ctx.documentPreviews.register({
        id, extensions: ['md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonc', 'yaml', 'yml',
          'xml', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'html', 'htm', 'svg', 'toml', 'ini', 'env'],
        priority: 'builtin', title: () => '编辑源文件', loading: 'renderer', wrap: true,
      }))
      ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
        name: 'sidebar.right.tab.document', key: id,
      }, (props) => h(Editor, { ...props, key: props.resourceAddress, fileWrite,
        workspaceFiles: ctx.remote.workspaceFiles })))
      ctx.slots.inject('sidebar.right.tab.document.action', () => {
        const register = (key, priority) => {
          try {
            const dispose = ctx.slots.register({
              name: 'sidebar.right.tab.document.action', key, priority,
            }, (props) => h(MarkdownInlineAction, { ...props, fileWrite,
              workspaceFiles: ctx.remote.workspaceFiles }))
            return dispose
          } catch (error) {
            console.warn('[dsh-file-write] Markdown action registration unavailable', error)
            return () => {}
          }
        }
        return register(`${MARKDOWN_ID}:file-write`, 1)
      })
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'dsh-file-write-tree-create',
      }, (props) => h(FileTreeCreate, { ...props, fileWrite })))
    }
    return module.exports
  },
})
