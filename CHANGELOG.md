# Change Log

All notable changes to the R Layout extension will be documented in this file.

## [0.3.0] - 2026-05-15

### Added

- **Integrated R Help Upgrades**: Implemented KaTeX mathematical equation rendering, a Smart Linker for automatic cross-references in the "See Also" section, and a "Run" button for interactive execution of code examples directly to the R console.
- **Advanced Diagnostics**: Upgraded the Problems view to use official VS Code Codicons, added accordion-style collapsible file groupings, and introduced per-file problem count badges.
- **Seamless Top Pane Maximization**: Implemented a CSS-based content-hiding strategy that minimizes the bottom-right panels to show only their tab bars, maximizing usable workspace without breaking VS Code's editor group constraints.
- **Robust Layout Restoration**: Engineered a two-step restoration logic (pixel equalization + proportional re-stamping) that prevents horizontal layout corruption on short windows while ensuring panes resize proportionally during window expansion.
- **Progress-Synced Notifications**: Replaced static informational messages with ephemeral progress-bar notifications that stay in sync with actual activation/deactivation timing.
- **RStudio 3-Pane Editor Layout**: Reorganized the layout so the Source editor occupies the full left side, with two panes on the right.
- **Plot Redirection**: Added Set View Dir and Set View/Out Dir to the Plots panel for real-time redirection of R plot output.
- **Smart Plot Appending**: Implemented directory scanning to automatically increment plot IDs and prevent overwriting.
- **Run Source Icon**: Added a theme-responsive Source File icon to the editor title bar.

### Changed

- **Aesthetic Refinement**: Polished the Workspace Explorer and Data Viewer table headers with refined typography (`font-weight: 600`, `font-style: italic`) for a more consistent, native VS Code look.
- **Local Workspace Structure**: Introduced a private `temp/` directory (automatically ignored via `.git/info/exclude`) for local scratchpads and experimental assets.
- **Documentation Overhaul**: Standardized the README, internal source comments, and project manifests to reflect the latest feature set.
- **Webview Architecture**: Migrated all sidebar panels (Environment Explorer, Data Viewer, Plots) from Activity Bar WebviewViews to Editor Grid WebviewPanels for deep layout integration.
- **Terminal Management**: Implemented robust terminal reuse and vanishing console protection.
- **Settings Preservation**: The layout toggle now meticulously saves and restores global VS Code settings (`closeEmptyGroups`, `terminal.integrated.defaultLocation`) to avoid destructive overwrites.
- **Cleanup Logic**: The `.r-layout` directory is now cleaned up unconditionally on shutdown.
- **UI Polish**: Updated plot gallery with theme-responsive backgrounds and refined rounding.

## [0.2.0] - 2026-04-15

### Added

- **Custom Plot Directory**: Added toolbar tool to override plot locations with native folder picker support.
- **Environment Explorer**: Tree view displaying variables from the active debug session.
- **Plot Gallery**: Initial implementation watching `.layout/plots/` for image files.
- **Data Viewer**: Initial implementation for inspecting dataframes.

### Changed

- **Silent Manual Refresh**: Transitioned Data Viewer to a manual, zero-resource refresh mechanism.
- **UI/UX Polish**: Implemented premium canvas aesthetics for plots, Day/Night mode toggles, and instant tooltips.

## [0.1.0] - 2026-04-01

- Initial scaffold with layout toggle command and terminal configuration.
