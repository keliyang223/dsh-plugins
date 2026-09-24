# DSH File Write

[简体中文](README.md)

A plugin for DeepSeek Harness Web `0.1.7-rc.1` that edits text files in the right-hand preview and creates or deletes files from the workspace file tree.

## Usage

- Open a `.md` or `.markdown` file in the built-in **Markdown** viewer and click **编辑 Markdown** (Edit Markdown) in its toolbar to edit directly over the preview. Save to refresh the rendered preview; **预览** (Preview) returns without saving after a confirmation and retains your draft.
- For other text files, choose **编辑源文件** (Edit source) in the viewer selector and click **保存** (Save). Markdown retains this alternative editor view too.
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
- Editing requires a complete file and version. There is no autosave. Drafts are held in memory for the lifetime of the plugin on the current page; save or copy your draft before refreshing or closing the page. Conflicts are not auto-merged.
- The Host checks the live session and workspace; read-only sessions cannot delete; workspace roots, symlinks, and out-of-workspace targets cannot be deleted. Deletion uses Node's local filesystem because DSH's filesystem interface lacks a delete primitive. Paths are rechecked just before removal, but a hostile concurrent ancestor-symlink swap remains a TOCTOU risk without fd-relative deletion. Do not use recursive deletion in environments with untrusted concurrent filesystem mutation.

## Development

```sh
npm run build
npm test
```

`lib/index.js` implements Host mutations; `lib/client.js` registers the editor and new-file menu; `cordis.patch.yml` installs both in the Web profile.
