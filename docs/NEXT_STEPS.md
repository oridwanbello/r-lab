# Quadrant Extension: Next Development Steps

This document outlines the pending improvements and optimizations for the R Quadrant VS Code extension to be tackled in the next development session.

## 1. Terminal State Retention (Session Continuity)
**Current Behavior:**
When deactivating the quadrant layout (returning to normal view), the existing "R Console" and shell terminals are retained. However, when re-activating the quadrant layout, the extension currently creates brand new terminal instances, causing the user to lose their current R session progress and shell history.

**Goal:**
Ensure that users never lose their active session state when toggling the quadrant view.

**Proposed Implementation:**
- Before creating new terminals during layout activation, scan `vscode.window.terminals` for existing instances of the "R Console" and the default shell.
- If they exist, **reuse them** instead of calling `vscode.window.createTerminal()`.
- Because we cannot pass `location: { viewColumn: Two }` to an already existing terminal, we will need to programmatically focus the preserved terminal's tab and use VS Code's layout commands (e.g., `workbench.action.moveEditorToSecondGroup`) to relocate it into the bottom-left quadrant.

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

