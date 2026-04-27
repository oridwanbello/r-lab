# R Layout — Agent Rules

This file defines non-negotiable layout rules and project conventions for AI agents working on this codebase.

## Non-Negotiable Layout Rules

### Layout Arrangement

| | |
|---|---|
| ① Source Editor (ViewColumn.One) | ③ Chat → Help (ViewColumn.Three) |
| ② R Console → Terminal → Problems (ViewColumn.Two) | ④ Workspace → Plots → Data Viewer (ViewColumn.Four) |

### Tab Order (STRICT — left to right within each layout)

| Layout       | Tab Order                              |
|----------------|----------------------------------------|
| Top-left (①)   | User's source files                    |
| Bottom-left (②)| R Console → Terminal → Problems        |
| Top-right (③)  | Chat → Help                            |
| Bottom-right (④)| Workspace → Plots → Data Viewer       |

### Default Focused Tab (STRICT — which tab is visible/active on activation)

| Layout       | Focused Tab     |
|----------------|-----------------|
| Top-left (①)   | Last open file  |
| Bottom-left (②)| R Console        |
| Top-right (③)  | Chat             |
| Bottom-right (④)| Workspace       |

## Implementation Notes

- Tab order in VS Code is determined by the order tabs are added to a group. To achieve the correct order, create/move tabs left-to-right (e.g., create Workspace first, then Plots, then Data Viewer for Group 4).
- To set focus without stealing keyboard focus from the source editor (Group 1), use `panel.reveal(undefined, true)` (preserveFocus=true).
- For R Console focus: call `rConsoleTerminal.show(true)` after all Group 2 tabs are added.
- For Chat focus: after HelpPanel is created, call `focusThirdEditorGroup` + `workbench.action.firstEditorInGroup` to activate the first tab (Chat) without creating a duplicate.
- ProblemsPanel is used as a temporary anchor for Group 2 to enable reliable `moveToEditor` placement of terminals. It is disposed and recreated at the end so it appears last.
- **Never recreate existing terminals** (`dispose()` + new `createTerminal()`). This kills the R session. Always reuse the existing terminal object.
- **Never call `t.show(false)` during deactivation** to avoid auto-creating a new bash terminal when the panel reopens. Focus Group 2 and call `moveToTerminalPanel` in a loop instead.

## Settings

- `r-layout.rConsolePath` — path to R binary (default `"R"`)
- `r-layout.useArkInteractiveConsole` — boolean, use Jupyter Interactive instead of terminal
- `r-layout.plotOutputDir` — directory to watch for plot images

## Key State Variables

```typescript
let isLayoutActive: boolean;     // whether 4-layout layout is active
let rConsoleTerminal: vscode.Terminal | undefined;  // R Console terminal (reuse, never dispose)
let shellTerminal: vscode.Terminal | undefined;     // Bash/shell terminal (reuse, never dispose)
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
const STATE_KEY = 'r-layout.layoutActive';       // persisted workspace state key
```
