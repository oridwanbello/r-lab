# R Layout

**An RStudio-style 4-pane layout orchestrator for VS Code.**

R Layout brings the familiar multi-pane workflow of RStudio to VS Code and its forks (Cursor, Google Antigravity, VSCodium). With a single command, snap your editor into a 4-layout layout optimized for data science — complete with a live variable explorer, plot gallery, and interactive data viewer.

---

## ✨ Features

### 🔲 Instant Layout Orchestration
One click to transform your editor into a 65/35 asymmetrical 4-pane grid:
- **Top Left** — Main editor
- **Bottom Left** — Console / AI Agent (configurable)
- **Top Right** — Environment Explorer
- **Bottom Right** — Plots & Data Viewer

### 🤖 Universal AI Integration
Choose your preferred AI assistant for the console layout:
- Standard Terminal / R Console
- GitHub Copilot
- Google Antigravity Agent
- Cursor AI

### 📊 Environment Explorer
A live TreeView that displays variables from your active debug session:
- Type-aware icons (numbers, strings, arrays, dataframes, functions)
- Expandable nested objects
- Auto-refreshes when the debugger pauses

### 🎨 Plot Gallery
A dedicated panel that watches for new plot outputs:
- **Custom Plot Directory**: Override the default output folder via a sleek toolbar dropdown with a native folder picker.
- **Canvas Aesthetic**: High-fidelity rendering with internal padding and shadows for a premium feel.
- **Navigate**: History navigation with ◀ ▶ controls.
- **Supports**: PNG, JPG, SVG, GIF, WebP, BMP, and ICO.

### 🔍 Data Viewer
Inspect dataframes directly from your R session:
- **Silent Manual Refresh**: Re-read data from disk with one click, consuming zero background resources.
- **Type-aware Column Formatting**: Clean, readable tables with automatic alignment.
- **Sorting & Filtering**: Real-time row filtering and click-to-sort columns.
- **Night Mode**: Fully dimmed dark mode support for late-night data exploration.

### 🚀 Advanced Tool Integration
R Layout is designed to be "Zero Friction" by default, but it is fully compatible with high-performance community tools:
- **`httpgd` Support** — Use the high-fidelity `httpgd` graphics device for interactive, vector-quality plotting inside the Plot Layout.
- **`ark` Console** — Seamlessly integrates with the `ark` (Jupyter-based) interactive console for a more powerful R programming experience.
- **DAP Integration** — Fully utilizes the Debug Adapter Protocol for real-time variable inspection.

---

## 🚀 Getting Started

1. Install the extension from the VS Code Marketplace (or build from source).
2. Open a workspace and press `Fn + F5` to try it in the Extension Development Host.
3. Click the **R Layout Layout** button in the Status Bar, or run `R Layout: Apply RStudio Layout` from the Command Palette.
4. Open the **R Layout** sidebar from the Activity Bar to access the Environment Explorer, Plot Gallery, and Data Viewer.

---

## ⚙️ Extension Settings

| Setting | Default | Description |
|---|---|---|
| `r-layout.rConsolePath` | `"R"` | Path or command for the R Console terminal. |
| `r-layout.plotOutputDir` | `".r-layout/plots"` | Relative path to the directory where plot images are saved. |

---

## 🎯 Commands

| Command | Description |
|---|---|
| `R Layout: Apply RStudio Layout` | Snap the editor into the 4-pane grid. |
| `R Layout: Inspect Variable` | Inspect a dataframe variable from the active debug session. |
| `Refresh Variables` | Refresh the Environment Explorer tree. |
| `Clear Plot History` | Clear all plots from the Plot Gallery. |

---

## 🛠️ Development

### Prerequisites
- Node.js 22+
- npm

### Setup
```bash
git clone https://github.com/oridwanbello/R-Layout.git
cd R-Layout
npm install
```

### Build & Test
```bash
npm run compile    # Build via webpack
npm run watch      # Watch mode for development
npm run lint       # Run ESLint
npm run test       # Run tests
```

### Debug
1. Run `npm run watch` in a terminal.
2. Press `F5` to launch the Extension Development Host.
3. Test the commands and sidebar views in the new window.

---

## 📁 Project Structure

```
src/
├── extension.ts               # Entry point (orchestrator)
├── layout/
│   └── layoutManager.ts       # Layout toggle & Status Bar
├── panels/
│   ├── environmentExplorer.ts # Variable TreeView (DAP)
│   ├── plotsPanel.ts          # Plot gallery (WebviewPanel)
│   ├── dataViewerPanel.ts     # Dataframe viewer (WebviewPanel)
│   └── helpPanel.ts           # Integrated R Help
└── util/
    └── debugSession.ts        # DAP helper utilities
```

---

## 📝 Release Notes

### 0.2.0 (Current)
- **Custom Plot Directory**: Added toolbar tool to override plot locations with native folder picker support.
- **Silent Manual Refresh**: Transitioned Data Viewer to a manual, resource-zero refresh mechanism.
- **UI/UX Polish**: Implemented premium canvas aesthetics for plots, Day/Night mode toggles, and instant tooltips.
- **Dynamic Resources**: Support for loading plots from any absolute path on the filesystem.

### 0.1.0
- **Environment Explorer**: Live variable inspection via Debug Adapter Protocol
- **Plot Gallery**: File-system-based plot capture with history navigation
- **Data Viewer**: Interactive dataframe viewer with sorting and filtering
- **R Layout Sidebar**: Dedicated Activity Bar container for all views
- **Modular architecture**: Refactored source into `layout/`, `panels/`, and `util/` modules

### 0.0.1
- Initial scaffold with layout toggle command and AI agent configuration

---

## 📜 Credits

This extension integrates high-quality resources from the R community. We would like to acknowledge the following projects for their contributions to the ecosystem:

- **R Logo** — The R logo is © 2016 The R Foundation and is used under the [CC-BY-SA 4.0](https://www.r-project.org/logo/) license.
- **Tidyverse** — The Tidyverse hex logo and branding are trademarks of Posit Software, PBC.
- **Bioconductor** — The Bioconductor logo is a trademark of the Bioconductor Project.
- **Rdocumentation** — The Rdocumentation icon is a custom recreation inspired by the official rdocumentation.org favicon.

---

## 📄 License

[MIT](LICENSE)
