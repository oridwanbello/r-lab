import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PlotsPanel } from '../panels/plotsPanel';
import { HelpPanel } from '../panels/helpPanel';
import { ProblemsPanel } from '../panels/problemsPanel';
import { WorkspacePanel } from '../panels/workspacePanel';
import { DataViewerPanel } from '../panels/dataViewerPanel';

/**
 * R Quadrant Layout Manager
 *
 * Orchestrates a true 4-quadrant RStudio layout:
 *
 *   ┌───────────────────┬───────────────────┐
 *   │ ① Source Editor   │ ③ AI Chat        │
 *   │                   │   + Help          │
 *   ├───────────────────┼───────────────────┤
 *   │ ② R Console       │ ④ Workspace      │
 *   │  | Terminal        │   | Plots | Data │
 *   │  | Problems        │                  │
 *   └───────────────────┴───────────────────┘
 *
 * On activation:
 *   - Saves open source files, then closes ALL editors & terminals
 *   - Sets the 2×2 layout, opens panels, reopens source files
 *
 * On deactivation:
 *   - Disposes webview panels, moves terminals back to bottom panel,
 *     resets to single editor group, reopens source files
 */

// ── Module State ────────────────────────────────────────────

let isLayoutActive = false;
let activationInProgress = false;
let rConsoleTerminal: vscode.Terminal | undefined;
let shellTerminal: vscode.Terminal | undefined;
let savedDataViewerState: { varName: string } | undefined;
let savedHelpState: any | undefined;
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

export function getRConsoleTerminal(): vscode.Terminal | undefined {
    return rConsoleTerminal;
}

const STATE_KEY = 'r-quadrant.layoutActive';

// ── Registration ────────────────────────────────────────────

export function registerLayoutCommand(
    context: vscode.ExtensionContext
): void {
    extensionContext = context;

    // Restore persisted state
    isLayoutActive = context.workspaceState.get<boolean>(STATE_KEY, false);

    // ── Status Bar Button ───────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'r-quadrant.toggleLayout';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ── Layout Toggle Command ───────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('r-quadrant.toggleLayout', async () => {
            if (isLayoutActive) {
                await deactivateLayout();
            } else {
                await activateLayout(context);
            }
        })
    );

    // ── Utility Commands ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('r-quadrant.noop', () => {})
    );

    // ── Track terminal disposal ─────────────────────────────
    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((t) => {
            if (t === rConsoleTerminal) {
                rConsoleTerminal = undefined;
                savedDataViewerState = undefined;
                savedHelpState = undefined;
                
                // Delete .r-quadrant directory to prevent left-over files
                const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (wf) {
                    const rQuadDir = path.join(wf, '.r-quadrant');
                    try {
                        if (fs.existsSync(rQuadDir)) {
                            fs.rmSync(rQuadDir, { recursive: true, force: true });
                        }
                    } catch (e) {
                        console.error('Failed to delete .r-quadrant directory on session end', e);
                    }
                }
            }
            if (t === shellTerminal) { shellTerminal = undefined; }
        })
    );
}

// ────────────────────────────────────────────────────────────
//  Stale Layout Guard
// ────────────────────────────────────────────────────────────

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
        // No stale layout — nothing to collapse.
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

    // ── UNCONDITIONAL settings reset ──────────────────────────
    // Reset these FIRST, before any other logic, as a safety net.
    // If a previous session crashed or was killed before cleanup
    // could finish, these settings can get stuck as workspace
    // overrides — causing files to open in a split view and
    // terminals to land in the editor area in pre-quadrant VS Code.
    try {
        const cfgTarget = vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        const wsConfig = vscode.workspace.getConfiguration();
        await Promise.all([
            Promise.resolve(
                wsConfig.update('workbench.editor.closeEmptyGroups', undefined, cfgTarget)
            ).catch(() => {}),
            Promise.resolve(
                wsConfig.update('terminal.integrated.defaultLocation', undefined, cfgTarget)
            ).catch(() => {}),
        ]);
    } catch {}

    // ── CONDITIONAL stale-layout cleanup ─────────────────────
    // Only close editors and reset the layout if there are actually
    // stale elements from a previous R Quadrant session:
    //   • more than one editor group (leftover 4-pane grid), OR
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
        // Nothing stale — leave the editor state exactly as VS Code
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

    // Close stale tabs (webviews, terminals-as-editors, etc.)
    try {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

// ────────────────────────────────────────────────────────────
//  Shutdown Collapse — called from extension deactivate()
// ────────────────────────────────────────────────────────────

/**
 * Called by the extension's deactivate() function.
 *
 * VS Code AWAITS the Promise returned by deactivate() before it saves
 * final workbench state and reloads the window. This is the critical
 * insight: if we collapse the layout here, VS Code writes a single-group
 * layout to its session store, so on the next startup there is nothing
 * multi-group to restore — and the flash never happens.
 *
 * Without this, when the user reloads while R Quadrant is active, VS Code
 * saves the 4-group layout, restores it on reload (flash!), and only then
 * our activation code can collapse it.
 */
export async function collapseLayoutForShutdown(): Promise<void> {
    if (!isLayoutActive) {
        // Layout wasn't active — nothing to collapse.
        return;
    }

    console.log('[R Quadrant] deactivate(): collapsing layout before state is saved.');

    // Determine config target once, synchronously, before we fan out.
    const cfgTarget = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const wsConfig = vscode.workspace.getConfiguration();

    // Fire ALL cleanup operations in parallel.
    //
    // Previously these were sequential (5 round-trips). Running them
    // concurrently cuts the wall-clock time to a single round-trip —
    // the longest individual operation — making the reload delay
    // imperceptible.
    //
    // NOTE: closeAllEditors is intentionally omitted. VS Code is
    // about to reload; in-memory tab state won't be persisted beyond
    // what the layout already controls. Removing it saves one full
    // async round-trip with no downside.
    await Promise.all([
        // ① Critical: collapse to single group so VS Code saves 1-group state
        Promise.resolve(
            vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [{}],
            })
        ).catch(() => {}),

        // ② Clear persisted state so resetStaleLayout is a no-op next start
        extensionContext
            ? Promise.resolve(
                extensionContext.workspaceState.update(STATE_KEY, false)
              ).catch(() => {})
            : Promise.resolve(),

        // ③ Reset settings — both fire at the same time
        Promise.resolve(
            wsConfig.update('terminal.integrated.defaultLocation', undefined, cfgTarget)
        ).catch(() => {}),
        Promise.resolve(
            wsConfig.update('workbench.editor.closeEmptyGroups', undefined, cfgTarget)
        ).catch(() => {}),
    ]);
}

// ────────────────────────────────────────────────────────────
//  Activate Layout
// ────────────────────────────────────────────────────────────

async function activateLayout(context: vscode.ExtensionContext): Promise<void> {
    activationInProgress = true;
    // 1. Load saved positions, and Save references to all currently open TEXT files
    //    so we can reopen them after setting the layout.
    const textFilePositions = context.workspaceState.get<Record<string, number>>('r-quadrant.textFilePositions', {});
    const panelPositions = context.workspaceState.get<Record<string, number>>('r-quadrant.panelPositions', {});

    const openFiles: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                openFiles.push(tab.input.uri);
            }
        }
    }

    // 2. Close stale R Quadrant panels from previous sessions.
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
        'setContext', 'r-quadrant.layoutActive', true
    );

    // 6. Apply workspace overrides
    const cfgTarget = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const wsConfig = vscode.workspace.getConfiguration();
    await wsConfig.update('workbench.editor.closeEmptyGroups', false, cfgTarget);
    await wsConfig.update('terminal.integrated.defaultLocation', 'editor', cfgTarget);

    await delay(200);

    // 7. Set the 4-group (2×2) editor layout
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [
            {
                size: 0.65,
                groups: [
                    { size: 0.6 }, // ① Source Editor
                    { size: 0.4 }, // ② Console / Terminal / Problems
                ],
            },
            {
                size: 0.35,
                groups: [
                    { size: 0.5 }, // ③ AI Chat + Help
                    { size: 0.5 }, // ④ Workspace + Plots
                ],
            },
        ],
    });

    await delay(100);

    // ─────────────────────────────────────────────────────────
    //  CRITICAL: Populate groups in strict order 1 → 2 → 3 → 4
    //  VS Code assigns ViewColumn numbers based on the order
    //  groups first receive content. If we put content into
    //  Group 2 before Group 1, the ViewColumns all shift.
    // ─────────────────────────────────────────────────────────

    // 8. Anchor Group 1 with an active text editor.
    //    The vscode-R extension's chunk-navigation shows a "No text editor active" warning
    //    whenever window.activeTextEditor is null. We prevent this by ensuring Group 1
    //    always has a visible text document during layout construction.
    //    Priority: (a) reopen a previously saved source file, (b) open an untitled scratch.
    try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
    await delay(100);

    let anchorEditor: vscode.TextEditor | undefined;
    if (openFiles.length > 0) {
        // Reopen the first saved file into Group 1 — this satisfies the R extension's check.
        try {
            anchorEditor = await vscode.window.showTextDocument(
                openFiles[0],
                { viewColumn: vscode.ViewColumn.One, preserveFocus: true, preview: false }
            );
        } catch {}
    }
    if (!anchorEditor) {
        // No saved file open — create a tiny untitled doc to anchor Group 1.
        try {
            const doc = await vscode.workspace.openTextDocument({ content: '', language: 'plaintext' });
            anchorEditor = await vscode.window.showTextDocument(
                doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true }
            );
        } catch {}
    }
    await delay(150);
    // NOTE: Do NOT call focusSecondEditorGroup here — it would set
    // window.activeTextEditor to undefined and trigger the R extension's
    // "No text editor active" warning. Terminal placement uses explicit
    // viewColumn or moveToEditor + immediate Group 1 restore instead.
    await delay(150);

    // 9. Group 2 (bottom-left): R Console → Terminal → Problems
    //
    //    Strategy for existing terminals (session retention):
    //      a) Create ProblemsPanel in ViewColumn.Two FIRST — this anchors Group 2
    //         as a real, focusable editor group before any terminal is moved.
    //      b) Focus Group 2 (it now has content so focus sticks).
    //      c) Call terminal.show(false) to make the terminal the active one
    //         in the panel without stealing editor focus away from Group 2.
    //      d) Call moveToEditor — moves the active panel terminal to the
    //         currently focused editor group (Group 2). ✓
    //
    //    For NEW terminals, createTerminal with location.viewColumn is reliable.
    const config = vscode.workspace.getConfiguration('r-quadrant');
    const useArk = config.get<boolean>('useArkInteractiveConsole', false);

    // 9a. Anchor Group 2 with ProblemsPanel before any terminal placement.
    ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    await delay(200);

    if (useArk) {
        // Ark kernel mode — use Jupyter Interactive
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
                await delay(100);
                await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
                await delay(100);
                await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
            } else {
                rConsoleTerminal = vscode.window.createTerminal({
                    name: 'R Console',
                    shellPath: resolveRPath(config),
                    location: { viewColumn: vscode.ViewColumn.Two },
                    iconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'r-logo.svg'),
                });
                rConsoleTerminal.show(false);
            }
        }
    } else {
        // Only delete stale workspace data if we are creating a BRAND-NEW R session.
        // If we found an existing R Console terminal (wasRConsoleReused), R is still
        // running and its variables are still live — do NOT wipe the data file.
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wf && !wasRConsoleReused) {
            const staleFile = path.join(wf, '.r-quadrant', '.workspace_data.json');
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

    if (rConsoleTerminal) {
            // Reuse the existing terminal — do NOT recreate (that kills the R session).
            // show(false) ensures this terminal is the active one in the terminal panel.
            rConsoleTerminal.show(false);
            await delay(200);
            
            // Fallback for older terminals or tricky states: use moveToEditor
            await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
            await delay(150);
            await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
            await delay(100);

            // Restore focus to Group 1
            try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
            await delay(100);
        } else {
            // New session: create directly in ViewColumn.Two
            rConsoleTerminal = vscode.window.createTerminal({
                name: 'R Console',
                shellPath: resolveRPath(config),
                location: { viewColumn: vscode.ViewColumn.Two },
                env: Object.keys(rProfileEnv).length > 0 ? rProfileEnv : undefined,
                iconPath: vscode.Uri.joinPath(context.extensionUri, 'resources', 'r-logo.svg'),
            });
            await delay(200);
            rConsoleTerminal.show(false);
        }
    }

    // Shell terminal
    await delay(200);
    if (shellTerminal) {
        shellTerminal.show(false);
        await delay(200);
        
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await delay(150);
        await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
        await delay(100);
        
        try { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); } catch {}
    } else {
        shellTerminal = vscode.window.createTerminal({
            name: 'Terminal',
            location: { viewColumn: vscode.ViewColumn.Two },
        });
        await delay(200);
        shellTerminal.show(false);
    }

    // ProblemsPanel: dispose the anchor instance and recreate so it becomes the
    // LAST tab in Group 2, giving order: R Console → Terminal → Problems.
    await delay(100);
    ProblemsPanel.currentPanel?.dispose();
    await delay(100);
    ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    await delay(100);



    // 10. Group 3 (top-right): Chat → Help  (Chat FIRST, Chat FOCUSED)
    //
    //     CRITICAL ORDER: HelpPanel MUST be created first so Group 3 has content.
    //     focusThirdEditorGroup silently no-ops on an empty group, causing
    //     openChatInGroup3 to fire while Group 1 is still active — landing Chat
    //     in the wrong quadrant.
    //
    //     Sequence:
    //       a) Open Help in Group 3 (preserveFocus=true so editor stays active).
    //       b) Load Help state.
    //       c) Open Chat — Group 3 now has content, focus is reliable.
    //       d) Chat lands as tab 2; moveEditorLeftInGroup moves it to tab 1.
    //       e) firstEditorInGroup activates Chat (tab 1).

    // a+b: Anchor Group 3 with HelpPanel.
    const helpPanel = HelpPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Three);
    if (savedHelpState) { helpPanel.loadState(savedHelpState); }
    await delay(150);

    // c+d: Open Chat into Group 3 (now non-empty) and reorder to tab 1.
    await openChatInGroup3();
    await delay(150);

    // e: Focus Group 3 and activate its first tab (Chat).
    try {
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
        await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
    } catch {}
    await delay(100);

    // 11. Group 4 (bottom-right): Workspace → Plots → Data Viewer  (Workspace FIRST, Workspace FOCUSED)
    //     Create Workspace first (leftmost tab), then Plots, then Data Viewer.
    //     Reveal Workspace at the end to make it the active/focused tab.
    const workspacePanel = WorkspacePanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);
    // Note: forceRefresh() is deferred (see end of activation) to give the webview
    // time to fully render before the message is posted.
    const plotsPanel = PlotsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);
    plotsPanel.syncPlots(); // catch up on any plots created while layout was closed
    const dataPanel = DataViewerPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);
    workspacePanel.reveal(); // restore Workspace as the focused tab in Group 4

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

    // 13. Now that ViewColumns 1-4 are rigidly locked by default content,
    //     we can safely restore saved positions without causing ViewColumn shifting.

    // 12. Create DataViewer if it was open (RESTORATION)
    if (savedDataViewerState && savedDataViewerState.varName) {
        const dvPanel = DataViewerPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);
        await dvPanel.loadState(savedDataViewerState);
    }

    // 13. Create Problems if it was open (RESTORATION)
    if (panelPositions['problems'] === vscode.ViewColumn.Two) {
        ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    }

    // Reposition custom panels
    if (panelPositions['problems'] && panelPositions['problems'] !== vscode.ViewColumn.Two) ProblemsPanel.createOrShow(context.extensionUri, panelPositions['problems']);
    if (panelPositions['help'] && panelPositions['help'] !== vscode.ViewColumn.Three) HelpPanel.createOrShow(context.extensionUri, panelPositions['help']);
    if (panelPositions['workspace'] && panelPositions['workspace'] !== vscode.ViewColumn.Four) WorkspacePanel.createOrShow(context.extensionUri, panelPositions['workspace']);
    if (panelPositions['plots'] && panelPositions['plots'] !== vscode.ViewColumn.Four) PlotsPanel.createOrShow(context.extensionUri, panelPositions['plots']);
    if (panelPositions['dataViewer'] && panelPositions['dataViewer'] !== vscode.ViewColumn.Four) DataViewerPanel.createOrShow(context.extensionUri, panelPositions['dataViewer']);

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

    // 16. Set final tab focus: R Console in Group 2 (done LAST so nothing steals it back).
    //     R Console is always the first tab placed in Group 2.
    try {
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await delay(100);
        await vscode.commands.executeCommand('workbench.action.firstEditorInGroup');
        await delay(50);
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    } catch {}

    activationInProgress = false;
    // Deferred refresh: give the Workspace webview ~500ms to fully render after
    // all layout commands complete, then push the latest R environment state.
    // Doing this earlier races the webview paint and the message is dropped.
    setTimeout(() => { WorkspacePanel.currentPanel?.forceRefresh(); }, 500);

    vscode.window.showInformationMessage('R Quadrant layout activated.');
}

// ────────────────────────────────────────────────────────────
//  Deactivate Layout
// ────────────────────────────────────────────────────────────

async function deactivateLayout(): Promise<void> {
    // 1. Clear context key
    await vscode.commands.executeCommand(
        'setContext', 'r-quadrant.layoutActive', false
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
                if (tab.label === 'Plots') panelPositions['plots'] = group.viewColumn;
                else if (tab.label === 'Help') panelPositions['help'] = group.viewColumn;
                else if (tab.label === 'Workspace') panelPositions['workspace'] = group.viewColumn;
                else if (tab.label === 'Data Viewer') panelPositions['dataViewer'] = group.viewColumn;
                else if (tab.label === 'Problems') panelPositions['problems'] = group.viewColumn;
            }
        }
    }

    // Save to workspaceState
    await extensionContext.workspaceState.update('r-quadrant.textFilePositions', textFilePositions);
    await extensionContext.workspaceState.update('r-quadrant.panelPositions', panelPositions);

    // Save Help state to in-memory variable before disposing
    if (HelpPanel.currentPanel) {
        savedHelpState = HelpPanel.currentPanel.saveState();
        // Clear workspaceState in case it was used previously
        await extensionContext.workspaceState.update('r-quadrant.helpState', undefined);
    }

    // Save Data Viewer state to in-memory variable before disposing
    if (DataViewerPanel.currentPanel) {
        savedDataViewerState = DataViewerPanel.currentPanel.saveState();
        // Clear workspaceState in case it was used previously
        await extensionContext.workspaceState.update('r-quadrant.dataViewerState', undefined);
    }

    // 4. Dispose panel singletons (closes our Webview tabs)
    //    We dispose HelpPanel here because we just serialized its state.
    HelpPanel.currentPanel?.dispose();
    PlotsPanel.currentPanel?.dispose();
    ProblemsPanel.currentPanel?.dispose();
    WorkspacePanel.currentPanel?.dispose();
    DataViewerPanel.currentPanel?.dispose();

    // 5. Move ALL terminals back to the bottom panel.
    //    We focus Group 2 (where terminal tabs live during quadrant mode) and
    //    call moveToTerminalPanel once per terminal. We deliberately do NOT call
    //    t.show() here — show() opens the terminal panel which can trigger VS Code
    //    to auto-create a new default bash terminal before ours arrive.
    const termCount = vscode.window.terminals.length;
    if (termCount > 0) {
        try { await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup'); } catch {}
        await delay(100);
        for (let i = 0; i < termCount; i++) {
            try {
                await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
                await delay(100);
            } catch {}
        }
    }
    // Keep rConsoleTerminal / shellTerminal references alive so the next
    // activateLayout() can immediately reuse them without re-scanning,
    // and so Bug 1's `wasRConsoleReused` guard works correctly.
    // The onDidCloseTerminal listener (registered in registerLayoutCommand)
    // will null them out if the user manually closes a terminal.

    // 6. Close non-text tabs to keep the normal view clean.
    //    CHAT SESSION CONTINUITY:
    //    We move chat tabs back to the sidebar before resetting the layout.
    //    Resetting the layout (setEditorLayout) can destroy tabs in disappearing groups.
    
    // First, specifically handle Group 3 (where Chat usually lives)
    try {
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
        const group3 = vscode.window.tabGroups.all.find(g => g.viewColumn === vscode.ViewColumn.Three);
        if (group3) {
            // Iterate backwards to safely handle moving tabs
            for (let i = group3.tabs.length - 1; i >= 0; i--) {
                const tab = group3.tabs[i];
                if (isChatTab(tab)) {
                    // Focus the tab to make it the target for openInSidebar
                    await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', i);
                    await delay(50);
                    await vscode.commands.executeCommand('workbench.action.chat.openInSidebar');
                    await delay(100);
                }
            }
        }
    } catch {}

    // Then, close remaining non-text/non-terminal tabs in all groups
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputTerminal) {
                continue;
            }
            if (isChatTab(tab)) {
                continue; // Already handled or will be handled by the final safety call
            }
            try { await vscode.window.tabGroups.close(tab); } catch {}
        }
    }

    // 8. Reset to single editor group
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{}],
    });

    // 8. Restore the sidebar
    try {
        await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
    } catch {}

    // 9. All chats should already be in sidebar from the loop above,
    //    but we call it once more as a safety measure for the native chat.
    try {
        await vscode.commands.executeCommand('workbench.action.chat.openInSidebar');
    } catch {}

    // 10. Restore user settings FIRST — before reopening files —
    //     so that closeEmptyGroups is true again when showTextDocument
    //     runs. If it were still false, reopening files could create
    //     a spurious second editor group.
    const cfgTarget = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const wsConfig = vscode.workspace.getConfiguration();
    await Promise.all([
        Promise.resolve(
            wsConfig.update('workbench.editor.closeEmptyGroups', undefined, cfgTarget)
        ).catch(() => {}),
        Promise.resolve(
            wsConfig.update('terminal.integrated.defaultLocation', undefined, cfgTarget)
        ).catch(() => {}),
    ]);

    // 11. Reopen user's source files in the single editor group
    for (const uri of sourceFiles) {
        try {
            await vscode.window.showTextDocument(uri, {
                viewColumn: vscode.ViewColumn.One,
                preview: false,
                preserveFocus: true,
            });
        } catch {
            // skip — file may no longer exist
        }
    }

    // 12. Persist & update UI
    isLayoutActive = false;
    await extensionContext.workspaceState.update(STATE_KEY, false);
    updateStatusBar();

    vscode.window.showInformationMessage('R Quadrant layout deactivated.');
}

// ────────────────────────────────────────────────────────────
//  Layout Guards — redirect stray content to the right quadrant
// ────────────────────────────────────────────────────────────

let layoutGuards: vscode.Disposable[] = [];
let terminalGuardBusy = false;

function registerLayoutGuards(context: vscode.ExtensionContext): void {
    for (const d of layoutGuards) { d.dispose(); }
    layoutGuards = [];

    // ── Terminal guard ─────────────────────────────────────────
    // Two-event approach for imperceptible interception:
    //
    // 1. onDidOpenTerminal — fires when the terminal object is created.
    //    Store a reference to the new terminal.
    //
    // 2. onDidChangeTabs (TabInputTerminal) — fires when the tab
    //    ACTUALLY APPEARS in the UI. At this moment we know its group
    //    from the event. If wrong group, immediately dispose+recreate.
    //    No delays, no terminal.show() — operates within the same
    //    ~16ms render frame as the tab appearing.
    let _pendingTerminal: vscode.Terminal | null = null;
    let _termGuardBusy = false;

    const termOpenGuard = vscode.window.onDidOpenTerminal((terminal) => {
        if (!isLayoutActive || activationInProgress || _termGuardBusy) { return; }
        if (terminal === rConsoleTerminal || terminal === shellTerminal) { return; }
        _pendingTerminal = terminal;
        // Safety timeout — clear reference if tab event never fires
        setTimeout(() => {
            if (_pendingTerminal === terminal) { _pendingTerminal = null; }
        }, 2000);
    });

    // Extend the existing tabGuard to also handle terminal tabs
    const tabAndTermGuard = vscode.window.tabGroups.onDidChangeTabs(async (e) => {
        if (!isLayoutActive) { return; }
        for (const tab of e.opened) {

            // ── Text file guard ──────────────────────────────
            if (tab.input instanceof vscode.TabInputText) {
                const group = vscode.window.tabGroups.all.find((g) => g.tabs.includes(tab));
                if (!group || group.viewColumn === vscode.ViewColumn.One) { continue; }
                const uri = tab.input.uri;
                try {
                    await vscode.window.tabGroups.close(tab);
                    await vscode.window.showTextDocument(uri, {
                        viewColumn: vscode.ViewColumn.One,
                        preview: false,
                        preserveFocus: false,
                    });
                } catch {}
            }

            // ── Terminal tab guard ───────────────────────────
            if (tab.input instanceof vscode.TabInputTerminal) {
                if (activationInProgress || _termGuardBusy || !_pendingTerminal) { continue; }

                const group = vscode.window.tabGroups.all.find((g) => g.tabs.includes(tab));
                if (!group || group.viewColumn === vscode.ViewColumn.Two) {
                    // Correct group — clear pending ref
                    _pendingTerminal = null;
                    continue;
                }

                // Wrong group — dispose and recreate immediately
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
            }
        }
    });

    layoutGuards.push(tabAndTermGuard, termOpenGuard);
    context.subscriptions.push(tabAndTermGuard, termOpenGuard);
}





function disposeLayoutGuards(): void {
    for (const d of layoutGuards) { d.dispose(); }
    layoutGuards = [];
}

// ────────────────────────────────────────────────────────────
//  AI Chat — helpers, discovery, and Group 3 placement
// ────────────────────────────────────────────────────────────

/**
 * Returns true if a tab is a Chat/AI chat tab from any vendor.
 * Uses label matching as a universal fallback — all major AI chat
 * extensions (Antigravity, Copilot, Gemini, Claude, etc.) include
 * "chat" or their brand name in their editor tab label.
 */
function isChatTab(tab: vscode.Tab): boolean {
    const label = tab.label.toLowerCase();
    const chatKeywords = [
        'chat', 'copilot', 'gemini', 'antigravity',
        'claude', 'cody', 'continue', 'amazon q',
        'tabnine', 'codeium', 'cursor', 'supermaven',
    ];
    return chatKeywords.some((k) => label.includes(k));
}

/**
 * Opens AI Chat tabs in Group 3 (top-right quadrant), preserving sessions.
 *
 * Strategy:
 *   Tier 1. Already in Group 3 — skip.
 *   Tier 2. vscode.moveViews — RELOCATES the existing sidebar view into Group 3.
 *           This preserves the chat session and avoids creating a duplicate.
 *           Tried for EVERY detected AI extension so Copilot + Gemini etc.
 *           each get their own sub-tab.
 *   Tier 3. openInEditor / extension-specific commands — last resort only.
 *           Creates a new (fresh) editor instance. Used only when moveViews
 *           fails for all extensions (e.g. extension doesn't support it).
 *
 * After each successful placement, the new tab is moved left past Help so
 * the order is always Chat(s) → Help per the AGENTS.md spec.
 *
 * IMPORTANT: Caller must create HelpPanel in Group 3 BEFORE calling this.
 * focusThirdEditorGroup silently no-ops on an empty group — Group 3 must
 * already have content for the focus (and thus placement) to be reliable.
 */
async function openChatInGroup3(): Promise<void> {
    // ── Tier 1: Already placed correctly — nothing to do ─────────
    const alreadyInGroup3 = () => vscode.window.tabGroups.all
        .find((g) => g.viewColumn === vscode.ViewColumn.Three)
        ?.tabs.some((t) => isChatTab(t)) ?? false;

    if (alreadyInGroup3()) {
        console.log('[R Quadrant] openChatInGroup3: Chat already in Group 3.');
        return;
    }

    const allCommands = await vscode.commands.getCommands(true);
    const aiReport = discoverAllAi(allCommands);
    for (const r of aiReport) {
        console.log(`[R Quadrant] AI discovered: ${r.displayName} (${r.id}), views: ${r.viewIds.join(', ')}`);
    }

    // ── Tier 2: vscode.moveViews — relocates the existing sidebar view ────
    //
    // This is the CORRECT approach for session continuity:
    //   • moveViews moves the actual sidebar view object into the editor area.
    //   • The chat session (history, context) is fully preserved.
    //   • No duplicate is created — it's the same view, just repositioned.
    //   • When the editor tab is later closed (on deactivate), the view
    //     automatically returns to its original sidebar container.
    //
    // We build a priority-ordered list of view IDs: real IDs from each
    // extension's package.json (via discoverAllAi) plus well-known fallbacks.
    // We iterate ALL extensions so that Copilot, Gemini, and any others each
    // get their own tab in Group 3.
    //
    // Group 3 MUST have HelpPanel content before this runs — that's what
    // makes focusThirdEditorGroup reliable.

    // ── Tier 0: User-configured view ID takes highest priority ───────────
    const userChatViewId = vscode.workspace.getConfiguration('r-quadrant').get<string>('chatViewId', '').trim();
    if (userChatViewId) {
        console.log(`[R Quadrant] Trying user-configured chatViewId: "${userChatViewId}"`);
    }

    const wellKnownViewIds = [
        // VS Code built-in / GitHub Copilot
        'workbench.panel.chat',
        'workbench.panel.chat.view.copilot',
        'workbench.view.copilot',
        'github.copilot.chat',
        'copilot.chatSidebar',
        // Google Gemini / Cloud Code
        'googleCloudCode.geminiChat',
        'cloudcode.geminiChat',
        'gemini.chat',
        // Antigravity
        'antigravity.chat',
        'antigravity.chatSidebar',
    ];

    let chatTabCount = 0; // how many chat tabs we've successfully placed

    // Build per-extension view ID lists: real IDs first, well-known after.
    // Outer loop = each AI extension; inner = each view ID for that extension.
    const tried = new Set<string>();

    const attemptMoveView = async (viewId: string): Promise<boolean> => {
        if (tried.has(viewId)) { return false; }
        tried.add(viewId);
        try {
            await focusGroup3(); // Group 3 has Help — focus sticks reliably
            await delay(100);
            await vscode.commands.executeCommand('vscode.moveViews', {
                viewIds: [viewId],
                destinationId: 'workbench.editor',
            });
            await delay(300);
            // Verify: did a NEW chat tab appear in Group 3?
            const currentCount = vscode.window.tabGroups.all
                .find((g) => g.viewColumn === vscode.ViewColumn.Three)
                ?.tabs.filter((t) => isChatTab(t)).length ?? 0;
            if (currentCount > chatTabCount) {
                chatTabCount = currentCount;
                console.log(`[R Quadrant] ✓ Moved view "${viewId}" → Group 3 (${chatTabCount} chat tab(s))`);
                // Move this chat tab before Help (reorder to tab 1)
                await focusGroup3();
                await delay(100);
                // focusThirdEditorGroup might restore focus to Help.
                // Select the newly added Chat tab (which is at the end)
                await vscode.commands.executeCommand('workbench.action.lastEditorInGroup');
                await delay(100);
                await vscode.commands.executeCommand('workbench.action.moveEditorLeftInGroup');
                await delay(50);
                await vscode.commands.executeCommand('workbench.action.moveEditorLeftInGroup'); // twice to be safe
                return true;
            }
        } catch { /* view ID not valid — try next */ }
        return false;
    };

    // Try user-configured ID first (highest priority)
    if (userChatViewId) {
        await attemptMoveView(userChatViewId);
    }

    // Try each AI extension's own view IDs first (most likely to be correct)
    for (const ai of aiReport) {
        for (const viewId of ai.viewIds) {
            await attemptMoveView(viewId);
        }
    }

    // Then try well-known fallback IDs that aren't already in the discovered set
    for (const viewId of wellKnownViewIds) {
        await attemptMoveView(viewId);
    }

    if (chatTabCount > 0) {
        console.log(`[R Quadrant] openChatInGroup3: placed ${chatTabCount} chat tab(s) via vscode.moveViews.`);
        return;
    }

    // ── Tier 3: Last-resort — openInEditor (new session, not the sidebar one) ──
    //
    // Only reached when vscode.moveViews failed for all extensions.
    // Creates a fresh chat editor — session continuity is not preserved,
    // but at least a chat tab appears in Group 3.
    const fallbackCmds = [
        'workbench.action.chat.openInEditor',
        'workbench.action.chat.open',
        'github.copilot.chat.openEditor',
    ].filter((c) => allCommands.includes(c));

    for (const cmd of fallbackCmds) {
        try {
            await focusGroup3();
            await delay(150);
            await vscode.commands.executeCommand(cmd);
            await delay(350);
            if (alreadyInGroup3()) {
                console.log(`[R Quadrant] ✓ Chat placed in Group 3 via fallback "${cmd}" (new session).`);
                await focusGroup3();
                await delay(100);
                await vscode.commands.executeCommand('workbench.action.lastEditorInGroup');
                await delay(100);
                await vscode.commands.executeCommand('workbench.action.moveEditorLeftInGroup');
                await delay(50);
                await vscode.commands.executeCommand('workbench.action.moveEditorLeftInGroup');
                return;
            }
        } catch { /* try next */ }
    }

    console.log(
        '[R Quadrant] openChatInGroup3: could not auto-place a chat tab. ' +
        'Open any AI chat and drag it into the top-right quadrant.'
    );
}



/**
 * Full AI extension discovery: scans ALL installed extensions and
 * collects views, chat participants, and commands for each AI extension.
 */
function discoverAllAi(allCommands: string[]): {
    id: string;
    displayName: string;
    viewIds: string[];
    chatParticipants: string[];
    commands: string[];
}[] {
    const results: {
        id: string;
        displayName: string;
        viewIds: string[];
        chatParticipants: string[];
        commands: string[];
    }[] = [];

    const aiPatterns = [
        'copilot', 'gemini', 'geminicodeassist', 'cloudcode',
        'claude', 'anthropic', 'codeium', 'tabnine',
        'amazonq', 'amazon-q', 'continue', 'cody',
        'sourcegraph', 'cursor', 'supermaven', 'windsurf',
        'antigravity', 'google',
    ];

    for (const ext of vscode.extensions.all) {
        const extIdLower = ext.id.toLowerCase();
        const isAi = aiPatterns.some((p) => extIdLower.includes(p));
        if (!isAi) { continue; }

        const pkg = ext.packageJSON;
        const displayName: string = pkg?.displayName || ext.id;

        // Collect view IDs
        const viewIds: string[] = [];
        if (pkg?.contributes?.views) {
            for (const views of Object.values(pkg.contributes.views)) {
                if (!Array.isArray(views)) { continue; }
                for (const v of views) {
                    if (typeof v === 'object' && v.id) {
                        viewIds.push(v.id);
                    }
                }
            }
        }

        // Collect chat participants
        const chatParticipants: string[] = [];
        if (pkg?.contributes?.chatParticipants) {
            for (const cp of pkg.contributes.chatParticipants) {
                if (cp?.id || cp?.name) {
                    chatParticipants.push(cp.id || cp.name);
                }
            }
        }

        // Collect all commands from this extension that are actually registered
        const prefix = ext.id.split('.').pop()?.toLowerCase() || '';
        const extCommands = allCommands.filter((c) => {
            const lower = c.toLowerCase();
            return lower.includes(prefix) || lower.includes(extIdLower.replace('.', ''));
        });

        results.push({
            id: ext.id,
            displayName,
            viewIds,
            chatParticipants,
            commands: extCommands,
        });
    }

    return results;
}

async function focusGroup3(): Promise<void> {
    try {
        // 1. Try standard command
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
        await delay(50);

        // 2. Aggressive fallback: Force reveal the HelpPanel WITHOUT preserving focus.
        // This is the most reliable way to force focus into Group 3 if it exists.
        if (HelpPanel.currentPanel) {
            HelpPanel.currentPanel.reveal(vscode.ViewColumn.Three, false);
        }
        await delay(100);
    } catch {
        // Silently ignore
    }
}

// ────────────────────────────────────────────────────────────
//  Status Bar
// ────────────────────────────────────────────────────────────

function updateStatusBar(): void {
    if (isLayoutActive) {
        statusBarItem.text = 'R Quadrant ●';
        statusBarItem.tooltip = 'Click to deactivate RStudio layout';
    } else {
        statusBarItem.text = 'R Quadrant';
        statusBarItem.tooltip = 'Click to activate RStudio layout';
    }
}

// ────────────────────────────────────────────────────────────
//  Utility
// ────────────────────────────────────────────────────────────

/**
 * Resolve the R binary path from multiple configuration sources:
 *   1. Our own setting: r-quadrant.rConsolePath  (e.g. "radian")
 *   2. R extension's terminal path: r.rterm.mac  (e.g. "/usr/local/bin/radian")
 *   3. R extension's R binary path: r.rpath.mac  (e.g. "/usr/local/bin/R")
 *   4. Default: "R"
 *
 * This lets R Quadrant respect the user's existing R extension
 * configuration (radian, custom paths) without calling r.createRTerm
 * — which would trigger "No text editor active" warnings.
 */
function resolveRPath(rQuadrantConfig: vscode.WorkspaceConfiguration): string {
    // 1. Our own setting takes priority
    const ours = rQuadrantConfig.get<string>('rConsolePath', '');
    if (ours && ours !== 'R') {
        return ours;
    }

    // 2. R extension's terminal path (platform-specific)
    const rConfig = vscode.workspace.getConfiguration('r');
    const rTermMac = rConfig.get<string>('rterm.mac', '');
    if (rTermMac) {
        console.log(`[R Quadrant] Using R extension's r.rterm.mac: ${rTermMac}`);
        return rTermMac;
    }

    // 3. R extension's R path
    const rPathMac = rConfig.get<string>('rpath.mac', '');
    if (rPathMac) {
        console.log(`[R Quadrant] Using R extension's r.rpath.mac: ${rPathMac}`);
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
 * so R sources it silently at startup — no command appears in the console.
 */
function _buildWatcherRprofile(): string | undefined {
    const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wf) { return undefined; }

    const outDir = path.join(wf, '.r-quadrant');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const scriptPath = path.join(outDir, '.workspace_watcher.R');

    // Helper R code to snapshot the current workspace — used both at
    // startup and in the task callback. We use TSV to avoid base R JSON serialization issues.
    const snapshotCode = `
  tryCatch({
    dir.create(".r-quadrant", showWarnings = FALSE, recursive = TRUE)
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
    writeLines(.info, ".r-quadrant/.workspace_vars.tsv")
    writeLines(loadedNamespaces(), ".r-quadrant/.workspace_loaded.tsv")
    writeLines(search(), ".r-quadrant/.workspace_attached.tsv")
  }, error = function(e) NULL)`;



    const rCode = `
# R Quadrant workspace watcher — auto-loaded via R_PROFILE_USER

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

# 3. Pre-set fixed Data Viewer temp paths.
#    These are defined ONCE here at startup — silently, via Rprofile — so the
#    extension never needs to send a path-setting command to the R console.
.rquad_csv  <- ".r-quadrant/dv.csv"
.rquad_meta <- ".r-quadrant/dv-meta.txt"
.rquad_active_df_to_export <- NULL
.rquad_last_plot_hash <- NULL
.rquad_current_plot_id <- 0

# Set default device to null pdf to enable invisible plot recording
options(device = function(...) { pdf(file="/dev/null", ...); dev.control("enable") })

# Hook plot.new to increment plot ID, so lines() etc. overwrite the same file
setHook("before.plot.new", function() { .rquad_current_plot_id <<- .rquad_current_plot_id + 1 })

# 4. Wipe stale R Quadrant data at startup so previous sessions don't bleed over.
#    We hook into .First which runs immediately when the R session begins.
if (exists(".First", envir = .GlobalEnv)) {
  .rquad_orig_First <- get(".First", envir = .GlobalEnv)
  .First <- function() {
    unlink(".r-quadrant/.workspace_*.tsv")
    unlink(".r-quadrant/plots/*")
    tryCatch(.rquad_orig_First(), error = function(e) {})
  }
} else {
  .First <- function() {
    unlink(".r-quadrant/.workspace_*.tsv")
    unlink(".r-quadrant/plots/*")
  }
}

# 5. Data Viewer export function.
#    .rquad_csv and .rquad_meta are already set above — no paths needed at call time.
.r_quadrant_export_data <- function(varName) {
  .rquad_active_df_to_export <<- varName
  tryCatch({
    obj <- get(varName, envir = .GlobalEnv)
    if (!is.data.frame(obj)) obj <- as.data.frame(obj)
    writeLines(c(as.character(nrow(obj)), as.character(ncol(obj))), .rquad_meta)
    write.csv(head(obj, 1000), .rquad_csv, row.names = FALSE, na = "NA")
  }, error = function(e) {
    writeLines(paste0("ERROR:", conditionMessage(e)), .rquad_meta)
  })
  invisible(NULL)
}

# 6. Install the task callback. It fires after every top-level R command.
invisible(local({
  if (!any(vapply(getTaskCallbackNames(), function(n) n == ".r-quadrant.watcher", logical(1)))) {
    addTaskCallback(function(expr, value, ok, visible) {
      # 1. Update Data Viewer quietly if active
      if (!is.null(.rquad_active_df_to_export) && exists(.rquad_active_df_to_export, envir = .GlobalEnv)) {
        try({
          obj <- get(.rquad_active_df_to_export, envir = .GlobalEnv)
          if (!is.data.frame(obj)) obj <- as.data.frame(obj)
          writeLines(c(as.character(nrow(obj)), as.character(ncol(obj))), .rquad_meta)
          write.csv(head(obj, 1000), .rquad_csv, row.names = FALSE, na = "NA")
        }, silent = TRUE)
      }

      # 2. Capture plots quietly
      if (dev.cur() > 1) {
        .p <- recordPlot()
        if (!is.null(.p) && length(.p[[1]]) > 0) {
          .hash <- sum(as.numeric(serialize(.p, NULL)))
          if (!identical(.hash, .rquad_last_plot_hash)) {
            .rquad_last_plot_hash <<- .hash
            # If no plot ID yet (startup), start at 1
            if (.rquad_current_plot_id == 0) .rquad_current_plot_id <<- 1
            .file <- sprintf(".r-quadrant/plots/plot_%05d.png", .rquad_current_plot_id)
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
    }, name = ".r-quadrant.watcher")
  }
}))
`;
    fs.writeFileSync(scriptPath, rCode, 'utf8');
    return scriptPath.replace(/\\/g, '/');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
