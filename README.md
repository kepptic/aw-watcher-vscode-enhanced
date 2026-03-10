# ActivityWatch VS Code Enhanced

An enhanced VS Code extension for [ActivityWatch](https://activitywatch.net/) — tracks files, terminals, git state, debugging sessions, and more.

## Fork Notice

This is an enhanced fork of [ActivityWatch/aw-watcher-vscode](https://github.com/ActivityWatch/aw-watcher-vscode), which has been inactive since May 2023. We forked to:

- **Merge community contributions** that had been waiting for review (PRs #36, #39, #40)
- **Add rich terminal context** — cwd resolution, terminal enumeration, switch detection
- **Fix multi-window issues** — only the focused window sends heartbeats, preventing broken pulse merge
- **Modernize the codebase** — TypeScript 5.x, ESLint, updated dependencies, proper VS Code types
- **Cross-platform terminal cwd** — macOS/Linux via `lsof`, Windows via PowerShell

Full credit to the original [ActivityWatch](https://github.com/ActivityWatch) team and contributors. Licensed under the same [MPL-2.0](LICENSE.txt) license.

## Features

| Feature | Original | Enhanced |
|---------|----------|----------|
| File tracking (language, path) | Yes | Yes |
| Git branch | Yes | Yes |
| Git dirty count, remote URL | - | Yes |
| Cursor position (line/col) | - | Yes |
| Debug session tracking | - | Yes |
| Terminal name & cwd | - | Yes |
| Terminal switch detection | - | Yes |
| All terminal enumeration | - | Yes |
| Editor identification | - | Yes (Cursor, Windsurf, etc.) |
| Workspace name | - | Yes |
| Multi-window focus safety | - | Yes |
| Untrusted workspace support | - | Yes |
| Relative file paths | - | Yes |
| Open editor tabs | - | Yes |

## Heartbeat Data

Each heartbeat includes:

```json
{
  "language": "typescript",
  "project": "my-project",
  "file": "/path/to/file.ts",
  "relative_path": "src/file.ts",
  "branch": "main",
  "editor": "Visual Studio Code",
  "workspace": "My Workspace",
  "cursor_line": 42,
  "cursor_col": 10,
  "lines_in_file": 200,
  "git_dirty_count": 3,
  "git_remote": "github.com/org/repo",
  "is_debugging": false,
  "debug_type": "node",
  "active_terminal": "zsh",
  "terminal_cwd": "/home/user/project",
  "terminal_description": "project",
  "terminal_count": 3,
  "terminal_names": "zsh project;node server;bash deploy",
  "is_focused": true,
  "open_files": "file.ts;index.ts",
  "open_file_count": 2
}
```

## Installation

### From Source

```bash
git clone https://github.com/kepptic/aw-watcher-vscode-enhanced.git
cd aw-watcher-vscode-enhanced
npm install
npm run compile
```

Then copy the extension to your VS Code extensions directory or use `vsce package` to create a `.vsix`.

### Configuration

In VS Code settings:

```json
{
  "aw-watcher-vscode.maxHeartbeatsPerSec": 1
}
```

## Requirements

- VS Code 1.75+
- [ActivityWatch](https://activitywatch.net/) running on `localhost:5600`

## Multi-Window Behavior

When multiple VS Code windows are open, only the **focused window** sends heartbeats. This prevents different projects from interleaving in the same bucket, which would break ActivityWatch's pulse merge and produce 0-duration events.

When a window loses focus, one final heartbeat is sent to properly close the current event with correct duration.

## Community Contributions Merged

- **PR #36** ([@Thopiax](https://github.com/Thopiax)) — workspace name field
- **PR #39** ([@fooman](https://github.com/fooman)) — editor identification (enhanced to be dynamic)
- **PR #40** ([@ishanarora](https://github.com/ishanarora)) — untrusted workspace support

## License

[Mozilla Public License 2.0](LICENSE.txt) — same as the original project.
