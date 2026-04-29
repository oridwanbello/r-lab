# R Layout

An RStudio-style 3-pane layout orchestrator for VS Code.

R Layout brings the familiar multi-pane workflow of RStudio to VS Code and its forks. With a single command, snap your editor into a layout optimized for data science, complete with a live variable explorer, plot gallery, and interactive data viewer.

## Features

### Instant Layout Orchestration
One click to transform your editor into an asymmetrical 3-pane grid:
- Left Pane: Main source editor (Full Height).
- Top-Right Pane: Console, Terminal, Problems, and Help.
- Bottom-Right Pane: Environment Explorer, Plots, and Data Viewer.

### Universal AI Integration
Choose your preferred AI assistant for the console layout using the extension settings. The layout seamlessly integrates your terminal and workspace panels alongside standard editor groups.

### Environment Explorer
A live variable inspector powered by the Debug Adapter Protocol (DAP):
- Type-aware icons for numbers, strings, arrays, dataframes, and functions.
- Expandable nested objects.
- Auto-refreshes when the debugger pauses.

### Plot Gallery
A dedicated panel that watches for new plot outputs:
- Custom Plot Directory: Override the default output folder via a native folder picker.
- Canvas Aesthetic: High-fidelity rendering with internal padding and shadows.
- Navigate: History navigation with previous and next controls.
- Supports: PNG, JPG, SVG, GIF, WebP, BMP, and ICO.

### Data Viewer
Inspect dataframes directly from your R session:
- Silent Manual Refresh: Re-read data from disk with one click, consuming zero background resources.
- Type-aware Column Formatting: Clean, readable tables with automatic alignment.
- Sorting and Filtering: Real-time row filtering and click-to-sort columns.
- Night Mode: Fully dimmed dark mode support for late-night data exploration.

## Getting Started

1. Install the extension from the VS Code Marketplace.
2. Open a workspace.
3. Click the "R Layout" button in the Status Bar, or run "Toggle R Layout" from the Command Palette.
4. Open an R file and click the "Source File" icon in the editor title bar to run your code.

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| r-layout.rConsolePath | "R" | Path or command for the R Console terminal. |
| r-layout.plotOutputDir | ".r-layout/plots" | Relative path to the directory where plot images are saved. |
| r-layout.useArkInteractiveConsole | false | If true, launches a Jupyter Interactive Window as the R Console. |

## Commands

| Command | Description |
|---|---|
| Toggle R Layout | Snap the editor into or out of the 3-pane grid. |
| R Layout: Clear Plot Gallery | Clear all plots from the Plot Gallery. |
| Maximize Top Pane | Expand the top-right pane to fill the right column. |
| Restore Pane Split | Restore the even split between top-right and bottom-right panes. |
| Source File to R Console | Execute the active R script in the console. |

## Development

### Prerequisites
- Node.js 22 or higher
- npm

### Setup
```bash
git clone https://github.com/oridwanbello/R-Layout.git
cd R-Layout
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
├── panels/
│   ├── workspacePanel.ts      # Variable inspector (DAP)
│   ├── plotsPanel.ts          # Plot gallery (WebviewPanel)
│   ├── dataViewerPanel.ts     # Dataframe viewer (WebviewPanel)
│   ├── helpPanel.ts           # Integrated R Help
│   └── problemsPanel.ts       # Temporary layout anchor
└── util/
    └── debugSession.ts        # DAP helper utilities
```

## Credits

This extension integrates high-quality resources from the R community:
- R Logo: Copyright 2016 The R Foundation (CC-BY-SA 4.0).
- Tidyverse: Trademarks of Posit Software, PBC.
- Bioconductor: Trademark of the Bioconductor Project.

## License

MIT
