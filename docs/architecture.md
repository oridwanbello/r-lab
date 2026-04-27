# R Layout — Technical Architecture

This document describes the internal architecture of the R Layout VS Code extension.

## Overview

R Layout follows a modular architecture where `extension.ts` acts as a thin orchestrator that delegates to specialized modules:

```
extension.ts (entry point)
    ├── layout/layoutManager.ts     → Layout toggle + Status Bar
    ├── views/environmentExplorer.ts → TreeDataProvider (DAP)
    ├── views/plotGallery.ts        → WebviewViewProvider (FileSystemWatcher)
    ├── views/dataViewer.ts         → WebviewViewProvider (DAP evaluate)
    └── util/debugSession.ts        → Shared DAP helpers
```

## Component Details

### Layout Manager (`layout/layoutManager.ts`)

Registers the `r-layout.toggleLayout` command and the Status Bar button. Uses `vscode.setEditorLayout` to snap the editor into a 65/35 asymmetrical 4-pane grid. Reads `r-layout.aiAgent` from settings to summon the appropriate AI chat panel.

### Environment Explorer (`views/environmentExplorer.ts`)

| Aspect | Detail |
|---|---|
| **Type** | `TreeDataProvider<VariableItem>` |
| **View ID** | `r-layout.environmentExplorer` |
| **Data Source** | VS Code Debug Adapter Protocol (DAP) |
| **Refresh Trigger** | Debug session changes, manual refresh command |

**DAP request chain:**
```
threads → stackTrace → scopes → variables
```

Each `VariableItem` displays:
- **Label**: Variable name
- **Description**: Truncated value (max 60 chars)
- **Icon**: Type-aware ThemeIcon (number, string, bool, array, dataframe, function, etc.)
- **Expandable**: If `variablesReference > 0`, children can be drilled into

### Plot Gallery (`views/plotGallery.ts`)

| Aspect | Detail |
|---|---|
| **Type** | `WebviewViewProvider` |
| **View ID** | `r-layout.plotGallery` |
| **Data Source** | `FileSystemWatcher` on configurable directory |
| **Default Watch Dir** | `.r-layout/plots/` |
| **Supported Formats** | PNG, JPG, JPEG, SVG, GIF, BMP, WebP |

**Message protocol (webview → extension):**
| Message Type | Action |
|---|---|
| `navigatePrev` | Show previous plot |
| `navigateNext` | Show next plot |
| `clear` | Clear all plot history |

### Data Viewer (`views/dataViewer.ts`)

| Aspect | Detail |
|---|---|
| **Type** | `WebviewViewProvider` |
| **View ID** | `r-layout.dataViewer` |
| **Data Source** | DAP `evaluate` request |
| **Row Limit** | 500 rows (head) |

**Serialization strategies** (tried in order):
1. **R**: `jsonlite::toJSON(head(var, 500), auto_unbox = TRUE)`
2. **Python**: `__import__('json').dumps(var.head(500).to_dict('records'))`

**Message protocol (webview → extension):**
| Message Type | Payload | Action |
|---|---|---|
| `sortColumn` | `{ column, direction }` | Sort by column |
| `filterRows` | `{ query }` | Filter rows (debounced 250ms) |

### Debug Session Utilities (`util/debugSession.ts`)

Shared helper functions used by the Environment Explorer and Data Viewer:

| Function | Purpose |
|---|---|
| `getTopFrameId(session)` | Get frame ID from topmost stack frame |
| `getLocalVariables(session, frameId)` | Get local scope variables |
| `getVariableChildren(session, ref)` | Drill into a `variablesReference` |
| `evaluateExpression(session, expr)` | Evaluate an expression in the top frame |

## Security

All Webview panels implement:
- **Content Security Policy (CSP)** with nonce-based script authorization
- **Restricted `localResourceRoots`** — only extension URI and workspace folders
- **Input sanitization** via HTML escaping for all user data rendered in tables

## Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `r-layout.aiAgent` | `string` (enum) | `"terminal"` | AI agent for the console layout |
| `r-layout.plotOutputDir` | `string` | `".r-layout/plots"` | Plot output directory path |

## View Container

R Layout registers a custom Activity Bar container (`r-layout-sidebar`) with three views. The sidebar icon is a 4-layout grid SVG (`resources/layout-icon.svg`).
