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
let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

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
            if (t === rConsoleTerminal) { rConsoleTerminal = undefined; }
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
    // 1. Save references to all currently open TEXT files
    //    so we can reopen them in group 1 after setting the layout.
    const openFiles: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                openFiles.push(tab.input.uri);
            }
        }
    }

    // 2. Close ALL editors — we need a perfectly clean slate for the
    //    4-group grid. ViewColumn assignment depends on the order
    //    groups receive content, so leftover tabs cause chaos.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // 3. Move any pre-existing terminals to the bottom panel so they
    //    don't interfere with group creation. We'll create fresh ones.
    for (const t of vscode.window.terminals) {
        t.dispose();
    }
    rConsoleTerminal = undefined;
    shellTerminal = undefined;

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

    // 8. Group 1 (top-left): Source Editor
    //    Open user's previously-open files, or leave Group 1 empty.
    //    We do NOT create an untitled file — the user should see
    //    a clean editor area that they populate themselves.
    if (openFiles.length > 0) {
        for (const uri of openFiles) {
            try {
                await vscode.window.showTextDocument(uri, {
                    viewColumn: vscode.ViewColumn.One,
                    preview: false,
                    preserveFocus: true,
                });
            } catch {
                // file may no longer exist, skip silently
            }
        }
    }
    await delay(100);

    // 9. Group 2 (bottom-left): R Console → Terminal → Problems
    //
    //    IMPORTANT: We always create our own R terminal directly
    //    instead of using the R extension's r.createRTerm command.
    //    r.createRTerm checks for an active text editor and shows
    //    "No text editor active" when there isn't one (which is the
    //    case during layout setup). It also causes interference
    //    between R Quadrant and the R extension.
    //
    //    FIX FOR EMPTY TERMINAL TABS: After setEditorLayout, VS Code's
    //    internal group registry needs time to settle before terminals
    //    can correctly bind to a ViewColumn. We must:
    //      a) Focus group 2 explicitly before creating each terminal
    //      b) Wait between each terminal creation
    //    Without this, terminals are created before VS Code knows what
    //    group "ViewColumn.Two" maps to, producing blank/empty tabs.
    const config = vscode.workspace.getConfiguration('r-quadrant');
    const useArk = config.get<boolean>('useArkInteractiveConsole', false);

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
            await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
            await delay(150);
            rConsoleTerminal = vscode.window.createTerminal({
                name: 'R Console',
                shellPath: resolveRPath(config),
                location: { viewColumn: vscode.ViewColumn.Two },
            });
            rConsoleTerminal.show(true);
        }
    } else {
        // Delete stale workspace data from previous session so the
        // panel shows empty/loading rather than outdated variables.
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wf) {
            const staleFile = path.join(wf, '.r-quadrant', '.workspace_data.json');
            try { fs.unlinkSync(staleFile); } catch {}
        }

        // Build the watcher Rprofile BEFORE creating the terminal.
        // Passing it as R_PROFILE_USER means R sources it silently
        // at startup — nothing appears in the console.
        const watcherPath = _buildWatcherRprofile();
        const rProfileEnv: Record<string, string> = {};
        if (watcherPath) {
            rProfileEnv['R_PROFILE_USER'] = watcherPath;
            const existing = process.env['R_PROFILE_USER'];
            if (existing) { rProfileEnv['R_PROFILE_USER_ORIG'] = existing; }
        }

        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await delay(150);
        rConsoleTerminal = vscode.window.createTerminal({
            name: 'R Console',
            shellPath: resolveRPath(config),
            location: { viewColumn: vscode.ViewColumn.Two },
            env: Object.keys(rProfileEnv).length > 0 ? rProfileEnv : undefined,
        });
        rConsoleTerminal.show(true);
    }

    // Shell terminal: refocus group 2 and wait again before creating.
    // Creating two terminals back-to-back without a pause causes the
    // second one to sometimes open as an empty/blank tab.
    await delay(200);
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
    await delay(100);
    shellTerminal = vscode.window.createTerminal({
        name: 'Terminal',
        location: { viewColumn: vscode.ViewColumn.Two },
    });
    shellTerminal.show(true);

    await delay(100);
    ProblemsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Two);
    await delay(100);

    // 10. Group 3 (top-right): AI Chat + Help
    await openChatInGroup3();
    HelpPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Three);
    await delay(100);

    // 11. Group 4 (bottom-right): Workspace + Plots + Data Viewer
    const workspacePanel = WorkspacePanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);
    PlotsPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);
    const dataPanel = DataViewerPanel.createOrShow(context.extensionUri, vscode.ViewColumn.Four);

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

    // 13. Register layout guards that redirect stray content
    registerLayoutGuards(context);

    // 14. Persist & update UI
    isLayoutActive = true;
    await context.workspaceState.update(STATE_KEY, true);
    updateStatusBar();

    activationInProgress = false;
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

    // 3. Save user's text files from group 1 before closing
    const sourceFiles: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) {
                sourceFiles.push(tab.input.uri);
            }
        }
    }

    // 4. Dispose panel singletons (closes our Webview tabs)
    PlotsPanel.currentPanel?.dispose();
    HelpPanel.currentPanel?.dispose();
    ProblemsPanel.currentPanel?.dispose();
    WorkspacePanel.currentPanel?.dispose();
    DataViewerPanel.currentPanel?.dispose();

    // 5. Move ALL terminals back to the bottom panel.
    //    We iterate because moveToTerminalPanel only moves the active one.
    const terminalCount = vscode.window.terminals.length;
    if (terminalCount > 0) {
        for (let i = 0; i < terminalCount; i++) {
            try {
                // Focus the next terminal in the editor, then move it
                await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
            } catch {}
        }
    }
    rConsoleTerminal = undefined;
    shellTerminal = undefined;

    // 6. Close any remaining non-text editor tabs (stray webviews, etc.)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // 7. Reset to single editor group
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{}],
    });

    // 8. Restore the sidebar
    try {
        await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
    } catch {}

    // 9. Try to return AI Chat to sidebar
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
//  AI Chat — discover installed AI extensions and open in Group 3
// ────────────────────────────────────────────────────────────

async function openChatInGroup3(): Promise<void> {
    const allCommands = await vscode.commands.getCommands(true);

    // ── Step 1: Log AI extension discovery for debugging ──
    const aiReport = discoverAllAi(allCommands);
    for (const r of aiReport) {
        console.log(`[R Quadrant] AI: ${r.displayName} (${r.id}), views: ${r.viewIds.join(', ')}`);
    }

    // ── Step 2: Open VS Code Chat in editor area (Copilot / Chat API) ──
    await focusGroup3();
    try {
        await vscode.commands.executeCommand('workbench.action.chat.openInEditor');
    } catch {
        // No chat provider available — that's fine
    }

    // ── Step 3: For non-Copilot AI extensions, try vscode.moveViews ──
    //    This is the only reliable method that doesn't trigger
    //    "No text editor active" warnings.
    const nonCopilotAi = aiReport.filter(
        (r) => !r.id.toLowerCase().includes('copilot')
    );

    if (nonCopilotAi.length === 0) { return; }

    let movedAny = false;

    for (const ai of nonCopilotAi) {
        for (const viewId of ai.viewIds) {
            try {
                await focusGroup3();
                await vscode.commands.executeCommand('vscode.moveViews', {
                    viewIds: [viewId],
                    destinationId: 'workbench.editor',
                });
                console.log(`[R Quadrant] ✓ Moved view "${viewId}" to editor`);
                movedAny = true;
                break;
            } catch (e) {
                console.log(`[R Quadrant] ✗ Couldn't move "${viewId}": ${e}`);
            }
        }
        if (movedAny) { break; }
    }

    // ── Step 4: If nothing worked, give guidance ──
    if (!movedAny && nonCopilotAi.length > 0) {
        const names = nonCopilotAi.map((r) => r.displayName).join(', ');
        vscode.window.showInformationMessage(
            `R Quadrant detected: ${names}. To add to the top-right quadrant: ` +
            `open the sidebar → right-click the AI chat tab → ` +
            `"Move View to Editor Area" → drag to the top-right group.`,
            'Open Sidebar'
        ).then((choice) => {
            if (choice === 'Open Sidebar') {
                vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
            }
        });
    }
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
        await vscode.commands.executeCommand(
            'workbench.action.focusThirdEditorGroup'
        );
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
    // startup and in the task callback.
    const snapshotCode = `
  tryCatch({
    dir.create(".r-quadrant", showWarnings = FALSE, recursive = TRUE)
    .vars <- ls(envir = .GlobalEnv)
    .info <- if (length(.vars) == 0) list() else lapply(.vars, function(nm) {
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
      list(name = nm, type = cls, size = dims, preview = prev, isDataFrame = is.data.frame(obj))
    })
    if (requireNamespace("jsonlite", quietly = TRUE)) {
      .json <- jsonlite::toJSON(
        list(variables = .info, loadedNamespaces = loadedNamespaces(), attachedNamespaces = search()),
        auto_unbox = TRUE
      )
      writeLines(as.character(.json), ".r-quadrant/.workspace_data.json")
    }
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

# 3. Install the task callback. It fires after every top-level R command,
#    including R's own startup sequence (.First, default package loading).
#    The stale data file is deleted at VS Code extension activation, so
#    the workspace panel shows empty until the first callback fires.
invisible(local({
  if (!any(vapply(getTaskCallbackNames(), function(n) n == ".r-quadrant.watcher", logical(1)))) {
    addTaskCallback(function(expr, value, ok, visible) {${snapshotCode}
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
