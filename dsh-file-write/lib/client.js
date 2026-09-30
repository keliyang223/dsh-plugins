// DSH Web client modules register lazy factories; React comes from the platform table.
window.__ModuleLoader__.load({
  id: 'dsh-file-write',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { createPortal } = require('react-dom')
    const module = { exports: {} }
    const EDITOR_ID = 'dsh-file-write/editor'
    const drafts = new Map()
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
    const createButtonStyle = {
      ...buttonStyle, border: '1px solid #2368dc', background: '#2368dc', color: '#fff',
      fontWeight: 600,
    }
    const trashButtonStyle = {
      ...buttonStyle, border: '1px solid #c83232', background: '#c83232', color: '#fff',
      fontWeight: 600,
    }
    const menuButtonStyle = {
      boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8,
      width: '100%', padding: '5px 8px', textAlign: 'left',
      background: 'transparent', color: 'inherit', border: 0, borderRadius: 4,
      cursor: 'pointer', font: 'inherit',
    }
    function menuIcon(kind) {
      const path = {
        createFile: 'M6 3h8l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 0v5h4M11 12v6m-3-3h6',
        createDirectory: 'M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2M3 7h18l-1.5 12a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2L3 7Zm9 4v6m-3-3h6',
        delete: 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6',
        rename: 'M4 20h4l11-11-4-4L4 16v4Zm9-13 4 4M4 20h16',
        upload: 'M12 16V3m-4 4 4-4 4 4M4 17v3h16v-3',
        paste: 'M8 4h2a2 2 0 0 1 4 0h2v3H8V4ZM6 7H5v14h14V7h-1',
      }[kind]
      return h('svg', {
        'aria-hidden': true, viewBox: '0 0 24 24', width: 16, height: 16,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { flex: '0 0 16px', color: 'var(--dsw-alias-label-secondary, #666)' },
      }, h('path', { d: path }))
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
    function Editor({ resourceAddress, content, useResource, useTabInfo, fileWrite, workspaceFiles }) {
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
      const [loadedOnce, setLoadedOnce] = useState(false)
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
        if (contentValue.kind !== 'renderer' || !fileSession || !filePath || !workspaceFiles?.readBytes) {
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
            setLoadedOnce(true)
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
          if (contentValue.kind === 'renderer') contentValue.failed()
        })
        return () => controller.abort()
      }, [revision, effectiveAddress, fileSession, filePath, workspaceFiles, safeSignal, contentValue.kind])
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
      const ready = !!draft && loadedOnce && !readError && !!fileSession && !safeSignal.aborted
      const dirty = !!draft && draft.text !== draft.baseText
      async function save() {
        const before = draftRef.current
        if (!ready || !before || before.saving || before.conflict || before.error ||
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
        } catch (error) {
          if (safeSignal.aborted) return
          const latest = draftRef.current
          if (latest?.path !== before.path) return
          update({ ...latest, saving: false, conflict: isConflict(error), error: failureMessage(error) })
        }
      }
      useEffect(() => {
        if (!ready || !dirty || draft.saving || draft.conflict || draft.error || !fileWrite?.save) return
        const timer = setTimeout(() => { void save() }, 600)
        return () => clearTimeout(timer)
      }, [ready, dirty, draft?.text, draft?.version, draft?.saving, draft?.conflict, draft?.error,
        observedVersion, fileWrite, safeSignal])
      return h('section', {
        'data-file-write-editor': '', style: {
          display: 'flex', flexDirection: 'column', minHeight: 280, height: '100%', color: 'var(--dsw-alias-label-primary, #222)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap' } },
        h('strong', { style: { fontSize: 12 } }, '编辑源文件'),
        h('span', { 'data-file-write-status': '', role: 'status', style: { fontSize: 12, flex: 1 } },
          readError || (!ready ? '正在完整读取文件…' : draft?.conflict ? '版本冲突' : draft?.saving ? '正在保存…' : draft?.error ? '保存失败' : dirty ? '等待自动保存…' : '已保存')),
      ),
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
        !/[/\\:\u0000-\u001f\u007f]/u.test(name)
    }
    function FileTreeCreate({ session, fileWrite }) {
      const sessionId = session?.id || session?.sessionId || session?.header?.id || session?.session?.id || session?.session?.sessionId || session?.session?.header?.id
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [deleting, setDeleting] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [trashName, setTrashName] = useState('废纸篓')
      const trashAction = `移到${trashName}`
      const [transfer, setTransfer] = useState(null)
      const [name, setName] = useState('')
      const [error, setError] = useState('')
      const [pending, setPending] = useState(false)
      const bridgeSeen = useRef(new WeakSet())
      const abortRef = useRef(null)
      const inputRef = useRef(null)
      const selectedDirectory = useRef(null)
      const transferRef = useRef(null)
      transferRef.current = transfer
      const mounted = useRef(true)
      useEffect(() => () => { mounted.current = false; abortRef.current?.abort() }, [])
      function chooseFiles(directory) {
        selectedDirectory.current = directory
        setMenu(null)
        if (transferRef.current?.busy) return
        if (inputRef.current) { inputRef.current.value = ''; inputRef.current.click() }
      }
      function filesFromClipboard(data) {
        const items = Array.from(data?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean)
        return items.length ? items : Array.from(data?.files || [])
      }
      async function importFiles(directory, files) {
        if (transferRef.current?.busy || !directory || !files.length) return
        const controller = new AbortController()
        abortRef.current = controller
        let completed = 0
        const failures = []
        const state = { directory, busy: true, message: `正在添加 0/${files.length} 个文件…`, failures: [] }
        transferRef.current = state
        setTransfer(state)
        try {
          for (const file of files) {
            if (controller.signal.aborted) break
            let token
            try {
              if (!basenameValid(file.name) || !Number.isSafeInteger(file.size) || file.size > 512 * 1024 * 1024) {
                throw new Error('无效文件名或文件超过 512 MiB')
              }
              const started = valueOf(await fileWrite.beginUpload(sessionId, directory, file.name, file.size, controller.signal))
              token = started?.token
              if (!token) throw new Error('上传服务未返回令牌；请重启 DSH Web 宿主')
              for (let offset = 0; offset < file.size; offset += 256 * 1024) {
                controller.signal.throwIfAborted()
                const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer())
                let binary = ''
                for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
                valueOf(await fileWrite.appendUpload(sessionId, token, btoa(binary), controller.signal))
              }
              valueOf(await fileWrite.finishUpload(sessionId, token, controller.signal))
              token = null
              completed++
            } catch (failure) {
              if (!controller.signal.aborted) failures.push(`${file.name}: ${failureMessage(failure)}`)
            } finally {
              if (token) { try { await fileWrite.cancelUpload(sessionId, token) } catch { /* Staging expires on the Host. */ } }
            }
            if (mounted.current && !controller.signal.aborted) setTransfer({ directory, busy: true,
              message: `正在添加 ${completed + failures.length}/${files.length} 个文件…`, failures: [...failures] })
          }
        } finally {
          const result = { directory, busy: false, message: controller.signal.aborted
            ? `已取消；成功 ${completed} 个文件。` : `成功 ${completed} 个，失败 ${failures.length} 个。`, failures }
          transferRef.current = result
          if (mounted.current) {
            setTransfer(result)
            if (completed) document.querySelector('[data-files-state="tree"] [data-files-reload]')?.click()
          }
          if (abortRef.current === controller) abortRef.current = null
        }
      }
      function pasteInto(directory) {
        selectedDirectory.current = directory
        setMenu(null)
        if (typeof navigator === 'undefined' || !navigator.clipboard?.read) {
          setTransfer({ directory, busy: false, message: '浏览器不支持读取文件剪贴板。请按 Cmd/Ctrl+V，或使用“添加文件”。', failures: [] })
          return
        }
        navigator.clipboard.read().then(async items => {
          const files = []
          for (const item of items) for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type)
              files.push(new File([blob], `粘贴图片-${Date.now()}.${type.split('/')[1] || 'png'}`, { type }))
            }
          }
          if (files.length) await importFiles(directory, files)
          else setTransfer({ directory, busy: false, message: '剪贴板没有浏览器可读取的文件；请使用“添加文件”或拖放。', failures: [] })
        }).catch(failure => setTransfer({ directory, busy: false,
          message: `无法读取剪贴板：${failureMessage(failure)}。请按 Cmd/Ctrl+V 或使用“添加文件”。`, failures: [] }))
      }
      function openCreate(directory, kind = 'file') {
        setMenu(null)
        setDialog({ directory, kind })
        setName('')
        setError('')
      }
      function openDelete(target) {
        setMenu(null)
        setDeleting(target)
        setError('')
      }
      function openRename(target) {
        setMenu(null)
        setRenaming(target)
        setName(target.path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || '')
        setError('')
      }
      useEffect(() => {
        function onBridge(e) {
          const detail = e.detail
          const target = detail?.event && treeTarget(detail.event)
          if (!target || !Array.isArray(detail.items)) return
          bridgeSeen.current.add(detail.event)
          if (target.kind === 'directory') {
            detail.items.push({ label: '新建文件', icon: 'createFile', onClick: () => openCreate(target.path) })
            detail.items.push({ label: '新建文件夹', icon: 'createDirectory', onClick: () => openCreate(target.path, 'directory') })
            detail.items.push({ label: '添加文件…', icon: 'upload', onClick: () => chooseFiles(target.path) })
            detail.items.push({ label: '粘贴', icon: 'paste', onClick: () => pasteInto(target.path) })
          }
          if (target.kind === 'directory' || target.kind === 'file') {
            detail.items.push({ label: '重命名', icon: 'rename', onClick: () => openRename(target) })
            detail.items.push({ label: trashAction, icon: 'delete', onClick: () => openDelete(target) })
          }
        }
        function onContextMenu(event) {
          const target = treeTarget(event)
          if (!target || target.kind === 'root' || bridgeSeen.current.has(event) || event.defaultPrevented) return
          // The other plugin intercepts during capture and stops propagation;
          // bubble only runs when no other menu handled this tree event.
          event.preventDefault()
          setMenu({ target, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 170)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - (target.kind === 'directory' ? 225 : 115))) })
        }
        document.addEventListener('dsh-file-tree-menu', onBridge)
        document.addEventListener('contextmenu', onContextMenu)
        return () => {
          document.removeEventListener('dsh-file-tree-menu', onBridge)
          document.removeEventListener('contextmenu', onContextMenu)
        }
      }, [trashAction])
      useEffect(() => {
        function select(event) {
          const target = treeTarget(event)
          if (target?.kind === 'directory' || target?.kind === 'root') selectedDirectory.current = target.path
        }
        function paste(event) {
          const target = event.target
          if (target?.closest?.('input,textarea,[contenteditable="true"],[role="textbox"]')) return
          const tree = target?.closest?.('[data-files-state="tree"]')
          const directory = (treeTarget(event)?.kind === 'directory' ? treeTarget(event).path : null) ||
            (tree && selectedDirectory.current)
          if (!directory) return
          const files = filesFromClipboard(event.clipboardData)
          if (!files.length) {
            if (tree) setTransfer({ directory, busy: false, message: '剪贴板未提供可读取的文件；请使用“添加文件”或拖放。', failures: [] })
            return
          }
          event.preventDefault()
          void importFiles(directory, files)
        }
        function dragover(event) {
          const target = treeTarget(event)
          if (target?.kind === 'directory' && Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault()
        }
        function drop(event) {
          const target = treeTarget(event)
          if (target?.kind !== 'directory') return
          const files = Array.from(event.dataTransfer?.files || [])
          if (!files.length) return
          event.preventDefault()
          selectedDirectory.current = target.path
          void importFiles(target.path, files)
        }
        document.addEventListener('click', select, true)
        document.addEventListener('paste', paste)
        document.addEventListener('dragover', dragover)
        document.addEventListener('drop', drop)
        return () => {
          document.removeEventListener('click', select, true)
          document.removeEventListener('paste', paste)
          document.removeEventListener('dragover', dragover)
          document.removeEventListener('drop', drop)
        }
      }, [sessionId])
      useEffect(() => {
        if (!sessionId || !fileWrite?.trashPlatform) return
        const controller = new AbortController()
        Promise.resolve().then(() => fileWrite.trashPlatform(sessionId, controller.signal)).then(response => {
          if (!controller.signal.aborted && mounted.current) {
            setTrashName(valueOf(response)?.platform === 'win32' ? '回收站' : '废纸篓')
          }
        }).catch(() => { /* Keep the fallback if the Host is not yet updated. */ })
        return () => controller.abort()
      }, [sessionId, fileWrite])
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
        if (!basenameValid(name)) { setError('请输入有效名称（不能包含路径分隔符）。'); return }
        if (!(dialog?.kind === 'directory' ? fileWrite?.createDirectory : fileWrite?.create) || !sessionId) {
          setError('当前会话的文件写入服务不可用。'); return
        }
        setPending(true)
        setError('')
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const result = valueOf(dialog.kind === 'directory'
            ? await fileWrite.createDirectory(sessionId, dialog.directory, name, controller.signal)
            : await fileWrite.create(sessionId, dialog.directory, name, '', controller.signal))
          if (!mounted.current || controller.signal.aborted) return
          if (!result?.absolutePath || (dialog.kind === 'file' && !result.version)) throw new Error('创建响应缺少路径或版本')
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
      async function renameTarget(event) {
        event.preventDefault()
        if (pending || !renaming) return
        if (!basenameValid(name)) { setError('请输入有效名称（不能包含路径分隔符）。'); return }
        const oldName = renaming.path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1)
        if (name === oldName) { setError('新名称不能与原名称相同。'); return }
        if (!fileWrite?.rename || !sessionId) { setError('当前会话的重命名服务不可用。'); return }
        setPending(true)
        setError('')
        const controller = new AbortController()
        abortRef.current = controller
        try {
          const result = valueOf(await fileWrite.rename(sessionId, renaming.path, renaming.kind, name, controller.signal))
          if (!mounted.current || controller.signal.aborted) return
          if (typeof result?.absolutePath !== 'string' || result.previousPath !== renaming.path || result.kind !== renaming.kind) {
            throw new Error('重命名响应与目标不匹配')
          }
          setRenaming(null)
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
          if (mounted.current && !controller.signal.aborted) setError(failure?.message || `${trashAction}失败，原文件未自动删除。`)
        } finally {
          if (mounted.current) setPending(false)
          if (abortRef.current === controller) abortRef.current = null
        }
      }
      return h('span', { 'data-file-write-tree-contribution': '', style: { display: 'none' } },
        h('input', { type: 'file', multiple: true, ref: inputRef, 'data-file-write-file-input': '',
          onChange(event) { const files = Array.from(event.target.files || []); if (files.length) void importFiles(selectedDirectory.current, files) } }),
        menu && createPortal(h('div', {
          role: 'menu', 'aria-label': '文件操作', 'data-file-write-menu': '',
          style: { position: 'fixed', zIndex: 2147483647, top: menu.y, left: menu.x,
            minWidth: 148, padding: 4, fontSize: 12, lineHeight: '16px',
            background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)',
            border: '1px solid var(--dsw-alias-border-l1, #ddd)', borderRadius: 6, boxShadow: '0 4px 12px #0003' },
        }, menu.target.kind === 'directory' && h('button', {
          type: 'button', role: 'menuitem', autoFocus: true, style: menuButtonStyle,
          onClick: () => openCreate(menu.target.path) }, menuIcon('createFile'), h('span', null, '新建文件')),
        menu.target.kind === 'directory' && h('button', {
          type: 'button', role: 'menuitem', style: menuButtonStyle,
          onClick: () => openCreate(menu.target.path, 'directory') }, menuIcon('createDirectory'), h('span', null, '新建文件夹')),
        menu.target.kind === 'directory' && h('button', {
          type: 'button', role: 'menuitem', style: menuButtonStyle,
          onClick: () => chooseFiles(menu.target.path) }, menuIcon('upload'), h('span', null, '添加文件…')),
        menu.target.kind === 'directory' && h('button', {
          type: 'button', role: 'menuitem', style: menuButtonStyle,
          onClick: () => pasteInto(menu.target.path) }, menuIcon('paste'), h('span', null, '粘贴')),
        (menu.target.kind === 'directory' || menu.target.kind === 'file') && h('button', {
          type: 'button', role: 'menuitem', autoFocus: menu.target.kind === 'file', style: menuButtonStyle,
          onClick: () => openRename(menu.target) }, menuIcon('rename'), h('span', null, '重命名')),
        (menu.target.kind === 'directory' || menu.target.kind === 'file') && h('button', {
          type: 'button', role: 'menuitem', style: menuButtonStyle,
          onClick: () => openDelete(menu.target) }, menuIcon('delete'), h('span', null, trashAction))), document.body),
        dialog !== null && createPortal(h('div', {
          role: 'presentation', 'data-file-write-dialog': '',
          style: { position: 'fixed', inset: 0, zIndex: 2147483647, background: '#0008', display: 'grid', placeItems: 'center' },
        }, h('form', { role: 'dialog', 'aria-modal': 'true', 'aria-label': dialog.kind === 'directory' ? '新建文件夹' : '新建文件', onSubmit: create,
          style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, width: 'min(360px, 90vw)',
            background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', borderRadius: 8 } },
        h('strong', null, dialog.kind === 'directory' ? '新建文件夹' : '新建文件'),
        h('small', { title: dialog.directory, style: { overflowWrap: 'anywhere' } }, `目录：${dialog.directory}`),
        h('label', null, dialog.kind === 'directory' ? '文件夹名 ' : '文件名 ', h('input', { autoFocus: true, required: true, value: name,
          disabled: pending, onChange: (event) => setName(event.target.value), 'data-file-write-name': '',
          style: { boxSizing: 'border-box', width: '100%', padding: 6 } })),
        error && h('span', { role: 'alert', style: { color: '#c44' } }, error),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: buttonStyle, disabled: pending,
            onClick: () => setDialog(null) }, '取消'),
          h('button', { type: 'submit', style: createButtonStyle, disabled: pending || !basenameValid(name),
            'data-file-write-create': '' }, pending ? '创建中…' : '创建')))), document.body),
        renaming && createPortal(h('div', {
          role: 'presentation', 'data-file-write-rename-dialog': '',
          style: { position: 'fixed', inset: 0, zIndex: 2147483647, background: '#0008', display: 'grid', placeItems: 'center' },
        }, h('form', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '重命名', onSubmit: renameTarget,
          style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, width: 'min(360px, 90vw)',
            background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', borderRadius: 8 } },
        h('strong', null, `重命名${renaming.kind === 'directory' ? '文件夹' : '文件'}`),
        h('small', { title: renaming.path, style: { overflowWrap: 'anywhere' } }, renaming.path),
        h('label', null, '新名称 ', h('input', { autoFocus: true, required: true, value: name,
          disabled: pending, onChange: (event) => setName(event.target.value), 'data-file-write-rename-name': '',
          style: { boxSizing: 'border-box', width: '100%', padding: 6 } })),
        error && h('span', { role: 'alert', style: { color: '#c44' } }, error),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: buttonStyle, disabled: pending,
            onClick: () => setRenaming(null) }, '取消'),
          h('button', { type: 'submit', style: createButtonStyle,
            disabled: pending || !basenameValid(name) || name === renaming.path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1),
            'data-file-write-rename': '' }, pending ? '重命名中…' : '重命名')))), document.body),
        transfer && createPortal(h('div', { role: 'dialog', 'aria-label': '文件导入', 'data-file-write-transfer': '',
          style: { position: 'fixed', zIndex: 2147483647, bottom: 20, right: 20, width: 'min(380px, 90vw)',
            padding: 16, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2, #fff)',
            color: 'var(--dsw-alias-label-primary, #222)', boxShadow: '0 4px 16px #0005' } },
          h('strong', null, '添加文件'), h('p', { role: 'status' }, transfer.message),
          transfer.failures.map((failure, index) => h('p', { key: index, role: 'alert', style: { color: '#c44' } }, failure)),
          h('button', { type: 'button', style: buttonStyle, onClick: () => {
            if (transfer.busy) abortRef.current?.abort()
            else setTransfer(null)
          } }, transfer.busy ? '取消上传' : '关闭')), document.body),
        deleting && createPortal(h('div', {
          role: 'presentation', 'data-file-write-delete-dialog': '',
          style: { position: 'fixed', inset: 0, zIndex: 2147483647, background: '#0008', display: 'grid', placeItems: 'center' },
        }, h('form', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `确认${trashAction}`, onSubmit: removeEntry,
          style: { display: 'flex', flexDirection: 'column', gap: 12, padding: 18, width: 'min(420px, 90vw)',
            background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'var(--dsw-alias-label-primary, #222)', borderRadius: 8 } },
        h('strong', null, `将${deleting.kind === 'directory' ? '目录' : '文件'}${trashAction}？`),
        h('small', { style: { overflowWrap: 'anywhere' } }, deleting.path),
        h('span', null, deleting.kind === 'directory' ? `目录及其中所有内容将一起移入系统${trashName}，可从中恢复。` : `文件将移入系统${trashName}，可从中恢复。`),
        error && h('span', { role: 'alert', style: { color: '#c44' } }, error),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h('button', { type: 'button', style: buttonStyle, disabled: pending,
            onClick: () => setDeleting(null) }, '取消'),
          h('button', { type: 'submit', style: trashButtonStyle, disabled: pending,
            'data-file-write-delete': '' }, pending ? '移动中…' : trashAction)))), document.body))
    }

    module.exports.inject = ['slots', 'documentPreviews', 'connection', 'remote', 'remote.workspaceFiles']
    module.exports.apply = function apply(ctx) {
      const id = EDITOR_ID
      // This plugin's Host endpoints are not part of the generated Remote table.
      // Use the existing gateway connection, preserving its Result envelope.
      const fileWrite = {
        trashPlatform(sessionId, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/trashPlatform',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId } }, signal)
        },
        create(sessionId, directory, basename, text, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/create',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, directory, basename, text } }, signal)
        },
        createDirectory(sessionId, directory, basename, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/createDirectory',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, directory, basename } }, signal)
        },
        save(sessionId, path, text, expectedVersion, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/save',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, path, text, expectedVersion } }, signal)
        },
        delete(sessionId, path, kind, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/delete',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, path, kind } }, signal)
        },
        rename(sessionId, path, kind, basename, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/rename',
            { args: { sessionId: sessionId?.id || sessionId?.sessionId || sessionId, path, kind, basename } }, signal)
        },
        beginUpload(sessionId, directory, basename, size, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/beginUpload', { args: { sessionId, directory, basename, size } }, signal)
        },
        appendUpload(sessionId, token, chunkBase64, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/appendUpload', { args: { sessionId, token, chunkBase64 } }, signal)
        },
        finishUpload(sessionId, token, signal) {
          return ctx.connection.rpc.call('/api', 'fileWrite/finishUpload', { args: { sessionId, token } }, signal)
        },
        cancelUpload(sessionId, token) {
          return ctx.connection.rpc.call('/api', 'fileWrite/cancelUpload', { args: { sessionId, token } })
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
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'dsh-file-write-tree-create',
      }, (props) => h(FileTreeCreate, { ...props, fileWrite })))
    }
    return module.exports
  },
})
