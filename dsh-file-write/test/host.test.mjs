import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, resolve as resolvePath } from 'node:path';
import { mkdtemp, writeFile, mkdir, symlink, access, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol';
import { FileWrite } from '../lib/index.js';

function fixture() {
  const entries = new Map([
    ['/work', { type: 'directory', version: 'root' }],
    ['/work/sub', { type: 'directory', version: 'sub' }],
    ['/work/sub/note.txt', { type: 'file', version: 'v1', text: 'before' }],
    ['/outside', { type: 'directory', version: 'outside' }],
    ['/work/binary.txt', { type: 'file', version: 'binary', raw: Buffer.from([65, 0, 66]) }],
    ['/work/invalid.txt', { type: 'file', version: 'invalid', raw: Buffer.from([0xff]) }],
    ['/work/large.txt', { type: 'file', version: 'large', raw: Buffer.alloc(2 * 1024 * 1024 + 1, 65) }],
    ['/work/link.txt', { type: 'symlink', pointsTo: '/outside/exfil.txt' }],
    ['/work/inside-link.txt', { type: 'symlink', pointsTo: '/work/sub/note.txt' }],
  ]);
  const calls = [];
  let revision = 2;
  function canonical(path) {
    let next = posix.normalize(path);
    for (let index = 0; index < 10; index++) {
      const components = next.split('/');
      let changed = false;
      for (let i = 1; i < components.length; i++) {
        const prefix = components.slice(0, i + 1).join('/') || '/';
        const link = entries.get(prefix);
        if (link?.type !== 'symlink') continue;
        next = posix.normalize(posix.join(link.pointsTo, ...components.slice(i + 1)));
        changed = true;
        break;
      }
      if (!changed) return next;
    }
    throw Error('symlink cycle');
  }
  const fs = {
    processPath: target => target.targetKey,
    processPathFromHostPath: path => path,
    contains: (root, child) => child.targetKey === root.targetKey || child.targetKey.startsWith(root.targetKey + '/'),
    async resolve(path, opts = {}) {
      opts.signal?.throwIfAborted();
      const displayPath = posix.resolve(opts.cwd ?? '/work', path);
      return { displayPath, targetKey: canonical(displayPath) };
    },
    async stat(target) {
      const info = entries.get(target.targetKey);
      return info && { type: info.type, version: info.version, size: info.type === 'file' ? (info.raw ?? Buffer.from(info.text)).length : undefined };
    },
    async lstat(path, opts = {}) {
      const info = entries.get(posix.resolve(opts.cwd ?? '/work', path));
      return info && { type: info.type, version: info.version };
    },
    async readBytes(target, _signal, limit) {
      const info = entries.get(target.targetKey);
      const data = info.raw ?? Buffer.from(info.text);
      if (data.length > limit) throw Object.assign(Error('too large'), { code: 'FS_TOO_LARGE' });
      return data;
    },
    async writeText(target, text, expected, signal, policy) {
      signal?.throwIfAborted();
      calls.push({ path: target.targetKey, expected, policy });
      const current = entries.get(target.targetKey);
      if (expected.kind === 'createIfAbsent' && current) throw Object.assign(Error('exists'), { code: 'FS_NOT_OBSERVED' });
      if (expected.kind === 'replaceIfVersion' && current?.version !== expected.version) {
        throw Object.assign(Error('stale'), { code: 'FS_STALE_VERSION' });
      }
      const version = `v${revision++}`;
      entries.set(target.targetKey, { type: 'file', version, text });
      return { version };
    },
  };
  const session = { id: 's1', header: { cwd: '/work' } };
  const owner = Object.create(FileWrite.prototype);
  owner.ctx = { fs, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work', sessionId: 's1' }) } };
  return { owner, entries, calls, scope: { session }, session };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('Host registers session lookup and marks create/save for SRC discovery', () => {
  const { owner, session } = fixture();
  let lookup;
  const ctx = {
    reflect: { props: {}, provide() {} },
    root: { reflect: { props: {} }, accessor() {} },
    typert: { lookups: { register(key, provider) { lookup = { key, provider }; } } },
    sandboxPolicy: owner.ctx.sandboxPolicy,
    sessions: { get(id) { return id === session.id ? session : undefined; } },
  };
  const service = new FileWrite(ctx);
  assert.equal(service.typertRemote.serviceKey, 'fileWrite');
  assert.equal(service.typertRemote.namespace, 'fileWrite');
  assert.deepEqual(remoteMethods(service).map(({ method }) => method), ['create', 'createDirectory', 'save', 'delete', 'rename']);
  assert.equal(lookup.key, 'dsh-file-write.session');
  assert.equal(lookup.provider.parameter, 'fileWriteSession');
  assert.equal(lookup.provider.wire, 'sessionId');
  assert.equal(lookup.provider.resolve('s1') instanceof Promise, true);
  assert.match(FileWrite.prototype.create.toString(), /create\(fileWriteSession, directory, basename, text, signal\)/);
  assert.match(FileWrite.prototype.createDirectory.toString(), /createDirectory\(fileWriteSession, directory, basename, signal\)/);
  assert.match(FileWrite.prototype.save.toString(), /save\(fileWriteSession, path, text, expectedVersion, signal\)/);
  assert.match(FileWrite.prototype.delete.toString(), /delete\(fileWriteSession, path, kind, signal\)/);
  assert.match(FileWrite.prototype.rename.toString(), /rename\(fileWriteSession, path, kind, basename, signal\)/);
});

test('create is confined and exclusive, and returns a versioned stat', async () => {
  const { owner, scope, calls, entries } = fixture();
  assert.deepEqual(await owner.create(scope, 'sub', 'new.txt', 'héllo'), {
    absolutePath: '/work/sub/new.txt', version: 'v2', bytes: 6,
  });
  assert.equal(entries.get('/work/sub/new.txt').text, 'héllo');
  assert.deepEqual(calls[0].expected, { kind: 'createIfAbsent' });
  assert.equal(calls[0].policy.mode, 'workspace-write');
  await rejectsCode(owner.create(scope, 'sub', 'new.txt', 'oops'), 'file-write/already-exists');
  await rejectsCode(owner.create(scope, 'sub', '../outside.txt', 'oops'), 'gateway/bad-request');
  await rejectsCode(owner.create(scope, '../outside', 'escape.txt', 'oops'), 'file-write/outside-workspace');
  await rejectsCode(owner.create(scope, '/outside', 'escape.txt', 'oops'), 'file-write/outside-workspace');
  await rejectsCode(owner.create(scope, '/work/link.txt', 'escape.txt', 'oops'), 'file-write/outside-workspace');
  await rejectsCode(owner.create(scope, '/work/missing', 'no.txt', 'oops'), 'file-write/not-directory');
  assert.equal(calls.length, 1);
});

test('createDirectory makes only one new child under an existing workspace directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-write-mkdir-'));
  const work = join(root, 'work');
  const outside = join(root, 'outside');
  try {
    await mkdir(join(work, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(work, 'sub', 'existing.txt'), 'keep');
    await symlink(outside, join(work, 'outside-link'));
    await symlink(join(work, 'sub'), join(work, 'inside-link'));
    const owner = Object.create(FileWrite.prototype);
    owner.ctx = {
      fs: {
        resolve: async (path, options = {}) => {
          const displayPath = resolvePath(options.cwd ?? work, path);
          try { return { targetKey: await realpath(displayPath) }; }
          catch (error) { if (error.code === 'ENOENT') return { targetKey: displayPath }; throw error; }
        },
        processPath: target => target.targetKey,
        processPathFromHostPath: path => path,
        contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '/'),
        stat: async target => {
          const { stat } = await import('node:fs/promises');
          try { const value = await stat(target.targetKey); return { type: value.isDirectory() ? 'directory' : 'file' }; }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
        },
        lstat: async (path) => {
          const { lstat } = await import('node:fs/promises');
          try { const value = await lstat(path); return { type: value.isDirectory() ? 'directory' : 'file' }; }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
        },
      },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: work }) },
    };
    const scope = { session: { id: 's1', header: { cwd: work } } };
    const expected = join(await realpath(work), 'sub', 'child');
    assert.deepEqual(await owner.createDirectory(scope, 'sub', 'child'), { absolutePath: expected });
    await access(expected);
    await rejectsCode(owner.createDirectory(scope, 'sub', 'child'), 'file-write/already-exists');
    await rejectsCode(owner.createDirectory(scope, 'sub', 'existing.txt'), 'file-write/already-exists');
    await rejectsCode(owner.createDirectory(scope, 'missing', 'child'), 'file-write/not-directory');
    await rejectsCode(owner.createDirectory(scope, 'sub', '../escape'), 'gateway/bad-request');
    await rejectsCode(owner.createDirectory(scope, '../outside', 'escape'), 'file-write/outside-workspace');
    await rejectsCode(owner.createDirectory(scope, 'outside-link', 'escape'), 'file-write/outside-workspace');
    await access(join(outside));
    owner.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: work });
    await rejectsCode(owner.createDirectory(scope, 'sub', 'denied'), 'file-write/policy-denied');
    delete owner.ctx.fs.processPathFromHostPath;
    await rejectsCode(owner.createDirectory(scope, 'sub', 'denied'), 'file-write/unsupported-backend');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('save rejects escapes, symlinks, stale edits, binary, and oversized files', async () => {
  const { owner, scope, calls, entries } = fixture();
  assert.deepEqual(await owner.save(scope, 'sub/note.txt', 'new', 'v1'), {
    absolutePath: '/work/sub/note.txt', version: 'v2', bytes: 3,
  });
  assert.deepEqual(calls[0].expected, { kind: 'replaceIfVersion', version: 'v1' });
  await rejectsCode(owner.save(scope, 'sub/note.txt', 'lost', 'v1'), 'file-write/stale-version');
  await rejectsCode(owner.save(scope, '/outside/a.txt', 'lost', 'v1'), 'file-write/outside-workspace');
  await rejectsCode(owner.save(scope, 'link.txt', 'lost', 'v1'), 'file-write/outside-workspace');
  await rejectsCode(owner.save(scope, 'inside-link.txt', 'lost', 'v1'), 'file-write/not-regular-file');
  await rejectsCode(owner.save(scope, 'binary.txt', 'lost', 'binary'), 'file-write/not-text');
  await rejectsCode(owner.save(scope, 'invalid.txt', 'lost', 'invalid'), 'file-write/not-text');
  await rejectsCode(owner.save(scope, 'large.txt', 'lost', 'large'), 'file-write/too-large');
  await rejectsCode(owner.save(scope, 'sub/note.txt', '\u0000', 'v2'), 'file-write/not-text');
  await rejectsCode(owner.save(scope, 'sub/note.txt', 'a'.repeat(2 * 1024 * 1024 + 1), 'v2'), 'file-write/too-large');
  assert.equal(entries.get('/work/sub/note.txt').text, 'new');
  assert.equal(calls.length, 1);
});

test('session read-only policy prevents all mutations even when backend is permissive', async () => {
  const { owner, scope, calls } = fixture();
  owner.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: '/work' });
  await rejectsCode(owner.create(scope, 'sub', 'new.txt', 'x'), 'file-write/policy-denied');
  await rejectsCode(owner.save(scope, 'sub/note.txt', 'x', 'v1'), 'file-write/policy-denied');
  await rejectsCode(owner.delete(scope, 'sub/note.txt', 'file'), 'file-write/policy-denied');
  await rejectsCode(owner.rename(scope, 'sub/note.txt', 'file', 'renamed.txt'), 'file-write/policy-denied');
  assert.equal(calls.length, 0);
});

test('danger-full-access sessions still use the workspace-only filesystem fence', async () => {
  const { owner, scope, calls } = fixture();
  owner.ctx.sandboxPolicy.resolve = () => ({ mode: 'danger-full-access', workspaceRoot: '/work' });
  await owner.create(scope, 'sub', 'new.txt', 'x');
  assert.equal(calls[0].policy.mode, 'workspace-write');
  assert.equal(calls[0].policy.workspaceRoot, '/work');
  await rejectsCode(owner.create(scope, '/outside', 'escape.txt', 'x'), 'file-write/outside-workspace');
});

test('rename confines entries and refuses collisions without overwriting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-write-rename-'));
  const work = join(root, 'work');
  const outside = join(root, 'outside');
  try {
    await mkdir(join(work, 'nested'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(work, 'a.md'), 'original');
    await writeFile(join(work, 'b.md'), 'existing');
    await writeFile(join(work, 'nested', 'child.txt'), 'child');
    await symlink(outside, join(work, 'outside-link'));
    await symlink(join(work, 'nested'), join(work, 'inside-link'));
    const owner = Object.create(FileWrite.prototype);
    owner.ctx = { fs: {
      resolve: async (path, options = {}) => {
        const displayPath = resolvePath(options.cwd ?? work, path);
        try { return { targetKey: await realpath(displayPath) }; }
        catch (error) { if (error.code === 'ENOENT') return { targetKey: displayPath }; throw error; }
      },
      processPath: target => target.targetKey,
      processPathFromHostPath: path => path,
      contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '/'),
      stat: async target => {
        const { stat } = await import('node:fs/promises');
        try { const value = await stat(target.targetKey); return { type: value.isDirectory() ? 'directory' : 'file' }; }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
      },
      lstat: async (path, options = {}) => {
        const { lstat } = await import('node:fs/promises');
        try { const value = await lstat(resolvePath(options.cwd ?? work, path));
          return { type: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : 'file' }; }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
      },
    }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: work }) } };
    const scope = { session: { header: { cwd: work } } };
    await rejectsCode(owner.rename(scope, work, 'directory', 'renamed'), 'file-write/protected-root');
    await rejectsCode(owner.rename(scope, '../outside', 'directory', 'else'), 'file-write/outside-workspace');
    await rejectsCode(owner.rename(scope, 'outside-link', 'directory', 'else'), 'file-write/outside-workspace');
    await rejectsCode(owner.rename(scope, 'inside-link', 'directory', 'else'), 'file-write/stale-entry');
    await rejectsCode(owner.rename(scope, 'a.md', 'directory', 'else'), 'file-write/stale-entry');
    await rejectsCode(owner.rename(scope, 'a.md', 'file', '../escape'), 'gateway/bad-request');
    await rejectsCode(owner.rename(scope, 'a.md', 'file', 'a.md'), 'file-write/same-name');
    await rejectsCode(owner.rename(scope, 'a.md', 'file', 'b.md'), 'file-write/already-exists');
    await rejectsCode(owner.rename(scope, 'a.md', 'file', 'outside-link'), 'file-write/already-exists');
    assert.equal(await (await import('node:fs/promises')).readFile(join(work, 'b.md'), 'utf8'), 'existing');
    assert.deepEqual(await owner.rename(scope, 'a.md', 'file', 'renamed.md'), {
      absolutePath: join(await realpath(work), 'renamed.md'), previousPath: join(await realpath(work), 'a.md'), kind: 'file',
    });
    assert.equal(await (await import('node:fs/promises')).readFile(join(work, 'renamed.md'), 'utf8'), 'original');
    await owner.rename(scope, 'nested', 'directory', 'moved');
    assert.equal(await (await import('node:fs/promises')).readFile(join(work, 'moved', 'child.txt'), 'utf8'), 'child');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trash move confines files and folders and never moves outside-workspace entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-write-test-'));
  const work = join(root, 'work');
  const outside = join(root, 'outside');
  try {
    await mkdir(join(work, 'nested'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(work, 'one.txt'), 'one');
    await writeFile(join(work, 'nested', 'two.txt'), 'two');
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(work, 'nested', 'external-child'));
    await symlink(outside, join(work, 'outside-link'));
    await symlink(join(work, 'nested'), join(work, 'inside-link'));
    const owner = Object.create(FileWrite.prototype);
    owner.ctx = {
      fs: {
        resolve: async (path, options = {}) => {
          const displayPath = resolvePath(options.cwd ?? work, path);
          const { realpath } = await import('node:fs/promises');
          return { displayPath, targetKey: await realpath(displayPath) };
        },
        processPath: target => target.targetKey,
        processPathFromHostPath: path => path,
        contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '/'),
        stat: async target => {
          const { stat } = await import('node:fs/promises');
          try { const value = await stat(target.targetKey); return { type: value.isDirectory() ? 'directory' : 'file' }; }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
        },
        lstat: async (path, options = {}) => {
          const { lstat } = await import('node:fs/promises');
          try { const value = await lstat(resolvePath(options.cwd ?? work, path));
            return { type: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : 'file' }; }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
        },
      },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: work }) },
    };
    const scope = { session: { id: 's1', header: { cwd: work } } };
    const trashed = [];
    owner.moveToTrash = async path => {
      trashed.push(path);
      const { rename } = await import('node:fs/promises');
      await rename(path, join(root, `trash-${trashed.length}`));
    };
    await rejectsCode(owner.delete(scope, work, 'directory'), 'file-write/protected-root');
    await rejectsCode(owner.delete(scope, '../outside', 'directory'), 'file-write/outside-workspace');
    await rejectsCode(owner.delete(scope, 'outside-link', 'directory'), 'file-write/outside-workspace');
    await rejectsCode(owner.delete(scope, 'inside-link', 'directory'), 'file-write/stale-entry');
    await rejectsCode(owner.delete(scope, 'one.txt', 'directory'), 'file-write/stale-entry');
    const canonicalWork = await realpath(work);
    assert.deepEqual(await owner.delete(scope, 'one.txt', 'file'), { absolutePath: join(canonicalWork, 'one.txt'), kind: 'file' });
    assert.deepEqual(await owner.delete(scope, 'nested', 'directory'), { absolutePath: join(canonicalWork, 'nested'), kind: 'directory' });
    await assert.rejects(access(join(work, 'nested')), { code: 'ENOENT' });
    assert.deepEqual(trashed, [join(canonicalWork, 'one.txt'), join(canonicalWork, 'nested')]);
    await access(join(root, 'trash-1'));
    await access(join(root, 'trash-2', 'two.txt'));
    await access(join(outside, 'keep.txt'));
    const { lstat } = await import('node:fs/promises');
    assert.equal((await lstat(join(work, 'inside-link'))).isSymbolicLink(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trash failure keeps the original file; a no-op is never reported as success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-write-trash-fail-'));
  const work = join(root, 'work');
  try {
    await mkdir(work);
    await writeFile(join(work, 'keep.txt'), 'keep');
    const owner = Object.create(FileWrite.prototype);
    owner.ctx = { fs: {
      processPathFromHostPath: path => path,
      processPath: target => target,
      contains: (parent, child) => child === parent || child.startsWith(parent + '/'),
      resolve: async (path, options = {}) => realpath(resolvePath(options.cwd ?? work, path)),
      stat: async target => ({ type: target === await realpath(work) ? 'directory' : 'file' }),
      lstat: async () => ({ type: 'file' }),
    }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: work }) } };
    const scope = { session: { header: { cwd: work } } };
    owner.moveToTrash = async () => { throw Error('trash unavailable'); };
    await assert.rejects(owner.delete(scope, 'keep.txt', 'file'), /trash unavailable/);
    await access(join(work, 'keep.txt'));
    owner.moveToTrash = async () => {};
    await rejectsCode(owner.delete(scope, 'keep.txt', 'file'), 'file-write/trash-failed');
    await access(join(work, 'keep.txt'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delete refuses a nonlocal filesystem backend', async () => {
  const { owner, scope } = fixture();
  delete owner.ctx.fs.processPathFromHostPath;
  await rejectsCode(owner.delete(scope, 'sub/note.txt', 'file'), 'file-write/unsupported-backend');
});

test('rejects content with unpaired surrogate instead of corrupting UTF-8', async () => {
  const { owner, scope } = fixture();
  await rejectsCode(owner.create(scope, 'sub', 'new.txt', '\ud800'), 'file-write/not-text');
});
