# DSH File Write

[简体中文](README.md)

A plugin for DeepSeek Harness Web `0.1.7-rc.1` that edits text files in the right-hand preview and creates or deletes files from the workspace file tree.

## Usage

- Choose **编辑源文件** (Edit source) in the viewer selector to edit text files with automatic saving. `.md` and `.markdown` files use this source editor too.
- Right-click a **directory** for **新建文件** (New file) or **删除文件** (Delete); provide one filename such as `a.md` to create. Right-click a **regular file** for Delete only. Empty tree space has no create/delete actions. Deleting a directory recursively removes all its contents, requires a confirmation dialog, and cannot be undone.
- With `dsh-file-to-chat`, these actions join the existing context menu. The actions also work without that plugin.

## Install

```sh
dsh plugin --profile web add "/absolute/path/to/dsh-plugins/dsh-file-write"
```

Restart the current DSH Web process and refresh the page to load both the Host write service and browser editor. Uninstall with `dsh plugin --profile web remove dsh-file-write`.

## Safety and limits

- Writes are restricted to regular files inside the active session's workspace and respect its read-only policy. Filenames must be single basenames; no path separators or traversal.
- Creation uses a create-if-absent operation, never overwriting another file. Saving checks the version observed when the document was opened; external changes cause a conflict and retain the draft.
- Only UTF-8 text without NUL bytes is supported, up to 2 MiB for both original and saved content. Large or binary files cannot be saved.
- Editing requires a complete file and version. Changes save automatically after about 600 ms of inactivity. A write failure or version conflict retains the draft and stops retries until the next edit. Drafts only survive for the current page lifetime; confirm the status says saved or copy your draft before refreshing or closing. Conflicts are not auto-merged.
- The Host checks the live session and workspace; read-only sessions cannot delete; workspace roots, symlinks, and out-of-workspace targets cannot be deleted. Deletion uses Node's local filesystem because DSH's filesystem interface lacks a delete primitive. Paths are rechecked just before removal, but a hostile concurrent ancestor-symlink swap remains a TOCTOU risk without fd-relative deletion. Do not use recursive deletion in environments with untrusted concurrent filesystem mutation.

## Development

```sh
npm run build
npm test
```

`lib/index.js` implements Host mutations; `lib/client.js` registers the editor and new-file menu; `cordis.patch.yml` installs both in the Web profile.
