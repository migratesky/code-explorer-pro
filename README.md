# Code Explorer Pro

Recursive, fast, and streamed reference search for VS Code workspaces. Results populate a dedicated tree view so you can keep context while exploring where a symbol/text appears across your project.

Repository: https://github.com/migratesky/vscode-code-explorer-pro

## Features

- **One-shot or streamed search** for any text across your workspace.
- **Groups results by file** in a "References" tree under the Explorer.
- **Inline symbols extraction** from each matching line; expand a symbol to find its references.
- **Click-to-open** any result; cursor jumps to the exact match location.
- **Prioritizes the active file** so first results appear where you are working.
- **Configurable** include/exclude globs, excluded extensions, line/file limits, timeout, match mode, and logging.
- **Per-file logging** (optional) and progress logs to the "Code Explorer Pro" output channel.

## Requirements

- VS Code: ^1.89.0

## Getting Started

1. Open a folder/workspace in VS Code.
2. Place your cursor on a word or select text.
3. Run the command: "Find Recursive References".
   - Command ID: `code-explorer-pro.findRecursiveReferences`
   - Default keybinding: `Ctrl+Shift+Space` (macOS: `Ctrl+Shift+Space`)
4. Results stream into the Explorer view named "References". Click to open; expand inline symbols to continue exploring.

If no selection/word is detected, you will be prompted to enter free text.

## Commands

- `code-explorer-pro.findRecursiveReferences` — Find references for selected text/word or an input string.
- `code-explorer-pro.openLocation` — Open a result location in an editor (internal).
- `code-explorer-pro.expandSymbol` — Expand a symbol node to find its references.
- `code-explorer-pro._getTreeRoots` — Internal (testing).
- `code-explorer-pro._expandAndSummarize` — Internal (testing).

## View

- Explorer view ID: `codeExplorerProReferences`
- Display name: "References"

## Settings

All settings live under the `codeExplorerPro` namespace.

- `codeExplorerPro.includeGlob` (string, default `"**/*"`)
  - Glob of files to include when scanning.
- `codeExplorerPro.excludeGlob` (string)
  - Glob of files/folders to exclude. Default excludes common build and cache folders.
- `codeExplorerPro.excludeFileExtensions` (string[])
  - File extensions to skip (e.g., `jar`, `zip`, `exe`, `class`, etc.).
- `codeExplorerPro.maxFiles` (number, default `50000`)
  - Maximum files to scan per search.
- `codeExplorerPro.maxLinesPerFile` (number, default `10000`)
  - Maximum lines scanned per file.
- `codeExplorerPro.maxSearchMs` (number, default `15000`)
  - Abort search after this many milliseconds. Partial results are returned.
- `codeExplorerPro.progressEvery` (number, default `50`)
  - Log progress every N files.
- `codeExplorerPro.verboseLogging` (boolean, default `false`)
  - Log per-file summaries even when there are 0 hits.
- `codeExplorerPro.matchMode` ("text" | "word", default `"text"`)
  - Raw substring match or word-boundary match.

Example settings.json snippet:

```json
{
  "codeExplorerPro.includeGlob": "**/*",
  "codeExplorerPro.excludeGlob": "**/{node_modules,dist,out,build,.git,.venv,venv,.tox,.cache}/**",
  "codeExplorerPro.excludeFileExtensions": ["jar", "war", "zip", "tar", "gz", "bz2", "7z", "rar", "iso", "dmg", "exe", "msi", "app", "pkg", "deb", "rpm", "apk", "ipa", "xpi", "class"],
  "codeExplorerPro.maxFiles": 50000,
  "codeExplorerPro.maxLinesPerFile": 10000,
  "codeExplorerPro.maxSearchMs": 15000,
  "codeExplorerPro.progressEvery": 50,
  "codeExplorerPro.verboseLogging": false,
  "codeExplorerPro.matchMode": "text"
}
```

## Tips

- Use `matchMode: "word"` to avoid partial matches (e.g., match `cat` but not `concatenate`).
- The active file is scanned first; keep focus in relevant files to see early results there.
- Tune `includeGlob`/`excludeGlob` and `excludeFileExtensions` to reduce noise and speed up searches.

## Keybinding conflicts (macOS)

`Ctrl+Shift+Space` can sometimes be used by system or other apps. If it conflicts:

- VS Code: open Keyboard Shortcuts and change the binding for "Find Recursive References".
- macOS: System Settings > Keyboard > Shortcuts to adjust any conflicting global shortcut.

## Development

- Build once: `npm run compile`
- Watch build: `npm run watch`
- Lint: `npm run lint`
- Run tests (integration): `npm test`
- Run unit tests: `npm run test:unit`

## Troubleshooting

- Check the "Code Explorer Pro" output channel for detailed logs.
- Increase `maxSearchMs` for large repositories.
- Enable `verboseLogging` to see per-file scan summaries.

## License

See the repository for license information.
