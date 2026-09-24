# DSH File to Chat: Add File and Selected-Line References to a Conversation

[简体中文](README.md) · English

**DSH File to Chat** is a browser-side plugin for DeepSeek Harness (DSH) Web. It inserts references to local files, folders, or selected line ranges from text-file previews into the current conversation draft. The AI can then use the Harness file tools to inspect the referenced context when the user sends a prompt.

> **Privacy and behavior:** The plugin inserts reference text only. It does not submit messages or independently read, copy, or upload referenced file contents. Any later file access depends on the user's prompt and tool execution.

## Features

- **Reference a file:** Right-click a file in the DSH file tree and choose **加入到对话框** (Add to chat) to insert an `@path` reference.
- **Reference a folder:** Right-click a folder and choose **加入到对话框** (Add to chat) to insert a directory reference ending in `/`.
- **Reference selected lines:** Select one or more lines in a text-file preview, right-click, and choose **加入选中行到对话框** (Add selected lines to chat). Example:

  ```text
  @/Users/me/project/src/app.ts 第 12–20 行
  ```

- **Preview toolbar button:** Click the chain-link button in the preview header to insert the current file reference and the selected line range, if any.
- **Draft-safe insertion:** Uses DSH's `inputActions.captureInsertion` and `insertText` APIs. It does not send the message or replace existing draft text.
- **Paths with spaces:** Uses the quoted form required by DSH's `@file` syntax, such as `@"/Users/me/my project/a.ts"`.

## Installation

Run this command where the DSH CLI is installed:

```sh
dsh plugin --profile web add "git+https://github.com/keliyang223/dsh-file-to-chat.git"
```

If the running DSH Web process does not hot-reload plugins, restart it and refresh the page. The plugin targets the DSH Web `0.1.7-rc.1` client API.

### Install from a local checkout

```sh
git clone https://github.com/keliyang223/dsh-file-to-chat.git
cd dsh-file-to-chat
dsh plugin --profile web add "$(pwd)"
```

If the CLI reports a profile lock, close other DSH or plugin-management operations first. Do not delete the lock file manually.

### Uninstall

```sh
dsh plugin --profile web remove dsh-file-to-chat
```

## Usage

1. Open DSH Web and locate a file or folder in the left-hand file tree.
2. Right-click a file or folder and choose **加入到对话框** (Add to chat). The reference is inserted into the current draft.
3. To reference a line range, select one or more lines in the right-hand text preview, right-click, and choose **加入选中行到对话框** (Add selected lines to chat).
4. Review the draft and decide whether to send it.

Example:

```text
@"/Users/me/notes/my file.md" 第 3–8 行
```

## Line numbers and supported content

- A selection must be wholly contained in the body of one file preview.
- The plugin prefers absolute source line markers provided by the text preview. For other renderers, it uses explicit line elements when available; if no line markers exist, it counts newline characters in the preview text.
- In paginated previews, only currently loaded and displayed lines can be referenced. The plugin cannot infer line numbers across content that has not been loaded.
- Paths that cannot be safely represented by DSH's `@file` syntax (for example, paths containing control characters or a double quote) are not inserted.
- A line range is plain text appended to the `@path` reference. It is not a structured attachment and does not force the AI to read only those lines; the AI still needs to use a file tool to inspect the file.
- The plugin observes DSH file-tree and preview DOM markers. A future DSH UI change to those markers may require a compatibility update.

## Development and tests

The repository includes the prebuilt browser client at `lib/client.js`. Normal installation does not require a bundler, a separate React dependency, or an install-time build step.

```sh
npm run build
npm test
```

Tests cover path references, selected-line coordinates, menu insertion, and non-submission behavior.

## Implementation overview

- `package.json`: DSH Web client manifest and bundle declaration.
- `cordis.patch.yml`: Adds the `ui-file-to-chat` client entry to the Web profile.
- `lib/index.js`: No-op host-side plugin entry.
- `lib/client.js`: File-tree context menu, preview selection-to-line mapping, and draft insertion.
- `test/client.test.mjs`: Client behavior tests.
