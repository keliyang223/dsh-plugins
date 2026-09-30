import { TextDecoder } from 'node:util';
import { posix, win32 } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { lstat, mkdir, mkdtemp, open, realpath, rename as renameEntry, rm } from 'node:fs/promises';
import trash from 'trash';
import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';

// The 0.1.7-rc.1 Gateway discovers these public Remote markers in SRC mode.
// The lookup maps an untrusted sessionId on the wire to a *live* Session and its
// current policy; the caller cannot supply either the workspace root or mode.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 1024 * 1024;
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const BASE64_CHUNK = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const OWN_PACKAGE = 'dsh-file-write';
const HAS_UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function fail(code, message, path) {
  throw new RemoteError(code, message, path === undefined ? {} : { path });
}

function checkText(text) {
  if (typeof text !== 'string') fail('gateway/bad-request', 'text must be a string');
  if (text.includes('\0') || HAS_UNPAIRED_SURROGATE.test(text)) {
    fail('file-write/not-text', 'text must contain valid UTF-8 characters and no NUL');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) fail('file-write/too-large', `text exceeds ${MAX_TEXT_BYTES} bytes`);
  return bytes;
}

function assertPath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    fail('gateway/bad-request', `${name} must be a nonempty path without NUL`);
  }
}

function assertBasename(value) {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' ||
      value.includes('/') || value.includes('\\') || value.includes(':') || value.includes('\0') ||
      /[\u0001-\u001f\u007f]/u.test(value)) {
    fail('gateway/bad-request', 'basename must be one plain filename');
  }
}

function isFsCode(error, code) {
  return error !== null && typeof error === 'object' && error.code === code;
}

export class FileWrite extends TypertRemoteService {
  static inject = ['fs', 'sandboxPolicy', 'sessions', 'typert'];

  constructor(ctx) {
    super(ctx, 'fileWrite');
    for (const initialize of remoteInitializers) initialize.call(this);
    // The unique parameter name below is intentional: SRC introspects the Host
    // method signature, maps it to the wire field sessionId, then resolves it.
    ctx.typert.lookups.register(`${OWN_PACKAGE}.session`, {
      parameter: 'fileWriteSession',
      wire: 'sessionId',
      hostTypeSymbol: `${OWN_PACKAGE}#FileWriteSession`,
      wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      resolve: async (sessionId) => {
        if (typeof sessionId !== 'string' || !sessionId) return undefined;
        const session = ctx.sessions.get(sessionId);
        if (session?.header === undefined) return undefined;
        return { session, policy: ctx.sandboxPolicy.resolve({ session }) };
      },
    });
  }

  policyOf(fileWriteSession) {
    const policy = this.ctx.sandboxPolicy.resolve({ session: fileWriteSession.session });
    if (policy.mode === 'read-only') fail('file-write/policy-denied', 'session policy is read-only');
    // Keep the backend's final re-canonicalization/containment fence active even
    // when the broader session policy is danger-full-access. This endpoint is
    // always workspace-only and never asks for an elevated policy.
    return { ...policy, mode: 'workspace-write' };
  }

  async workspaceOf(policy, signal) {
    signal?.throwIfAborted();
    const root = await this.ctx.fs.resolve(policy.workspaceRoot, { signal });
    if ((await this.ctx.fs.stat(root, signal))?.type !== 'directory') {
      fail('file-write/not-directory', 'session workspace is not a directory', policy.workspaceRoot);
    }
    return root;
  }

  async confinedPath(root, path, signal) {
    assertPath(path, 'path');
    const target = await this.ctx.fs.resolve(path, { cwd: this.ctx.fs.processPath(root), signal });
    if (!this.ctx.fs.contains(root, target)) fail('file-write/outside-workspace', 'path is outside session workspace', path);
    return target;
  }

  uploadStore() {
    return this.uploads ??= new Map();
  }

  async uploadParent(fileWriteSession, directory, signal) {
    if (typeof this.ctx.fs.processPathFromHostPath !== 'function') {
      fail('file-write/unsupported-backend', 'binary upload requires a local filesystem backend');
    }
    const policy = this.policyOf(fileWriteSession);
    const root = await this.workspaceOf(policy, signal);
    const parent = await this.confinedPath(root, directory, signal);
    if ((await this.ctx.fs.stat(parent, signal))?.type !== 'directory') {
      fail('file-write/not-directory', 'parent directory must already exist', directory);
    }
    const rootPath = this.ctx.fs.processPath(root);
    const paths = rootPath.startsWith('/') ? posix : win32;
    const suppliedPath = paths.resolve(rootPath, directory);
    const parentPath = this.ctx.fs.processPath(parent);
    // Never write through an alias (including a symlink pointing back inside).
    if (suppliedPath !== parentPath || await realpath(parentPath) !== parentPath) {
      fail('file-write/stale-entry', 'parent must not contain symlinks', directory);
    }
    return { parentPath, paths };
  }

  async discardUpload(upload) {
    clearTimeout(upload.timer);
    this.uploadStore().delete(upload.token);
    await rm(upload.tempDir, { recursive: true, force: true });
  }

  uploadFor(fileWriteSession, token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      fail('gateway/bad-request', 'token must be a valid upload token');
    }
    const upload = this.uploadStore().get(token);
    if (!upload || upload.session !== fileWriteSession.session) {
      fail('file-write/invalid-upload', 'upload token is invalid for this session');
    }
    if (upload.busy) fail('file-write/upload-busy', 'upload is already in use');
    upload.busy = true;
    return upload;
  }

  // wire: fileWrite.beginUpload({sessionId, directory, basename, size})
  async beginUpload(fileWriteSession, directory, basename, size, signal) {
    assertPath(directory, 'directory');
    assertBasename(basename);
    if (!Number.isSafeInteger(size) || size < 0) fail('gateway/bad-request', 'size must be a nonnegative safe integer');
    if (size > MAX_UPLOAD_BYTES) fail('file-write/too-large', `upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    const { parentPath, paths } = await this.uploadParent(fileWriteSession, directory, signal);
    const destination = paths.join(parentPath, basename);
    if (await this.ctx.fs.lstat(destination, undefined, signal) !== undefined) {
      fail('file-write/already-exists', 'entry already exists', destination);
    }
    signal?.throwIfAborted();
    const tempDir = await mkdtemp(paths.join(tmpdir(), 'dsh-file-write-upload-'));
    const tempPath = paths.join(tempDir, 'data');
    try {
      const handle = await open(tempPath, 'wx', 0o600);
      await handle.close();
      const token = randomBytes(32).toString('hex');
      const upload = { token, session: fileWriteSession.session, directory, basename, parentPath,
        size, received: 0, tempDir, tempPath, busy: false, expiresAt: Date.now() + UPLOAD_TTL_MS };
      const expire = () => {
        if (upload.busy) {
          upload.expired = true;
          upload.timer = setTimeout(expire, 1000);
          upload.timer.unref?.();
          return;
        }
        void this.discardUpload(upload).catch(() => {});
      };
      upload.timer = setTimeout(expire, UPLOAD_TTL_MS);
      upload.timer.unref?.();
      this.uploadStore().set(token, upload);
      return { token, maxChunkBytes: MAX_UPLOAD_CHUNK_BYTES, expiresAt: upload.expiresAt };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  // wire: fileWrite.appendUpload({sessionId, token, chunkBase64})
  async appendUpload(fileWriteSession, token, chunkBase64, signal) {
    const upload = this.uploadFor(fileWriteSession, token);
    try {
      if (Date.now() >= upload.expiresAt || upload.expired) fail('file-write/upload-expired', 'upload expired');
      this.policyOf(fileWriteSession);
      if (typeof chunkBase64 !== 'string' || !BASE64_CHUNK.test(chunkBase64)) {
        fail('gateway/bad-request', 'chunkBase64 must be canonical base64');
      }
      if (chunkBase64.length > Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4) {
        fail('file-write/too-large', 'upload chunk exceeds 1 MiB');
      }
      const chunk = Buffer.from(chunkBase64, 'base64');
      if (chunk.length > MAX_UPLOAD_CHUNK_BYTES) fail('file-write/too-large', 'upload chunk exceeds 1 MiB');
      if (chunk.toString('base64') !== chunkBase64) fail('gateway/bad-request', 'chunkBase64 must be canonical base64');
      if (upload.received + chunk.length > upload.size) fail('file-write/too-large', 'upload exceeds declared size');
      signal?.throwIfAborted();
      const handle = await open(upload.tempPath, 'r+');
      try {
        let offset = 0;
        while (offset < chunk.length) {
          signal?.throwIfAborted();
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, upload.received + offset);
          if (!bytesWritten) throw Error('upload write made no progress');
          offset += bytesWritten;
        }
      } finally { await handle.close(); }
      upload.received += chunk.length;
      return { bytes: upload.received };
    } catch (error) {
      await this.discardUpload(upload);
      throw error;
    } finally { upload.busy = false; }
  }

  // wire: fileWrite.finishUpload({sessionId, token})
  async finishUpload(fileWriteSession, token, signal) {
    const upload = this.uploadFor(fileWriteSession, token);
    try {
      if (Date.now() >= upload.expiresAt || upload.expired) fail('file-write/upload-expired', 'upload expired');
      if (upload.received !== upload.size) fail('file-write/incomplete-upload', 'upload does not match declared size');
      const { parentPath, paths } = await this.uploadParent(fileWriteSession, upload.directory, signal);
      if (parentPath !== upload.parentPath) fail('file-write/stale-entry', 'parent directory changed during upload');
      const destination = paths.join(parentPath, upload.basename);
      if (await this.ctx.fs.lstat(destination, undefined, signal) !== undefined) {
        fail('file-write/already-exists', 'entry already exists', destination);
      }
      // Recheck canonical containment and parent immediately before the exclusive copy.
      const fresh = await this.uploadParent(fileWriteSession, upload.directory, signal);
      if (fresh.parentPath !== parentPath) fail('file-write/stale-entry', 'parent directory changed during upload');
      signal?.throwIfAborted();
      let output;
      try { output = await open(destination, 'wx', 0o600); }
      catch (error) {
        if (isFsCode(error, 'EEXIST')) fail('file-write/already-exists', 'entry already exists', destination);
        throw error;
      }
      try {
        const source = await open(upload.tempPath, 'r');
        try {
          const block = Buffer.allocUnsafe(MAX_UPLOAD_CHUNK_BYTES);
          let offset = 0;
          while (offset < upload.size) {
            signal?.throwIfAborted();
            const { bytesRead } = await source.read(block, 0, Math.min(block.length, upload.size - offset), offset);
            if (!bytesRead) throw Error('upload temporary file ended early');
            let written = 0;
            while (written < bytesRead) {
              signal?.throwIfAborted();
              const result = await output.write(block, written, bytesRead - written, offset + written);
              if (!result.bytesWritten) throw Error('upload copy made no progress');
              written += result.bytesWritten;
            }
            offset += bytesRead;
          }
        } finally { await source.close(); }
        await output.close();
      } catch (error) {
        await output.close().catch(() => {});
        await rm(destination, { force: true });
        throw error;
      }
      return { absolutePath: destination, bytes: upload.received };
    } finally {
      await this.discardUpload(upload);
      upload.busy = false;
    }
  }

  // wire: fileWrite.cancelUpload({sessionId, token})
  async cancelUpload(fileWriteSession, token, signal) {
    const upload = this.uploadFor(fileWriteSession, token);
    try {
      signal?.throwIfAborted();
      await this.discardUpload(upload);
      return { cancelled: true };
    } finally { upload.busy = false; }
  }

  // The trash action executes on the Host machine, which may differ from the browser OS.
  // wire: fileWrite.trashPlatform({sessionId})
  async trashPlatform(fileWriteSession) {
    if (!fileWriteSession?.session?.header) fail('gateway/bad-request', 'session is unavailable');
    return { platform: process.platform };
  }

  // wire: fileWrite.create({sessionId, directory, basename, text})
  async create(fileWriteSession, directory, basename, text, signal) {
    const bytes = checkText(text);
    assertPath(directory, 'directory');
    assertBasename(basename);
    const policy = this.policyOf(fileWriteSession);
    const root = await this.workspaceOf(policy, signal);
    const parent = await this.confinedPath(root, directory, signal);
    const parentInfo = await this.ctx.fs.stat(parent, signal);
    if (parentInfo?.type !== 'directory') fail('file-write/not-directory', 'parent directory must already exist', directory);
    const path = this.ctx.fs.processPath(parent);
    const paths = path.startsWith('/') ? posix : win32;
    const name = paths.join(path, basename);
    const entry = await this.ctx.fs.lstat(name, undefined, signal);
    if (entry !== undefined) fail('file-write/already-exists', 'file already exists', name);
    const target = await this.confinedPath(root, name, signal);
    try {
      const written = await this.ctx.fs.writeText(target, text, { kind: 'createIfAbsent' }, signal, policy);
      return { absolutePath: this.ctx.fs.processPath(target), version: written.version, bytes };
    } catch (error) {
      if (isFsCode(error, 'FS_NOT_OBSERVED')) fail('file-write/already-exists', 'file already exists', name);
      throw error;
    }
  }

  // wire: fileWrite.createDirectory({sessionId, directory, basename})
  // The DSH FileSystem API has no mkdir primitive. Restrict the Node syscall
  // to the local backend and re-resolve the parent immediately beforehand.
  async createDirectory(fileWriteSession, directory, basename, signal) {
    if (typeof this.ctx.fs.processPathFromHostPath !== 'function') {
      fail('file-write/unsupported-backend', 'directory creation requires a local filesystem backend');
    }
    assertPath(directory, 'directory');
    assertBasename(basename);
    const policy = this.policyOf(fileWriteSession);
    const root = await this.workspaceOf(policy, signal);
    const parent = await this.confinedPath(root, directory, signal);
    if ((await this.ctx.fs.stat(parent, signal))?.type !== 'directory') {
      fail('file-write/not-directory', 'parent directory must already exist', directory);
    }
    const path = this.ctx.fs.processPath(parent);
    const paths = path.startsWith('/') ? posix : win32;
    const name = paths.join(path, basename);
    if (await this.ctx.fs.lstat(name, undefined, signal) !== undefined) {
      fail('file-write/already-exists', 'entry already exists', name);
    }
    const fresh = await this.confinedPath(root, directory, signal);
    if (this.ctx.fs.processPath(fresh) !== path ||
        (await this.ctx.fs.stat(fresh, signal))?.type !== 'directory') {
      fail('file-write/stale-entry', 'parent directory changed during creation', directory);
    }
    signal?.throwIfAborted();
    try {
      await mkdir(name);
    } catch (error) {
      if (isFsCode(error, 'EEXIST')) fail('file-write/already-exists', 'entry already exists', name);
      throw error;
    }
    return { absolutePath: name };
  }

  // wire: fileWrite.save({sessionId, path, text, expectedVersion})
  async save(fileWriteSession, path, text, expectedVersion, signal) {
    const bytes = checkText(text);
    assertPath(path, 'path');
    if (typeof expectedVersion !== 'string' || !expectedVersion) {
      fail('gateway/bad-request', 'expectedVersion must be a nonempty version token');
    }
    const policy = this.policyOf(fileWriteSession);
    const root = await this.workspaceOf(policy, signal);
    const target = await this.confinedPath(root, path, signal);
    const entry = await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot }, signal);
    if (entry?.type !== 'file') fail('file-write/not-regular-file', 'path must name an existing regular file (not a symlink)', path);
    const info = await this.ctx.fs.stat(target, signal);
    if (info?.type !== 'file') fail('file-write/not-regular-file', 'path is not a regular file', path);
    if (info.version !== expectedVersion) fail('file-write/stale-version', 'file changed since it was read', path);
    if (info.size !== undefined && info.size > MAX_TEXT_BYTES) fail('file-write/too-large', `existing file exceeds ${MAX_TEXT_BYTES} bytes`, path);
    let current;
    try {
      current = await this.ctx.fs.readBytes(target, signal, MAX_TEXT_BYTES);
    } catch (error) {
      if (isFsCode(error, 'FS_TOO_LARGE')) fail('file-write/too-large', `existing file exceeds ${MAX_TEXT_BYTES} bytes`, path);
      throw error;
    }
    if (current.includes(0)) fail('file-write/not-text', 'existing file contains NUL bytes', path);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(current);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      fail('file-write/not-text', 'existing file is not valid UTF-8', path);
    }
    try {
      const written = await this.ctx.fs.writeText(target, text, { kind: 'replaceIfVersion', version: expectedVersion }, signal, policy);
      return { absolutePath: this.ctx.fs.processPath(target), version: written.version, bytes };
    } catch (error) {
      if (isFsCode(error, 'FS_STALE_VERSION')) fail('file-write/stale-version', 'file changed since it was read', path);
      throw error;
    }
  }

  // wire: fileWrite.rename({sessionId, path, kind, basename})
  // Node's rename may overwrite a target on some platforms. Recheck the
  // destination immediately before the syscall; concurrent external creation
  // remains a TOCTOU risk (Node has no portable no-replace rename primitive).
  async rename(fileWriteSession, path, kind, basename, signal) {
    if (typeof this.ctx.fs.processPathFromHostPath !== 'function') {
      fail('file-write/unsupported-backend', 'renaming requires a local filesystem backend');
    }
    assertPath(path, 'path');
    assertBasename(basename);
    if (kind !== 'file' && kind !== 'directory') fail('gateway/bad-request', 'kind must be file or directory');
    const policy = this.policyOf(fileWriteSession);
    const root = await this.workspaceOf(policy, signal);
    const target = await this.confinedPath(root, path, signal);
    const source = this.ctx.fs.processPath(target);
    if (source === this.ctx.fs.processPath(root)) {
      fail('file-write/protected-root', 'cannot rename the session workspace root', path);
    }
    if ((await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot }, signal))?.type !== kind) {
      fail('file-write/stale-entry', 'entry type changed or entry no longer exists', path);
    }
    const paths = source.startsWith('/') ? posix : win32;
    const destination = paths.join(paths.dirname(source), basename);
    if (destination === source) fail('file-write/same-name', 'new name must differ from the existing name', path);
    if (await this.ctx.fs.lstat(destination, undefined, signal) !== undefined) {
      fail('file-write/already-exists', 'destination already exists', destination);
    }
    const fresh = await this.confinedPath(root, path, signal);
    if (this.ctx.fs.processPath(fresh) !== source ||
        (await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot }, signal))?.type !== kind) {
      fail('file-write/stale-entry', 'entry changed during rename', path);
    }
    const freshDestination = await this.confinedPath(root, destination, signal);
    if (this.ctx.fs.processPath(freshDestination) !== destination ||
        (await this.ctx.fs.stat(await this.confinedPath(root, paths.dirname(destination), signal), signal))?.type !== 'directory') {
      fail('file-write/stale-entry', 'destination parent changed during rename', destination);
    }
    if (await this.ctx.fs.lstat(destination, undefined, signal) !== undefined) {
      fail('file-write/already-exists', 'destination already exists', destination);
    }
    signal?.throwIfAborted();
    try {
      await renameEntry(source, destination);
    } catch (error) {
      if (isFsCode(error, 'EEXIST') || isFsCode(error, 'ENOTEMPTY')) {
        fail('file-write/already-exists', 'destination already exists', destination);
      }
      throw error;
    }
    return { absolutePath: destination, previousPath: source, kind };
  }

  async moveToTrash(absolutePath) {
    await trash(absolutePath, { glob: false });
  }

  // The DSH FileSystem API has no trash primitive. This path is local-only:
  // canonicalize again immediately before moving to the OS trash; never pass
  // the caller's original path to the trash library. Do not fall back to rm.
  // As with DSH fs-sandbox writes, hostile concurrent ancestor symlink swaps
  // remain a residual TOCTOU risk.
  async delete(fileWriteSession, path, kind, signal) {
    // processPathFromHostPath is present on DSH's local filesystem backend;
    // do not issue Node syscalls against a nonlocal/virtual fs implementation.
    if (typeof this.ctx.fs.processPathFromHostPath !== 'function') {
      fail('file-write/unsupported-backend', 'deletion requires a local filesystem backend');
    }
    assertPath(path, 'path');
    if (kind !== 'file' && kind !== 'directory') fail('gateway/bad-request', 'kind must be file or directory');
    const policy = this.policyOf(fileWriteSession);
    const root = await this.workspaceOf(policy, signal);
    const target = await this.confinedPath(root, path, signal);
    if (this.ctx.fs.processPath(target) === this.ctx.fs.processPath(root)) {
      fail('file-write/protected-root', 'cannot delete the session workspace root', path);
    }
    const entry = await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot }, signal);
    if (entry?.type !== kind) fail('file-write/stale-entry', 'file type changed or entry no longer exists', path);
    // Reject identity changes between resolution and deletion, including a
    // symlink inserted at the leaf or one that moves an ancestor outside root.
    const fresh = await this.confinedPath(root, path, signal);
    if (this.ctx.fs.processPath(fresh) !== this.ctx.fs.processPath(target)) {
      fail('file-write/stale-entry', 'file path changed during deletion', path);
    }
    if ((await this.ctx.fs.lstat(path, { cwd: policy.workspaceRoot }, signal))?.type !== kind) {
      fail('file-write/stale-entry', 'file type changed during deletion', path);
    }
    signal?.throwIfAborted();
    const absolutePath = this.ctx.fs.processPath(fresh);
    // trash() silently ignores missing inputs, even with glob disabled. Check
    // existence both before and after it returns so a no-op is not reported as
    // success, and never turn trash failures into permanent deletion.
    const before = await lstat(absolutePath);
    if (kind === 'file' ? !before.isFile() : !before.isDirectory()) {
      fail('file-write/stale-entry', 'file type changed during trash move', path);
    }
    signal?.throwIfAborted();
    await this.moveToTrash(absolutePath);
    try {
      await lstat(absolutePath);
    } catch (error) {
      if (isFsCode(error, 'ENOENT')) return { absolutePath, kind };
      throw error;
    }
    fail('file-write/trash-failed', 'file was not moved to the trash', path);
  }
}

// Standard decorators without a build step; markers are attached to the
// prototype on construction, as required by DSH's Typert SRC gateway.
const remoteInitializers = [];
for (const method of ['create', 'createDirectory', 'save', 'delete', 'rename', 'beginUpload', 'appendUpload', 'finishUpload', 'cancelUpload', 'trashPlatform']) {
  Remote(FileWrite.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
  });
}

export default FileWrite;
