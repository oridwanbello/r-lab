# Product Requirements Document (PRD) & Roadmap

**Project Name:** R Layout for VS Code
**Author:** Lead Architect
**Status:** Active

## 1. Executive Summary
Data scientists working in R and Python frequently miss the dedicated, multi-pane UI of IDEs like RStudio and Positron. R Layout is a VS Code extension that seamlessly orchestrates native editor panels into an RStudio-style 4-pane layout. It leverages standard VS Code APIs to remain universally compatible with forks like Google Antigravity, Cursor, and VSCodium.

## 2. Core Features & Requirements
* **Instant Layout Orchestration:** A single command to snap the editor into a customizable 65/35 asymmetrical 4-pane layout.
* **Universal AI Integration:** A user setting to dynamically assign the bottom-left layout to a standard Terminal, GitHub Copilot, Cursor AI, or the Antigravity Agent.
* **Environment Explorer:** A dedicated TreeView panel displaying current variables and data types.
* **Data Viewer:** A high-performance Webview for viewing and sorting dataframes.
* **Plot Gallery:** A dedicated Webview intercepting graphical outputs with history navigation.

## 3. Technical Design (TDD)
* **Language:** TypeScript / VS Code Extension API.
* **Layout Engine:** Uses `vscode.setEditorLayout` for the grid.
* **Agent Integration:** Reads `workspace.getConfiguration('r-layout.aiAgent')` to fire specific chat panel commands based on the user's IDE environment.
* **Environment Explorer:** Implements `TreeDataProvider` backed by DAP requests (`threads` → `stackTrace` → `scopes` → `variables`) for live variable inspection.
* **Plot Gallery:** Implements `WebviewViewProvider` with a `FileSystemWatcher` on a configurable output directory (default: `.r-layout/plots/`).
* **Data Viewer:** Implements `WebviewViewProvider` that serializes dataframes to JSON via DAP `evaluate` requests (R: `jsonlite::toJSON`, Python: `json.dumps`).

## 4. Ecosystem & Dependencies
To ensure best-in-class R support, R Layout will integrate with and build upon established tools:
* **VS Code R Support:** Leveraging official recommendations from the [VS Code R Language Guide](https://code.visualstudio.com/docs/languages/r).
* **Posit Tools:** 
    - **Air:** Integrating with the Posit Air extension (available on the Marketplace) for enhanced communication.
    - **Ark:** Evaluating the Ark kernel for improved performance and compatibility.

## 5. Roadmap

### Phase 1: Foundation 
- [x] Draft architectural documents.
- [x] Initialize TypeScript extension.
- [x] Build layout toggle command and Status Bar button.
- [x] Implement AI Agent configuration settings in `package.json`.

### Phase 2: Core Analysis Views 
- [x] Implement Environment Explorer (TreeView) using DAP requests.
- [x] Implement Plot Gallery (Webview) with output interception.
- [x] Implement Data Viewer (Webview) for high-performance dataframe sorting.

### Phase 3: Polish & Power Features
- [ ] Add custom layout presets (2-pane, 3-pane, custom ratios).
- [ ] Implement variable pinning in Environment Explorer.
- [ ] Add CSV/Excel export from Data Viewer.
- [ ] Integrate R package management view.
- [ ] Add plot export (PNG, SVG, PDF) from Plot Gallery.
- [ ] Implement keyboard shortcuts for all R Layout commands.

### Phase 4: Ecosystem Integration
- [ ] Deep integration with Posit Ark kernel for enhanced R support.
- [ ] Jupyter notebook variable bridging.
- [ ] Remote/SSH workspace compatibility testing.
- [ ] Marketplace publishing and CI/CD pipeline.