import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Plots Panel — a WebviewPanel (editor tab) that watches a directory
 * for new plot images and displays them with history navigation.
 *
 * Opens in ViewColumn.Three (bottom-right quadrant).
 */
export class PlotsPanel {
    public static currentPanel: PlotsPanel | undefined;
    public static readonly viewType = 'r-quadrant.plotsPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _plots: vscode.Uri[] = [];
    private _currentIndex = -1;
    private _watcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];

    // ── Factory ─────────────────────────────────────────────

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Three
    ): PlotsPanel {
        if (PlotsPanel.currentPanel) {
            PlotsPanel.currentPanel._panel.reveal(column, true);
            return PlotsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            PlotsPanel.viewType,
            'Plots',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: PlotsPanel._getResourceRoots(extensionUri),
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        PlotsPanel.currentPanel = new PlotsPanel(panel);
        return PlotsPanel.currentPanel;
    }

    private static _getResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
        const roots: vscode.Uri[] = [extensionUri];
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                roots.push(folder.uri);
            }
        }
        return roots;
    }

    // ── Constructor ─────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._render();
        this._startWatcher();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            (msg: { type: string }) => {
                switch (msg.type) {
                    case 'navigatePrev':
                        if (this._currentIndex > 0) {
                            this._currentIndex--;
                            this._render();
                        }
                        break;
                    case 'navigateNext':
                        if (this._currentIndex < this._plots.length - 1) {
                            this._currentIndex++;
                            this._render();
                        }
                        break;
                    case 'clear':
                        this.clear();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    // ── File System Watcher ─────────────────────────────────

    private _startWatcher(): void {
        const config = vscode.workspace.getConfiguration('r-quadrant');
        const plotDir = config.get<string>('plotOutputDir', '.r-quadrant/plots');

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const pattern = new vscode.RelativePattern(
            workspaceFolder.uri,
            `${plotDir}/*.{png,jpg,jpeg,svg,gif,bmp,webp}`
        );

        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this._watcher.onDidCreate((uri) => {
            this._plots.push(uri);
            this._currentIndex = this._plots.length - 1;
            this._render();
        });
        this._disposables.push(this._watcher);
    }

    // ── Public API ──────────────────────────────────────────

    public clear(): void {
        this._plots = [];
        this._currentIndex = -1;
        this._render();
    }

    public addPlot(uri: vscode.Uri): void {
        this._plots.push(uri);
        this._currentIndex = this._plots.length - 1;
        this._render();
    }

    /**
     * Scan the plot directory and merge any files that were created while the
     * layout was closed (i.e., not yet in `_plots`). Called on re-activation.
     */
    public syncPlots(): void {
        const config = vscode.workspace.getConfiguration('r-quadrant');
        const plotDir = config.get<string>('plotOutputDir', '.r-quadrant/plots');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        const dir = path.join(workspaceFolder.uri.fsPath, plotDir);
        if (!fs.existsSync(dir)) { return; }

        const exts = new Set(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.bmp', '.webp']);
        const existing = new Set(this._plots.map(u => u.fsPath));

        let added = 0;
        for (const file of fs.readdirSync(dir)) {
            if (!exts.has(path.extname(file).toLowerCase())) { continue; }
            const uri = vscode.Uri.file(path.join(dir, file));
            if (!existing.has(uri.fsPath)) {
                this._plots.push(uri);
                added++;
            }
        }

        if (added > 0) {
            this._currentIndex = this._plots.length - 1;
            this._render();
        }
    }

    // ── Rendering ───────────────────────────────────────────

    private _render(): void {
        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const nonce = getNonce();
        const hasPlots = this._plots.length > 0;
        const plotUri = hasPlots
            ? this._panel.webview.asWebviewUri(this._plots[this._currentIndex])
            : '';
        const counter = hasPlots
            ? `${this._currentIndex + 1} / ${this._plots.length}`
            : '—';
        const prevDisabled = this._currentIndex <= 0 ? 'disabled' : '';
        const nextDisabled =
            this._currentIndex >= this._plots.length - 1 ? 'disabled' : '';

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${this._panel.webview.cspSource} data:;
                   style-src 'nonce-${nonce}';
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 12px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }
        .pane-title {
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            opacity: 0.7;
        }
        .nav-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .counter {
            font-size: 12px;
            opacity: 0.7;
            min-width: 44px;
            text-align: center;
            font-variant-numeric: tabular-nums;
        }
        .toolbar button {
            background: none;
            color: var(--vscode-foreground);
            border: none;
            padding: 3px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
            opacity: 0.7;
        }
        .toolbar button:hover:not([disabled]) {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar button[disabled] {
            opacity: 0.25;
            cursor: default;
        }
        .plot-area {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto;
            padding: 12px;
        }
        .plot-area img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        }
        .empty-state {
            text-align: center;
            opacity: 0.5;
        }
        .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
        .empty-state p { font-size: 13px; line-height: 1.6; }
        .empty-state code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 3px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <span class="pane-title">Plots</span>
        <div class="nav-controls">
            <button id="btn-prev" ${prevDisabled} title="Previous plot">◀</button>
            <span class="counter">${counter}</span>
            <button id="btn-next" ${nextDisabled} title="Next plot">▶</button>
            <button id="btn-clear" ${!hasPlots ? 'disabled' : ''} title="Clear all plots">🗑</button>
        </div>
    </div>
    <div class="plot-area">
        ${
            hasPlots
                ? `<img src="${plotUri}" alt="Plot ${this._currentIndex + 1}" />`
                : `<div class="empty-state">
                       <div class="icon">📊</div>
                       <p>No plots yet.<br/>
                       Save images to <code>.r-quadrant/plots/</code><br/>
                       and they will appear here.</p>
                   </div>`
        }
    </div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.getElementById('btn-prev')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'navigatePrev' });
            });
            document.getElementById('btn-next')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'navigateNext' });
            });
            document.getElementById('btn-clear')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'clear' });
            });
        })();
    </script>
</body>
</html>`;
    }

    // ── Cleanup ─────────────────────────────────────────────

    dispose(): void {
        PlotsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

// ────────────────────────────────────────────────────────────
//  Utility
// ────────────────────────────────────────────────────────────

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
