# R Layout Agent Rules

This file defines non-negotiable layout rules and project conventions for AI agents working on this codebase.

## Non-Negotiable Layout Rules

### Layout Arrangement

The editor is split into an asymmetrical 3-pane grid.

| Layout Section | Components | ViewColumn |
|---|---|---|
| Left Pane (Group 1) | Source Editor (Full Height) | ViewColumn.One |
| Top-Right Pane (Group 2) | R Console, Terminal, Problems, Help | ViewColumn.Two |
| Bottom-Right Pane (Group 3) | Workspace, Plots, Data Viewer | ViewColumn.Three |

### Tab Order (STRICT: left to right within each layout)

| Layout | Tab Order |
|---|---|
| Left (Group 1) | User source files |
| Top-Right (Group 2) | R Console, Terminal, Problems, Help |
| Bottom-Right (Group 3) | Workspace, Plots, Data Viewer |

### Default Focused Tab (STRICT: which tab is visible on activation)

| Layout | Focused Tab |
|---|---|
| Left (Group 1) | Last open file |
| Top-Right (Group 2) | R Console |
| Bottom-Right (Group 3) | Workspace |

## Implementation Notes

- Tab order in VS Code is determined by the order tabs are added to a group. To achieve the correct order, create and move tabs left-to-right (e.g., create Workspace first, then Plots, then Data Viewer for Group 3).
- To set focus without stealing keyboard focus from the source editor (Group 1), use `panel.reveal(undefined, true)` (preserveFocus=true) for WebviewPanels.
- For R Console focus: call `rConsoleTerminal.show(false)` to bring it into view without stealing keyboard focus.
- ProblemsPanel is used as a temporary anchor for Group 2 to enable reliable `moveToEditor` placement of terminals. It is disposed and recreated at the end so it appears after the terminals.
- Never recreate existing terminals (calling `dispose()` and creating a new `Terminal`). This kills the R session. Always reuse the existing terminal object.
- Terminal placements must rely on explicitly moving the terminal to the correct group to prevent layout shifting.

## Settings

- `r-layout.rConsolePath` (string): path to R binary (default "R")
- `r-layout.useArkInteractiveConsole` (boolean): use Jupyter Interactive instead of a terminal
- `r-layout.plotOutputDir` (string): directory to watch for plot images

## Key State Variables

```typescript
let isLayoutActive: boolean;                        // whether the 3-pane layout is active
let rConsoleTerminal: vscode.Terminal | undefined;  // R Console terminal (reuse, never dispose)
let shellTerminal: vscode.Terminal | undefined;     // Bash/shell terminal (reuse, never dispose)
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
const STATE_KEY = 'r-layout.layoutActive';          // persisted workspace state key
```

## Critical Troubleshooting and Stability Rules

### 1. The Vanishing R Console Bug (Restart Stability)
- Problem: During extension host restarts (or manual compiles), the R Console specifically would often disappear from the layout.
- Root Cause: If the R Console was already an editor tab from a previous session, calling `moveToEditor` again caused it to vanish.
- The Rule: Always explicitly check if the R Console is already an editor tab before attempting to move it. You must verify the label specifically for the R Console (`tab.label.includes('R Console')`).

### 2. Integrated Terminal Caution Symbol (Process Crashes)
- Problem: Terminals and R Console showing a yellow caution or warning symbol indicating the underlying process crashed or became unresponsive.
- Root Cause: This happens when AI agents write code that aggressively kills terminals, recreates terminals without properly disposing of old ones, sends commands before the terminal is fully initialized, or runs blocking processes that freeze the PTY.
- The Rule:
    - Never recreate existing terminals. If `rConsoleTerminal` exists, reuse it. Recreating it kills the user's active R session.
    - Handle with Care: Do not send generic bash commands (like sed, cat, etc.) to the R Console. It runs R, not bash.
    - Always use `delay()` when orchestrating terminal movements to give the VS Code terminal API time to initialize the process.

### 3. Focus Management (Anti-Stealing)
- Problem: Activating the layout or generating a plot would often steal the keyboard focus away from the user's code editor.
- The Rule:
    - Use `panel.reveal(undefined, true)` (the true is preserveFocus) for all webview panels.
    - When placing terminals, ensure the final action restores focus to the user's primary workspace (Group 1).

### 4. Workspace Cleanup
- Directory cleanup (`.r-layout`) must run unconditionally in `deactivate()` or early in `activate()` if stale data is detected.

### 5. Config Overrides and Settings Integrity
- Problem: Activating the layout requires overriding specific VS Code UI settings, such as `workbench.editor.closeEmptyGroups`. Setting them back to `undefined` during deactivation permanently deletes a user's pre-existing settings.
- The Rule: Before modifying any setting via `wsConfig.update`, inspect the exact original value of that setting (`globalValue` or `workspaceValue`) and persist it to `workspaceState`. During layout deactivation, strictly restore the saved value.
