import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PlotsPanel } from "../panels/plotsPanel";
import { HelpPanel } from "../panels/helpPanel";
import { ProblemsPanel } from "../panels/problemsPanel";
import { ToolsPanel } from "../panels/toolsPanel";
import { WorkspacePanel } from "../panels/workspacePanel";
import { DataViewerPanel } from "../panels/dataViewerPanel";
import { ViewerPanel } from "../panels/viewerPanel";
import { VisualsPanel } from "../panels/visualsPanel";
import { getRPath, getRArgs } from "../utils/rPathResolver";

/**
 * R Lab Layout Manager
 *
 * Orchestrates an asymmetrical 3-pane RStudio-style layout:
 *
 *   +------------------------------+------------------------------+
 *   |                              |       2 R Console / Term     |
 *   |      1 Source Editor         +------------------------------+
 *   |       (Full Height)          |       3 Workspace / Plots    |
 *   +------------------------------+------------------------------+
 *
 * On activation:
 *   - Saves open source files, then closes ALL editors & terminals
 *   - Sets the 3-pane layout, opens panels, reopens source files
 *
 * On deactivation:
 *   - Disposes webview panels, moves terminals back to bottom panel,
 *     resets to single editor group, reopens source files
 */

// Module State

let isLayoutActive = false;
let activationInProgress = false;
let panelMoveInProgress = false;

/**
 * Temporarily suppress the layout guard while a panel is being
 * popped-out or restored. Each panel calls this before reveal()
 * and the guard ignores all tab events while the flag is set.
 * The flag auto-clears after a short delay.
 */
export function suppressGuardForPanelMove(): void {
    panelMoveInProgress = true;
    setTimeout(() => {
        panelMoveInProgress = false;
    }, 500);
}
let rConsoleTerminal: vscode.Terminal | undefined;
let shellTerminal: vscode.Terminal | undefined;
let savedDataViewerState: { varName: string } | undefined;
let savedHelpState: any | undefined;
let savedViewerState: any | undefined;
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let currentAnchorUri: string | undefined;
let cachedWorkspaceRoots: string[] = [];
let dvWatcher: vscode.FileSystemWatcher | undefined;
let viewerWatcher: vscode.FileSystemWatcher | undefined;

export function getRConsoleTerminal(): vscode.Terminal | undefined {
    return rConsoleTerminal;
}

export function recordLayoutFocus(
    label: string,
    viewColumn: vscode.ViewColumn | undefined
): void {
    if (
        !isLayoutActive ||
        activationInProgress ||
        panelMoveInProgress ||
        protectedPanelRestoreBusy ||
        viewColumn === undefined
    ) {
        return;
    }
    lastActiveTabByColumn.set(viewColumn, label);
    lastActiveGroupColumn = viewColumn;
}

const STATE_KEY = "r-lab.layoutActive";

// Registration

export function registerLayoutCommand(context: vscode.ExtensionContext): void {
    extensionContext = context;
    // Restore persisted state
    isLayoutActive = context.workspaceState.get<boolean>(STATE_KEY, false);

    // Cache workspace roots early so shutdown cleanup works even if
    // workspaceFolders is undefined during window close.
    captureWorkspaceRoots();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            captureWorkspaceRoots();
        })
    );

    // Status Bar Button
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = "r-lab.toggleLayout";
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Layout Toggle Command
    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.activate", () => {
            activateLayout(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.focusViewer", () => {
            if (VisualsPanel.currentPanel) {
                VisualsPanel.currentPanel.revealTarget("viewer");
            } else {
                ViewerPanel.currentPanel?.reveal();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.toggleLayout", async () => {
            if (isLayoutActive) {
                await deactivateLayout();
            } else {
                await activateLayout(context);
            }
        })
    );

    // Utility Commands
    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.noop", () => {})
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.syncWidgetPlaceholder", () => {
            const hasWidgets =
                ViewerPanel.currentPanel?.hasInteractiveWidgetHistory() ??
                false;
            PlotsPanel.currentPanel?.setWidgetPlaceholderVisible(hasWidgets);
        })
    );

    // Source File to R Console
    // This command sends source('filepath') to our R Console terminal.
    // It also overrides r.runSource so the R extension's built-in
    // "Run Source" button routes to our terminal instead of a generic shell.
    const doSourceFile = async () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            const visibleEditors = vscode.window.visibleTextEditors;
            editor =
                visibleEditors.find(
                    (e) => e.viewColumn === vscode.ViewColumn.One
                ) || visibleEditors[0];
        }

        const filePath = editor?.document.uri.fsPath;
        if (!filePath) {
            vscode.window.showWarningMessage("No active file to source.");
            return;
        }

        // Save the document first if it has unsaved changes
        if (editor.document.isDirty) {
            await editor.document.save();
        }

        // Ensure we have a live R Console terminal
        if (!rConsoleTerminal) {
            vscode.window.showWarningMessage(
                "R Console is not running. Activate R Lab first."
            );
            return;
        }

        // Prevent sourcing markdown files as they are not valid R scripts
        if (
            filePath.toLowerCase().endsWith(".rmd") ||
            filePath.toLowerCase().endsWith(".qmd")
        ) {
            vscode.window.showWarningMessage(
                "Cannot source R Markdown or Quarto files. Please highlight specific code chunks and run selection instead."
            );
            return;
        }

        // Escape backslashes for Windows paths; forward slashes work on all platforms
        const escapedPath = filePath.replace(/\\/g, "/");
        rConsoleTerminal.show(false); // bring it into view without stealing keyboard focus
        rConsoleTerminal.sendText(
            `source(${JSON.stringify(escapedPath)}, echo = FALSE, print.eval = TRUE)`
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.sourceFile", doSourceFile)
    );

    // Run Selection in R Console
    // This command sends the currently selected text to the R Console.
    const doRunSelection = async () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            const visibleEditors = vscode.window.visibleTextEditors;
            editor =
                visibleEditors.find(
                    (e) => e.viewColumn === vscode.ViewColumn.One
                ) || visibleEditors[0];
        }

        if (!editor) {
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showWarningMessage("No text selected to run.");
            return;
        }

        const text = editor.document.getText(selection);
        if (!text.trim()) {
            return; // Ignore empty/whitespace-only selections
        }

        if (!rConsoleTerminal) {
            vscode.window.showWarningMessage(
                "R Console is not running. Activate R Lab first."
            );
            return;
        }

        rConsoleTerminal.show(false); // bring it into view without stealing keyboard focus

        // Bracketed paste is strictly required for radian to process multiline selections.
        // We determine if we should use bracketed paste based on the user's explicit Console Type setting,
        // or auto-detect it from the path if set to Auto Detect.
        const layoutConfig = vscode.workspace.getConfiguration("r-lab");
        const rConsoleType = layoutConfig.get<string>(
            "rConsoleType",
            "Auto Detect"
        );
        const rConsolePath = layoutConfig.get<string>("rConsolePath", "R");

        let useBracketedPaste = false;
        if (rConsoleType === "Radian") {
            useBracketedPaste = true;
        } else if (rConsoleType === "Standard R") {
            useBracketedPaste = false;
        } else {
            // Auto Detect: check vscode-R's native setting, then fallback to checking path
            const rConfig = vscode.workspace.getConfiguration("r");
            const rBracketedPaste = rConfig.get<boolean>(
                "bracketedPaste",
                false
            );
            useBracketedPaste =
                rBracketedPaste ||
                rConsolePath.toLowerCase().includes("radian") ||
                getRPath().toLowerCase().includes("radian");
        }

        if (useBracketedPaste) {
            // \x1b[200~ and \x1b[201~ are the ANSI escape codes for bracketed paste mode
            rConsoleTerminal.sendText(`\x1b[200~${text}\x1b[201~`, true);
        } else {
            rConsoleTerminal.sendText(text);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.runSelection", doRunSelection)
    );

    // Run Smart: Run selection if there is one, otherwise source file.
    const doRunSmart = async () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            const visibleEditors = vscode.window.visibleTextEditors;
            editor =
                visibleEditors.find(
                    (e) => e.viewColumn === vscode.ViewColumn.One
                ) || visibleEditors[0];
        }

        if (!editor) {
            return;
        }
        if (
            !editor.selection.isEmpty &&
            editor.document.getText(editor.selection).trim()
        ) {
            await doRunSelection();
        } else {
            await doSourceFile();
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.runSmart", doRunSmart)
    );

    // Resize Commands
    //
    // Maximize: apply hardcoded 0.9/0.1 vertical layout (works reliably).
    // Restore:  read the CURRENT layout (at current window pixel scale),
    //           equalize the vertical sub-split, and re-apply.  This keeps
    //           all values at the same pixel scale; mixing proportional
    //           values (0-1) with pixel values caused distortion on
    //           short windows.  Reading at current scale also ensures
    //           values are above minimum heights, so proportional resize
    //           works correctly when the window is later resized.

    context.subscriptions.push(
        vscode.commands.registerCommand("r-lab.maximizeTopRight", async () => {
            if (!isLayoutActive) {
                return;
            }

            // Hide Group 3 content before shrinking it. This prevents thumbnails
            // and webview canvases from visibly compressing during the layout change.
            WorkspacePanel.currentPanel?.setMinimized(true);
            VisualsPanel.currentPanel?.setMinimized(true);
            DataViewerPanel.currentPanel?.setMinimized(true);
            await delay(80);

            try {
                await vscode.commands.executeCommand("vscode.setEditorLayout", {
                    orientation: 0,
                    groups: [
                        { size: 0.6 },
                        {
                            size: 0.4,
                            groups: [{ size: 0.9 }, { size: 0.1 }],
                        },
                    ],
                });

                await vscode.commands.executeCommand(
                    "setContext",
                    "r-lab.isTopRightMaximized",
                    true
                );
            } catch {
                WorkspacePanel.currentPanel?.setMinimized(false);
                VisualsPanel.currentPanel?.setMinimized(false);
                DataViewerPanel.currentPanel?.setMinimized(false);
                await vscode.commands.executeCommand(
                    "setContext",
                    "r-lab.isTopRightMaximized",
                    false
                );
            }
        }),
        vscode.commands.registerCommand("r-lab.restoreRightSplit", async () => {
            if (!isLayoutActive) {
                return;
            }

            // Two-step restore:
            // 1) Read current layout (pixel values at current window scale),
            //    equalize the vertical sub-split, and apply. This sets the
            //    correct 50/50 without distortion (all pixel scale).
            // 2) Re-apply with proportional values (0.60/0.40 + 0.5/0.5).
            //    Because step 1 already set the correct visual state, the
            //    proportional values just re-stamp the grid with proper
            //    proportional-resize behavior so all panes grow/shrink
            //    together when the window is resized.
            try {
                try {
                    const current: any = await vscode.commands.executeCommand(
                        "vscode.getEditorLayout"
                    );
                    const subGroups = current?.groups?.[1]?.groups;
                    if (
                        subGroups?.length === 2 &&
                        typeof subGroups[0].size === "number" &&
                        typeof subGroups[1].size === "number"
                    ) {
                        const avg = (subGroups[0].size + subGroups[1].size) / 2;
                        subGroups[0].size = avg;
                        subGroups[1].size = avg;
                    }
                    await vscode.commands.executeCommand(
                        "vscode.setEditorLayout",
                        current
                    );
                } catch {
                    // ignore; step 2 below will handle it
                }

                // Step 2: proportional re-stamp
                await vscode.commands.executeCommand("vscode.setEditorLayout", {
                    orientation: 0,
                    groups: [
                        { size: 0.6 },
                        {
                            size: 0.4,
                            groups: [{ size: 0.5 }, { size: 0.5 }],
                        },
                    ],
                });
                await delay(80);
            } finally {
                // Never leave Group 3 webviews invisible if the layout command fails midway.
                WorkspacePanel.currentPanel?.setMinimized(false);
                VisualsPanel.currentPanel?.setMinimized(false);
                DataViewerPanel.currentPanel?.setMinimized(false);
            }

            // Restore webview content only after the split has real dimensions.
            VisualsPanel.currentPanel?.restoreActivePlotlyWidgetAfterPaneSplit();

            await vscode.commands.executeCommand(
                "setContext",
                "r-lab.isTopRightMaximized",
                false
            );
        })
    );

    // Track terminal disposal
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(async (t) => {
            if (
                t === rConsoleTerminal ||
                (t.name === "R Console" && !rConsoleTerminal)
            ) {
                rConsoleTerminal = undefined;
                savedDataViewerState = undefined;
                savedHelpState = undefined;
                savedViewerState = undefined;
                PlotsPanel.resetSessionState();

                // Delete .R-lab directory to prevent left-over files
                deleteRLabDir();

                // If the layout is active, closing the R Console should trigger an exit
                if (isLayoutActive) {
                    vscode.window.showInformationMessage(
                        "R Console session ended. Exiting R Lab."
                    );
                    await deactivateLayout();
                }
            }
            if (t === shellTerminal) {
                shellTerminal = undefined;
                if (
                    isLayoutActive &&
                    vscode.workspace
                        .getConfiguration("r-lab")
                        .get<boolean>("protectLayoutTabs", true)
                ) {
                    await recreateProtectedShellTerminal();
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            if (terminal === rConsoleTerminal) {
                recordLayoutFocus("R Console", vscode.ViewColumn.Two);
            } else if (terminal === shellTerminal) {
                recordLayoutFocus("Terminal", vscode.ViewColumn.Two);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor?.viewColumn !== undefined) {
                recordLayoutFocus(editor.document.fileName, editor.viewColumn);
            }
        })
    );
}

//  Stale Layout Guard

/**
 * SYNCHRONOUS fire-and-forget called as the VERY FIRST action in activate().
 *
 * We submit the single-group layout command to VS Code's command queue
 * before any async work runs. This races the session-restore rendering:
 * VS Code queues its own layout draw, we queue our collapse immediately
 * after, and our command wins because it's queued first in the same tick.
 *
 * Only fires if the workspace state shows the layout was previously active,
 * so it's a no-op on fresh starts where no cleanup is needed.
 */
export function fireImmediateLayoutReset(
    context: vscode.ExtensionContext
): void {
    const wasActive = context.workspaceState.get<boolean>(STATE_KEY, false);
    if (!wasActive) {
        // No stale layout - nothing to collapse.
        return;
    }

    // Fire these WITHOUT await so they're submitted synchronously
    // into VS Code's command queue in the same JavaScript tick as activate().
    // setEditorLayout runs first, then closeAllEditors, giving us the
    // fastest possible collapse before the user's eyes register the flash.
    void Promise.resolve(
        vscode.commands.executeCommand("vscode.setEditorLayout", {
            orientation: 0,
            groups: [{}],
        })
    )
        .then(() => {
            // Close stale editor tabs (webviews, terminal-editors, etc.)
            // after the layout has collapsed.
            return vscode.commands.executeCommand(
                "workbench.action.closeAllEditors"
            );
        })
        .catch(() => {
            /* silently ignore */
        });
}

/**
 * Full async cleanup called after fireImmediateLayoutReset.
 * Clears persisted state, updates the status bar, and reopens
 * the user's text files cleanly in the single editor group.
 */
export async function resetStaleLayout(
    context: vscode.ExtensionContext
): Promise<void> {
    // Always clear persisted state on startup.
    await context.workspaceState.update(STATE_KEY, false);
    isLayoutActive = false;
    updateStatusBar();

    // UNCONDITIONAL settings reset
    // Reset these FIRST, before any other logic, as a safety net.
    // If a previous session crashed or was killed before cleanup
    // could finish, these settings can get stuck as workspace
    // overrides - causing files to open in a split view and
    // terminals to land in the editor area in pre-layout VS Code.
    try {
        const cfgTarget = getConfigTarget();
        const wsConfig = vscode.workspace.getConfiguration();

        const origClose = context.workspaceState.get<boolean | undefined>(
            "r-lab.origCloseEmptyGroups",
            undefined
        );

        await Promise.all([
            Promise.resolve(
                wsConfig.update(
                    "workbench.editor.closeEmptyGroups",
                    origClose,
                    cfgTarget
                )
            ).catch(() => {}),
            Promise.resolve(
                context.workspaceState.update(
                    "r-lab.origCloseEmptyGroups",
                    undefined
                )
            ).catch(() => {}),
        ]);
    } catch {}

    // CONDITIONAL stale-layout cleanup
    // Only close editors and reset the layout if there are actually
    // stale elements from a previous R Lab session:
    //   - more than one editor group (leftover 3-pane grid), OR
    //   - webview / notebook tabs (our panel singletons) still open
    // On a clean startup with no stale layout this is a no-op,
    // which avoids creating a spurious two-group split.
    const groups = vscode.window.tabGroups.all;
    const hasMultipleGroups = groups.length > 1;
    const hasStaleWebviews = groups.some((g) =>
        g.tabs.some(
            (t) =>
                t.input instanceof vscode.TabInputWebview ||
                t.input instanceof vscode.TabInputNotebook
        )
    );

    if (!hasMultipleGroups && !hasStaleWebviews) {
        // Nothing stale - leave the editor state exactly as VS Code
        // restored it. No cleanup needed.
        return;
    }

    // Collect text files before we close everything
    const textFiles: vscode.Uri[] = [];
    for (const group of groups) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                textFiles.push(tab.input.uri);
            }
        }
    }

    // Close stale tabs (webviews, notebooks, etc.) but PRESERVE terminal-as-editor
    // tabs. The R Console and Shell terminals live as editor tabs and must survive
    // this cleanup so activation can reuse them without losing the R session.
    const terminalTabs: vscode.Tab[] = [];
    for (const group of groups) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputTerminal) {
                terminalTabs.push(tab);
            }
        }
    }

    const nonTerminalTabs = groups.flatMap((g) =>
        g.tabs.filter((t) => !(t.input instanceof vscode.TabInputTerminal))
    );
    try {
        if (nonTerminalTabs.length > 0) {
            await vscode.window.tabGroups.close(nonTerminalTabs);
        }
    } catch {}

    // Collapse to a clean single-group layout
    try {
        await vscode.commands.executeCommand("vscode.setEditorLayout", {
            orientation: 0,
            groups: [{}],
        });
    } catch {}

    // Reopen only the user's text files in group 1
    for (const uri of textFiles) {
        try {
            await vscode.window.showTextDocument(uri, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: true,
            });
        } catch {}
    }
}

//  Shutdown Collapse - called from extension deactivate()

/**
 * Called by the extension's deactivate() function.
 *
 * VS Code AWAITS the Promise returned by deactivate() before it saves
 * final workbench state and reloads the window. This is the critical
 * insight: if we collapse the layout here, VS Code writes a single-group
 * layout to its session store, so on the next startup there is nothing
 * multi-group to restore - and the flash never happens.
 *
 * Without this, when the user reloads while R Lab is active, VS Code
 * saves the 4-group layout, restores it on reload (flash!), and only then
 * our activation code can collapse it.
 */
export async function collapseLayoutForShutdown(): Promise<void> {
    // Always clean up the .R-lab temp directory on shutdown.
    deleteRLabDir();

    if (!isLayoutActive) {
        // Layout wasn't active - no layout state to collapse.
        return;
    }

    console.log(
        "[R Lab] deactivate(): collapsing layout before state is saved."
    );

    // Determine config target once, synchronously, before we fan out.
    const cfgTarget = getConfigTarget();
    const wsConfig = vscode.workspace.getConfiguration();

    // Fire ALL cleanup operations in parallel.
    //
    // Previously these were sequential (5 round-trips). Running them
    // concurrently cuts the wall-clock time to a single round-trip -
    // the longest individual operation - making the reload delay
    // imperceptible.
    //
    // NOTE: closeAllEditors is intentionally omitted. VS Code is
    // about to reload; in-memory tab state won't be persisted beyond
    // what the layout already controls. Removing it saves one full
    // async round-trip with no downside.
    await Promise.all([
        // 1 Critical: collapse to single group so VS Code saves 1-group state
        Promise.resolve(
            vscode.commands.executeCommand("vscode.setEditorLayout", {
                orientation: 0,
                groups: [{}],
            })
        ).catch(() => {}),

        // 2 Clear persisted state so resetStaleLayout is a no-op next start
        extensionContext
            ? Promise.resolve(
                  extensionContext.workspaceState.update(STATE_KEY, false)
              ).catch(() => {})
            : Promise.resolve(),

        // 3 Reset settings
        (() => {
            const origClose = extensionContext
                ? extensionContext.workspaceState.get<boolean | undefined>(
                      "r-lab.origCloseEmptyGroups",
                      undefined
                  )
                : undefined;

            return Promise.all([
                Promise.resolve(
                    wsConfig.update(
                        "workbench.editor.closeEmptyGroups",
                        origClose,
                        cfgTarget
                    )
                ).catch(() => {}),
                extensionContext
                    ? Promise.resolve(
                          extensionContext.workspaceState.update(
                              "r-lab.origCloseEmptyGroups",
                              undefined
                          )
                      ).catch(() => {})
                    : Promise.resolve(),
            ]);
        })(),
    ]);
}

//  Activate Layout

async function activateLayout(context: vscode.ExtensionContext): Promise<void> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Activating R Lab...",
            cancellable: false,
        },
        async () => {
            activationInProgress = true;
            // 1. Load saved positions, and Save references to all currently open TEXT files
            //    so we can reopen them after setting the layout.
            const textFilePositions = context.workspaceState.get<
                Record<string, number>
            >("r-lab.textFilePositions", {});
            let panelPositions = context.workspaceState.get<
                Record<string, number>
            >("r-lab.panelPositions", {});

            // --- Layout Integrity Check ---
            // If the layout was closed prematurely or tabs were deleted in a previous session,
            // the saved panelPositions might be broken (e.g. missing core panels, or panels stuck in Group 1).
            let missingCorePanels = 0;
            const corePanels = ["workspace", "tools"];
            for (const p of corePanels) {
                if (!panelPositions[p]) {
                    missingCorePanels++;
                }
            }
            if (
                !panelPositions["visuals"] &&
                !panelPositions["visualizations"] &&
                !panelPositions["plots"] &&
                !panelPositions["viewer"]
            ) {
                missingCorePanels++;
            }

            // If layout state is severely broken (panels in Group 1, or missing too many panels), ignore custom positions
            const hasPanelsInMainEditor = Object.values(panelPositions).some(
                (col) => col === vscode.ViewColumn.One
            );
            if (hasPanelsInMainEditor || missingCorePanels >= 2) {
                panelPositions = {}; // Force reset to defaults
            }
            // ------------------------------

            const openFiles: vscode.Uri[] = [];
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        openFiles.push(tab.input.uri);
                    }
                }
            }

            // 2. Close stale R Lab panels from previous sessions.
            //    We explicitly PRESERVE the Help tab and any Chat tabs so their sessions survive layout toggles.
            //    We preserve TabInputText so the user's source files remain open.
            const config = vscode.workspace.getConfiguration("r-lab");
            const restoreCustom = config.get<boolean>(
                "restoreCustomPanelPositions",
                false
            );

            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const disposablePanels = [
                        "Workspace",
                        "Visuals",
                        "Visualizations",
                        "Plots",
                        "Data Viewer",
                        "Viewer",
                        "Problems",
                        "R Help",
                        "Tools",
                    ];
                    if (disposablePanels.includes(tab.label)) {
                        if (
                            !restoreCustom ||
                            tab.label === "Problems" ||
                            tab.label === "R Help" ||
                            tab.label === "Tools" ||
                            tab.label === "Plots" ||
                            tab.label === "Viewer"
                        ) {
                            try {
                                await vscode.window.tabGroups.close(tab);
                            } catch {}
                        }
                    }
                }
            }

            // Wait for restored terminals to load on slow startups if we see them in tabGroups
            const hasRestoredRConsoleTab = vscode.window.tabGroups.all.some(
                (g) =>
                    g.tabs.some(
                        (tab) =>
                            tab.input instanceof vscode.TabInputTerminal &&
                            tab.label.includes("R Console")
                    )
            );
            if (hasRestoredRConsoleTab && !rConsoleTerminal) {
                for (let i = 0; i < 30; i++) {
                    const found = vscode.window.terminals.find(
                        (t) => t.name === "R Console"
                    );
                    if (found) {
                        break;
                    }
                    await delay(100);
                }
            }

            const hasRestoredShellTab = vscode.window.tabGroups.all.some((g) =>
                g.tabs.some(
                    (tab) =>
                        tab.input instanceof vscode.TabInputTerminal &&
                        tab.label === "Terminal"
                )
            );
            if (hasRestoredShellTab && !shellTerminal) {
                for (let i = 0; i < 30; i++) {
                    const found = vscode.window.terminals.find(
                        (t) => t.name === "Terminal"
                    );
                    if (found) {
                        break;
                    }
                    await delay(100);
                }
            }

            // 3. Scan for existing terminals to reuse. We will relocate them to ViewColumn.Two.
            //    Track whether we are reusing to avoid wiping workspace data for live sessions.
            let wasRConsoleReused = false;
            for (const t of vscode.window.terminals) {
                if (t.name === "R Console" && !rConsoleTerminal) {
                    rConsoleTerminal = t;
                    wasRConsoleReused = true;
                } else if (t.name === "Terminal" && !shellTerminal) {
                    shellTerminal = t;
                }
            }

            // 4. Close sidebars and the bottom panel
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.closeSidebar"
                );
            } catch {}
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.closeAuxiliaryBar"
                );
            } catch {}
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.closePanel"
                );
            } catch {}

            // 5. Set context key (for keybinding "when" clauses)
            await vscode.commands.executeCommand(
                "setContext",
                "r-lab.layoutActive",
                true
            );
            await vscode.commands.executeCommand(
                "setContext",
                "r-lab.isTopRightMaximized",
                false
            );

            // 6. Apply workspace overrides
            const cfgTarget = getConfigTarget();
            const wsConfig = vscode.workspace.getConfiguration();

            // Inspect and save original user settings before modifying them
            const existingOrigClose = extensionContext.workspaceState.get<
                boolean | undefined
            >("r-lab.origCloseEmptyGroups", undefined);
            if (existingOrigClose === undefined) {
                const inspectionClose = wsConfig.inspect<boolean>(
                    "workbench.editor.closeEmptyGroups"
                );
                const origClose =
                    cfgTarget === vscode.ConfigurationTarget.Workspace
                        ? inspectionClose?.workspaceValue
                        : inspectionClose?.globalValue;
                // If the workspace value is already exactly 'false' when we inspect it, but it's only there
                // because of a previous stuck state, we just save undefined. A genuine user setting would be fine to lose
                // in favor of default behavior (undefined) rather than permanently polluting settings.json.
                const safeOrigClose =
                    origClose === false ? undefined : origClose;
                await extensionContext.workspaceState.update(
                    "r-lab.origCloseEmptyGroups",
                    safeOrigClose
                );
            }

            await wsConfig.update(
                "workbench.editor.closeEmptyGroups",
                false,
                cfgTarget
            );

            await delay(10);

            // 7. Set the 3-pane editor layout
            await vscode.commands.executeCommand("vscode.setEditorLayout", {
                orientation: 0,
                groups: [
                    { size: 0.6 }, // 1 Source Editor (Full Height)
                    {
                        size: 0.4,
                        groups: [
                            { size: 0.5 }, // 2 Console / Terminal / Problems / Help
                            { size: 0.5 }, // 3 Workspace / Plots / Data Viewer
                        ],
                    },
                ],
            });

            await delay(10);

            //  CRITICAL: Populate groups in strict order 1 -> 2 -> 3 -> 4
            //  VS Code assigns ViewColumn numbers based on the order
            //  groups first receive content. If we put content into
            //  Group 2 before Group 1, the ViewColumns all shift.

            // 8. Anchor Group 1 with an active text editor.
            //    The vscode-R extension's chunk-navigation shows a "No text editor active" warning
            //    whenever window.activeTextEditor is null. We prevent this by ensuring Group 1
            //    always has a visible text document during layout construction.
            //    Priority: (a) reopen a previously saved source file, (b) open an untitled scratch.
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.focusFirstEditorGroup"
                );
            } catch {}
            await delay(10);

            let anchorEditor: vscode.TextEditor | undefined;
            if (openFiles.length > 0) {
                // Reopen the first saved file into Group 1 - this satisfies the R extension's check.
                try {
                    anchorEditor = await vscode.window.showTextDocument(
                        openFiles[0],
                        {
                            viewColumn: vscode.ViewColumn.One,
                            preserveFocus: false,
                            preview: false,
                        }
                    );
                } catch {}
            }
            if (!anchorEditor) {
                // No saved file open - create a tiny untitled doc to anchor Group 1.
                try {
                    const doc = await vscode.workspace.openTextDocument({
                        content: "",
                        language: "plaintext",
                    });
                    currentAnchorUri = doc.uri.toString();
                    anchorEditor = await vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.ViewColumn.One,
                        preserveFocus: false,
                        preview: false,
                    });
                } catch {}
            }
            await delay(10);
            // NOTE: Do NOT call focusSecondEditorGroup here - it would set
            // window.activeTextEditor to undefined and trigger the R extension's
            // "No text editor active" warning. Terminal placement uses explicit
            // viewColumn or moveToEditor + immediate Group 1 restore instead.
            await delay(10);

            // 9. Group 2 (bottom-left): R Console -> Terminal -> Tools
            //
            //    Strategy for existing terminals (session retention):
            //      a) Create ToolsPanel in ViewColumn.Two FIRST - this anchors Group 2
            //         as a real, focusable editor group before any terminal is moved.
            //      b) Focus Group 2 (it now has content so focus sticks).
            //      c) Call terminal.show(false) to make the terminal the active one
            //         in the panel without stealing editor focus away from Group 2.
            //      d) Call moveToEditor - moves the active panel terminal to the
            //         currently focused editor group (Group 2).
            //
            //    For NEW terminals, createTerminal with location.viewColumn is reliable.
            // 9a. Anchor Group 2 with ToolsPanel before any terminal placement.
            ToolsPanel.createOrShow(
                context.extensionUri,
                vscode.ViewColumn.Two
            );
            await delay(150); // Ensure Group 2 is fully mounted in the UI before spawning PTYs

            // Only delete stale workspace data if we are creating a BRAND-NEW R session.
            // If we found an existing R Console terminal (wasRConsoleReused), R is still
            // running and its variables are still live - do NOT wipe the data file.
            const wf = getEffectiveWorkspaceRoot();
            if (!wasRConsoleReused) {
                const staleFile = path.join(
                    wf,
                    ".R-lab",
                    ".workspace_data.json"
                );
                try {
                    fs.unlinkSync(staleFile);
                } catch {}

                // NEW: Clear R Help state for brand-new R sessions
                // state is now in workspaceState
            }

            // Build the watcher Rprofile BEFORE creating the terminal.
            const watcherPath = _buildWatcherRprofile();
            const rProfileEnv: Record<string, string> = {};
            if (watcherPath) {
                rProfileEnv["R_PROFILE_USER"] = watcherPath;
                rProfileEnv["R_LAB_SESSION"] = "1";
                const existing = process.env["R_PROFILE_USER"];
                if (existing) {
                    rProfileEnv["R_PROFILE_USER_ORIG"] = existing;
                }
            }
            console.log(
                `[R Lab] rProfileEnv=${JSON.stringify(rProfileEnv)}, wasRConsoleReused=${wasRConsoleReused}, rConsoleTerminal=${!!rConsoleTerminal}`
            );

            // Merge process.env and user settings to emulate normal terminal env while using strictEnv
            const platform =
                os.platform() === "win32"
                    ? "windows"
                    : os.platform() === "darwin"
                      ? "osx"
                      : "linux";
            const userEnv =
                vscode.workspace
                    .getConfiguration("terminal.integrated.env")
                    .get<Record<string, string>>(platform) || {};
            const strictEnvArgs: Record<string, string> = {
                ...(process.env as any),
                ...userEnv,
                ...rProfileEnv,
            };

            if (rConsoleTerminal) {
                // Reuse the existing terminal - do NOT recreate (that kills the R session).
                // Check specifically for the R Console tab by name.
                const rConsoleIsEditorTab = vscode.window.tabGroups.all.some(
                    (g) =>
                        g.tabs.some((tab) => {
                            const input = tab.input as any;
                            return (
                                input instanceof vscode.TabInputTerminal &&
                                tab.label.includes("R Console")
                            );
                        })
                );
                console.log(
                    `[R Lab] Reusing rConsoleTerminal, isEditorTab=${rConsoleIsEditorTab}`
                );

                if (rConsoleIsEditorTab) {
                    // Already an editor tab - just reveal it without moving.
                    rConsoleTerminal.show(true); // preserveFocus = true
                    await delay(10);
                } else {
                    // Terminal is in the bottom panel - move it into Group 2.
                    // Use show(true) to make it the active panel terminal without
                    // stealing keyboard focus from the editor group.
                    rConsoleTerminal.show(true);
                    await delay(100);
                    await vscode.commands.executeCommand(
                        "workbench.action.focusSecondEditorGroup"
                    );
                    await delay(50);
                    await vscode.commands.executeCommand(
                        "workbench.action.terminal.moveToEditor"
                    );
                    await delay(100);
                }
            } else {
                const shellPath = getRPath();
                const cwdPath = getEffectiveWorkspaceRoot();
                console.log(
                    `[R Lab] Creating NEW R Console: shellPath=${shellPath}, cwd=${cwdPath}, env keys=${Object.keys(rProfileEnv).join(",")}`
                );
                const isWindows = os.platform() === "win32";
                rConsoleTerminal = vscode.window.createTerminal({
                    name: "R Console",
                    shellPath,
                    shellArgs: getRArgs(),
                    // DO NOT use location: { viewColumn: vscode.ViewColumn.Two } on Windows
                    // Creating directly into the editor group causes intermittent blank ConPTY terminals on Windows.
                    location: isWindows
                        ? undefined
                        : { viewColumn: vscode.ViewColumn.Two },
                    env: strictEnvArgs,
                    strictEnv: !isWindows, // Prevents Python extension from applying its EnvironmentVariableCollection and crashing PTY
                    cwd: cwdPath, // Prevents PTY hang in no-workspace mode
                    iconPath: vscode.Uri.joinPath(
                        context.extensionUri,
                        "resources",
                        "r_logo.svg"
                    ),
                });

                if (isWindows) {
                    // Show in the panel first to force PTY initialization
                    rConsoleTerminal.show(true);
                    await delay(500); // Give ConPTY time to fully spawn before moving

                    // Move to editor area (Group 2)
                    await vscode.commands.executeCommand(
                        "workbench.action.focusSecondEditorGroup"
                    );
                    await delay(50);
                    await vscode.commands.executeCommand(
                        "workbench.action.terminal.moveToEditor"
                    );
                    await delay(100);
                }
            }

            // Wait for R Console to be fully positioned in Group 2 before proceeding
            await waitForTerminalInGroup2("R Console", 4000);

            // Shell terminal
            await delay(10);
            if (shellTerminal) {
                // Check specifically for the Shell terminal by name.
                const shellIsEditorTab = vscode.window.tabGroups.all.some((g) =>
                    g.tabs.some((tab) => {
                        const input = tab.input as any;
                        return (
                            input instanceof vscode.TabInputTerminal &&
                            (tab.label === "Terminal" ||
                                tab.label === shellTerminal?.name)
                        );
                    })
                );
                if (shellIsEditorTab) {
                    shellTerminal.show(true);
                    await delay(10);
                } else {
                    shellTerminal.show(true);
                    await delay(100);
                    await vscode.commands.executeCommand(
                        "workbench.action.focusSecondEditorGroup"
                    );
                    await delay(50);
                    await vscode.commands.executeCommand(
                        "workbench.action.terminal.moveToEditor"
                    );
                    await delay(100);
                }
            } else {
                await createShellTerminalInGroup2();
            }

            // Wait for Shell terminal to be fully positioned in Group 2 before recreating Tools panel
            await waitForTerminalInGroup2("Terminal", 4000);

            // ToolsPanel: dispose the anchor instance and recreate so it becomes the
            // LAST tab in Group 2, giving order: R Console -> Terminal -> Tools.
            await delay(10);
            ToolsPanel.currentPanel?.dispose();
            await delay(10);
            const toolsPanel = ToolsPanel.createOrShow(
                context.extensionUri,
                vscode.ViewColumn.Two
            );
            toolsPanel.loadState(savedHelpState ?? ToolsPanel.lastClosedState);
            await delay(10);

            // Focus Group 2 and activate R Console (which is usually the 1st or 2nd tab)
            // Ensure Group 2 retains focus after terminal placement.
            // and then activate the first editor (R Console).
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.focusSecondEditorGroup"
                );
                await vscode.commands.executeCommand(
                    "workbench.action.firstEditorInGroup"
                );
            } catch {}

            // 11. Group 3 (bottom-right): Workspace -> Visuals -> Data Viewer (Workspace FIRST, Workspace FOCUSED)
            //     Create Workspace first, then Visuals, then Data Viewer.
            //     Reveal Workspace at the end to make it the active/focused tab.
            const workspacePanel = WorkspacePanel.createOrShow(
                context.extensionUri,
                vscode.ViewColumn.Three,
                !restoreCustom
            );
            if (WorkspacePanel.lastClosedState) {
                workspacePanel.loadState(WorkspacePanel.lastClosedState);
            }
            // Note: forceRefresh() is deferred (see end of activation) to give the webview
            // time to fully render before the message is posted.
            const visualsPanel = VisualsPanel.createOrShow(
                context.extensionUri,
                vscode.ViewColumn.Three,
                !restoreCustom
            );
            PlotsPanel.currentPanel?.syncPlots(); // catch up on any plots created while layout was closed
            const dataPanel = DataViewerPanel.createOrShow(
                context.extensionUri,
                vscode.ViewColumn.Three,
                !restoreCustom
            );
            const visualsState =
                VisualsPanel.lastClosedState ??
                (savedViewerState
                    ? { viewerState: savedViewerState }
                    : undefined);
            if (visualsState) {
                visualsPanel.loadState(visualsState);
            }
            await vscode.commands.executeCommand("r-lab.syncWidgetPlaceholder");

            if (!restoreCustom) {
                workspacePanel.reveal(); // restore Workspace as the focused tab in Group 3
            }

            bindWorkspaceDataView(context, workspacePanel);

            if (!viewerWatcher) {
                const wf = getEffectiveWorkspaceRoot();
                const pattern = new vscode.RelativePattern(
                    vscode.Uri.file(path.join(wf, ".R-lab")),
                    "viewer_url.txt"
                );
                viewerWatcher =
                    vscode.workspace.createFileSystemWatcher(pattern);
                let lastViewerLineCount = 0;

                const viewerHandler = async () => {
                    if (!isLayoutActive) {
                        return;
                    }
                    const urlPath = path.join(wf, ".R-lab", "viewer_url.txt");
                    try {
                        let content = "";
                        // Wait for file creation + flush
                        for (let i = 0; i < 10; i++) {
                            try {
                                content = fs.readFileSync(urlPath, "utf8");
                                if (content.trim().length > 0) {
                                    break;
                                }
                            } catch {
                                // ignore ENOENT
                            }
                            await new Promise((r) => setTimeout(r, 100));
                        }

                        const lines = content
                            .split(/\r?\n/)
                            .filter((l) => l.trim().length > 0);

                        // Reset if file was truncated/cleared
                        if (lines.length < lastViewerLineCount) {
                            lastViewerLineCount = 0;
                        }

                        if (lines.length > lastViewerLineCount) {
                            const newLines = lines.slice(lastViewerLineCount);
                            lastViewerLineCount = lines.length;

                            if (!ViewerPanel.currentPanel) {
                                VisualsPanel.createOrShow(
                                    context.extensionUri,
                                    vscode.ViewColumn.Three
                                );
                            }
                            const vp = ViewerPanel.currentPanel;
                            if (!vp) {
                                return;
                            }

                            for (const url of newLines) {
                                await vp.loadUrl(url.trim());
                            }
                            VisualsPanel.currentPanel?.revealTarget("viewer");
                        }
                    } catch {}
                };
                viewerWatcher.onDidChange(viewerHandler);
                viewerWatcher.onDidCreate(viewerHandler);
                context.subscriptions.push(viewerWatcher);
            }

            if (!dvWatcher) {
                const wf = getEffectiveWorkspaceRoot();
                const pattern = new vscode.RelativePattern(
                    vscode.Uri.file(path.join(wf, ".R-lab")),
                    "dv-meta.txt"
                );
                dvWatcher = vscode.workspace.createFileSystemWatcher(pattern);
                const dvHandler = async () => {
                    if (!isLayoutActive) {
                        return;
                    }
                    const metaPath = path.join(wf, ".R-lab", "dv-meta.txt");
                    try {
                        let raw = "";
                        // Windows watchers often fire on file creation before content is fully flushed.
                        // Poll briefly until the file has content.
                        for (let i = 0; i < 10; i++) {
                            try {
                                raw = fs.readFileSync(metaPath, "utf8");
                                if (raw.trim().length > 0) {
                                    break;
                                }
                            } catch {
                                // ignore ENOENT during write
                            }
                            await new Promise((r) => setTimeout(r, 100));
                        }

                        if (raw.trim().length === 0) {
                            return;
                        }

                        // Strip Windows \r\n line endings
                        raw = raw.replace(/\r/g, "");

                        let varName = "";
                        if (raw.startsWith("ERROR:")) {
                            // Do nothing in the background watcher on error!
                            // Let the error print to the R console instead of forcing the UI open.
                            return;
                        } else {
                            const lines = raw.trim().split("\n");
                            if (lines.length > 2) {
                                if (lines[2] === "3D") {
                                    varName = lines[lines.length - 1].trim();
                                } else if (lines[2] === "2D") {
                                    varName = lines[3].trim();
                                }
                            }
                        }
                        if (varName) {
                            const existingPanel = DataViewerPanel.currentPanel;
                            const dvp =
                                existingPanel ||
                                DataViewerPanel.createOrShow(
                                    context.extensionUri,
                                    vscode.ViewColumn.Three
                                );
                            await dvp.loadVariable(varName, true);
                            if (!dvp.isPoppedOut()) {
                                dvp.reveal();
                            }
                        }
                    } catch {}
                };
                dvWatcher.onDidChange(dvHandler);
                dvWatcher.onDidCreate(dvHandler);
                context.subscriptions.push(dvWatcher);
            }

            // 12. Focus the source editor
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.focusFirstEditorGroup"
                );
            } catch {}

            // 13. Now that ViewColumns 1-3 are rigidly locked by default content,
            //     we can safely restore saved positions without causing ViewColumn shifting.

            // 12. Create DataViewer if it was open (RESTORATION)
            if (savedDataViewerState && savedDataViewerState.varName) {
                const dvPanel = DataViewerPanel.createOrShow(
                    context.extensionUri,
                    vscode.ViewColumn.Three
                );
                await dvPanel.loadState(savedDataViewerState);
            }

            // 13. Keep Tools present if it was open in the saved layout.
            if (
                panelPositions["tools"] === vscode.ViewColumn.Two ||
                panelPositions["problems"] === vscode.ViewColumn.Two ||
                panelPositions["help"] === vscode.ViewColumn.Two
            ) {
                const panel = ToolsPanel.createOrShow(
                    context.extensionUri,
                    vscode.ViewColumn.Two
                );
                panel.loadState(savedHelpState ?? ToolsPanel.lastClosedState);
            }

            // Reposition custom panels
            const restoreCustomPositions = vscode.workspace
                .getConfiguration("r-lab")
                .get<boolean>("restoreCustomPanelPositions", false);
            if (restoreCustomPositions) {
                if (
                    panelPositions["tools"] &&
                    panelPositions["tools"] !== vscode.ViewColumn.Two
                ) {
                    const panel = ToolsPanel.createOrShow(
                        context.extensionUri,
                        panelPositions["tools"]
                    );
                    panel.loadState(
                        savedHelpState ?? ToolsPanel.lastClosedState
                    );
                }
                if (
                    panelPositions["workspace"] &&
                    panelPositions["workspace"] !== vscode.ViewColumn.Three
                ) {
                    const panel = WorkspacePanel.createOrShow(
                        context.extensionUri,
                        panelPositions["workspace"]
                    );
                    if (WorkspacePanel.lastClosedState) {
                        panel.loadState(WorkspacePanel.lastClosedState);
                    }
                }
                const visualsColumn =
                    panelPositions["visuals"] ??
                    panelPositions["visualizations"] ??
                    panelPositions["plots"] ??
                    panelPositions["viewer"];
                if (
                    visualsColumn &&
                    visualsColumn !== vscode.ViewColumn.Three
                ) {
                    VisualsPanel.createOrShow(
                        context.extensionUri,
                        visualsColumn
                    );
                }
                if (
                    panelPositions["dataViewer"] &&
                    panelPositions["dataViewer"] !== vscode.ViewColumn.Three
                ) {
                    DataViewerPanel.createOrShow(
                        context.extensionUri,
                        panelPositions["dataViewer"]
                    );
                }

                // Reposition text files
                if (openFiles.length > 0) {
                    for (const uri of openFiles) {
                        const col = textFilePositions[uri.fsPath];
                        if (col && col !== vscode.ViewColumn.One) {
                            try {
                                await vscode.window.showTextDocument(uri, {
                                    viewColumn: col,
                                    preview: false,
                                    preserveFocus: true,
                                });
                            } catch {}
                        }
                    }
                }
            }

            // 14. Register layout guards that redirect stray content
            registerLayoutGuards(context);

            // 14. Persist & update UI
            isLayoutActive = true;
            await context.workspaceState.update(STATE_KEY, true);
            updateStatusBar();

            // 15. Ensure bottom panel is closed since we opened terminals
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.closePanel"
                );
            } catch {}

            // 16. The layout is not complete unless the R Console is visible in Group 2.
            await ensureRConsoleInGroup2(context, strictEnvArgs);
            await enforceTabOrder(vscode.ViewColumn.Two, "R Console", [
                "R Console",
                "Terminal",
                "Tools",
            ]);

            // 17. Set final tab focus:
            //     - R Console  -> first tab in Group 2 (top-right)
            //     - Workspace  -> first tab in Group 3 (bottom-right)
            //     Done LAST so nothing steals the focus back.

            // Group 3 (bottom-right): activate Workspace (first tab)
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.focusThirdEditorGroup"
                );
                await delay(10);
                await vscode.commands.executeCommand(
                    "workbench.action.firstEditorInGroup"
                );
                await delay(10);
            } catch {}

            // Group 2 (top-right): activate R Console (first tab)
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.focusSecondEditorGroup"
                );
                await delay(10);
                await vscode.commands.executeCommand(
                    "workbench.action.firstEditorInGroup"
                );
                await delay(10);
            } catch {}

            // Return focus to the source editor (Group 1)
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.focusFirstEditorGroup"
                );
            } catch {}

            activationInProgress = false;

            // Force xterm.js to recalculate terminal viewport dimensions (including top padding)
            // by re-applying the editor layout. When terminals are moved from the bottom panel
            // to the editor during restoration, subsequent Group 2 mutations can cause
            // xterm.js to lose its container padding.
            // Re-applying the layout forces a container resize event that triggers a full reflow.
            const reapplyLayout = async () => {
                try {
                    await vscode.commands.executeCommand(
                        "vscode.setEditorLayout",
                        {
                            orientation: 0,
                            groups: [
                                { size: 0.6 },
                                {
                                    size: 0.4,
                                    groups: [{ size: 0.5 }, { size: 0.5 }],
                                },
                            ],
                        }
                    );
                } catch {}
            };
            setTimeout(reapplyLayout, 50);
            setTimeout(reapplyLayout, 400);

            // Deferred refresh: give the Workspace webview ~500ms to fully render after
            // all layout commands complete, then push the latest R environment state.
            // Doing this earlier races the webview paint and the message is dropped.
            setTimeout(() => {
                WorkspacePanel.currentPanel?.forceRefresh();
            }, 500);
            // Fetching installed packages is now handled natively in workspacePanel.ts without timers.
        }
    );
}

//  Deactivate Layout

async function deactivateLayout(): Promise<void> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Deactivating R Lab...",
            cancellable: false,
        },
        async () => {
            // 1. Clear context key
            await vscode.commands.executeCommand(
                "setContext",
                "r-lab.layoutActive",
                false
            );
            await vscode.commands.executeCommand(
                "setContext",
                "r-lab.isTopRightMaximized",
                false
            );

            // 2. Dispose layout guards immediately so they don't interfere
            disposeLayoutGuards();
            viewerWatcher?.dispose();
            viewerWatcher = undefined;
            dvWatcher?.dispose();
            dvWatcher = undefined;

            // 3. Save user's text files and custom panel positions before closing
            const sourceFiles: vscode.Uri[] = [];
            const textFilePositions: Record<string, number> = {};
            const panelPositions: Record<string, number> = {};

            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        sourceFiles.push(tab.input.uri);
                        textFilePositions[tab.input.uri.fsPath] =
                            group.viewColumn;
                    } else if (tab.input instanceof vscode.TabInputWebview) {
                        if (tab.label === "Plots") {
                            panelPositions["visuals"] = group.viewColumn;
                        } else if (tab.label === "R Help") {
                            panelPositions["help"] = group.viewColumn;
                        } else if (tab.label === "Tools") {
                            panelPositions["tools"] = group.viewColumn;
                        } else if (
                            tab.label === "Visuals" ||
                            tab.label === "Visualizations"
                        ) {
                            panelPositions["visuals"] = group.viewColumn;
                        } else if (tab.label === "Workspace") {
                            panelPositions["workspace"] = group.viewColumn;
                        } else if (tab.label === "Data Viewer") {
                            panelPositions["dataViewer"] = group.viewColumn;
                        } else if (tab.label === "Viewer") {
                            panelPositions["visuals"] = group.viewColumn;
                        } else if (tab.label === "Problems") {
                            panelPositions["problems"] = group.viewColumn;
                        }
                    }
                }
            }

            // Save to workspaceState
            await extensionContext.workspaceState.update(
                "r-lab.textFilePositions",
                textFilePositions
            );
            await extensionContext.workspaceState.update(
                "r-lab.panelPositions",
                panelPositions
            );

            // Save Help state to in-memory variable before disposing
            if (ToolsPanel.currentPanel) {
                savedHelpState = ToolsPanel.currentPanel.saveState();
                await extensionContext.workspaceState.update(
                    "r-lab.helpState",
                    undefined
                );
            } else if (HelpPanel.currentPanel) {
                savedHelpState = HelpPanel.currentPanel.saveState();
                await extensionContext.workspaceState.update(
                    "r-lab.helpState",
                    undefined
                );
            }

            // Save Data Viewer state to in-memory variable before disposing
            if (DataViewerPanel.currentPanel) {
                savedDataViewerState = DataViewerPanel.currentPanel.saveState();
                // Clear workspaceState in case it was used previously
                await extensionContext.workspaceState.update(
                    "r-lab.dataViewerState",
                    undefined
                );
            }

            // Save Viewer/Visuals state to in-memory variable before disposing
            if (VisualsPanel.currentPanel) {
                const visualsState = VisualsPanel.currentPanel.saveState();
                savedViewerState = visualsState.viewerState;
                VisualsPanel.lastClosedState = visualsState;
                await extensionContext.workspaceState.update(
                    "r-lab.viewerState",
                    undefined
                );
            }
            if (ViewerPanel.currentPanel) {
                savedViewerState = ViewerPanel.currentPanel.saveState();
                await extensionContext.workspaceState.update(
                    "r-lab.viewerState",
                    undefined
                );
            }

            // Ensure focus is on a text editor before disposing panels to avoid
            // "No active text editor" warnings from vscode-R when the active tab is
            // a popped-out R Lab webview in the main editor area.
            await focusTextEditorBeforePanelDisposal(sourceFiles);

            // 4. Dispose panel singletons (closes our Webview tabs). VS Code can clear
            // activeTextEditor after any individual webview closes, so restore the text
            // focus between disposals when needed.
            await disposePanelWithTextFocus(
                () => HelpPanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => VisualsPanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => PlotsPanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => ViewerPanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => ProblemsPanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => ToolsPanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => WorkspacePanel.currentPanel?.dispose(),
                sourceFiles
            );
            await disposePanelWithTextFocus(
                () => DataViewerPanel.currentPanel?.dispose(),
                sourceFiles
            );

            // 5. Restore user settings FIRST - before moving terminals or reopening files -
            //    so that terminal defaults are correct when moving, and closeEmptyGroups
            //    is true when showTextDocument runs.
            const cfgTarget = getConfigTarget();
            const wsConfig = vscode.workspace.getConfiguration();

            const origClose = extensionContext.workspaceState.get<
                boolean | undefined
            >("r-lab.origCloseEmptyGroups", undefined);

            await Promise.all([
                Promise.resolve(
                    wsConfig.update(
                        "workbench.editor.closeEmptyGroups",
                        origClose,
                        cfgTarget
                    )
                ).catch(() => {}),
                Promise.resolve(
                    extensionContext.workspaceState.update(
                        "r-lab.origCloseEmptyGroups",
                        undefined
                    )
                ).catch(() => {}),
            ]);
            await delay(100); // Give VS Code backend time to register the setting change

            // 6. Move only R Lab terminals back to the bottom panel.
            //    We target ONLY our terminals by reference, not all editor terminals.
            //    This prevents moving third-party terminals (e.g. Python Debugger) which
            //    can corrupt panel state and cause PTY crashes on reactivation.
            for (const terminal of [rConsoleTerminal, shellTerminal]) {
                if (!terminal) {
                    continue;
                }
                // Check if this specific terminal is an editor tab
                const isEditorTab = vscode.window.tabGroups.all.some((g) =>
                    g.tabs.some((tab) => {
                        const input = tab.input as any;
                        return (
                            input instanceof vscode.TabInputTerminal &&
                            (tab.label === terminal.name ||
                                tab.label.includes(terminal.name))
                        );
                    })
                );
                if (isEditorTab) {
                    terminal.show(false); // Activate this terminal in its editor tab
                    await delay(100);
                    await vscode.commands.executeCommand(
                        "workbench.action.terminal.moveToTerminalPanel"
                    );
                    await delay(100);
                }
            }
            // Keep rConsoleTerminal / shellTerminal references alive so the next
            // activateLayout() can immediately reuse them without re-scanning,
            // and so Bug 1's `wasRConsoleReused` guard works correctly.
            // The onDidCloseTerminal listener (registered in registerLayoutCommand)
            // will null them out if the user manually closes a terminal.

            // 7. Close remaining non-text/non-terminal tabs (our custom webview panels).
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of [...group.tabs]) {
                    if (
                        tab.input instanceof vscode.TabInputText ||
                        tab.input instanceof vscode.TabInputTerminal
                    ) {
                        continue;
                    }
                    try {
                        await vscode.window.tabGroups.close(tab);
                    } catch {}
                }
            }
            await focusTextEditorBeforePanelDisposal(sourceFiles);

            // 8. Reset to single editor group.
            await vscode.commands.executeCommand("vscode.setEditorLayout", {
                orientation: 0,
                groups: [{}],
            });
            await focusTextEditorBeforePanelDisposal(sourceFiles);

            // 9. Restore the sidebar
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.toggleSidebarVisibility"
                );
            } catch {}

            // (Settings were restored above in step 5)

            // 11. Reopen user's source files in the single editor group
            for (const uri of sourceFiles) {
                try {
                    await vscode.window.showTextDocument(uri, {
                        viewColumn: vscode.ViewColumn.One,
                        preview: false,
                        preserveFocus: true,
                    });
                } catch {
                    // skip - file may no longer exist
                }
            }

            // 12. Persist & update UI
            isLayoutActive = false;
            currentAnchorUri = undefined;
            await extensionContext.workspaceState.update(STATE_KEY, false);
            updateStatusBar();
        }
    );
}

//  Layout Guards - redirect stray content to the right layout

let layoutGuards: vscode.Disposable[] = [];
let terminalGuardBusy = false;
type ProtectedPanelKey = "tools" | "workspace" | "plots" | "dataViewer";

const protectedPanelByViewType = new Map<string, ProtectedPanelKey>([
    [ToolsPanel.viewType, "tools"],
    [WorkspacePanel.viewType, "workspace"],
    [VisualsPanel.viewType, "plots"],
    [VisualsPanel.legacyViewType, "plots"],
    [PlotsPanel.viewType, "plots"],
    [DataViewerPanel.viewType, "dataViewer"],
    [ViewerPanel.viewType, "plots"],
]);

const protectedPanelByLabel = new Map<string, ProtectedPanelKey>([
    ["Tools", "tools"],
    ["Workspace", "workspace"],
    ["Visuals", "plots"],
    ["Visualizations", "plots"],
    ["Plots", "plots"],
    ["Data Viewer", "dataViewer"],
    ["Viewer", "plots"],
]);

const pendingProtectedPanelRestores = new Set<ProtectedPanelKey>();
interface ProtectedPanelRestoreRequest {
    panelKey: ProtectedPanelKey;
    viewColumn: vscode.ViewColumn;
    activeLabel: string;
    activeGroupColumn: vscode.ViewColumn | undefined;
}

const pendingProtectedPanelRestoreRequests = new Map<
    ProtectedPanelKey,
    ProtectedPanelRestoreRequest
>();
let protectedPanelRestoreBusy = false;
const lastActiveTabByColumn = new Map<vscode.ViewColumn, string>();
let lastActiveGroupColumn: vscode.ViewColumn | undefined;

function registerLayoutGuards(context: vscode.ExtensionContext): void {
    for (const d of layoutGuards) {
        d.dispose();
    }
    layoutGuards = [];
    refreshActiveTabSnapshot();

    // Terminal guard
    // Two-event approach for imperceptible interception:
    //
    // 1. onDidOpenTerminal - fires when the terminal object is created.
    //    Store a reference to the new terminal.
    //
    // 2. onDidChangeTabs (TabInputTerminal) - fires when the tab
    //    ACTUALLY APPEARS in the UI. At this moment we know its group
    //    from the event. If wrong group, immediately dispose+recreate.
    //    No delays, no terminal.show() - operates within the same
    //    ~16ms render frame as the tab appearing.
    let _pendingTerminal: vscode.Terminal | null = null;
    let _termGuardBusy = false;

    const termOpenGuard = vscode.window.onDidOpenTerminal((terminal) => {
        if (!isLayoutActive || activationInProgress || _termGuardBusy) {
            return;
        }
        if (terminal === rConsoleTerminal || terminal === shellTerminal) {
            return;
        }
        _pendingTerminal = terminal;
        // Safety timeout - clear reference if tab event never fires
        setTimeout(() => {
            if (_pendingTerminal === terminal) {
                _pendingTerminal = null;
            }
        }, 2000);
    });

    // Allowlist of webview viewTypes that BELONG in Groups 2 and 3.
    // Anything not in this set (and not a terminal we own) is stray and
    // gets moved to Group 1.
    const allowedGroup2ViewTypes = new Set([ToolsPanel.viewType]);
    const allowedGroup3ViewTypes = new Set([
        "r-lab.workspacePanel",
        VisualsPanel.viewType,
        VisualsPanel.legacyViewType,
        "r-lab.dataViewerPanel",
    ]);

    const tabAndTermGuard = vscode.window.tabGroups.onDidChangeTabs(
        async (e) => {
            if (
                !isLayoutActive ||
                activationInProgress ||
                panelMoveInProgress
            ) {
                return;
            }
            if (
                vscode.workspace
                    .getConfiguration("r-lab")
                    .get<boolean>("protectLayoutTabs", true)
            ) {
                for (const tab of e.closed) {
                    const panelKey = getProtectedPanelKey(tab);
                    if (panelKey) {
                        scheduleProtectedPanelRestore(
                            context,
                            getProtectedPanelRestoreRequest(panelKey, tab)
                        );
                    }
                }
            }

            for (const tab of e.opened) {
                const group = vscode.window.tabGroups.all.find((g) =>
                    g.tabs.includes(tab)
                );
                if (!group) {
                    continue;
                }

                // --- Anchor cleanup: when a real file opens in Group 1, close the placeholder ---
                if (
                    group.viewColumn === vscode.ViewColumn.One &&
                    tab.input instanceof vscode.TabInputText &&
                    currentAnchorUri &&
                    tab.input.uri.toString() !== currentAnchorUri
                ) {
                    const anchorUriStr = currentAnchorUri;
                    currentAnchorUri = undefined;
                    setTimeout(async () => {
                        for (const g of vscode.window.tabGroups.all) {
                            for (const t of g.tabs) {
                                if (
                                    t.input instanceof vscode.TabInputText &&
                                    t.input.uri.toString() === anchorUriStr
                                ) {
                                    try {
                                        await vscode.window.tabGroups.close(t);
                                    } catch {}
                                }
                            }
                        }
                    }, 50);
                    continue;
                }

                // --- Everything in Group 1 is fine ---
                if (group.viewColumn === vscode.ViewColumn.One) {
                    continue;
                }

                // --- Group 2: allow our terminals and our panels ---
                if (group.viewColumn === vscode.ViewColumn.Two) {
                    if (tab.input instanceof vscode.TabInputTerminal) {
                        continue;
                    }
                    if (tab.input instanceof vscode.TabInputWebview) {
                        const viewType = (tab.input as any).viewType as
                            | string
                            | undefined;
                        if (viewType && allowedGroup2ViewTypes.has(viewType)) {
                            continue;
                        }
                    }
                }

                // --- Group 3: allow our panels ---
                if (group.viewColumn === vscode.ViewColumn.Three) {
                    if (tab.input instanceof vscode.TabInputWebview) {
                        const viewType = (tab.input as any).viewType as
                            | string
                            | undefined;
                        if (viewType && allowedGroup3ViewTypes.has(viewType)) {
                            continue;
                        }
                    }
                }

                // --- This tab is stray. Move it to Group 1. ---

                // Text documents: close and reopen in Group 1 (reliable for text).
                if (tab.input instanceof vscode.TabInputText) {
                    const uri = tab.input.uri;
                    try {
                        await vscode.window.tabGroups.close(tab);
                        await vscode.window.showTextDocument(uri, {
                            viewColumn: vscode.ViewColumn.One,
                            preview: false,
                            preserveFocus: false,
                        });
                    } catch {}
                    continue;
                }

                // Text diffs: close and reopen in Group 1.
                if (tab.input instanceof vscode.TabInputTextDiff) {
                    const diff = tab.input as vscode.TabInputTextDiff;
                    try {
                        await vscode.window.tabGroups.close(tab);
                        await vscode.commands.executeCommand(
                            "vscode.diff",
                            diff.original,
                            diff.modified,
                            undefined,
                            {
                                viewColumn: vscode.ViewColumn.One,
                                preserveFocus: false,
                            }
                        );
                    } catch {}
                    continue;
                }

                // Third-party terminal tabs: dispose and recreate in Group 2.
                if (tab.input instanceof vscode.TabInputTerminal) {
                    if (_termGuardBusy || !_pendingTerminal) {
                        continue;
                    }
                    const terminal = _pendingTerminal;
                    _pendingTerminal = null;
                    _termGuardBusy = true;
                    const opts =
                        terminal.creationOptions as vscode.TerminalOptions;
                    terminal.dispose();
                    try {
                        const newTerm = vscode.window.createTerminal({
                            name: opts.name ?? "Terminal",
                            shellPath: opts.shellPath,
                            shellArgs: opts.shellArgs,
                            cwd: opts.cwd,
                            env: opts.env,
                            location: { viewColumn: vscode.ViewColumn.Two },
                        });
                        newTerm.show(false);
                    } finally {
                        setTimeout(() => {
                            _termGuardBusy = false;
                        }, 600);
                    }
                    continue;
                }

                // Everything else (extension info pages, settings, walkthroughs,
                // notebooks, custom editors, etc.): MOVE the tab to Group 1 without
                // closing it. We use a deferred approach because onDidChangeTabs fires
                // when the tab object is created, but before the tab becomes the active
                // editor in its group. The 300ms delay lets the tab fully render and
                // become active, so moveEditorToFirstGroup targets the correct tab.
                const strayGroupColumn = group.viewColumn;
                setTimeout(async () => {
                    try {
                        if (strayGroupColumn === vscode.ViewColumn.Two) {
                            await vscode.commands.executeCommand(
                                "workbench.action.focusSecondEditorGroup"
                            );
                        } else if (
                            strayGroupColumn === vscode.ViewColumn.Three
                        ) {
                            await vscode.commands.executeCommand(
                                "workbench.action.focusThirdEditorGroup"
                            );
                        }
                        await vscode.commands.executeCommand(
                            "workbench.action.moveEditorToFirstGroup"
                        );
                        await vscode.commands.executeCommand(
                            "workbench.action.focusFirstEditorGroup"
                        );
                    } catch {}
                }, 80);
            }
        }
    );

    layoutGuards.push(tabAndTermGuard, termOpenGuard);
    context.subscriptions.push(tabAndTermGuard, termOpenGuard);
}

function getProtectedPanelKey(tab: vscode.Tab): ProtectedPanelKey | undefined {
    const byLabel = protectedPanelByLabel.get(tab.label);
    if (byLabel) {
        return byLabel;
    }

    if (tab.input instanceof vscode.TabInputWebview) {
        const viewType = (tab.input as any).viewType as string | undefined;
        return viewType ? protectedPanelByViewType.get(viewType) : undefined;
    }

    return undefined;
}

function getProtectedPanelRestoreRequest(
    panelKey: ProtectedPanelKey,
    closedTab: vscode.Tab
): ProtectedPanelRestoreRequest {
    const viewColumn = getProtectedPanelViewColumn(panelKey);
    const activeGroupColumn =
        lastActiveGroupColumn ??
        vscode.window.tabGroups.activeTabGroup.viewColumn;
    let activeLabel =
        (closedTab.isActive
            ? closedTab.label
            : lastActiveTabByColumn.get(viewColumn)) ??
        getActiveTabLabel(viewColumn) ??
        closedTab.label;
    if (panelKey === "plots") {
        activeLabel = "Visuals";
    }

    return { panelKey, viewColumn, activeLabel, activeGroupColumn };
}

function getProtectedPanelViewColumn(
    panelKey: ProtectedPanelKey
): vscode.ViewColumn {
    return panelKey === "tools"
        ? vscode.ViewColumn.Two
        : vscode.ViewColumn.Three;
}

function getActiveTabLabel(viewColumn: vscode.ViewColumn): string | undefined {
    return vscode.window.tabGroups.all.find(
        (group) => group.viewColumn === viewColumn
    )?.activeTab?.label;
}

function refreshActiveTabSnapshot(): void {
    lastActiveGroupColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;
    for (const group of vscode.window.tabGroups.all) {
        const activeTab = group.activeTab;
        if (activeTab) {
            lastActiveTabByColumn.set(group.viewColumn, activeTab.label);
        }
    }
}

function scheduleProtectedPanelRestore(
    context: vscode.ExtensionContext,
    request: ProtectedPanelRestoreRequest
): void {
    pendingProtectedPanelRestores.add(request.panelKey);
    pendingProtectedPanelRestoreRequests.set(request.panelKey, request);
    if (protectedPanelRestoreBusy) {
        return;
    }

    protectedPanelRestoreBusy = true;
    setTimeout(async () => {
        panelMoveInProgress = true;
        let requests: ProtectedPanelRestoreRequest[] = [];
        try {
            requests = await restoreProtectedPanels(context);
        } finally {
            setTimeout(async () => {
                try {
                    await restoreProtectedPanelFocus(requests);
                    await delay(175);
                    await restoreProtectedPanelFocus(requests);
                } finally {
                    panelMoveInProgress = false;
                    protectedPanelRestoreBusy = false;
                    if (pendingProtectedPanelRestores.size > 0) {
                        const next = pendingProtectedPanelRestores
                            .values()
                            .next().value;
                        if (next) {
                            const request =
                                pendingProtectedPanelRestoreRequests.get(next);
                            if (request) {
                                scheduleProtectedPanelRestore(context, request);
                            }
                        }
                    }
                }
            }, 180);
        }
    }, 80);
}

async function recreateProtectedShellTerminal(): Promise<void> {
    if (
        !isLayoutActive ||
        activationInProgress ||
        panelMoveInProgress ||
        shellTerminal
    ) {
        return;
    }

    panelMoveInProgress = true;
    try {
        await createShellTerminalInGroup2();
        await enforceTabOrder(vscode.ViewColumn.Two, "Terminal", [
            "R Console",
            "Terminal",
            "Tools",
        ]);
        const restoredTerminal = shellTerminal as vscode.Terminal | undefined;
        restoredTerminal?.show(false);
        setTimeout(() => {
            if (
                restoredTerminal &&
                isLayoutActive &&
                getActiveTabLabel(vscode.ViewColumn.Two) === "Terminal"
            ) {
                restoredTerminal.show(false);
            }
        }, 400);
    } finally {
        setTimeout(() => {
            panelMoveInProgress = false;
        }, 200);
    }
}

async function createShellTerminalInGroup2(): Promise<void> {
    const platform =
        os.platform() === "win32"
            ? "windows"
            : os.platform() === "darwin"
              ? "osx"
              : "linux";
    const userEnv =
        vscode.workspace
            .getConfiguration("terminal.integrated.env")
            .get<Record<string, string>>(platform) || {};
    const shellEnvArgs: Record<string, string> = {
        ...(process.env as any),
        ...userEnv,
    };

    const terminalOptions: vscode.TerminalOptions = {
        name: "Terminal",
        // Do NOT use location: { viewColumn: ... } here on Windows. Creating a generic shell directly
        // into an editor group causes intermittent blank ConPTY terminals on Windows.
        location:
            os.platform() === "win32"
                ? undefined
                : { viewColumn: vscode.ViewColumn.Two },
        cwd: getEffectiveWorkspaceRoot(),
    };

    // strictEnv crashes the default shell on Windows, but is required on Mac/Linux
    // to prevent PTY crashes (warning icon) during layout deactivation.
    if (os.platform() !== "win32") {
        terminalOptions.env = shellEnvArgs;
        terminalOptions.strictEnv = true;
    }

    shellTerminal = vscode.window.createTerminal(terminalOptions);

    if (os.platform() === "win32") {
        shellTerminal.show(true); // Must show in panel to force PTY initialization
        await delay(500); // Give ConPTY time to fully spawn before moving

        await vscode.commands.executeCommand(
            "workbench.action.focusSecondEditorGroup"
        );
        await delay(50);
        await vscode.commands.executeCommand(
            "workbench.action.terminal.moveToEditor"
        );
        await delay(100);
    } else {
        shellTerminal.show(false);
        await delay(50);
    }
}

function getTerminalTabGroup(
    label: string,
    viewColumn?: vscode.ViewColumn
): vscode.TabGroup | undefined {
    return vscode.window.tabGroups.all.find(
        (group) =>
            (viewColumn === undefined || group.viewColumn === viewColumn) &&
            group.tabs.some(
                (tab) =>
                    tab.input instanceof vscode.TabInputTerminal &&
                    tab.label.includes(label)
            )
    );
}

async function ensureRConsoleInGroup2(
    context: vscode.ExtensionContext,
    rEnv: Record<string, string>
): Promise<void> {
    if (getTerminalTabGroup("R Console", vscode.ViewColumn.Two)) {
        return;
    }

    if (!rConsoleTerminal) {
        rConsoleTerminal = vscode.window.terminals.find(
            (t) => t.name === "R Console"
        );
    }

    if (
        rConsoleTerminal &&
        vscode.window.terminals.includes(rConsoleTerminal)
    ) {
        const rConsoleEditorGroup = getTerminalTabGroup("R Console");
        if (rConsoleEditorGroup) {
            await focusTabByLabelFallback(
                rConsoleEditorGroup.viewColumn,
                "R Console"
            );
            await delay(80);
            if (getTerminalTabGroup("R Console", vscode.ViewColumn.Two)) {
                return;
            }
            try {
                await vscode.commands.executeCommand(
                    "workbench.action.moveEditorToSecondGroup"
                );
                await delay(120);
            } catch {}
        } else {
            rConsoleTerminal.show(true);
            await delay(120);
            await vscode.commands.executeCommand(
                "workbench.action.focusSecondEditorGroup"
            );
            await delay(50);
            await vscode.commands.executeCommand(
                "workbench.action.terminal.moveToEditor"
            );
            await delay(120);
        }

        // Wait up to 2 seconds for it to land in Group 2
        for (let i = 0; i < 20; i++) {
            if (getTerminalTabGroup("R Console", vscode.ViewColumn.Two)) {
                return;
            }
            await delay(100);
        }
        return; // Even if it takes longer, do NOT fall through to create a duplicate!
    }

    const isWindows = os.platform() === "win32";
    rConsoleTerminal = vscode.window.createTerminal({
        name: "R Console",
        shellPath: getRPath(),
        shellArgs: getRArgs(),
        location: isWindows ? undefined : { viewColumn: vscode.ViewColumn.Two },
        env: { ...rEnv, R_LAB_SESSION: "1" },
        strictEnv: !isWindows,
        cwd: getEffectiveWorkspaceRoot(),
        iconPath: vscode.Uri.joinPath(
            context.extensionUri,
            "resources",
            "r_logo.svg"
        ),
    });

    if (isWindows) {
        rConsoleTerminal.show(true);
        await delay(500);
        await vscode.commands.executeCommand(
            "workbench.action.focusSecondEditorGroup"
        );
        await delay(50);
        await vscode.commands.executeCommand(
            "workbench.action.terminal.moveToEditor"
        );
        await delay(200);
        // Wait for it to land in Group 2
        await waitForTerminalInGroup2("R Console", 3000);
    } else {
        rConsoleTerminal.show(false);
        await delay(80);
    }
}

async function restoreProtectedPanels(
    context: vscode.ExtensionContext
): Promise<ProtectedPanelRestoreRequest[]> {
    const restoreOrder: ProtectedPanelKey[] = [
        "tools",
        "workspace",
        "plots",
        "dataViewer",
    ];
    const requested = restoreOrder.filter((panelKey) =>
        pendingProtectedPanelRestores.delete(panelKey)
    );
    const requests = requested
        .map((panelKey) => pendingProtectedPanelRestoreRequests.get(panelKey))
        .filter(
            (request): request is ProtectedPanelRestoreRequest => !!request
        );
    for (const panelKey of requested) {
        pendingProtectedPanelRestoreRequests.delete(panelKey);
    }

    for (const panelKey of requested) {
        switch (panelKey) {
            case "tools": {
                const panel = ToolsPanel.createOrShow(
                    context.extensionUri,
                    vscode.ViewColumn.Two
                );
                const state = savedHelpState ?? ToolsPanel.lastClosedState;
                if (state) {
                    panel.loadState(state);
                }
                await enforceTabOrder(vscode.ViewColumn.Two, "Tools", [
                    "R Console",
                    "Terminal",
                    "Tools",
                ]);
                break;
            }
            case "workspace": {
                const panel = WorkspacePanel.createOrShow(
                    context.extensionUri,
                    vscode.ViewColumn.Three
                );
                if (WorkspacePanel.lastClosedState) {
                    panel.loadState(WorkspacePanel.lastClosedState);
                }
                bindWorkspaceDataView(context, panel);
                await enforceTabOrder(vscode.ViewColumn.Three, "Workspace", [
                    "Workspace",
                    "Visuals",
                    "Data Viewer",
                ]);
                setTimeout(
                    () => WorkspacePanel.currentPanel?.forceRefresh(),
                    250
                );
                break;
            }
            case "plots": {
                const panel = VisualsPanel.createOrShow(
                    context.extensionUri,
                    vscode.ViewColumn.Three
                );
                const state =
                    VisualsPanel.lastClosedState ??
                    (savedViewerState
                        ? { viewerState: savedViewerState }
                        : undefined);
                if (state) {
                    await panel.loadState(state);
                }
                PlotsPanel.currentPanel?.syncPlots();
                await enforceTabOrder(vscode.ViewColumn.Three, "Visuals", [
                    "Workspace",
                    "Visuals",
                    "Data Viewer",
                ]);
                break;
            }
            case "dataViewer": {
                const panel = DataViewerPanel.createOrShow(
                    context.extensionUri,
                    vscode.ViewColumn.Three
                );
                const state =
                    savedDataViewerState ?? DataViewerPanel.lastClosedState;
                if (state) {
                    await panel.loadState(state);
                }
                await enforceTabOrder(vscode.ViewColumn.Three, "Data Viewer", [
                    "Workspace",
                    "Visuals",
                    "Data Viewer",
                ]);
                break;
            }
        }
    }

    return requests;
}

function bindWorkspaceDataView(
    context: vscode.ExtensionContext,
    workspacePanel: WorkspacePanel
): void {
    workspacePanel.onRequestDataView((varName) => {
        const activeDataPanel =
            DataViewerPanel.currentPanel ||
            DataViewerPanel.createOrShow(
                context.extensionUri,
                vscode.ViewColumn.Three
            );
        activeDataPanel.loadVariable(varName);
        activeDataPanel.reveal();
    });
}

async function restoreProtectedPanelFocus(
    requests: ProtectedPanelRestoreRequest[]
): Promise<void> {
    const desiredByColumn = new Map<vscode.ViewColumn, string>();
    let activeGroupColumn = vscode.window.tabGroups.activeTabGroup.viewColumn;

    for (const request of requests) {
        desiredByColumn.set(request.viewColumn, request.activeLabel);
        activeGroupColumn = request.activeGroupColumn ?? activeGroupColumn;
    }

    for (const [viewColumn, activeLabel] of desiredByColumn) {
        await revealLayoutTab(activeLabel, viewColumn);
    }

    if (activeGroupColumn !== undefined) {
        const focusCommand = groupFocusCommand(activeGroupColumn);
        if (focusCommand) {
            try {
                await vscode.commands.executeCommand(focusCommand);
            } catch {}
        }
    }
    for (const [viewColumn, activeLabel] of desiredByColumn) {
        lastActiveTabByColumn.set(viewColumn, activeLabel);
    }
    if (activeGroupColumn !== undefined) {
        lastActiveGroupColumn = activeGroupColumn;
    }
}

async function revealLayoutTab(
    label: string,
    viewColumn: vscode.ViewColumn
): Promise<void> {
    try {
        switch (label) {
            case "R Console":
                rConsoleTerminal?.show(false);
                break;
            case "Terminal":
                shellTerminal?.show(false);
                break;
            case "Problems":
                ToolsPanel.currentPanel?.revealTool(
                    "problems",
                    viewColumn,
                    false
                );
                break;
            case "R Help":
                ToolsPanel.currentPanel?.revealTool("help", viewColumn, false);
                break;
            case "Tools":
                ToolsPanel.currentPanel?.reveal(viewColumn, false);
                break;
            case "Workspace":
                WorkspacePanel.currentPanel?.reveal(viewColumn, false);
                break;
            case "Visuals":
            case "Visualizations":
                VisualsPanel.currentPanel?.reveal(viewColumn, false);
                break;
            case "Plots":
                VisualsPanel.currentPanel?.revealTarget(
                    "plots",
                    viewColumn,
                    false
                );
                break;
            case "Data Viewer":
                DataViewerPanel.currentPanel?.reveal(viewColumn, false);
                break;
            case "Viewer":
                VisualsPanel.currentPanel?.revealTarget(
                    "viewer",
                    viewColumn,
                    false
                );
                break;
            default:
                await focusTabByLabelFallback(viewColumn, label);
                break;
        }
        await delay(40);
    } catch {}
}

async function focusTabByLabelFallback(
    viewColumn: vscode.ViewColumn,
    label: string
): Promise<void> {
    const focusCommand = groupFocusCommand(viewColumn);
    let group = vscode.window.tabGroups.all.find(
        (g) => g.viewColumn === viewColumn
    );
    if (!focusCommand || !group) {
        return;
    }

    let tabIndex = group.tabs.findIndex((tab) => tab.label === label);
    if (tabIndex === -1) {
        return;
    }

    await vscode.commands.executeCommand(focusCommand);
    await delay(20);
    await vscode.commands.executeCommand("workbench.action.lastEditorInGroup");
    await delay(20);

    group = vscode.window.tabGroups.all.find(
        (g) => g.viewColumn === viewColumn
    );
    if (!group) {
        return;
    }

    tabIndex = group.tabs.findIndex((tab) => tab.label === label);
    if (tabIndex === -1) {
        return;
    }

    for (let i = group.tabs.length - 1; i > tabIndex; i--) {
        await vscode.commands.executeCommand(
            "workbench.action.previousEditorInGroup"
        );
        await delay(10);
    }
}

async function waitForTerminalInGroup2(
    label: string,
    timeoutMs: number = 4000
): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (getTerminalTabGroup(label, vscode.ViewColumn.Two)) {
            return true;
        }
        await delay(100);
    }
    return false;
}

async function enforceTabOrder(
    viewColumn: vscode.ViewColumn,
    panelTitle: string,
    strictOrder: string[]
): Promise<void> {
    await delay(50);
    const focusCommand = groupFocusCommand(viewColumn);
    if (!focusCommand) {
        return;
    }

    for (let expectedIdx = 0; expectedIdx < strictOrder.length; expectedIdx++) {
        const expectedLabel = strictOrder[expectedIdx];
        let group = vscode.window.tabGroups.all.find(
            (g) => g.viewColumn === viewColumn
        );
        if (!group) {
            return;
        }

        let currentIdx = group.tabs.findIndex(
            (tab) => tab.label === expectedLabel
        );
        if (currentIdx === -1) {
            continue;
        }
        if (currentIdx === expectedIdx) {
            continue;
        }

        try {
            await vscode.commands.executeCommand(focusCommand);
            await delay(20);
            await vscode.commands.executeCommand(
                "workbench.action.lastEditorInGroup"
            );
            await delay(20);

            group = vscode.window.tabGroups.all.find(
                (g) => g.viewColumn === viewColumn
            );
            if (!group) {
                return;
            }
            currentIdx = group.tabs.findIndex(
                (tab) => tab.label === expectedLabel
            );
            if (currentIdx === -1) {
                continue;
            }

            for (let i = group.tabs.length - 1; i > currentIdx; i--) {
                await vscode.commands.executeCommand(
                    "workbench.action.previousEditorInGroup"
                );
                await delay(10);
            }

            await vscode.commands.executeCommand("moveActiveEditor", {
                to: "position",
                by: "tab",
                value: expectedIdx + 1,
            });
            await delay(30);
        } catch {}
    }

    const group = vscode.window.tabGroups.all.find(
        (g) => g.viewColumn === viewColumn
    );
    const finalLabels = group?.tabs.map((tab) => tab.label) ?? [];
    if (finalLabels.includes(panelTitle)) {
        return;
    }
}

function disposeLayoutGuards(): void {
    for (const d of layoutGuards) {
        d.dispose();
    }
    layoutGuards = [];
}

//  AI Chat - helpers, discovery, and Group 3 placement

/**
 * Returns true if a tab is a Chat/AI chat tab from any vendor.
 * Uses label matching as a universal fallback - all major AI chat
 * extensions (Antigravity, Copilot, Gemini, Claude, etc.) include
 * "chat" or their brand name in their editor tab label.
 */

/**
 * Opens AI Chat tabs in Group 3 (top-right layout), preserving sessions.
 *
 * Strategy:
 *   Tier 1. Already in Group 3 - skip.
 *   Tier 2. vscode.moveViews - RELOCATES the existing sidebar view into Group 3.
 *           This preserves the chat session and avoids creating a duplicate.
 *           Tried for EVERY detected AI extension so Copilot + Gemini etc.
 *           each get their own sub-tab.
 *   Tier 3. openInEditor / extension-specific commands - last resort only.
 *           Creates a new (fresh) editor instance. Used only when moveViews
 *           fails for all extensions (e.g. extension doesn't support it).
 *
 * After each successful placement, the new tab is moved left past Help so
 * the order is always Chat(s) -> Help per the AGENTS.md spec.
 *
 * IMPORTANT: Caller must create HelpPanel in Group 3 BEFORE calling this.
 * focusThirdEditorGroup silently no-ops on an empty group - Group 3 must
 * already have content for the focus (and thus placement) to be reliable.
 */

/**
 * Full AI extension discovery: scans ALL installed extensions and
 * collects views, chat participants, and commands for each AI extension.
 */

async function focusGroup3(): Promise<void> {
    try {
        // 1. Try standard command
        await vscode.commands.executeCommand(
            "workbench.action.focusThirdEditorGroup"
        );
        await delay(10);

        // 2. Aggressive fallback: Force reveal the HelpPanel WITHOUT preserving focus.
        // This is the most reliable way to force focus into Group 3 if it exists.
        if (HelpPanel.currentPanel) {
            HelpPanel.currentPanel.reveal(vscode.ViewColumn.Three, false);
        }
        await delay(10);
    } catch {
        // Silently ignore
    }
}

//  Status Bar

function updateStatusBar(): void {
    if (isLayoutActive) {
        statusBarItem.text = "R Lab $(circle-filled)";
        statusBarItem.tooltip = "Click to Deactivate R Lab";
    } else {
        statusBarItem.text = "R Lab";
        statusBarItem.tooltip = "Click to Activate R Lab";
    }
}

//  Utility

/** Maps a ViewColumn to the command that focuses that editor group. */
function groupFocusCommand(col: vscode.ViewColumn): string | undefined {
    const map: Record<number, string> = {
        1: "workbench.action.focusFirstEditorGroup",
        2: "workbench.action.focusSecondEditorGroup",
        3: "workbench.action.focusThirdEditorGroup",
        4: "workbench.action.focusFourthEditorGroup",
    };
    return map[col as number];
}

/**
 * Write the workspace watcher R script and return its path.
 * The caller passes this as R_PROFILE_USER when creating the terminal,
 * so R sources it silently at startup - no command appears in the console.
 */
function _buildWatcherRprofile(): string | undefined {
    const wf = getEffectiveWorkspaceRoot();
    console.log(
        `[R Lab] _buildWatcherRprofile: wf=${wf}, workspaceFolders=${JSON.stringify(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath))}`
    );

    const outDir = path.join(wf, ".R-lab");
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    const configPlotDir =
        vscode.workspace
            .getConfiguration("r-lab")
            .get<string>("plotOutputDir") || "";
    let plotsDir = path.join(outDir, "plots");
    if (configPlotDir.trim()) {
        const resolved = configPlotDir.replace("~", os.homedir());
        plotsDir = path.isAbsolute(resolved)
            ? path.normalize(resolved)
            : path.join(wf, resolved);
    }

    if (!fs.existsSync(plotsDir)) {
        fs.mkdirSync(plotsDir, { recursive: true });
    }

    const scriptPath = path.join(outDir, ".workspace_watcher.R");
    console.log(`[R Lab] _buildWatcherRprofile: scriptPath=${scriptPath}`);

    // Absolute paths injected into the R script so it works regardless of R's cwd.
    // On Windows, backslashes must be escaped for R string literals.
    const absOutDir = outDir.replace(/\\/g, "/");
    const absPlotsDir = plotsDir.replace(/\\/g, "/");
    const absDvCsv = path.join(outDir, "dv.csv").replace(/\\/g, "/");
    const absDvMeta = path.join(outDir, "dv-meta.txt").replace(/\\/g, "/");
    const absVarsTsv = path
        .join(outDir, ".workspace_vars.tsv")
        .replace(/\\/g, "/");
    const absLoadedTsv = path
        .join(outDir, ".workspace_loaded.tsv")
        .replace(/\\/g, "/");
    const absAttachedTsv = path
        .join(outDir, ".workspace_attached.tsv")
        .replace(/\\/g, "/");
    const absVarsMeta = path
        .join(outDir, ".workspace_meta.txt")
        .replace(/\\/g, "/");

    // Helper R code to snapshot the current workspace - used both at
    // startup and in the task callback. We use TSV to avoid base R JSON serialization issues.
    const snapshotCode = `
  tryCatch({
    unlink("${absVarsMeta}")
    dir.create("${absPlotsDir}", showWarnings = FALSE, recursive = TRUE)
    .vars <- ls(envir = .GlobalEnv)
    .vars <- .vars[!grepl("^\\\\.rlab_|^\\\\.r_lab|^null_dev$|^\\\\.First$|^\\\\.Last$|^\\\\.r_lab_view_data$|^View$", .vars)]
    .info <- if (length(.vars) == 0) character(0) else vapply(.vars, function(nm) {
      obj <- get(nm, envir = .GlobalEnv)
      cls_vec <- class(obj)
      if (length(cls_vec) > 3) {
        cls <- paste(c(cls_vec[1:2], "..."), collapse = ", ")
      } else {
        cls <- paste(cls_vec, collapse = ", ")
      }
      dims <- if (!is.null(dim(obj))) paste(dim(obj), collapse = " x ") else as.character(length(obj))
      sz <- format(object.size(obj), units = "auto", standard = "SI")
      dims <- paste0(dims, " (", sz, ")")
      prev <- tryCatch({
        get_type <- function(x) {
          if (is.data.frame(x)) "df" else if (is.list(x)) "list" else {
            t <- typeof(x)
            if (t == "double") "num" else if (t == "integer") "int" else if (t == "character") "chr" else if (t == "logical") "logi" else t
          }
        }
        if (is.data.frame(obj)) {
          base_str <- paste0(nrow(obj), " obs. of ", ncol(obj), " variables")
          if (length(obj) == 0) base_str else {
            nm_names <- names(obj)
            if (!is.null(nm_names) && length(nm_names) > 0 && any(nm_names != "")) {
              nm_valid <- nm_names[nm_names != ""]
              n_show <- if (length(nm_valid) > 3) 3 else length(nm_valid)
              types <- vapply(obj[1:n_show], get_type, character(1))
              paste0(base_str, " {", paste0("$", head(nm_valid, n_show), ": ", types, collapse=", "), if(length(nm_valid)>3) ", ...}" else "}")
            } else {
              n_show <- if (length(obj) > 3) 3 else length(obj)
              types <- vapply(obj[1:n_show], get_type, character(1))
              paste0(base_str, " {", paste(paste0(": ", types), collapse=", "), if(length(obj)>3) ", ...}" else "}")
            }
          }
        } else if (is.array(obj)) {
          type_lbl <- typeof(obj)
          if (type_lbl == "double") type_lbl <- "num" else if (type_lbl == "integer") type_lbl <- "int" else if (type_lbl == "character") type_lbl <- "chr" else if (type_lbl == "logical") type_lbl <- "logi"
          dim_ranges <- paste0("1:", dim(obj), collapse = ", ")
          n_show <- if (length(obj) > 3) 3 else length(obj)
          flat_vals <- as.vector(head(as.vector(obj), n_show))
          if (typeof(obj) == "character") flat_vals <- paste0('"', flat_vals, '"')
          vals_str <- paste(flat_vals, collapse = " ")
          if (length(obj) > 3) vals_str <- paste0(vals_str, " ...")
          paste0(type_lbl, " [", dim_ranges, "] ", vals_str)
        } else if (is.list(obj)) {
          if (length(obj) == 0) "List of 0" else {
            nm_names <- names(obj)
            if (!is.null(nm_names) && length(nm_names) > 0 && any(nm_names != "")) {
              nm_valid <- nm_names[nm_names != ""]
              n_show <- if (length(nm_valid) > 3) 3 else length(nm_valid)
              types <- vapply(obj[1:n_show], get_type, character(1))
              paste0("List of ", length(obj), " {", paste0("$", head(nm_valid, n_show), ": ", types, collapse=", "), if(length(nm_valid)>3) ", ...}" else "}")
            } else {
              n_show <- if (length(obj) > 3) 3 else length(obj)
              types <- vapply(obj[1:n_show], get_type, character(1))
              paste0("List of ", length(obj), " {", paste(paste0(": ", types), collapse=", "), if(length(obj)>3) ", ...}" else "}")
            }
          }
        } else if (is.function(obj)) {
          "function"
        } else if (is.vector(obj)) {
          if (length(obj) == 1) {
            if (is.character(obj)) paste0('"', obj, '"') else as.character(obj)
          } else {
            type_lbl <- typeof(obj)
            if (type_lbl == "double") type_lbl <- "num" else if (type_lbl == "integer") type_lbl <- "int" else if (type_lbl == "character") type_lbl <- "chr" else if (type_lbl == "logical") type_lbl <- "logi"
            dim_range <- paste0("1:", length(obj))
            n_show <- if (length(obj) > 3) 3 else length(obj)
            flat_vals <- as.vector(head(obj, n_show))
            if (typeof(obj) == "character") flat_vals <- paste0('"', flat_vals, '"')
            vals_str <- paste(flat_vals, collapse = " ")
            if (length(obj) > 3) vals_str <- paste0(vals_str, " ...")
            paste0(type_lbl, " [", dim_range, "] ", vals_str)
          }
        } else {
          substr(paste(as.character(obj), collapse = " "), 1, 60)
        }
      }, error = function(e) "?")
      prev <- gsub("\\\\t|\\\\n|\\\\r", " ", prev)
      is_df <- if (is.data.frame(obj) || is.matrix(obj) || (is.array(obj) && length(dim(obj)) == 3)) "true" else "false"
      paste(nm, cls, dims, prev, is_df, sep = "\\t")
    }, character(1))
    writeLines(.info, "${absVarsTsv}")
    .def_pkgs <- getOption("defaultPackages", c("datasets", "utils", "grDevices", "graphics", "stats", "methods"))
    writeLines(unique(c(loadedNamespaces(), .def_pkgs)), "${absLoadedTsv}")
    writeLines(unique(c(search(), paste0("package:", .def_pkgs))), "${absAttachedTsv}")
    writeLines("OK", "${absVarsMeta}")
  }, error = function(e) NULL)`;

    const plotExportCode = `
      .plot_req_path <- file.path("${absOutDir}", ".plot_req")
      if (file.exists(.plot_req_path)) {
        try({
          .req <- readLines(.plot_req_path, warn = FALSE)
          if (length(.req) >= 6) {
            .pid <- .req[1]
            .fmt <- .req[2]
            .w <- as.numeric(.req[3])
            .h <- as.numeric(.req[4])
            .unit <- .req[5]
            .dest <- .req[6]
            .out_dir <- getOption(".rlab_plot_dir", "${absPlotsDir}")
            .rds_file <- file.path(.out_dir, paste0(.pid, ".rds"))
            if (file.exists(.rds_file)) {
              .p_obj <- readRDS(.rds_file)

              .res <- 300
              if (.unit == "cm") { .w_in <- .w / 2.54; .h_in <- .h / 2.54 }
              else if (.unit == "mm") { .w_in <- .w / 25.4; .h_in <- .h / 25.4 }
              else if (.unit == "px") {
                .base_res <- 300
                .w_in <- .w / .base_res
                .h_in <- .h / .base_res
                if (.w_in < 5 || .h_in < 5) {
                  .scale <- max(5 / .w_in, 5 / .h_in)
                  .w_in <- .w_in * .scale
                  .h_in <- .h_in * .scale
                }
                .res <- .w / .w_in
              } else {
                .w_in <- .w; .h_in <- .h
              }

              if (.fmt == "pdf") {
                pdf(file = .dest, width = .w_in, height = .h_in, onefile = FALSE)
              } else if (.fmt == "svg") {
                svg(filename = .dest, width = .w_in, height = .h_in, onefile = FALSE)
              } else if (.fmt == "eps") {
                if (capabilities("cairo")) {
                  cairo_ps(filename = .dest, width = .w_in, height = .h_in, onefile = FALSE, fallback_resolution = 300)
                } else {
                  postscript(file = .dest, width = .w_in, height = .h_in, horizontal = FALSE, onefile = FALSE, paper = "special")
                }
              } else if (.fmt == "png") {
                png(filename = .dest, width = .w, height = .h, units = .unit, res = .res, bg = "white")
              } else if (.fmt == "jpeg" || .fmt == "jpg") {
                jpeg(filename = .dest, width = .w, height = .h, units = .unit, res = .res, bg = "white", quality = 90)
              }
              try(replayPlot(.p_obj), silent = TRUE)
              dev.off()
            }
          }
          unlink(.plot_req_path)
        }, silent = TRUE)
      }
    `;

    const plotDirRequestCode = `
      .plot_dir_req_path <- file.path("${absOutDir}", ".plot_dir_req")
      if (file.exists(.plot_dir_req_path)) {
        try({
          .dir_req <- readLines(.plot_dir_req_path, warn = FALSE)
          if (length(.dir_req) > 0) {
            .target_dir <- trimws(.dir_req[1])
            if (identical(.target_dir, "__DEFAULT__") || !nzchar(.target_dir)) {
              options(.rlab_plot_dir = NULL)
            } else {
              .target_dir <- path.expand(.target_dir)
              dir.create(.target_dir, showWarnings = FALSE, recursive = TRUE)
              options(.rlab_plot_dir = .target_dir)
            }
            .rlab_current_plot_id <<- 0
            .rlab_last_plot_hash <<- NULL
            .rlab_advance_next_plot <<- TRUE
            .rlab_skip_stale_plot_once <<- TRUE
          }
          unlink(.plot_dir_req_path)
        }, silent = TRUE)
      }
    `;

    const rCode = `
# R Lab workspace watcher - auto-loaded via R_PROFILE_USER
#
# Only the interactive R Lab console should install these hooks. If this
# profile is inherited by vscode-R, languageserver, callr, Rscript, or package
# child processes, restore normal user-profile behavior and stop here.
.rlab_is_console <- identical(Sys.getenv("R_LAB_SESSION", unset = ""), "1") && interactive()
if (!isTRUE(.rlab_is_console)) {
  local({
    orig <- Sys.getenv("R_PROFILE_USER_ORIG", unset = "")
    if (nchar(orig) > 0 && file.exists(orig)) {
      try(source(orig, echo = FALSE), silent = TRUE)
    } else {
      home_prof <- path.expand("~/.Rprofile")
      if (file.exists(home_prof)) try(source(home_prof, echo = FALSE), silent = TRUE)
    }
  })
  rm(.rlab_is_console)
} else {

# 1. Source the standard user profile (~/.Rprofile).
#    R_PROFILE_USER overrides it, so we must source it explicitly.
local({
  home_prof <- path.expand("~/.Rprofile")
  if (file.exists(home_prof)) source(home_prof, echo = FALSE)
})

# 2. Chain to any previously set R_PROFILE_USER (unlikely, but safe).
local({
  orig <- Sys.getenv("R_PROFILE_USER_ORIG", unset = "")
  if (nchar(orig) > 0 && file.exists(orig)) source(orig, echo = FALSE)
})

# 3. Pre-set fixed Data Viewer temp paths (absolute paths injected by extension).
.rlab_csv  <- "${absDvCsv}"
.rlab_meta <- "${absDvMeta}"
.rlab_active_df_to_export <- NULL
.rlab_active_df_slice <- 1
.rlab_last_plot_hash <- NULL
.rlab_current_plot_id <- 0
.rlab_skip_stale_plot_once <- FALSE

# Default plot output directory (absolute path injected by extension).
options(.rlab_plot_dir = "${absPlotsDir}")

# Set default device to null pdf to enable invisible plot recording
options(device = function(...) { pdf(file=NULL, ...); dev.control("enable") })

# Flush any pending plot before an interactive widget takes over the Viewer.
.rlab_emit_interactive_placeholder <- function() {
  ${plotDirRequestCode}
  tryCatch(.rlab_force_save_plot(), error = function(e) {})
}

# Hook HTML/Shiny viewer
options(viewer = function(url, height = NULL) {
  .viewer_req_path <- file.path("${absOutDir}", "viewer_url.txt")
  cat(url, "\n", file = .viewer_req_path, append = TRUE)

  # Only emit placeholder for htmlwidgets (which print to tempdir/viewhtml.../index.html)
  if (grepl("viewhtml.*(/|\\\\\\\\)index\\\\.html$", url)) {
    .rlab_emit_interactive_placeholder()
  }
})
options(page_viewer = function(url) {
  .viewer_req_path <- file.path("${absOutDir}", "viewer_url.txt")
  cat(url, "\n", file = .viewer_req_path, append = TRUE)
})
options(browser = function(url) {
  .viewer_req_path <- file.path("${absOutDir}", "viewer_url.txt")
  cat(url, "\n", file = .viewer_req_path, append = TRUE)
})

# Hook plot.new to increment plot ID safely by scanning directory
.rlab_advance_next_plot <- FALSE
.rlab_force_save_plot <- function() {
  if (dev.cur() > 1) {
    .p <- recordPlot()
    if (!is.null(.p) && length(.p[[1]]) > 0) {
      .hash <- sum(as.numeric(serialize(.p, NULL)))
      if (!identical(.hash, .rlab_last_plot_hash)) {
        .rlab_last_plot_hash <<- .hash

        .out_dir <- getOption(".rlab_plot_dir", "${absPlotsDir}")
        dir.create(.out_dir, showWarnings = FALSE, recursive = TRUE)

        if (.rlab_advance_next_plot || .rlab_current_plot_id == 0) {
          files <- list.files(.out_dir, pattern = "^plot_[0-9]{5}.*\\\\.(png|svg)$")
          if (length(files) == 0) {
            .rlab_current_plot_id <<- 1
          } else {
            nums <- as.numeric(sub("^plot_([0-9]{5}).*$", "\\\\1", files))
            .rlab_current_plot_id <<- max(nums, na.rm = TRUE) + 1
          }
          .rlab_advance_next_plot <<- FALSE
        }

        .file <- file.path(.out_dir, sprintf("plot_%05d.png", .rlab_current_plot_id))
        .rds_file <- file.path(.out_dir, sprintf("plot_%05d.rds", .rlab_current_plot_id))
        .tmp_file <- tempfile("rlab_plot_", tmpdir = .out_dir, fileext = ".tmp")
        png(filename = .tmp_file, width = 1600, height = 1200, res = 200, bg = "white")
        try(replayPlot(.p), silent = TRUE)
        dev.off()
        .tmp_size <- file.info(.tmp_file)$size
        if (!is.na(.tmp_size) && .tmp_size > 12000) {
          try(saveRDS(.p, .rds_file), silent = TRUE)
          if (file.exists(.file)) unlink(.file)
          if (!file.rename(.tmp_file, .file)) {
            file.copy(.tmp_file, .file, overwrite = TRUE)
            unlink(.tmp_file)
          }
        } else {
          unlink(.tmp_file)
          .rlab_last_plot_hash <<- NULL
        }
      }
    }
  }
}

.rlab_update_plot_id_base <- function() {
  if (dev.cur() > 1 && !isTRUE(par("page"))) return()
  if (isTRUE(.rlab_skip_stale_plot_once)) {
    .rlab_skip_stale_plot_once <<- FALSE
    .rlab_last_plot_hash <<- NULL
    .rlab_advance_next_plot <<- TRUE
    return()
  }
  # Force save the previous plot before a new page clears it.
  # .rlab_force_save_plot renders to a temp PNG first and rejects blank
  # device captures, which Windows can expose as non-empty display lists.
  tryCatch(.rlab_force_save_plot(), error = function(e) {})
  .rlab_advance_next_plot <<- TRUE
}
.rlab_update_plot_id_grid <- function() {
  if (isTRUE(.rlab_skip_stale_plot_once)) {
    .rlab_skip_stale_plot_once <<- FALSE
    .rlab_last_plot_hash <<- NULL
    .rlab_advance_next_plot <<- TRUE
    return()
  }
  tryCatch(.rlab_force_save_plot(), error = function(e) {})
  .rlab_advance_next_plot <<- TRUE
}
setHook("before.plot.new", .rlab_update_plot_id_base)
setHook("before.grid.newpage", .rlab_update_plot_id_grid)

# 4. Wipe stale R Lab data at startup and shutdown so previous sessions don't bleed over.
#    We hook into .First and .Last.
if (exists(".First", envir = .GlobalEnv)) {
  .rlab_orig_First <- get(".First", envir = .GlobalEnv)
  .First <- function() {
    unlink("${absVarsTsv}")
    unlink(file.path("${absPlotsDir}", "*"))
    tryCatch(.rlab_orig_First(), error = function(e) {})
    ${snapshotCode}
  }
} else {
  .First <- function() {
    unlink("${absVarsTsv}")
    unlink(file.path("${absPlotsDir}", "*"))
    ${snapshotCode}
  }
}

if (exists(".Last", envir = .GlobalEnv)) {
  .rlab_orig_Last <- get(".Last", envir = .GlobalEnv)
  .Last <- function() {
    unlink("${absVarsTsv}")
    unlink(file.path("${absPlotsDir}", "*"))
    .out_dir <- getOption(".rlab_plot_dir")
    if (!is.null(.out_dir) && .out_dir != "${absPlotsDir}") {
      .rds_files <- list.files(.out_dir, pattern = "^plot_[0-9]{5}\\\\.rds$", full.names = TRUE)
      if (length(.rds_files) > 0) unlink(.rds_files)
    }
    tryCatch(.rlab_orig_Last(), error = function(e) {})
  }
} else {
  .Last <- function() {
    unlink("${absVarsTsv}")
    unlink(file.path("${absPlotsDir}", "*"))
    .out_dir <- getOption(".rlab_plot_dir")
    if (!is.null(.out_dir) && .out_dir != "${absPlotsDir}") {
      .rds_files <- list.files(.out_dir, pattern = "^plot_[0-9]{5}\\\\.rds$", full.names = TRUE)
      if (length(.rds_files) > 0) unlink(.rds_files)
    }
  }
}

# 5. Data Viewer export function.
#    .rlab_csv and .rlab_meta are already set above - no paths needed at call time.
.r_lab_protected_objects <- "^\\\\.rlab_|^\\\\.r_lab|^\\\\.rm$|^null_dev$|^\\\\.First$|^\\\\.Last$|^View$"

.rm <- function(..., list = character(), pos = -1, envir = as.environment(pos), inherits = FALSE) {
  targets <- c(as.character(substitute(list(...))[-1L]), list)
  if (identical(envir, .GlobalEnv)) {
    protected <- if (exists(".r_lab_protected_objects", envir = .GlobalEnv)) {
      get(".r_lab_protected_objects", envir = .GlobalEnv)
    } else {
      "^\\\\.rlab_|^\\\\.r_lab|^\\\\.rm$|^null_dev$|^\\\\.First$|^\\\\.Last$|^View$"
    }
    targets <- grep(protected, targets, value = TRUE, invert = TRUE)
  }
  if (length(targets) > 0) {
    rm(list = targets, envir = envir, inherits = inherits)
  }
  invisible()
}

.r_lab_view_data <- function(varName, rowLimit = 1000) {
  .rlab_active_df_to_export <<- varName
  tryCatch({
    unlink(.rlab_meta)
    unlink(.rlab_csv)
    obj <- get(varName, envir = .GlobalEnv)
    rowLimit <- suppressWarnings(as.integer(rowLimit))
    if (is.na(rowLimit) || rowLimit < 1) rowLimit <- 1000

    is3D <- is.array(obj) && length(dim(obj)) == 3
    if (!is3D && !is.data.frame(obj) && !is.matrix(obj)) {
      if (is.list(obj) && is.null(dim(obj))) {
        if (is.null(names(obj))) {
          names(obj) <- paste0("[[", 1:length(obj), "]]")
        }
      } else if (is.null(dim(obj)) || length(dim(obj)) == 1) {
        obj <- as.data.frame(obj, check.names = FALSE)
        if (ncol(obj) == 1) colnames(obj) <- varName
      }
    }

    if (is.null(colnames(obj)) && !is.null(ncol(obj))) {
      if (is.data.frame(obj)) {
        colnames(obj) <- paste0("#", 1:ncol(obj))
      } else {
        colnames(obj) <- paste0("[,", 1:ncol(obj), "]")
      }
    }
    if (is.null(rownames(obj)) && !is.null(nrow(obj))) {
      if (is.data.frame(obj)) {
        rownames(obj) <- paste0("#", 1:nrow(obj))
      } else {
        rownames(obj) <- paste0("[", 1:nrow(obj), ",]")
      }
    }
    is3D <- is.array(obj) && length(dim(obj)) == 3
    if (is3D) {
      nslices <- dim(obj)[3]
      unlink(file.path(dirname(.rlab_csv), "dv_slice_*.csv"))

      slice_labels <- dimnames(obj)[[3]]
      if (is.null(slice_labels)) {
        slice_labels <- paste0("Slice ", 1:nslices)
      }



      for (i in 1:nslices) {
        slice_obj <- obj[, , i]
        if (!is.data.frame(slice_obj)) {
          slice_obj <- as.data.frame(slice_obj, check.names = FALSE)
        }
        write.csv(head(slice_obj, rowLimit), file.path(dirname(.rlab_csv), sprintf("dv_slice_%d.csv", i)), row.names = TRUE, na = "NA")
      }

      writeLines(c(
        as.character(nrow(obj)),
        as.character(ncol(obj)),
        "3D",
        as.character(nslices),
        slice_labels,
        varName
      ), .rlab_meta)

    } else {
      if (!is.data.frame(obj)) {

        obj <- as.data.frame(obj, check.names = FALSE)
      }
      write.csv(head(obj, rowLimit), .rlab_csv, row.names = TRUE, na = "NA")
      writeLines(c(as.character(nrow(obj)), as.character(ncol(obj)), "2D", varName), .rlab_meta)
    }
  }, error = function(e) {
    message("Error in View: ", conditionMessage(e))
    writeLines(paste0("ERROR:", conditionMessage(e)), .rlab_meta)
    .rlab_active_df_to_export <<- NULL
  })
  invisible(NULL)
}

# Override base View() so that user commands and the fallback trigger open our Data Viewer cleanly
View <- function(x, title) {
  var_name <- deparse(substitute(x))
  if (length(var_name) > 1) var_name <- paste(var_name, collapse = "")

  if (exists(var_name, envir = .GlobalEnv)) {
    .r_lab_view_data(var_name)
  } else {
    # If the user typed an expression like View(mtcars[1:5,]), store it temporarily
    assign(".rlab_temp_view", x, envir = .GlobalEnv)
    .r_lab_view_data(".rlab_temp_view")
  }
}

# 6. Install the task callback. It fires after every top-level R command.
invisible(local({
  if (!any(vapply(getTaskCallbackNames(), function(n) n == ".r_lab.watcher", logical(1)))) {
    addTaskCallback(function(expr, value, ok, visible) {
      # Data Viewer auto-update was removed to conserve resources.
      # Users must click the Refresh button to manually re-load variables.

      # 2. Check for manual view requests from the extension
      .view_req_path <- file.path("${absOutDir}", ".view_request")
      if (file.exists(.view_req_path)) {
        try({
          .var_req <- readLines(.view_req_path, warn = FALSE)
          if (length(.var_req) > 0 && nchar(.var_req[1]) > 0) {
             .row_limit <- if (length(.var_req) >= 2) suppressWarnings(as.integer(.var_req[2])) else 1000
             if (is.na(.row_limit) || .row_limit < 1) .row_limit <- 1000
             if (exists(.var_req[1], envir = .GlobalEnv)) {
               .r_lab_view_data(.var_req[1], .row_limit)
             }
          }
          unlink(.view_req_path)
        }, silent = TRUE)
      }

      ${plotDirRequestCode}
      ${plotExportCode}

      # 2. Capture plots quietly
      if (isTRUE(.rlab_skip_stale_plot_once)) {
        .rlab_last_plot_hash <<- NULL
      } else {
        tryCatch(.rlab_force_save_plot(), error = function(e) {})
      }

      # 3. Snapshot Workspace
      ${snapshotCode}
      TRUE
    }, name = ".r_lab.watcher")
  }
}))

# 7. Setup Background View Request Watcher (if 'later' package is installed)
invisible(local({
  .has_later_file <- file.path("${absOutDir}", ".has_later")
  if (requireNamespace("later", quietly = TRUE)) {
    file.create(.has_later_file)
    .rlab_loop <- function() {
      if (!"later" %in% loadedNamespaces()) {
        if (file.exists(.has_later_file)) unlink(.has_later_file)
        return(invisible())
      }
      .view_req_path <- file.path("${absOutDir}", ".view_request")
      if (file.exists(.view_req_path)) {
        try({
          .var_req <- readLines(.view_req_path, warn = FALSE)
          if (length(.var_req) > 0 && nchar(.var_req[1]) > 0) {
             .row_limit <- if (length(.var_req) >= 2) suppressWarnings(as.integer(.var_req[2])) else 1000
             if (is.na(.row_limit) || .row_limit < 1) .row_limit <- 1000
             if (exists(.var_req[1], envir = .GlobalEnv)) {
               .r_lab_view_data(.var_req[1], .row_limit)
             }
          }
          unlink(.view_req_path)
        }, silent = TRUE)
      }

      ${plotDirRequestCode}
      ${plotExportCode}
      if ("later" %in% loadedNamespaces()) {
        try(later::later(.rlab_loop, 0.2), silent = TRUE)
      } else {
        if (file.exists(.has_later_file)) unlink(.has_later_file)
      }
    }
    .rlab_loop()
  } else {
    if (file.exists(.has_later_file)) unlink(.has_later_file)
  }
}))
}
`;
    fs.writeFileSync(scriptPath, rCode, "utf8");
    return scriptPath.replace(/\\/g, "/");
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function focusTextEditorBeforePanelDisposal(
    sourceFiles: vscode.Uri[]
): Promise<void> {
    const visibleEditor =
        vscode.window.visibleTextEditors.find(
            (e) => e.viewColumn === vscode.ViewColumn.One
        ) || vscode.window.visibleTextEditors[0];

    if (visibleEditor) {
        try {
            await vscode.window.showTextDocument(visibleEditor.document, {
                viewColumn: visibleEditor.viewColumn,
                preview: false,
                preserveFocus: false,
            });
            await delay(80);
            if (vscode.window.activeTextEditor) {
                return;
            }
        } catch {}
    }

    for (const uri of sourceFiles) {
        try {
            await vscode.window.showTextDocument(uri, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: false,
            });
            await vscode.commands.executeCommand(
                "workbench.action.focusFirstEditorGroup"
            );
            await delay(120);
            if (vscode.window.activeTextEditor) {
                return;
            }
        } catch {}
    }

    try {
        await vscode.commands.executeCommand(
            "workbench.action.focusFirstEditorGroup"
        );
        await delay(120);
        if (vscode.window.activeTextEditor) {
            return;
        }
    } catch {}

    try {
        const doc = await vscode.workspace.openTextDocument({
            content: "",
            language: "plaintext",
        });
        currentAnchorUri = doc.uri.toString();
        await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        await delay(120);
    } catch {}
}

async function disposePanelWithTextFocus(
    disposePanel: () => void,
    sourceFiles: vscode.Uri[]
): Promise<void> {
    try {
        disposePanel();
    } catch {}
    await delay(40);
    if (!vscode.window.activeTextEditor) {
        await focusTextEditorBeforePanelDisposal(sourceFiles);
    }
}

function getConfigTarget(): vscode.ConfigurationTarget {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

/**
 * Returns the effective workspace root: the first workspace folder if available,
 * otherwise falls back to the user's home directory. This ensures all features
 * (R watcher, .R-lab directory, plots, workspace panel) work in no-workspace mode.
 */
export function getEffectiveWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

function captureWorkspaceRoots(): void {
    const roots =
        vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (roots.length > 0) {
        cachedWorkspaceRoots = roots;
    }
}

function getWorkspaceRootsForCleanup(): string[] {
    const roots =
        vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    return roots.length > 0 ? roots : cachedWorkspaceRoots;
}

/**
 * Deletes the .R-lab temporary directory in the current workspace.
 */
function deleteRLabDir() {
    // Collect all roots: workspace folders (current + cached) AND home directory fallback
    const roots = new Set<string>(getWorkspaceRootsForCleanup());
    roots.add(os.homedir());

    for (const root of roots) {
        const rLabDir = path.join(root, ".R-lab");
        try {
            if (fs.existsSync(rLabDir)) {
                fs.rmSync(rLabDir, {
                    recursive: true,
                    force: true,
                    maxRetries: 3,
                    retryDelay: 25,
                });
            }
        } catch (e) {
            console.error("[R Lab] Failed to delete .R-lab directory", e);
        }
    }
}
