# R Quadrant

**An RStudio-style 4-pane layout orchestrator for VS Code.**

R Quadrant brings the familiar multi-pane workflow of RStudio to VS Code and its forks (Cursor, Google Antigravity, VSCodium). With a single command, snap your editor into a 4-quadrant layout optimized for data science — complete with a live variable explorer, plot gallery, and interactive data viewer.

---

## ✨ Features

### 🔲 Instant Layout Orchestration
One click to transform your editor into a 65/35 asymmetrical 4-pane grid:
- **Top Left** — Main editor
- **Bottom Left** — Console / AI Agent (configurable)
- **Top Right** — Environment Explorer
- **Bottom Right** — Plots & Data Viewer

### 🤖 Universal AI Integration
Choose your preferred AI assistant for the console quadrant:
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
- Navigate through plot history with ◀ ▶ controls
- Supports PNG, JPG, SVG, GIF, WebP, and BMP
- Configurable watch directory (default: `.r-quadrant/plots/`)

### 🔍 Data Viewer
Inspect dataframes directly from debug sessions:
- Click-to-sort columns (ascending / descending)
- Real-time row filtering
- Works with R (`data.frame`, `tibble`) and Python (`pandas.DataFrame`)

### 🚀 Advanced Tool Integration
R Quadrant is designed to be "Zero Friction" by default, but it is fully compatible with high-performance community tools:
- **`httpgd` Support** — Use the high-fidelity `httpgd` graphics device for interactive, vector-quality plotting inside the Plot Quadrant.
- **`ark` Console** — Seamlessly integrates with the `ark` (Jupyter-based) interactive console for a more powerful R programming experience.
- **DAP Integration** — Fully utilizes the Debug Adapter Protocol for real-time variable inspection.

---

## 🚀 Getting Started

1. Install the extension from the VS Code Marketplace (or build from source).
2. Open a workspace and press `Fn + F5` to try it in the Extension Development Host.
3. Click the **R Quadrant Layout** button in the Status Bar, or run `R Quadrant: Apply RStudio Layout` from the Command Palette.
4. Open the **R Quadrant** sidebar from the Activity Bar to access the Environment Explorer, Plot Gallery, and Data Viewer.

---

## ⚙️ Extension Settings

| Setting | Default | Description |
|---|---|---|
| `r-quadrant.rConsolePath` | `"R"` | Path or command for the R Console terminal. |
| `r-quadrant.plotOutputDir` | `".r-quadrant/plots"` | Relative path to the directory where plot images are saved. |

---

## 🎯 Commands

| Command | Description |
|---|---|
| `R Quadrant: Apply RStudio Layout` | Snap the editor into the 4-pane grid. |
| `R Quadrant: Inspect Variable` | Inspect a dataframe variable from the active debug session. |
| `Refresh Variables` | Refresh the Environment Explorer tree. |
| `Clear Plot History` | Clear all plots from the Plot Gallery. |

---

## 🛠️ Development

### Prerequisites
- Node.js 22+
- npm

### Setup
```bash
git clone https://github.com/oridwanbello/R-Quadrant.git
cd R-Quadrant
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
├── views/
│   ├── environmentExplorer.ts # Variable TreeView (DAP)
│   ├── plotGallery.ts         # Plot gallery (WebviewView)
│   └── dataViewer.ts          # Dataframe viewer (WebviewView)
└── util/
    └── debugSession.ts        # DAP helper utilities
```

---

## 📝 Release Notes

### 0.1.0
- **Environment Explorer**: Live variable inspection via Debug Adapter Protocol
- **Plot Gallery**: File-system-based plot capture with history navigation
- **Data Viewer**: Interactive dataframe viewer with sorting and filtering
- **R Quadrant Sidebar**: Dedicated Activity Bar container for all views
- **Modular architecture**: Refactored source into `layout/`, `views/`, and `util/` modules

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
