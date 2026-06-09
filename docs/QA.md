# R Layout: QA Runbook

This document outlines the essential manual testing steps that should be performed before releasing a new version of the extension. Because many of the core features involve complex webviews, inter-process communication with R, and OS-specific terminal handling, automated tests cannot catch everything.

## Pre-Release Checklist

### 1. Layout Lifecycle & Stability

Goal: Ensure the 3-pane layout activates, restores, and deactivates correctly without leaving stray terminals or crashing.

- [ ] Fresh Activation: Open a completely empty workspace. Trigger `Toggle R Layout`. Verify the 3-pane split occurs cleanly without stealing focus from the text editor.
- [ ] Deactivation: Trigger `Toggle R Layout` again. Ensure all custom panels close and terminals return to the standard bottom panel.
- [ ] Layout Restoration (Padding Check): Re-activate the layout. Check the R Console and Terminal in the top-right pane. Ensure they have proper top padding and aren't squished directly against the tab bar.
- [ ] Windows ConPTY Check: (On Windows) Ensure that when the layout activates, the terminal tabs do not render as completely blank or unresponsive screens.

### 2. Plot Gallery & Device Capture

Goal: Verify R graphics are captured correctly and the UI functions work.

- [ ] First Plot on Windows: Run a simple `plot(1:10)`. Ensure the very first plot shows up and is NOT a blank white screen.
- [ ] Layered Graphics: Run `plot(1:10)`, then `lines(10:1)`. Ensure only *one* plot shows in the gallery, and it contains both layers (no duplicates).
- [ ] Responsive Resizing: Resize the Plots pane. Ensure the plot re-renders automatically to fit the new dimensions without distortion.
- [ ] Interactivity: Test click-and-drag panning and scroll-wheel zooming on a plot.
- [ ] Export Options: Export a plot as `PNG`, `SVG`, `PDF`, and `EPS`. Verify the export progress notification appears, a status-bar success message follows, and the files exist on disk.
- [ ] Comparison Mode: Generate two different plots. Use the Compare button and verify side-by-side comparison, synced zoom/pan, and overlay controls work.

### 3. Data Viewer

Goal: Ensure data tables load quickly, correctly parse, and handle edge cases.

- [ ] Basic View(): Run `View(mtcars)`. Verify the webview opens in Group 3, shows the correct headers, and row numbers.
- [ ] Large Datasets: Run `View(ggplot2::diamonds)`. Ensure it loads without freezing the UI and shows the truncation notice if it exceeds the row limit.
- [ ] 3D Matrices: Create a 3D matrix (`arr <- array(1:24, dim = c(4, 3, 2))`) and run `View(arr)`. Ensure the Slice Navigation buttons appear and correctly swap between slices.
- [ ] Windows Lock Race: (On Windows) Rapidly call `View(df1)` then `View(df2)`. Ensure `df2` loads successfully and doesn't throw `ENOENT` or get stuck on `df1`.

### 4. Workspace Explorer

Goal: Ensure environment variables track perfectly.

- [ ] Variable Detection: Create `x <- 5` and `df <- data.frame(a=1)`. Ensure both appear in the Workspace panel.
- [ ] Quick Viewer Launch: Click the eye icon next to `df`. Ensure the Data Viewer opens for that specific data frame.
- [ ] Variable Removal: Remove a single variable with the trash icon. Verify the loading spinner appears and only that variable is removed.
- [ ] Clear Workspace: Click the broom icon. Verify user variables are cleared while R Layout internals such as `View`, `.r_layout_view_data`, and `.rlayout_*` objects are preserved.
- [ ] Package Attach/Detach: Attach and detach a package from the Packages tab. Verify `later` can be detached without unloading/crashing the R session.

### 5. HTML Widgets & Viewer Panel

Goal: Ensure web-based outputs render and serve correctly.

- [ ] HTML Widgets: Run `plotly::plot_ly(mtcars, x = ~wt, y = ~mpg, type = 'scatter', mode = 'markers')`. Verify the interactive chart appears in the Viewer pane.
- [ ] Snapshots: Click the "Capture as PNG" button in the Viewer pane. Verify the status-bar success message appears, the completion notification appears, and the image is saved.
- [ ] Local Shiny App: Run a basic Shiny app. Verify the Viewer pane loads the app correctly.

### 6. Webview Pop-out & Focus Management

Goal: Ensure webviews can float and restore without breaking VS Code execution contexts.

- [ ] Pop-out Panel: In the Data Viewer or Plots pane, click the `Pop-out to Main Editor` button. Verify it moves to the large Group 1 pane.
- [ ] Restore Panel: Click the `Restore to Side Panel` button. Verify it correctly returns to Group 3 *and maintains the strict architectural tab order* (`Workspace > Plots > Data Viewer > Viewer`).
- [ ] Focus Stealing Prevention: After generating a plot or popping a panel out, immediately press `Cmd+Enter` (or `Ctrl+Enter`) on a line of code. Ensure `vscode-R` executes the code and does NOT throw a "No active Text editor" error.
