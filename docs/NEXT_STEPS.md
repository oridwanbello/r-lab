# Quadrant Extension: Next Development Steps

This document outlines the pending improvements and optimizations for the R Quadrant VS Code extension to be tackled in the next development session.

## 1. Session Continuity
**Current Behavior:**
When deactivating the quadrant layout, the extension currently disposes of all custom panels (Plots, Data Viewer, Help, etc.) and creates brand new terminal instances upon re-activation. This causes the user to lose their current R session progress, shell history, and the state of their analysis panels.

**Goal:**
Ensure that users never lose their active session state when toggling the quadrant view. All tabs should be preserved and relocated rather than recreated.

**Implementation Phases:**
- [ ] **Phase 1: Terminal Retention (Priority)**
    - Scan `vscode.window.terminals` for "R Console" and default "Terminal".
    - Reuse existing instances and relocate them to `ViewColumn.Two` using layout commands.
- [ ] **Phase 2: Analysis Panel Retention**
    - Modify `deactivateLayout` to stop disposing of `PlotsPanel`, `DataViewerPanel`, and `HelpPanel`.
    - Update `activateLayout` to check for existing panels and relocate them to their respective quadrants.
- [ ] **Phase 3: State Syncing**
    - Ensure that panels retained from previous sessions correctly sync with the current R environment state.

**Proposed Technical Approach:**
- For existing terminals/panels, use `vscode.commands.executeCommand` (e.g., `workbench.action.moveEditorToSecondGroup`) to reposition them.
- Use `vscode.window.tabGroups` to track tab locations during transitions.

## 2. Layout Activation Speed Optimization
**Current Behavior:**
While the quadrant layout activates at a decent speed, the transition still has some perceptible lag. The current implementation relies on a sequence of artificial `delay()` calls (e.g., `await delay(150)`, `await delay(200)`) to give VS Code's UI time to render panels and grids before firing the next command.

**Goal:**
Make the activation of the quadrant view feel completely instantaneous.

**Proposed Implementation:**
- **Audit Delays:** Review all `delay()` statements within the layout initialization sequence in `layoutManager.ts`.
- **Reduce or Eliminate:** See if the timeout durations can be safely reduced without breaking the layout.
- **Concurrent Execution:** Where possible, execute layout setup commands concurrently using `Promise.all()` instead of waiting for them sequentially.
- **Event-Driven UI Updates:** Investigate if we can replace arbitrary time delays with actual event listeners that fire exactly when the UI is ready.

## 3 Making the help results colorful in the help tab

## 4 ARK integration

## 5 Having tabs for multiple agents

## 6 Testing the data viewer and plot tabs

