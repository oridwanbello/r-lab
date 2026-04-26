# Quadrant Extension: Next Development Steps

This document outlines the pending improvements and optimizations for the R Quadrant VS Code extension to be tackled in the next development session.

## 1. Session Continuity
**Current Behavior:**
When deactivating the quadrant layout, the extension currently disposes of all custom panels (Plots, Data Viewer, Help, etc.) and creates brand new terminal instances upon re-activation. This causes the user to lose their current R session progress, shell history, and the state of their analysis panels.

**Goal:**
Ensure that users never lose their active session state when toggling the quadrant view. All tabs should be preserved and relocated rather than recreated.

**Implementation Phases:**
- [x] **Phase 1: Terminal Retention (Priority)**
    - Scan `vscode.window.terminals` for "R Console" and default "Terminal".
    - Reuse existing instances and relocate them to `ViewColumn.Two` using layout commands.
- [x] **Phase 2: Analysis Panel Retention**
    - Modify `deactivateLayout` to stop disposing of `PlotsPanel`, `DataViewerPanel`, and `HelpPanel`.
    - Update `activateLayout` to check for existing panels and relocate them to their respective quadrants.
- [x] **Phase 3: State Syncing**
    - Workspace data file is no longer deleted when an existing R Console terminal is reused.
    - Plots panel syncs files created while layout was closed via `syncPlots()` on re-activation.
    - Workspace panel force-refreshes immediately on re-activation, skipping the loading spinner.
    - Terminal module-level references are preserved across deactivation so reuse works correctly.
- [x] **Phase 4: Advanced Panel Refinements**
    - **Custom Plot Directory**: Added toolbar dropdown with native folder picker and visual state feedback.
    - **Silent Data Refresh**: Removed background polling from Data Viewer in favor of a silent manual trigger.
    - **Premium Aesthetics**: Added canvas padding, shadows, and Day/Night modes to Plots and Data Viewer.
    - **Make the help results colorful in the help tab**

Unfortunately, the chat showing up in the top right quadrant is the editor version of the chat. Since we have wasted time trying to solve that, we can suspend that for now. Instead, we should focus on having a persistent chat across layout switches. As a matter of fact, since it is an ai chat, the chat history should be persistent forever until the individual chooses to delete the chat. Also, a user should be able to resume that chat. What has been happening is that the chat is being persistent forever which is good. And the way it currently works is that the chat I have during an R session becomes part of the standard chat side panel list of chats as soon as I switch from R quadrant layout. When I switch back to R quadrant layout, that chat from the list of the side panel chanel history is not restored back to the quadrant chat, instead the quadrant chat becomes a brand new chat.

**Proposed Technical Approach:**
- For existing terminals/panels, use `vscode.commands.executeCommand` (e.g., `workbench.action.moveEditorToSecondGroup`) to reposition them.
- Use `vscode.window.tabGroups` to track tab locations during transitions.

## 2. Restore Chat Tab (Quadrant 3) - NEXT MAJOR FOCUS
**Current Status:**
The chat tab has been missing from the top-right quadrant (ViewColumn.Three). This quadrant is intended to be a hub for AI interaction.

**Goal:**
Restore the Chat Tab and make it a "Universal AI Hub" that can host multiple sub-tabs for different AI agents.

**Implementation Plan:**
- [ ] **Multi-Agent Support**: Design the tab to hold the default VS Code chat, Antigravity, and third-party AI extensions (Cursor, Copilot, etc.) as sub-tabs.
- [ ] **Quadrant Locking**: Ensure the Chat Tab snap-locks to Quadrant 3 during layout activation.
- [ ] **Session Continuity**: Ensure chat history and agent state are preserved across layout toggles.
- [ ] **Integration**: Allow R Quadrant to communicate with these agents (e.g., sending console errors or dataframe summaries to the active chat).


## 3. Layout Activation Speed Optimization
**Current Behavior:**
While the quadrant layout activates at a decent speed, the transition still has some perceptible lag. The current implementation relies on a sequence of artificial `delay()` calls (e.g., `await delay(150)`, `await delay(200)`) to give VS Code's UI time to render panels and grids before firing the next command.

**Goal:**
Make the activation of the quadrant view feel completely instantaneous.

**Proposed Implementation:**
- **Audit Delays:** Review all `delay()` statements within the layout initialization sequence in `layoutManager.ts`.
- **Reduce or Eliminate:** See if the timeout durations can be safely reduced without breaking the layout.
- **Concurrent Execution:** Where possible, execute layout setup commands concurrently using `Promise.all()` instead of waiting for them sequentially.
- **Event-Driven UI Updates:** Investigate if we can replace arbitrary time delays with actual event listeners that fire exactly when the UI is ready.

## 4 ARK integration
- [ ] Implement seamless layout support for the `ark` interactive console.
- [ ] Auto-detect `ark` sessions and adjust quadrant behavior.

## 5 httpgd Integration (Advanced Plotting)
- [ ] Detect if `httpgd` is installed and active in the R session.
- [ ] Provide an option to swap the standard PNG gallery for the interactive `httpgd` webview.
- [ ] Support SVG resizing and hover inspections within the Plot Quadrant.

## 6 Having tabs for multiple agents
## 7 Testing the data viewer and plot tabs

