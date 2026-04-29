# Change Log

All notable changes to the R Layout extension will be documented in this file.

## [0.5.0] - 2026-04-29

### Added
- RStudio 3-Pane Editor Layout: Reorganized the layout so the Source editor occupies the full left side, with two panes on the right.
- Plot Redirection: Added Set View Dir and Set View/Out Dir to the Plots panel for real-time redirection of R plot output.
- Smart Plot Appending: Implemented directory scanning to automatically increment plot IDs and prevent overwriting.
- Integrated R Help: Help documentation is now rendered as a tab within the editor layout.
- Run Source Icon: Added a theme-responsive Source File icon to the editor title bar.
- Stability Rules: Added AGENTS.md to enforce technical best practices.

### Changed
- Webview Architecture: Migrated all sidebar panels (Environment Explorer, Data Viewer, Plots) from Activity Bar WebviewViews to Editor Grid WebviewPanels for deep layout integration.
- Terminal Management: Implemented robust terminal reuse and vanishing console protection.
- Settings Preservation: The layout toggle now meticulously saves and restores global VS Code settings (closeEmptyGroups, terminal.integrated.defaultLocation) to avoid destructive overwrites.
- Cleanup Logic: The .r-layout directory is now cleaned up unconditionally on shutdown.
- UI Polish: Updated plot gallery with theme-responsive backgrounds and refined rounding.

## [0.2.0] - 2026-04-15

### Added
- Custom Plot Directory: Added toolbar tool to override plot locations with native folder picker support.

### Changed
- Silent Manual Refresh: Transitioned Data Viewer to a manual, zero-resource refresh mechanism.
- UI/UX Polish: Implemented premium canvas aesthetics for plots, Day/Night mode toggles, and instant tooltips.

## [0.1.0] - 2026-04-09

### Added
- Environment Explorer: Tree view displaying variables from the active debug session.
- Plot Gallery: Initial implementation watching .layout/plots/ for image files.
- Data Viewer: Initial implementation for inspecting dataframes.
- R Layout Sidebar: Initial Activity Bar view container (Since Deprecated).

## [0.0.1] - 2026-04-01

- Initial scaffold with layout toggle command and terminal configuration.