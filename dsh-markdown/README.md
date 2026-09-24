# DSH Markdown TOC

**DSH Markdown TOC** adds a persistent, collapsible table of contents to Markdown previews in DeepSeek Harness Web.

## Features

- Adds a `目录` button to Markdown preview actions.
- Scans rendered `h1`–`h6` headings from the current Markdown preview.
- Shows the TOC on the right side of the current preview.
- Clicking an item smoothly scrolls to its heading.
- Remembers whether the TOC is visible using browser local storage.
- Does not replace the built-in Markdown renderer.

## Installation

```sh
dsh plugin --profile web add "$(pwd)"
```

Restart DSH Web and refresh the page if the plugin is not loaded automatically.

## Development

```sh
npm run build
npm test
```
