import * as vscode from 'vscode';
import { registerLayoutCommand, resetStaleLayout, fireImmediateLayoutReset, collapseLayoutForShutdown } from './layout/layoutManager';

export function activate(context: vscode.ExtensionContext) {
    console.log('R Quadrant extension is now active.');

    // ── Immediate layout guard (fire-and-forget) ────────────
    //    This is the VERY FIRST thing we do — before any awaits.
    //    We fire setEditorLayout synchronously into VS Code's
    //    command queue so it races (and beats) session-restore
    //    rendering of any stale 4-pane grid from a previous session.
    //    resetStaleLayout() does the full async cleanup afterwards.
    fireImmediateLayoutReset(context);

    // ── Register commands & status bar ──────────────────────
    registerLayoutCommand(context);

    // ── Full async stale layout cleanup ─────────────────────
    //    Closes stale webview tabs, reopens user's text files, etc.
    resetStaleLayout(context);
}

/**
 * VS Code AWAITS this Promise before saving final workbench state
 * and completing a window reload. By collapsing the layout here,
 * VS Code writes a single-group layout to its session store —
 * so on the next startup, there is no multi-group layout to restore
 * and the quadrant flash never happens.
 */
export async function deactivate(): Promise<void> {
    await collapseLayoutForShutdown();
}
