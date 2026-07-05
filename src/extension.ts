import * as vscode from "vscode";
import {
    registerLayoutCommand,
    resetStaleLayout,
    fireImmediateLayoutReset,
    collapseLayoutForShutdown,
    getRConsoleTerminal,
} from "./layout/layoutManager";
import { initializeRPathResolver } from "./utils/rPathResolver";
import { PlotsPanel } from "./panels/plotsPanel";

export async function activate(context: vscode.ExtensionContext) {
    console.log("R Lab extension is now active.");

    // Immediate layout guard (fire-and-forget)
    fireImmediateLayoutReset(context);

    // Initialize R Path (and warn user immediately if missing)
    await initializeRPathResolver();

    // Re-resolve if R configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            const pathChanged =
                e.affectsConfiguration("r-lab.rConsolePath") ||
                e.affectsConfiguration("r");
            const typeChanged = e.affectsConfiguration("r-lab.rConsoleType");

            if (pathChanged) {
                initializeRPathResolver();
            }

            if ((pathChanged || typeChanged) && getRConsoleTerminal()) {
                const selection = await vscode.window.showInformationMessage(
                    "R Console settings have changed. Restart R Lab to apply immediately?",
                    "Restart Now",
                    "Apply Next Session"
                );
                if (selection === "Restart Now") {
                    await vscode.commands.executeCommand("r-lab.toggleLayout");
                    setTimeout(() => {
                        vscode.commands.executeCommand("r-lab.toggleLayout");
                    }, 500);
                }
            }
        })
    );

    // Register commands & status bar
    registerLayoutCommand(context);

    // Register Webview Serializers to support tearing off tabs into native OS floating windows
    vscode.window.registerWebviewPanelSerializer(PlotsPanel.viewType, {
        async deserializeWebviewPanel(
            webviewPanel: vscode.WebviewPanel,
            state: any
        ) {
            PlotsPanel.revive(webviewPanel, context.extensionUri);
        },
    });

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
