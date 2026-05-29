import * as vscode from 'vscode';
import { registerLayoutCommand, resetStaleLayout, fireImmediateLayoutReset, collapseLayoutForShutdown } from './layout/layoutManager';
import { initializeRPathResolver } from './utils/rPathResolver';

export async function activate(context: vscode.ExtensionContext) {
    console.log('R Layout extension is now active.');

    // Immediate layout guard (fire-and-forget)
    fireImmediateLayoutReset(context);

    // Initialize R Path (and warn user immediately if missing)
    await initializeRPathResolver();

    // Re-resolve if R configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('r-layout.rConsolePath') || e.affectsConfiguration('r')) {
                initializeRPathResolver();
            }
        })
    );

    // Register commands & status bar
    registerLayoutCommand(context);

    // Full async stale layout cleanup
    resetStaleLayout(context);
}

/**
 * VS Code AWAITS this Promise before saving final workbench state
 * and completing a window reload. By collapsing the layout here,
 * VS Code writes a single-group layout to its session store -
 * so on the next startup, there is no multi-group layout to restore
 * and the layout flash never happens.
 */
export async function deactivate(): Promise<void> {
    await collapseLayoutForShutdown();
}
