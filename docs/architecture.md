# Architecture

## 1. High-Level Concept

The R Lab extension orchestrates a 3-pane layout within VS Code tailored for R development, visually mirroring the standard RStudio interface. Rather than relying on standard VS Code sidebar views, it implements all major UI components (Workspace, Visuals, Data Viewer, and Tools) as WebviewPanels integrated directly into the editor grid.

## 2. Core Modules

The architecture is divided into three primary concerns:

- extension.ts: The minimal entry point. It registers the layout orchestration command and delegates execution to layoutManager.ts.
- layoutManager.ts: The engine of the extension. It manages the physical grid layout, component instantiation, and lifecycle state.
- panels/: A directory containing singleton classes that govern individual UI components (e.g., WorkspacePanel, VisualsPanel, DataViewerPanel, ToolsPanel).

## 3. Layout Manager

The layout manager handles the complex sequence of safely restructuring the VS Code environment.

### Activation Sequence

When a user triggers the layout:

1. State Preservation: It records the exact values of global settings like workbench.editor.closeEmptyGroups.
2. Clean Slate: It closes all sidebars, auxiliary bars, and terminal panels.
3. Grid Construction: It forces a 3-pane layout via vscode.setEditorLayout.
4. Component Placement:
    - Group 1 (Left): Receives the user's active source files.
    - Group 2 (Top-Right): Populated with the R Console, standard Terminal, and Tools panel.
    - Group 3 (Bottom-Right): Populated with the Workspace Explorer, Visuals panel, and Data Viewer.
5. Layout Tab Protection: When `r-lab.protectLayoutTabs` is enabled, accidental closure of R Lab webview tabs and the owned shell Terminal recreates them in their architectural pane and then re-stamps the full strict tab order. R Console is excluded because closing it represents session termination.

### Deactivation Sequence

1. Serialization: Current states of the webviews (e.g., which variable is being inspected) are saved to memory.
2. Teardown: All custom WebviewPanel tabs are disposed.
3. Terminal Restoration: Existing terminals are moved back to the default bottom panel, remaining active to preserve the R session.
4. Settings Restoration: Overridden VS Code settings are meticulously restored to their pre-activation states using the workspaceState cache.

## 4. UI Panels (WebviewPanels)

Each tool is implemented as a WebviewPanel managed by a singleton class pattern.

### WorkspacePanel

Reads live R session state to display active variables and loaded packages. It operates with a 2-tier fallback priority:

1. R Lab's custom atomic file-watcher logs (`.workspace_meta.txt` and `.tsv` dumps).
2. A fallback background `Rscript` process that parses `.RData`.
   It renders the results in a custom HTML webview table, allowing users to view data frames or inspect package attachment states.

### DataViewerPanel

Receives data frame, matrix, and 3D array inspection requests from the WorkspacePanel. It renders interactive HTML tables with sorting, row limits, slice navigation, and theme-responsive styling.

### VisualsPanel

Hosts the Plots and Viewer surfaces inside one editor tab. The Plots subtab monitors the plot directory (default: `.R-lab/plots/`) and displays the latest R graphics. The Viewer subtab renders R `viewer()` output, HTML widgets, Shiny apps, package help pages, and Quarto previews.

### ToolsPanel

Hosts the R Help and Problems surfaces inside one editor tab. The Help subtab runs documentation lookups through `Rscript`, parses the HTML, and injects KaTeX math rendering, cross-reference links, and "Run" buttons for example code. The Problems subtab queries `vscode.languages.getDiagnostics()` and renders errors, warnings, and hints with native VS Code styling.

### Legacy Panels

`PlotsPanel` and `ViewerPanel` still exist as hosted implementation classes inside `VisualsPanel`. The legacy standalone `HelpPanel` and `ProblemsPanel` have been removed, and their logic has been consolidated directly inside `ToolsPanel`. Local HTML widgets are served through an internal localhost file server with path containment checks.

## 5. Dependency Model (vscode-R)

R Lab implements a **soft dependency** architecture with the official `vscode-R` extension:

- **Static Editor Support:** We delegate syntax highlighting, Language Server Protocol (LSP) code intelligence (autocompletion, hover cards, parameter hints), and document diagnostics (Problem markers) to `vscode-R`. This ensures a feature-rich R coding environment in Group 1 without code duplication.
    - **Forced Extension Startup:** R Lab explicitly registers `REditorSupport.r` under `extensionDependencies` in `package.json` and activates immediately via `onStartupFinished`. This design decision forces VS Code to activate `vscode-R` on startup, bypassing `vscode-R`'s lazy-loading limitations (which relies on `workspaceContains` and fails to activate for single files, newly created scripts, or non-workspace sessions). This guarantees that syntax highlighting and autocompletions are active immediately on startup, without requiring the user to manually launch the R Terminal belonging to `vscode-R` or click the R extension icon on the Activity Bar to reveal the `vscode-R` workspace view (both of which are the only ways to otherwise force it to start).
- **Runtime Session Decoupling:** R Lab is completely independent of `vscode-R`'s active session state and runtime watchers. We run our own R console terminal process and custom `.Rprofile` callbacks, storing state locally (and streaming it in-memory via TCP sockets in v0.5.0). We do not attach to `vscode-R`'s WebSocket connection or parse its JSON-RPC payload, ensuring that future updates to `vscode-R` never break R Lab's session synchronization.
