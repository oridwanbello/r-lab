import * as vscode from 'vscode';

// ────────────────────────────────────────────────────────────
//  Plot Gallery — WebviewViewProvider
// ────────────────────────────────────────────────────────────

export class PlotGalleryProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'r-layout.plotGallery';

    private _view?: vscode.WebviewView;
    private _plots: vscode.Uri[] = [];
    private _currentIndex = -1;
    private _watcher?: vscode.FileSystemWatcher;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    // ── Lifecycle ───────────────────────────────────────────

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: this._getLocalResourceRoots(),
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((msg) =>
            this._onMessage(msg)
        );

        // Start watching for new plots
        this._startWatcher();

        webviewView.onDidDispose(() => {
            this._watcher?.dispose();
        });
    }

    // ── File System Watcher ─────────────────────────────────

    private _startWatcher(): void {
        const config = vscode.workspace.getConfiguration('r-layout');
        const plotDir = '.r-layout/plots';

        // Watch for new image files in the configured directory
        const pattern = new vscode.RelativePattern(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('.'),
            `${plotDir}/*.{png,jpg,jpeg,svg,gif,bmp,webp}`
        );

        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

        this._watcher.onDidCreate((uri) => {
            this._plots.push(uri);
            this._currentIndex = this._plots.length - 1;
            this._updateWebview();
        });
    }

    // ── Public API ──────────────────────────────────────────

    /** Clear the plot history. */
    clear(): void {
        this._plots = [];
        this._currentIndex = -1;
        this._updateWebview();
    }

    /** Programmatically add a plot (e.g., from an output channel). */
    addPlot(uri: vscode.Uri): void {
        this._plots.push(uri);
        this._currentIndex = this._plots.length - 1;
        this._updateWebview();
    }

    // ── Message Handling ────────────────────────────────────

    private _onMessage(msg: { type: string }): void {
        switch (msg.type) {
            case 'navigatePrev':
                if (this._currentIndex > 0) {
                    this._currentIndex--;
                    this._updateWebview();
                }
                break;
            case 'navigateNext':
                if (this._currentIndex < this._plots.length - 1) {
                    this._currentIndex++;
                    this._updateWebview();
                }
                break;
            case 'clear':
                this.clear();
                break;
        }
    }

    // ── Update the Webview Content ──────────────────────────

    private _updateWebview(): void {
        if (!this._view) {
            return;
        }
        this._view.webview.html = this._getHtml(this._view.webview);
    }

    // ── Local Resource Roots ────────────────────────────────

    private _getLocalResourceRoots(): vscode.Uri[] {
        const roots: vscode.Uri[] = [this._extensionUri];

        // Include all workspace folders so plot images can be loaded
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                roots.push(folder.uri);
            }
        }

        return roots;
    }

    // ── HTML Generation ─────────────────────────────────────

    private _getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const hasPlots = this._plots.length > 0;
        const plotUri = hasPlots
            ? webview.asWebviewUri(this._plots[this._currentIndex])
            : '';
        const counter = hasPlots
            ? `${this._currentIndex + 1} / ${this._plots.length}`
            : '0 / 0';
        const prevDisabled = this._currentIndex <= 0 ? 'disabled' : '';
        const nextDisabled =
            this._currentIndex >= this._plots.length - 1 ? 'disabled' : '';

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${webview.cspSource} data:;
                   style-src 'nonce-${nonce}';
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 6px 10px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
            flex-shrink: 0;
        }
        .toolbar button {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 13px;
        }
        .toolbar button:hover:not([disabled]) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar button[disabled] {
            opacity: 0.4;
            cursor: default;
        }
        .counter {
            font-size: 12px;
            opacity: 0.8;
            min-width: 50px;
            text-align: center;
        }
        .plot-area {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto;
            padding: 10px;
        }
        .plot-area img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 4px;
        }
        .empty-state {
            text-align: center;
            opacity: 0.6;
            padding: 20px;
        }
        .empty-state .icon {
            font-size: 36px;
            margin-bottom: 10px;
        }
        .empty-state p {
            font-size: 12px;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <button id="btn-prev" ${prevDisabled} title="Previous Plot">◀</button>
        <span class="counter">${counter}</span>
        <button id="btn-next" ${nextDisabled} title="Next Plot">▶</button>
        <button id="btn-clear" ${!hasPlots ? 'disabled' : ''} title="Clear All Plots">🗑</button>
    </div>
    <div class="plot-area">
        ${
            hasPlots
                ? `<img src="${plotUri}" alt="Plot ${this._currentIndex + 1}" />`
                : `<div class="empty-state">
                       <div class="icon">📊</div>
                       <p>No plots yet.<br/>
                       Save image files to <code>.r-layout/plots/</code><br/>
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
}

// ────────────────────────────────────────────────────────────
//  Registration helper
// ────────────────────────────────────────────────────────────

export function registerPlotGallery(
    context: vscode.ExtensionContext
): PlotGalleryProvider {
    const provider = new PlotGalleryProvider(context.extensionUri);

    const registration = vscode.window.registerWebviewViewProvider(
        PlotGalleryProvider.viewType,
        provider
    );

    const clearCmd = vscode.commands.registerCommand(
        'r-layout.plotGallery.clear',
        () => provider.clear()
    );

    context.subscriptions.push(registration, clearCmd);

    return provider;
}

// ────────────────────────────────────────────────────────────
//  Utility
// ────────────────────────────────────────────────────────────

function getNonce(): string {
    let text = '';
    const possible =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
