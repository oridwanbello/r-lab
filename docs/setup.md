# Setup Guide

This guide describes how to set up the development environment for the R Layout extension.

## 1. Prerequisites

Before you begin, ensure you have the following installed:

- Node.js (version 22.x or higher)
- npm (comes with Node.js)
- VS Code (or a compatible fork like VSCodium, Cursor, etc.)

## 2. Project Installation

Clone the repository and install the dependencies:

```bash
git clone https://github.com/oridwanbello/r-layout.git
cd r-layout
npm install
```

## 3. Directory Structure

The project has been refactored into a modular architecture to support the 3-pane layout system:

- src/extension.ts: The main entry point.
- src/layout/layoutManager.ts: The core engine that orchestrates the VS Code layout, grid groups, and terminal preservation.
- src/panels/: Contains the WebviewPanel singletons for the layout:
  - dataViewerPanel.ts: Renders dataframe tables.
  - helpPanel.ts: Displays integrated R documentation.
  - plotsPanel.ts: Watches for and renders plot images.
  - problemsPanel.ts: Visualizes workspace diagnostics with native Codicons.
  - workspacePanel.ts: Renders the DAP variable tree.
- src/util/: Helper utilities (e.g., Debug Adapter Protocol functions).

## 4. Building and Running

To compile the TypeScript code and launch the extension in a test environment:

1. Open the project in VS Code.
2. Press F5. This will compile the code, launch a new "Extension Development Host" window, and attach the debugger.

Alternatively, to compile via the command line:

```bash
# Compile once
npm run compile

# Watch mode (recompiles automatically on save)
npm run watch
```

## 5. Debugging and Testing

- Console Logs: console.log statements within the extension code will appear in the "Debug Console" of your primary VS Code window.
- Testing the Layout: In the Extension Development Host, press Cmd+Shift+P and execute "Toggle R Layout" to observe the 3-pane orchestration.
- Reloading: If you make changes to the source code, compile them, then run the "Developer: Reload Window" command in the Extension Development Host to see the updates.

## 6. Packaging for Distribution

To bundle the extension into a .vsix file for installation or distribution, you need the vsce CLI tool:

```bash
# Install vsce globally if you haven't already
npm install -g @vscode/vsce

# Package the extension
vsce package
```
