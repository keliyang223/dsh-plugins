import { TextDecoder } from 'node:util';
import { posix, win32 } from 'node:path';
import { rm } from 'node:fs/promises';
import { TypertRemoteService, Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';

// The 0.1.7-rc.1 Gateway discovers these public Remote markers in SRC mode.
// The lookup maps an untrusted sessionId on the wire to a *live* Session and its
// current policy; the caller cannot supply either the workspace root or mode.
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
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

  // The DSH FileSystem API has no delete primitive. This path is local-only:
  // canonicalize again immediately before Node's rm; never use the caller's
  // original path in the destructive syscall. As with DSH fs-sandbox writes,
  // concurrent hostile ancestor symlink swaps remain a residual TOCTOU risk.
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
    await rm(this.ctx.fs.processPath(fresh), { recursive: kind === 'directory', force: false });
    return { absolutePath: this.ctx.fs.processPath(fresh), kind };
  }
}

// Standard decorators without a build step; markers are attached to the
// prototype on construction, as required by DSH's Typert SRC gateway.
const remoteInitializers = [];
for (const method of ['create', 'save', 'delete']) {
  Remote(FileWrite.prototype[method], {
    kind: 'method', name: method, static: false, private: false,
    addInitializer(initializer) { remoteInitializers.push(initializer); },
  });
}

export default FileWrite;
