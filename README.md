# R Layout

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/i/oridwanbello.r-layout?label=VS%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=oridwanbello.r-layout) [![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs/oridwanbello.r-layout.svg)](https://marketplace.visualstudio.com/items?itemName=oridwanbello.r-layout) [![Open VSX Downloads](https://img.shields.io/open-vsx/dt/oridwanbello/r-layout?label=Open%20VSX%20Downloads&logo=eclipseide)](https://open-vsx.org/extension/oridwanbello/r-layout)

An RStudio-inspired multi-pane layout orchestrator for VS Code.
![R Layout Showcase](https://raw.githubusercontent.com/oridwanbello/assets/main/images/r_layout_showcase.png)

> [!NOTE]
> This extension is currently in **Preview**. We are actively refining the layout and feature set. Please report any issues on GitHub!

R Layout brings the familiar multi-pane workflow of RStudio to VS Code and its forks. With a single command, snap your editor into a layout optimized for data science, complete with a live variable explorer, plot gallery, and interactive data viewer.

## Features

### Instant Layout Orchestration

One click to transform your editor into an RStudio-inspired 3-pane grid.

- **Left**: Main source editor (Full Height)
- **Top-Right**: R Console, Terminal, Problems, Help
- **Bottom-Right**: Workspace, Plots, Data Viewer, Viewer

### Workspace & Package Manager

A live variable inspector and environment manager.

- **Inline Previews**: Elegant dictionary-style previews for lists and dataframes with un-cluttered horizontal scrolling.
- **Data Viewing**: 1-click inspection of dataframes and matrices using a high-performance, spreadsheet-style viewer.
- **Package Control**: Instantly search, attach, and detach R packages via dedicated subtabs.

### Plot Gallery & Export

A high-fidelity rendering panel for your R plots.

- **Interactive Navigation**: Scroll/pinch-to-zoom and click-to-pan with precision toolbar controls.
- **Advanced Export**: Save plots in vector (`PDF`, `SVG`, `EPS`) or raster (`PNG`, `JPG`) formats with dimension controls and unit auto-switching.

### HTML Widget & Shiny Viewer

Host R `viewer()` outputs (Shiny apps, `htmlwidgets`, package vignettes) inside VS Code.

- Proxies local and localhost URLs into a sandboxed layout tab.
- Toolbar controls to toggle night mode, navigate history, refresh, delete widgets, and open in an external browser.

### Integrated R Help & Smart Execution

A professional documentation viewer and intelligent execution routing.

- **Docs**: KaTeX math rendering, cross-reference linking, and embedded "Run" buttons for examples.
- **Smart Execution**: The "Run Source / Selection" button dynamically runs only the highlighted code when text is highlighted. Natively supports `.Rmd`/`.qmd` context execution.
- **Diagnostics**: A native Codicon-integrated problems panel with collapsible file groups.

## Getting Started

### Prerequisites

- **vscode-R**: You must have the [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension installed. R Layout relies on it for code execution and providing live workspace data. (It will be installed automatically if you install R Layout from the marketplace).

### Installation

1. Install the extension from the VS Code Marketplace.
2. Open a workspace.
3. Click the "R Layout" button in the Status Bar, or run "Toggle R Layout" from the Command Palette.
4. Open an R file and click the "Source File" icon in the editor title bar to run your code.

## Extension Settings

| Setting                           | Default | Description                                                      |
| --------------------------------- | ------- | ---------------------------------------------------------------- |
| r-layout.rConsolePath             | "R"     | Path or command for the R Console terminal.                      |
| r-layout.restoreCustomPanelPositions | false | Restore the webview panels to custom pane locations set by the user during their last session. |
| r-layout.plotOutputDir | "" | A custom directory path where R Layout should silently write plot images. If left blank, it uses `.r_layout/plots` in the workspace root. |

## Commands

| Command                      | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| Toggle R Layout              | Snap the editor into or out of the 3-pane grid.                  |
| R Layout: Clear Plot Gallery | Clear all plots from the Plot Gallery.                           |
| Maximize Top Pane            | Expand the top-right pane; minimizes bottom panes to tabs.       |
| Restore Pane Split           | Restore the even split between top-right and bottom-right panes. |
| Source File to R Console     | Execute the active R script in the console.                      |

## Development

### Prerequisites

- Node.js 22 or higher
- npm

### Setup

```bash
git clone https://github.com/oridwanbello/r-layout.git
cd r-layout
npm install
```

### Build and Test

```bash
npm run compile
npm run watch
npm run lint
npm run test
```

## Project Structure

```text
src/
├── extension.ts               # Entry point (orchestrator)
├── layout/
│   └── layoutManager.ts       # Layout toggle and Status Bar
└── panels/
    ├── workspacePanel.ts      # Variable inspector
    ├── plotsPanel.ts          # Plot gallery (WebviewPanel)
    ├── dataViewerPanel.ts     # Dataframe viewer (WebviewPanel)
    ├── helpPanel.ts           # Integrated R Help
    └── problemsPanel.ts       # Temporary layout anchor
```

## Trademarks & Attribution

The following trademarks and logos used in this extension are the property of their respective owners:

- [R Logo](https://www.r-project.org/logo/) : Copyright © 2016 The R Foundation. Licensed under [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- [Tidyverse](https://tidyverse.org/) : Trademark of Posit Software, PBC.
- [Bioconductor](https://bioconductor.org/) : Trademark of the Bioconductor Project.
- [RDocumentation](https://www.rdocumentation.org/) : Copyright © DataCamp, Inc.

## License

[MIT License](LICENSE.txt)
