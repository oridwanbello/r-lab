import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlotsPanel } from '../panels/plotsPanel';
import { HelpPanel } from '../panels/helpPanel';
import { ProblemsPanel } from '../panels/problemsPanel';
import { WorkspacePanel } from '../panels/workspacePanel';
import { DataViewerPanel } from '../panels/dataViewerPanel';

/**
 * R Layout Layout Manager
 *
 * Orchestrates an asymmetrical 3-pane RStudio-style layout:
 *
 *   ┌──────────────────────────────┬──────────────────────────────┐
 *   │                              │                              │
 *   │                              │       2 R Console / Term     │
 *   │                              │                              │
 *   │      1 Source Editor         ├──────────────────────────────┤
 *   │       (Full Height)          │                              │
 *   │                              │       3 Workspace / Plots    │
 *   │                              │                              │
 *   └──────────────────────────────┴──────────────────────────────┘
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
let rConsoleTerminal: vscode.Terminal | undefined;
let shellTerminal: vscode.Terminal | undefined;
let savedDataViewerState: { varName: string } | undefined;
let savedHelpState: any | undefined;
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let currentAnchorUri: string | undefined;
let cachedWorkspaceRoots: string[] = [];

export function getRConsoleTerminal(): vscode.Terminal | undefined {
    return rConsoleTerminal;
}

const STATE_KEY = 'r-layout.layoutActive';

// Registration

export function registerLayoutCommand(
    context: vscode.ExtensionContext
): void {
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
    statusBarItem.command = 'r-layout.toggleLayout';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Layout Toggle Command
    context.subscriptions.push(
        vscode.commands.registerCommand('r-layout.toggleLayout', async () => {
            if (isLayoutActive) {
                await deactivateLayout();
            } else {
                await activateLayout(context);
            }
        })
    );

    // Utility Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('r-layout.noop', () => {})
    );

    // Source File to R Console
    // This command sends source('filepath') to our R Console terminal.
    // It also overrides r.runSource so the R extension's built-in
    // "Run Source" button routes to our terminal instead of a generic shell.
    const doSourceFile = async () => {
        const editor = vscode.window.activeTextEditor;
        const filePath = editor?.document.uri.fsPath;
        if (!filePath) {
            vscode.window.showWarningMessage('No active file to source.');
            return;
        }

        // Ensure we have a live R Console terminal
        if (!rConsoleTerminal) {
            vscode.window.showWarningMessage('R Console is not running. Activate R Layout first.');
            return;
        }

        // Escape backslashes for Windows paths; forward slashes work on all platforms
        const escapedPath = filePath.replace(/\\/g, '/');
        rConsoleTerminal.show(false); // bring it into view without stealing keyboard focus
        rConsoleTerminal.sendText(`source('${escapedPath}', echo = FALSE)`);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('r-layout.sourceFile', doSourceFile)
    );

    // Resize Commands
    //
    // Maximize: apply hardcoded 0.9/0.1 vertical layout (works reliably).
    // Restore:  read the CURRENT layout (at current window pixel scale),
    //           equalize the vertical sub-split, and re-apply.  This keeps
    //           all values at the same pixel scale — mixing proportional
    //           values (0-1) with pixel values caused distortion on
    //           short windows.  Reading at current scale also ensures
    //           values are above minimum heights, so proportional resize
    //           works correctly when the window is later resized.

    context.subscriptions.push(
        vscode.commands.registerCommand('r-layout.maximizeTopRight', async () => {
            if (!isLayoutActive) {
                return;
            }

            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [
                    { size: 0.60 },
                    {
                        size: 0.40,
                        groups: [
                            { size: 0.9 },
                            { size: 0.1 }
                        ]
                    }
                ]
            });

            // Hide webview content in Group 3 panels so only tabs are visible
            WorkspacePanel.currentPanel?.setMinimized(true);
            PlotsPanel.currentPanel?.setMinimized(true);
            DataViewerPanel.currentPanel?.setMinimized(true);
            await vscode.commands.executeCommand('setContext', 'r-layout.isTopRightMaximized', true);
        }),
        vscode.commands.registerCommand('r-layout.restoreRightSplit', async () => {
            if (!isLayoutActive) {
                return;
            }

            // Restore webview content in Group 3 panels
            WorkspacePanel.currentPanel?.setMinimized(false);
            PlotsPanel.currentPanel?.setMinimized(false);
            DataViewerPanel.currentPanel?.setMinimized(false);

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
                const current: any = await vscode.commands.executeCommand('vscode.getEditorLayout');
                const subGroups = current?.groups?.[1]?.groups;
                if (subGroups?.length === 2 && typeof subGroups[0].size === 'number' && typeof subGroups[1].size === 'number') {
                    const avg = (subGroups[0].size + subGroups[1].size) / 2;
                    subGroups[0].size = avg;
                    subGroups[1].size = avg;
                }
                await vscode.commands.executeCommand('vscode.setEditorLayout', current);
            } catch {
                // ignore – step 2 below will handle it
            }

            // Step 2: proportional re-stamp
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [
                    { size: 0.60 },
                    {
                        size: 0.40,
                        groups: [
                            { size: 0.5 },
                            { size: 0.5 }
                        ]
                    }
                ]
            });

            await vscode.commands.executeCommand('setContext', 'r-layout.isTopRightMaximized', false);
        })
    );

    // Track terminal disposal
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(async (t) => {
            if (t === rConsoleTerminal || (t.name === 'R Console' && !rConsoleTerminal)) {
                rConsoleTerminal = undefined;
                savedDataViewerState = undefined;
                savedHelpState = undefined;
                PlotsPanel.resetSessionState();

                // Delete .r_layout directory to prevent left-over files
                deleteRLayoutDir();

                // If the layout is active, closing the R Console should trigger an exit
                if (isLayoutActive) {
                    vscode.window.showInformationMessage('R Console session ended. Exiting R Layout.');
                    await deactivateLayout();
                }
            }
            if (t === shellTerminal) { shellTerminal = undefined; }
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
        vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{}],
        })
    ).then(() => {
        // Close stale editor tabs (webviews, terminal-editors, etc.)
        // after the layout has collapsed.
        return vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }).catch(() => { /* silently ignore */ });
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

        const origClose = context.workspaceState.get<boolean | undefined>('r-layout.origCloseEmptyGroups', undefined);

        await Promise.all([
            Promise.resolve(
                wsConfig.update('workbench.editor.closeEmptyGroups', origClose, cfgTarget)
            ).catch(() => {})
        ]);
    } catch {}

    // CONDITIONAL stale-layout cleanup
    // Only close editors and reset the layout if there are actually
    // stale elements from a previous R Layout session:
    //   • more than one editor group (leftover 3-pane grid), OR
    //   • webview / notebook tabs (our panel singletons) still open
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

    const nonTerminalTabs = groups.flatMap(g =>
        g.tabs.filter(t => !(t.input instanceof vscode.TabInputTerminal))
    );
    try {
        if (nonTerminalTabs.length > 0) {
            await vscode.window.tabGroups.close(nonTerminalTabs);
        }
    } catch {}

    // Collapse to a clean single-group layout
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
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
 * Without this, when the user reloads while R Layout is active, VS Code
 * saves the 4-group layout, restores it on reload (flash!), and only then
 * our activation code can collapse it.
 */
export async function collapseLayoutForShutdown(): Promise<void> {
    // Always clean up the .r_layout temp directory on shutdown.
    deleteRLayoutDir();

    if (!isLayoutActive) {
        // Layout wasn't active - no layout state to collapse.
        return;
    }

    console.log('[R Layout] deactivate(): collapsing layout before state is saved.');

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
            vscode.commands.executeCommand('vscode.setEditorLayout', {
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
                ? extensionContext.workspaceState.get<boolean | undefined>('r-layout.origCloseEmptyGroups', undefined)
                : undefined;

            return Promise.all([
                Promise.resolve(
                    wsConfig.update('workbench.editor.closeEmptyGroups', origClose, cfgTarget)
                ).catch(() => {})
            ]);
        })(),
    ]);
}

//  Activate Layout

async function activateLayout(context: vscode.ExtensionContext): Promise<void> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Activating R Layout...',
        cancellable: false
    }, async () => {
    activationInProgress = true;
    // 1. Load saved positions, and Save references to all currently open TEXT files
    //    so we can reopen them after setting the layout.
    const textFilePositions = context.workspaceState.get<Record<string, number>>('r-layout.textFilePositions', {});
    const panelPositions = context.workspaceState.get<Record<string, number>>('r-layout.panelPositions', {});

    const openFiles: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                openFiles.push(tab.input.uri);
            }
        }
    }

    // 2. Close stale R Layout panels from previous sessions.
    //    We explicitly PRESERVE the Help tab and any Chat tabs so their sessions survive layout toggles.
    //    We preserve TabInputText so the user's source files remain open.
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const disposablePanels = ['Workspace', 'Plots', 'Data Viewer', 'Problems'];
            if (disposablePanels.includes(tab.label)) {
                try { await vscode.window.tabGroups.close(tab); } catch {}
            }
        }
    }

    // 3. Scan for existing terminals to reuse. We will relocate them to ViewColumn.Two.
    //    Track whether we are reusing to avoid wiping workspace data for live sessions.
    let wasRConsoleReused = false;
    for (const t of vscode.window.terminals) {
        if (t.name === 'R Console' && !rConsoleTerminal) {
            rConsoleTerminal = t;
            wasRConsoleReused = true;
        } else if (t.name === 'Terminal' && !shellTerminal) {
            shellTerminal = t;
        }
    }

    // 4. Close sidebars and the bottom panel
    try { await vscode.commands.executeCommand('workbench.action.closeSidebar'); } catch {}
    try { await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar'); } catch {}
    try { await vscode.commands.executeCommand('workbench.action.closePanel'); } catch {}

    // 5. Set context key (for keybinding "when" clauses)
    await vscode.commands.executeCommand(
        'setContext', 'r-layout.layoutActive', true
    );
    await vscode.commands.executeCommand(
        'setContext', 'r-layout.isTopRightMaximized', false
    );

    // 6. Apply workspace overrides
    const cfgTarget = getConfigTarget();
    const wsConfig = vscode.workspace.getConfiguration();

    // Inspect and save original user settings before modifying them
    const inspectionClose = wsConfig.inspect<boolean>('workbench.editor.closeEmptyGroups');
    const origClose = cfgTarget === vscode.ConfigurationTarget.Workspace ? inspectionClose?.workspaceValue : inspectionClose?.globalValue;
    await extensionContext.workspaceState.update('r-layout.origCloseEmptyGroups', origClose);

    await wsConfig.update('workbench.editor.closeEmptyGroups', false, cfgTarget);

    await delay(10);

    // 7. Set the 3-pane editor layout
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [
            { size: 0.60 }, // 1 Source Editor (Full Height)
            {
                size: 0.40,
                groups: [
                    { size: 0.5 }, // 2 Console / Terminal / Problems / Help
                    { size: 0.5 }, // 3 Workspace / Plots / Data Viewer
                ],
            },
        ],
    });

    await delay(10);

    //  CRITICAL: Populate groups in strict order 1 → 2 → 3 → 4
    //  VS Code assigns ViewColumn numbers based on the order
    //  groups first receive content. If we put content into
    //  Group 2 before Group 1, the ViewColumns all shift.

    // 8. Anchor Group 1 with an active text editor.
    //    The vscode-R extension's chunk-navigation shows a "No text editor active" warning
    //    whenever window.activeTextEditor is null. We prevent this by ensuring Group 1
    //    always has a visible text document during layout construction.
    //    Priority: (a) reopen a previously saved source file, (b) open an untitled scratch.
    try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
    await delay(10);

    let anchorEditor: vscode.TextEditor | undefined;
    if (openFiles.length > 0) {
        // Reopen the first saved file into Group 1 - this satisfies the R extension's check.
        try {
            anchorEditor = await vscode.window.showTextDocument(
                openFiles[0],
                { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false }
            );
        } catch {}
    }
    if (!anchorEditor) {
        // No saved file open - create a tiny untitled doc to anchor Group 1.
        try {
            const doc = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });
            currentAnchorUri = doc.uri.toString();
            anchorEditor = await vscode.window.showTextDocument(
                doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false }
            );
        } catch {}
    }
    await delay(10);
    // NOTE: Do NOT call focusSecondEditorGroup here - it would set
    // window.activeTextEditor to undefined and trigger the R extension's
    // "No text editor active" warning. Terminal placement uses explicit
    // viewColumn or moveToEditor + immediate Group 1 restore instead.
    await delay(10);

    // 9. Group 2 (bottom-left): R Console → Terminal → Problems
    //
    //    Strategy for existing terminals (session retention):
    //      a) Create ProblemsPanel in ViewColumn.Two FIRST - this anchors Group 2
    //         as a real, focusable editor group before any terminal is moved.
    //      b) Focus Group 2 (it now has content so focus sticks).
    //      c) Call terminal.show(false) to make the terminal the active one
    //         in the panel without stealing editor focus away from Group 2.
    //      d) Call moveToEditor - moves the active panel terminal to the
    //         currently focused editor group (Group 2). ✓
    //
    //    For NEW terminals, createTerminal with location.viewColumn is reliable.
    const config = vscode.workspace.getConfiguration('r-layout');
    const useArk = config.get<boolean>('useArkInteractiveConsole', false);

    // 9a. Anchor Group 2 with ProblemsPanel before any terminal placement.
    ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    await delay(150); // Ensure Group 2 is fully mounted in the UI before spawning PTYs

    if (useArk) {
        // Ark kernel mode - use Jupyter Interactive
        try {
            await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
            await vscode.commands.executeCommand('jupyter.createnewinteractive');
            setTimeout(async () => {
                try {
                    await vscode.commands.executeCommand('notebook.selectKernel');
                } catch { /* ignore */ }
            }, 800);
        } catch {
            // Fallback to standard terminal
            if (rConsoleTerminal) {
                rConsoleTerminal.show(false);
                await delay(10);
                await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
                await delay(10);
                await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
            } else {
                rConsoleTerminal = vscode.window.createTerminal({
                    name: 'R Console',
                    shellPath: resolveRPath(config),
                    location: { viewColumn: vscode.ViewColumn.Two },
                    iconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'r_logo.svg'),
                });
                rConsoleTerminal.show(false);
            }
        }
    } else {
        // Only delete stale workspace data if we are creating a BRAND-NEW R session.
        // If we found an existing R Console terminal (wasRConsoleReused), R is still
        // running and its variables are still live - do NOT wipe the data file.
        const wf = getEffectiveWorkspaceRoot();
        if (!wasRConsoleReused) {
            const staleFile = path.join(wf, '.r_layout', '.workspace_data.json');
            try { fs.unlinkSync(staleFile); } catch {}

            // NEW: Clear R Help state for brand-new R sessions
            // state is now in workspaceState
        }

        // Build the watcher Rprofile BEFORE creating the terminal.
        const watcherPath = _buildWatcherRprofile();
        const rProfileEnv: Record<string, string> = {};
        if (watcherPath) {
            rProfileEnv['R_PROFILE_USER'] = watcherPath;
            const existing = process.env['R_PROFILE_USER'];
            if (existing) { rProfileEnv['R_PROFILE_USER_ORIG'] = existing; }
        }
        console.log(`[R Layout] rProfileEnv=${JSON.stringify(rProfileEnv)}, wasRConsoleReused=${wasRConsoleReused}, rConsoleTerminal=${!!rConsoleTerminal}`);

    if (rConsoleTerminal) {
            // Reuse the existing terminal - do NOT recreate (that kills the R session).
            // Check specifically for the R Console tab by name.
            const rConsoleIsEditorTab = vscode.window.tabGroups.all.some(g =>
                g.tabs.some(tab => {
                    const input = tab.input as any;
                    return input instanceof vscode.TabInputTerminal &&
                        tab.label.includes('R Console');
                })
            );
            console.log(`[R Layout] Reusing rConsoleTerminal, isEditorTab=${rConsoleIsEditorTab}`);

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
                await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
                await delay(50);
                await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
                await delay(100);
            }

        } else {
            // New session: create directly in ViewColumn.Two. R Console does not suffer
            // from the empty PTY bug, so this is safe and guarantees correct placement.
            const shellPath = resolveRPath(config);
            const cwdPath = getEffectiveWorkspaceRoot();
            console.log(`[R Layout] Creating NEW R Console: shellPath=${shellPath}, cwd=${cwdPath}, env keys=${Object.keys(rProfileEnv).join(',')}`);
            rConsoleTerminal = vscode.window.createTerminal({
                name: 'R Console',
                shellPath,
                location: { viewColumn: vscode.ViewColumn.Two },
                env: rProfileEnv, // No strictEnv: let VS Code merge naturally
                cwd: cwdPath, // Prevents PTY hang in no-workspace mode
                iconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'r_logo.svg'),
            });
            await delay(100); // Give terminal time to attach
            rConsoleTerminal.show(false);
        }
    }

    // Shell terminal
    await delay(10);
    if (shellTerminal) {
        // Check specifically for the Shell terminal by name.
        const shellIsEditorTab = vscode.window.tabGroups.all.some(g =>
            g.tabs.some(tab => {
                const input = tab.input as any;
                return input instanceof vscode.TabInputTerminal &&
                    (tab.label === 'Terminal' || tab.label === shellTerminal?.name);
            })
        );
        if (shellIsEditorTab) {
            shellTerminal.show(true);
            await delay(10);
        } else {
            shellTerminal.show(true);
            await delay(100);
            await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
            await delay(50);
            await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
            await delay(100);
        }

    } else {
        // Create directly in ViewColumn.Two, no bottom-pane origin
        shellTerminal = vscode.window.createTerminal({
            name: 'Terminal',
            location: { viewColumn: vscode.ViewColumn.Two },
            cwd: getEffectiveWorkspaceRoot(),
        });
        await delay(100); // Give terminal time to attach
        shellTerminal.show(false);
    }

    // ProblemsPanel: dispose the anchor instance and recreate so it becomes the
    // LAST tab in Group 2, giving order: R Console → Terminal → Problems.
    await delay(10);
    ProblemsPanel.currentPanel?.dispose();
    await delay(10);
    ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    await delay(10);



    // 10. HelpPanel: Appended to Group 2 (Top-Right) so it becomes the 4th tab
    //     Order in Group 2: R Console → Terminal → Problems → Help
    const helpPanel = HelpPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    if (savedHelpState) { helpPanel.loadState(savedHelpState); }
    await delay(10);

    // Focus Group 2 and activate R Console (which is usually the 1st or 2nd tab)
    // Ensure Group 2 retains focus after terminal placement.
    // and then activate the first editor (R Console).
    try {
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
    } catch {}

    // 11. Group 3 (bottom-right): Workspace → Plots → Data Viewer  (Workspace FIRST, Workspace FOCUSED)
    //     Create Workspace first (leftmost tab), then Plots, then Data Viewer.
    //     Reveal Workspace at the end to make it the active/focused tab.
    const workspacePanel = WorkspacePanel.createOrShow(context.extensionUri, vscode.ViewColumn.Three);
    // Note: forceRefresh() is deferred (see end of activation) to give the webview
    // time to fully render before the message is posted.
    const plotsPanel = PlotsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Three);
    plotsPanel.syncPlots(); // catch up on any plots created while layout was closed
    const dataPanel = DataViewerPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Three);
    workspacePanel.reveal(); // restore Workspace as the focused tab in Group 3

    // Wire up: clicking "View" on a data.frame in Workspace opens it in Data Viewer
    workspacePanel.onRequestDataView((varName) => {
        dataPanel.loadVariable(varName);
        dataPanel.reveal();
    });


    // 12. Focus the source editor
    try {
        await vscode.commands.executeCommand(
            'workbench.action.focusFirstEditorGroup'
        );
    } catch {}

    // 13. Now that ViewColumns 1-3 are rigidly locked by default content,
    //     we can safely restore saved positions without causing ViewColumn shifting.

    // 12. Create DataViewer if it was open (RESTORATION)
    if (savedDataViewerState && savedDataViewerState.varName) {
        const dvPanel = DataViewerPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Three);
        await dvPanel.loadState(savedDataViewerState);
    }

    // 13. Create Problems if it was open (RESTORATION)
    if (panelPositions['problems'] === vscode.ViewColumn.Two) {
        ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    }

    // Reposition custom panels
    if (panelPositions['problems'] && panelPositions['problems'] !== vscode.ViewColumn.Two) {
        ProblemsPanel.createOrShow(context.extensionUri, panelPositions['problems']);
    }
    if (panelPositions['help'] && panelPositions['help'] !== vscode.ViewColumn.Two) {
        HelpPanel.createOrShow(context.extensionUri, panelPositions['help']);
    }
    if (panelPositions['workspace'] && panelPositions['workspace'] !== vscode.ViewColumn.Three) {
        WorkspacePanel.createOrShow(context.extensionUri, panelPositions['workspace']);
    }
    if (panelPositions['plots'] && panelPositions['plots'] !== vscode.ViewColumn.Three) {
        PlotsPanel.createOrShow(context.extensionUri, panelPositions['plots']);
    }
    if (panelPositions['dataViewer'] && panelPositions['dataViewer'] !== vscode.ViewColumn.Three) {
        DataViewerPanel.createOrShow(context.extensionUri, panelPositions['dataViewer']);
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

    // 14. Register layout guards that redirect stray content
    registerLayoutGuards(context);

    // 14. Persist & update UI
    isLayoutActive = true;
    await context.workspaceState.update(STATE_KEY, true);
    updateStatusBar();

    // 15. Ensure bottom panel is closed since we opened terminals
    try { await vscode.commands.executeCommand('workbench.action.closePanel'); } catch {}

    // 16. Set final tab focus:
    //     • R Console  → first tab in Group 2 (top-right)
    //     • Workspace  → first tab in Group 3 (bottom-right)
    //     Done LAST so nothing steals the focus back.

    // Group 3 (bottom-right): activate Workspace (first tab)
    try {
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
        await delay(10);
        await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
        await delay(10);
    } catch {}

    // Group 2 (top-right): activate R Console (first tab)
    try {
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await delay(10);
        await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
        await delay(10);
    } catch {}

    // Return focus to the source editor (Group 1)
    try {
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    } catch {}

    activationInProgress = false;
    // Deferred refresh: give the Workspace webview ~500ms to fully render after
    // all layout commands complete, then push the latest R environment state.
    // Doing this earlier races the webview paint and the message is dropped.
    setTimeout(() => { WorkspacePanel.currentPanel?.forceRefresh(); }, 500);
    });
}

//  Deactivate Layout

async function deactivateLayout(): Promise<void> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Deactivating R Layout...',
        cancellable: false
    }, async () => {
    // 1. Clear context key
    await vscode.commands.executeCommand(
        'setContext', 'r-layout.layoutActive', false
    );
    await vscode.commands.executeCommand(
        'setContext', 'r-layout.isTopRightMaximized', false
    );

    // 2. Dispose layout guards immediately so they don't interfere
    disposeLayoutGuards();

    // 3. Save user's text files and custom panel positions before closing
    const sourceFiles: vscode.Uri[] = [];
    const textFilePositions: Record<string, number> = {};
    const panelPositions: Record<string, number> = {};

    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                sourceFiles.push(tab.input.uri);
                textFilePositions[tab.input.uri.fsPath] = group.viewColumn;
            } else if (tab.input instanceof vscode.TabInputWebview) {
                if (tab.label === 'Plots') {
                    panelPositions['plots'] = group.viewColumn;
                } else if (tab.label === 'Help') {
                    panelPositions['help'] = group.viewColumn;
                } else if (tab.label === 'Workspace') {
                    panelPositions['workspace'] = group.viewColumn;
                } else if (tab.label === 'Data Viewer') {
                    panelPositions['dataViewer'] = group.viewColumn;
                } else if (tab.label === 'Problems') {
                    panelPositions['problems'] = group.viewColumn;
                }
            }
        }
    }

    // Save to workspaceState
    await extensionContext.workspaceState.update('r-layout.textFilePositions', textFilePositions);
    await extensionContext.workspaceState.update('r-layout.panelPositions', panelPositions);

    // Save Help state to in-memory variable before disposing
    if (HelpPanel.currentPanel) {
        savedHelpState = HelpPanel.currentPanel.saveState();
        // Clear workspaceState in case it was used previously
        await extensionContext.workspaceState.update('r-layout.helpState', undefined);
    }

    // Save Data Viewer state to in-memory variable before disposing
    if (DataViewerPanel.currentPanel) {
        savedDataViewerState = DataViewerPanel.currentPanel.saveState();
        // Clear workspaceState in case it was used previously
        await extensionContext.workspaceState.update('r-layout.dataViewerState', undefined);
    }

    // 4. Dispose panel singletons (closes our Webview tabs)
    //    We dispose HelpPanel here because we just serialized its state.
    HelpPanel.currentPanel?.dispose();
    PlotsPanel.currentPanel?.dispose();
    ProblemsPanel.currentPanel?.dispose();
    WorkspacePanel.currentPanel?.dispose();
    DataViewerPanel.currentPanel?.dispose();

    // 5. Restore user settings FIRST - before moving terminals or reopening files -
    //    so that terminal defaults are correct when moving, and closeEmptyGroups
    //    is true when showTextDocument runs.
    const cfgTarget = getConfigTarget();
    const wsConfig = vscode.workspace.getConfiguration();

    const origClose = extensionContext.workspaceState.get<boolean | undefined>('r-layout.origCloseEmptyGroups', undefined);

    await Promise.all([
        Promise.resolve(
            wsConfig.update('workbench.editor.closeEmptyGroups', origClose, cfgTarget)
        ).catch(() => {})
    ]);
    await delay(100); // Give VS Code backend time to register the setting change

    // 6. Move only R Layout terminals back to the bottom panel.
    //    We target ONLY our terminals by reference, not all editor terminals.
    //    This prevents moving third-party terminals (e.g. Python Debugger) which
    //    can corrupt panel state and cause PTY crashes on reactivation.
    for (const terminal of [rConsoleTerminal, shellTerminal]) {
        if (!terminal) {
            continue;
        }
        // Check if this specific terminal is an editor tab
        const isEditorTab = vscode.window.tabGroups.all.some(g =>
            g.tabs.some(tab => {
                const input = tab.input as any;
                return input instanceof vscode.TabInputTerminal &&
                    (tab.label === terminal.name || tab.label.includes(terminal.name));
            })
        );
        if (isEditorTab) {
            terminal.show(false); // Activate this terminal in its editor tab
            await delay(100);
            await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
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
            if (tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputTerminal) {
                continue;
            }
            try { await vscode.window.tabGroups.close(tab); } catch {}
        }
    }

    // 8. Reset to single editor group.
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{}],
    });

    // 9. Restore the sidebar
    try {
        await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
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
    });
}

//  Layout Guards - redirect stray content to the right layout

let layoutGuards: vscode.Disposable[] = [];
let terminalGuardBusy = false;

function registerLayoutGuards(context: vscode.ExtensionContext): void {
    for (const d of layoutGuards) { d.dispose(); }
    layoutGuards = [];

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
        if (!isLayoutActive || activationInProgress || _termGuardBusy) { return; }
        if (terminal === rConsoleTerminal || terminal === shellTerminal) { return; }
        _pendingTerminal = terminal;
        // Safety timeout - clear reference if tab event never fires
        setTimeout(() => {
            if (_pendingTerminal === terminal) { _pendingTerminal = null; }
        }, 2000);
    });

    // Allowlist of webview viewTypes that BELONG in Groups 2 and 3.
    // Anything not in this set (and not a terminal we own) is stray and
    // gets moved to Group 1.
    const allowedGroup2ViewTypes = new Set([
        'r-layout.problemsPanel',
        'r-layout.helpPanel',
    ]);
    const allowedGroup3ViewTypes = new Set([
        'r-layout.workspacePanel',
        'r-layout.plotsPanel',
        'r-layout.dataViewerPanel',
    ]);

    const tabAndTermGuard = vscode.window.tabGroups.onDidChangeTabs(async (e) => {
        if (!isLayoutActive || activationInProgress) { return; }
        for (const tab of e.opened) {
            const group = vscode.window.tabGroups.all.find((g) => g.tabs.includes(tab));
            if (!group) {
                continue;
            }

            // --- Anchor cleanup: when a real file opens in Group 1, close the placeholder ---
            if (group.viewColumn === vscode.ViewColumn.One &&
                tab.input instanceof vscode.TabInputText &&
                currentAnchorUri &&
                tab.input.uri.toString() !== currentAnchorUri) {
                const anchorUriStr = currentAnchorUri;
                currentAnchorUri = undefined;
                setTimeout(async () => {
                    for (const g of vscode.window.tabGroups.all) {
                        for (const t of g.tabs) {
                            if (t.input instanceof vscode.TabInputText && t.input.uri.toString() === anchorUriStr) {
                                try { await vscode.window.tabGroups.close(t); } catch {}
                            }
                        }
                    }
                }, 50);
                continue;
            }

            // --- Everything in Group 1 is fine ---
            if (group.viewColumn === vscode.ViewColumn.One) { continue; }

            // --- Group 2: allow our terminals and our panels ---
            if (group.viewColumn === vscode.ViewColumn.Two) {
                if (tab.input instanceof vscode.TabInputTerminal) { continue; }
                if (tab.input instanceof vscode.TabInputWebview) {
                    const viewType = (tab.input as any).viewType as string | undefined;
                    if (viewType && allowedGroup2ViewTypes.has(viewType)) { continue; }
                }
            }

            // --- Group 3: allow our panels ---
            if (group.viewColumn === vscode.ViewColumn.Three) {
                if (tab.input instanceof vscode.TabInputWebview) {
                    const viewType = (tab.input as any).viewType as string | undefined;
                    if (viewType && allowedGroup3ViewTypes.has(viewType)) { continue; }
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
                    await vscode.commands.executeCommand('vscode.diff',
                        diff.original, diff.modified, undefined,
                        { viewColumn: vscode.ViewColumn.One, preserveFocus: false }
                    );
                } catch {}
                continue;
            }

            // Third-party terminal tabs: dispose and recreate in Group 2.
            if (tab.input instanceof vscode.TabInputTerminal) {
                if (_termGuardBusy || !_pendingTerminal) { continue; }
                const terminal = _pendingTerminal;
                _pendingTerminal = null;
                _termGuardBusy = true;
                const opts = terminal.creationOptions as vscode.TerminalOptions;
                terminal.dispose();
                try {
                    const newTerm = vscode.window.createTerminal({
                        name: opts.name ?? 'Terminal',
                        shellPath: opts.shellPath,
                        shellArgs: opts.shellArgs,
                        cwd: opts.cwd,
                        env: opts.env,
                        location: { viewColumn: vscode.ViewColumn.Two },
                    });
                    newTerm.show(false);
                } finally {
                    setTimeout(() => { _termGuardBusy = false; }, 600);
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
                        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
                    } else if (strayGroupColumn === vscode.ViewColumn.Three) {
                        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
                    }
                    await vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
                    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                } catch {}
            }, 80);
        }
    });

    layoutGuards.push(tabAndTermGuard, termOpenGuard);
    context.subscriptions.push(tabAndTermGuard, termOpenGuard);
}





function disposeLayoutGuards(): void {
    for (const d of layoutGuards) { d.dispose(); }
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
 * the order is always Chat(s) → Help per the AGENTS.md spec.
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
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
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
        statusBarItem.text = 'R Layout ●';
        statusBarItem.tooltip = 'Click to Deactivate RStudio Layout';
    } else {
        statusBarItem.text = 'R Layout';
        statusBarItem.tooltip = 'Click to Activate RStudio Layout';
    }
}

//  Utility

/**
 * Resolve the R binary path from multiple configuration sources:
 *   1. Our own setting: r-layout.rConsolePath  (e.g. "radian")
 *   2. R extension's terminal path: r.rterm.mac  (e.g. "/usr/local/bin/radian")
 *   3. R extension's R binary path: r.rpath.mac  (e.g. "/usr/local/bin/R")
 *   4. Default: "R"
 *
 * This lets R Layout respect the user's existing R extension
 * configuration (radian, custom paths) without calling r.createRTerm
 * - which would trigger "No text editor active" warnings.
 */
function resolveRPath(rLayoutConfig: vscode.WorkspaceConfiguration): string {
    // 1. Our own setting takes priority
    const ours = rLayoutConfig.get<string>('rConsolePath', '');
    if (ours && ours !== 'R') {
        return ours;
    }

    // 2. R extension's terminal path (platform-specific)
    const rConfig = vscode.workspace.getConfiguration('r');
    const rTermMac = rConfig.get<string>('rterm.mac', '');
    if (rTermMac) {
        console.log(`[R Layout] Using R extension's r.rterm.mac: ${rTermMac}`);
        return rTermMac;
    }

    // 3. R extension's R path
    const rPathMac = rConfig.get<string>('rpath.mac', '');
    if (rPathMac) {
        console.log(`[R Layout] Using R extension's r.rpath.mac: ${rPathMac}`);
        return rPathMac;
    }

    // 4. Default
    return ours || 'R';
}

/** Maps a ViewColumn to the command that focuses that editor group. */
function groupFocusCommand(col: vscode.ViewColumn): string | undefined {
    const map: Record<number, string> = {
        1: 'workbench.action.focusFirstEditorGroup',
        2: 'workbench.action.focusSecondEditorGroup',
        3: 'workbench.action.focusThirdEditorGroup',
        4: 'workbench.action.focusFourthEditorGroup',
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
    console.log(`[R Layout] _buildWatcherRprofile: wf=${wf}, workspaceFolders=${JSON.stringify(vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath))}`);

    const outDir = path.join(wf, '.r_layout');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    const plotsDir = path.join(outDir, 'plots');
    if (!fs.existsSync(plotsDir)) {
        fs.mkdirSync(plotsDir, { recursive: true });
    }

    const scriptPath = path.join(outDir, '.workspace_watcher.R');
    console.log(`[R Layout] _buildWatcherRprofile: scriptPath=${scriptPath}`);

    // Absolute paths injected into the R script so it works regardless of R's cwd.
    // On Windows, backslashes must be escaped for R string literals.
    const absOutDir = outDir.replace(/\\/g, '/');
    const absPlotsDir = plotsDir.replace(/\\/g, '/');
    const absDvCsv = path.join(outDir, 'dv.csv').replace(/\\/g, '/');
    const absDvMeta = path.join(outDir, 'dv-meta.txt').replace(/\\/g, '/');
    const absVarsTsv = path.join(outDir, '.workspace_vars.tsv').replace(/\\/g, '/');
    const absLoadedTsv = path.join(outDir, '.workspace_loaded.tsv').replace(/\\/g, '/');
    const absAttachedTsv = path.join(outDir, '.workspace_attached.tsv').replace(/\\/g, '/');

    // Helper R code to snapshot the current workspace - used both at
    // startup and in the task callback. We use TSV to avoid base R JSON serialization issues.
    const snapshotCode = `
  tryCatch({
    dir.create("${absPlotsDir}", showWarnings = FALSE, recursive = TRUE)
    .vars <- ls(envir = .GlobalEnv)
    .info <- if (length(.vars) == 0) character(0) else vapply(.vars, function(nm) {
      obj <- get(nm, envir = .GlobalEnv)
      cls <- paste(class(obj), collapse = ", ")
      dims <- if (!is.null(dim(obj))) paste(dim(obj), collapse = " x ") else as.character(length(obj))
      prev <- tryCatch({
        if (is.data.frame(obj) || is.matrix(obj)) paste0(nrow(obj), " obs. of ", ncol(obj), " variables")
        else if (is.list(obj)) paste0("List of ", length(obj))
        else if (is.function(obj)) "function"
        else if (is.character(obj) && length(obj) == 1) paste0('"', substr(obj, 1, 60), '"')
        else if (length(obj) <= 6) paste(head(obj, 6), collapse = " ")
        else paste0(length(obj), " elements")
      }, error = function(e) "?")
      prev <- gsub("\\\\t|\\\\n|\\\\r", " ", prev)
      is_df <- if (is.data.frame(obj)) "true" else "false"
      paste(nm, cls, dims, prev, is_df, sep = "\\t")
    }, character(1))
    writeLines(.info, "${absVarsTsv}")
    .def_pkgs <- getOption("defaultPackages", c("datasets", "utils", "grDevices", "graphics", "stats", "methods"))
    writeLines(unique(c(loadedNamespaces(), .def_pkgs)), "${absLoadedTsv}")
    writeLines(unique(c(search(), paste0("package:", .def_pkgs))), "${absAttachedTsv}")
  }, error = function(e) NULL)`;



    const rCode = `
# R Layout workspace watcher - auto-loaded via R_PROFILE_USER

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
.rlayout_csv  <- "${absDvCsv}"
.rlayout_meta <- "${absDvMeta}"
.rlayout_active_df_to_export <- NULL
.rlayout_last_plot_hash <- NULL
.rlayout_current_plot_id <- 0

# Default plot output directory (absolute path injected by extension).
# Can be overridden mid-session via: options(.rlayout_plot_dir = "/your/custom/path")
# Resetting: options(.rlayout_plot_dir = NULL)  → reverts to default
options(.rlayout_plot_dir = "${absPlotsDir}")

# Set default device to null pdf to enable invisible plot recording
options(device = function(...) { pdf(file="/dev/null", ...); dev.control("enable") })

# Hook plot.new to increment plot ID. Instead of naive +1, we scan the directory
# to find the highest existing plot number and append. This is safe for custom
# directories and idempotent if multiple hooks fire for the same plot.
.rlayout_update_plot_id <- function() {
  .out_dir <- getOption(".rlayout_plot_dir", "${absPlotsDir}")
  if (!dir.exists(.out_dir)) {
    .rlayout_current_plot_id <<- 1
    return()
  }
  files <- list.files(.out_dir, pattern = "^plot_[0-9]{5}\\\\.png$")
  if (length(files) == 0) {
    .rlayout_current_plot_id <<- 1
  } else {
    nums <- as.numeric(sub("^plot_([0-9]{5})\\\\.png$", "\\\\1", files))
    .rlayout_current_plot_id <<- max(nums, na.rm = TRUE) + 1
  }
}
setHook("before.plot.new", .rlayout_update_plot_id)
setHook("before.grid.newpage", .rlayout_update_plot_id)

# 4. Wipe stale R Layout data at startup so previous sessions don't bleed over.
#    We hook into .First which runs immediately when the R session begins.
if (exists(".First", envir = .GlobalEnv)) {
  .rlayout_orig_First <- get(".First", envir = .GlobalEnv)
  .First <- function() {
    unlink("${absVarsTsv}")
    unlink(file.path("${absPlotsDir}", "*"))
    tryCatch(.rlayout_orig_First(), error = function(e) {})
    ${snapshotCode}
  }
} else {
  .First <- function() {
    unlink("${absVarsTsv}")
    unlink(file.path("${absPlotsDir}", "*"))
    ${snapshotCode}
  }
}

# 5. Data Viewer export function.
#    .rlayout_csv and .rlayout_meta are already set above - no paths needed at call time.
.r_layout_view_data <- function(varName) {
  .rlayout_active_df_to_export <<- varName
  tryCatch({
    obj <- get(varName, envir = .GlobalEnv)
    if (!is.data.frame(obj)) obj <- as.data.frame(obj)
    writeLines(c(as.character(nrow(obj)), as.character(ncol(obj))), .rlayout_meta)
    write.csv(head(obj, 1000), .rlayout_csv, row.names = FALSE, na = "NA")
  }, error = function(e) {
    writeLines(paste0("ERROR:", conditionMessage(e)), .rlayout_meta)
  })
  invisible(NULL)
}

# 6. Install the task callback. It fires after every top-level R command.
invisible(local({
  if (!any(vapply(getTaskCallbackNames(), function(n) n == ".r_layout.watcher", logical(1)))) {
    addTaskCallback(function(expr, value, ok, visible) {
      # 1. Update Data Viewer quietly if active
      if (!is.null(.rlayout_active_df_to_export) && exists(.rlayout_active_df_to_export, envir = .GlobalEnv)) {
        try({
          obj <- get(.rlayout_active_df_to_export, envir = .GlobalEnv)
          if (!is.data.frame(obj)) obj <- as.data.frame(obj)
          writeLines(c(as.character(nrow(obj)), as.character(ncol(obj))), .rlayout_meta)
          write.csv(head(obj, 1000), .rlayout_csv, row.names = FALSE, na = "NA")
        }, silent = TRUE)
      }

      # 2. Capture plots quietly
      if (dev.cur() > 1) {
        .p <- recordPlot()
        if (!is.null(.p) && length(.p[[1]]) > 0) {
          .hash <- sum(as.numeric(serialize(.p, NULL)))
          if (!identical(.hash, .rlayout_last_plot_hash)) {
            .rlayout_last_plot_hash <<- .hash
            # If no plot ID yet (startup), calculate the next available ID safely
            if (.rlayout_current_plot_id == 0) .rlayout_update_plot_id()
            # Resolve output directory: user override via options() or default absolute plots dir
            .out_dir <- getOption(".rlayout_plot_dir", "${absPlotsDir}")
            dir.create(.out_dir, showWarnings = FALSE, recursive = TRUE)
            .file <- file.path(.out_dir, sprintf("plot_%05d.png", .rlayout_current_plot_id))
            # Explicitly set background to white for the generated PNG file
            png(filename = .file, width = 800, height = 600, res = 100, bg = "white")
            try(replayPlot(.p), silent = TRUE)
            dev.off()
          }
        }
      }

      # 3. Snapshot Workspace
      ${snapshotCode}
      TRUE
    }, name = ".r_layout.watcher")
  }
}))
`;
    fs.writeFileSync(scriptPath, rCode, 'utf8');
    return scriptPath.replace(/\\/g, '/');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
 * (R watcher, .r_layout directory, plots, workspace panel) work in no-workspace mode.
 */
function getEffectiveWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

function captureWorkspaceRoots(): void {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (roots.length > 0) {
        cachedWorkspaceRoots = roots;
    }
}

function getWorkspaceRootsForCleanup(): string[] {
    const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    return roots.length > 0 ? roots : cachedWorkspaceRoots;
}

/**
 * Deletes the .r_layout temporary directory in the current workspace.
 */
function deleteRLayoutDir() {
    // Collect all roots: workspace folders (current + cached) AND home directory fallback
    const roots = new Set<string>(getWorkspaceRootsForCleanup());
    roots.add(os.homedir());

    for (const root of roots) {
        const rLayoutDir = path.join(root, '.r_layout');
        try {
            if (fs.existsSync(rLayoutDir)) {
                fs.rmSync(rLayoutDir, {
                    recursive: true,
                    force: true,
                    maxRetries: 3,
                    retryDelay: 25,
                });
            }
        } catch (e) {
            console.error('[R Layout] Failed to delete .r_layout directory', e);
        }
    }
}
