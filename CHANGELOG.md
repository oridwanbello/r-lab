# Change Log

All notable changes to the "R Layout" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] — 2026-04-09

### Added
- **Environment Explorer**: TreeView displaying variables from the active debug session via DAP requests. Supports type-aware icons, expandable nested objects, and auto-refresh on debug events.
- **Plot Gallery**: WebviewView that watches a configurable directory (`.layout/plots/`) for new image files. Includes previous/next navigation and clear history.
- **Data Viewer**: WebviewView for inspecting dataframes with click-to-sort columns and real-time row filtering. Supports R (jsonlite) and Python (pandas) serialization.
- **R Layout Sidebar**: Custom Activity Bar view container housing all three analysis views.
- **New commands**: `layout.environmentExplorer.refresh`, `layout.plotGallery.clear`, `layout.dataViewer.inspect`.
- **New setting**: `layout.plotOutputDir` for configuring the plot output directory.
- **Architecture docs**: Added `docs/architecture.md` describing the modular component structure.

### Changed
- **Source refactored** into modular structure: `layout/`, `views/`, `util/` directories.
- **`extension.ts`** simplified to a thin orchestrator that delegates to dedicated modules.
- **Version bumped** to 0.1.0.
- **README** rewritten with full feature documentation.
- **`docs/setup.md`** updated with new project structure.
- **`docs/executive_blueprint.md`** updated — Phase 2 checked off, Phase 3 & 4 roadmap added.

## [Unreleased]

- Initial release