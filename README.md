# R Layout

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/i/oridwanbello.r-layout?label=VS%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=oridwanbello.r-layout) [![Visual Studio Marketplace Installs](https://vsmarketplacebadges.dev/installs/oridwanbello.r-layout.svg)](https://marketplace.visualstudio.com/items?itemName=oridwanbello.r-layout) [![Open VSX Downloads](https://img.shields.io/open-vsx/dt/oridwanbello/r-layout?label=Open%20VSX%20Downloads&logo=eclipseide)](https://open-vsx.org/extension/oridwanbello/r-layout)

An RStudio-inspired multi-pane layout orchestrator for VS Code.

![R Layout Showcase](https://raw.githubusercontent.com/oridwanbello/assets/main/images/r_layout_showcase.png)

> [!NOTE]
> This extension is currently in preview. We are actively refining the layout and feature set. Please report any issues on GitHub!

Transform your editor into an RStudio-inspired 3-pane grid with a single click. Optimized for data science, it includes a live variable explorer, interactive plot gallery, and high-performance data viewer.

## Core Features

- Instant Layout: Snaps your editor into a 3-pane grid (Source Editor, Terminal/Console, and Workspace/Plots).
- Workspace & Package Manager: Live variable inspector, dictionary-style object previews, and a 1-click interactive data frame viewer. Includes a dedicated tab to search, attach, and detach R packages.
- Plot Gallery & Export: Interactive plot navigation (scroll/pinch zoom, pan) with advanced export settings (PDF, SVG, EPS, PNG, JPG) and smart file size estimation.
- HTML Widget Viewer: Sandboxed layout tab for R `viewer()` outputs (Shiny apps, `htmlwidgets`, Quarto previews, vignettes).
- Integrated R Help & Smart Execution: KaTeX math rendering, cross-reference linking, and dynamic code execution (Run Source / Run Selection).

## Getting Started

1. Prerequisite: Ensure you have the official [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) extension installed.
2. Open a workspace and click "R Layout" in the Status Bar, or run `Toggle R Layout` from the Command Palette.
3. Open an `.R` file and click the source icon in the editor title bar. For `.Rmd`, `.qmd`, or Markdown files, select a code chunk or line and run the selection.

## Key Settings & Commands

| Feature | Description |
| ------- | ----------- |
| `r-layout.rConsoleType` | Select console type (`Auto Detect`, `Standard R`, `Radian`) to enforce bracketed paste. |
| `r-layout.rConsolePath` | Path or command for the R Console terminal (default: `"R"`). |
| `r-layout.restoreCustomPanelPositions` | If true, restores panels to custom dragged locations instead of strict 3-pane. |
| `r-layout.plotOutputDir` | Custom directory for R Layout plot images. Defaults to `.R-layout/plots` in the workspace or home directory. |
| `Toggle R Layout` | Snap the editor into or out of the 3-pane grid. |
| `Maximize Top Pane` | Expand the top-right pane; minimizes bottom panes. |

## Contributing

Interested in building the layout, fixing bugs, or reviewing our architecture? See our detailed [Contributing Guidelines](CONTRIBUTING.md) for environment setup and project structure.

## Trademarks & License

- R Logo: © The R Foundation (CC-BY-SA 4.0)
- Tidyverse: Trademark of Posit Software, PBC.
- Bioconductor: Trademark of the Bioconductor Project.
- RDocumentation: © DataCamp, Inc.
- License: [MIT License](LICENSE.txt)
