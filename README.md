# R Layout

An RStudio-style 3-pane layout orchestrator for VS Code.

R Layout brings the familiar multi-pane workflow of RStudio to VS Code and its forks. With a single command, snap your editor into a layout optimized for data science, complete with a live variable explorer, plot gallery, and interactive data viewer.

## Features

### Instant Layout Orchestration
One click to transform your editor into an asymmetrical 3-pane grid:
- **Left Pane**: Main source editor (Full Height).
- **Top-Right Pane**: R Console, Terminal, Problems, and Help.
- **Bottom-Right Pane**: Workspace Explorer, Plots, and Data Viewer.

### Workspace Explorer
A live variable inspector that synchronizes with your R session to display:
- Active variables, types, and values.
- Direct interaction with the Data Viewer for dataframes and tibbles.

### Plot Gallery
A high-fidelity rendering panel for your R plots:
- **Auto-Sync**: Automatically detects and displays new plots generated from the console.
- **Save-As**: Export any plot to PNG or SVG with white-background enforcement.
- **History**: Navigate through your session's plot history with dedicated controls.

### Data Viewer
A high-performance spreadsheet-style inspector:
- **Silent Refresh**: Zero-resource background footprint; refreshes only on demand.
- **Search & Sort**: Real-time filtering and multi-column sorting.
- **Responsive Theme**: Automatic light/dark mode support with curated aesthetics.


## Getting Started

1. Install the extension from the VS Code Marketplace.
2. Open a workspace.
3. Click the "R Layout" button in the Status Bar, or run "Toggle R Layout" from the Command Palette.
4. Open an R file and click the "Source File" icon in the editor title bar to run your code.

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| r-layout.rConsolePath | "R" | Path or command for the R Console terminal. |
| r-layout.useArkInteractiveConsole | false | If true, launches a Jupyter Interactive Window as the R Console. |

## Commands

| Command | Description |
|---|---|
| Toggle R Layout | Snap the editor into or out of the 3-pane grid. |
| R Layout: Clear Plot Gallery | Clear all plots from the Plot Gallery. |
| Maximize Top Pane | Expand the top-right pane; minimizes bottom panes to tabs. |
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
