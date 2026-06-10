# Architecture

## 1. High-Level Concept

The R Layout extension orchestrates a 3-pane layout within VS Code tailored for R development, visually mirroring the standard RStudio interface. Rather than relying on standard VS Code sidebar views, it implements all major UI components (Workspace, Visuals, Data Viewer, and Tools) as WebviewPanels integrated directly into the editor grid.

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
5. Layout Tab Protection: When `r-layout.protectLayoutTabs` is enabled, accidental closure of R Layout webview tabs and the owned shell Terminal recreates them in their architectural pane and then re-stamps the full strict tab order. R Console is excluded because closing it represents session termination.

### Deactivation Sequence

1. Serialization: Current states of the webviews (e.g., which variable is being inspected) are saved to memory.
2. Teardown: All custom WebviewPanel tabs are disposed.
3. Terminal Restoration: Existing terminals are moved back to the default bottom panel, remaining active to preserve the R session.
4. Settings Restoration: Overridden VS Code settings are meticulously restored to their pre-activation states using the workspaceState cache.

## 4. UI Panels (WebviewPanels)

Each tool is implemented as a WebviewPanel managed by a singleton class pattern.

### WorkspacePanel

Reads live R session state to display active variables and loaded packages. It operates with a 3-tier fallback priority:

1. Native `vscode-R` session watcher state files (`globalenv.json`, `search.json`).
2. R Layout's custom atomic file-watcher logs (`.workspace_meta.txt` and `.tsv` dumps).
3. A fallback background `Rscript` process that parses `.RData`.
It renders the results in a custom HTML webview table, allowing users to view data frames or inspect package attachment states.

### DataViewerPanel

Receives data frame, matrix, and 3D array inspection requests from the WorkspacePanel. It renders interactive HTML tables with sorting, row limits, slice navigation, and theme-responsive styling.

### VisualsPanel

Hosts the Plots and Viewer surfaces inside one editor tab. The Plots subtab monitors the plot directory (default: `.R-layout/plots/`) and displays the latest R graphics. The Viewer subtab renders R `viewer()` output, HTML widgets, Shiny apps, package help pages, and Quarto previews.

### ToolsPanel

Hosts the R Help and Problems surfaces inside one editor tab. The Help subtab runs documentation lookups through `Rscript`, parses the HTML, and injects KaTeX math rendering, cross-reference links, and "Run" buttons for example code. The Problems subtab queries `vscode.languages.getDiagnostics()` and renders errors, warnings, and hints with native VS Code styling.

### Legacy Panels

`PlotsPanel`, `ViewerPanel`, `HelpPanel`, and `ProblemsPanel` still exist as implementation classes or compatibility paths, but the active default layout presents them through `VisualsPanel` and `ToolsPanel`. Local HTML widgets are served through an internal localhost file server with path containment checks.
