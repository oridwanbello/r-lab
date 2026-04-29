# Next Steps and Roadmap

This document outlines the immediate development priorities and long-term goals for the R Layout extension.

## 1. Recently Completed Tasks

- 3-Pane WebviewPanel Migration: Successfully moved Workspace, Plots, Data Viewer, and Help out of the sidebar and directly into the editor grid.
- Terminal Stability: Resolved the "Vanishing R Console" bug. The extension now reliably identifies and reuses existing R Consoles, even after an extension host restart, without crashing the active R session.
- Settings Persistence: Implemented safe caching and restoration for VS Code user settings (workbench.editor.closeEmptyGroups, terminal.integrated.defaultLocation) to prevent the extension from permanently overwriting user preferences.
- Removed Old Layout Artifacts: Stripped away remaining logic and dependencies tied to the obsolete 4-pane architecture and sidebar views.

## 2. Suspended Tasks

- Universal AI Hub (Chat Tab): 
  - Goal: Reintroduce the AI Chat as the first tab in the Top-Right pane.
  - Status: Suspended.
  - Reason: Current API limitations cause the chat view command to open the "Editor Chat" instead of the "Panel Chat", leading to duplicate chat instances and erratic focus stealing. We are waiting for a more reliable VS Code API command or workaround before proceeding.

## 3. Short-Term Roadmap

- Performance Optimization: Replace sequential delay() calls in layoutManager.ts with Promise.all() where possible to speed up the layout activation sequence.
- Help Panel Search: Improve the integrated R Help panel to support direct search queries from the R Console.

## 4. Long-Term Roadmap

- httpgd Support: Implement deep integration with the httpgd graphics device for interactive, vector-quality plotting inside the Plot Layout.
- Notebook Mode: Explore seamless integration with the Ark kernel (Jupyter) for a more interactive, notebook-style console experience while preserving the multi-pane grid.
