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
    private _isNightMode: boolean = false;

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
                    case 'saveAs':
                        this._handleSaveAs();
                        break;
                    case 'deleteCurrent':
                        this._handleDeleteCurrent();
                        break;
                    case 'toggleNightMode':
                        this._isNightMode = !this._isNightMode;
                        this._render();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private _handleDeleteCurrent(): void {
        if (this._currentIndex < 0 || this._currentIndex >= this._plots.length) { return; }
        const uri = this._plots[this._currentIndex];
        try {
            if (fs.existsSync(uri.fsPath)) {
                fs.unlinkSync(uri.fsPath);
            }
            // The watcher will pick up the deletion and update the UI
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to delete plot: ${err.message}`);
        }
    }

    private async _handleSaveAs(): Promise<void> {
        if (this._currentIndex < 0) { return; }
        const sourceUri = this._plots[this._currentIndex];

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.basename(sourceUri.fsPath)),
            filters: { 'Images': ['png'] }
        });

        if (saveUri) {
            try {
                fs.copyFileSync(sourceUri.fsPath, saveUri.fsPath);
                vscode.window.showInformationMessage(`Plot saved to ${saveUri.fsPath}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to save plot: ${err.message}`);
            }
        }
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
        this._watcher.onDidChange(() => {
            // Re-render current plot to pick up the updated file content
            this._render();
        });
        this._watcher.onDidDelete((uri) => {
            const idx = this._plots.findIndex(p => p.fsPath === uri.fsPath);
            if (idx !== -1) {
                this._plots.splice(idx, 1);
                if (this._currentIndex >= this._plots.length) {
                    this._currentIndex = this._plots.length - 1;
                }
                this._render();
            }
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
        // Add cache-busting timestamp for the currently viewed image
        const plotUrl = hasPlots ? `${plotUri.toString()}?t=${Date.now()}` : '';
        const counter = hasPlots
            ? `${this._currentIndex + 1} / ${this._plots.length}`
            : '—';
        const prevDisabled = this._currentIndex <= 0 ? 'disabled' : '';
        const nextDisabled =
            this._currentIndex >= this._plots.length - 1 ? 'disabled' : '';

        const moonIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/></svg>';
        const sunIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 0zm0 13a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 13zm8-5a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2a.5.5 0 01.5.5zM3 8a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2A.5.5 0 013 8zm10.657-5.657a.5.5 0 010 .707l-1.414 1.415a.5.5 0 11-.707-.708l1.414-1.414a.5.5 0 01.707 0zm-9.193 9.193a.5.5 0 010 .707L3.05 13.657a.5.5 0 01-.707-.707l1.414-1.414a.5.5 0 01.707 0zm9.193 2.121a.5.5 0 01-.707 0l-1.414-1.414a.5.5 0 01.707-.707l1.414 1.414a.5.5 0 010 .707zM4.464 2.343a.5.5 0 01-.707 0L2.343 3.757a.5.5 0 11.707.707l1.414-1.414a.5.5 0 010-.707z"/></svg>';
        const plotBg = this._isNightMode ? '#C8C8C8' : 'white';

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
        ::selection { background: var(--vscode-editor-selectionBackground); color: var(--vscode-editor-selectionForeground); }
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
            justify-content: flex-end; /* Right align tools */
            padding: 0 12px;
            height: 32px; /* Fixed height to prevent shrinking */
            background: var(--vscode-editor-background); /* Matches active tab */
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
        .toolbar button svg { width: 14px; height: 14px; display: block; }
        .toolbar button[disabled] {
            opacity: 0.3;
            cursor: default;
            pointer-events: auto; /* Allow hover for tooltips */
        }
        .toolbar button[disabled]:hover {
            background: none;
        }

        /* Custom Instant Tooltip */
        .tooltip {
            position: fixed;
            background: var(--vscode-editorHoverWidget-background, #252526);
            color: var(--vscode-editorHoverWidget-foreground, #cccccc);
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            z-index: 1000;
            pointer-events: none;
            display: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            white-space: nowrap;
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
            background: ${plotBg};
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            transition: background-color 0.2s ease;
        }
        .empty-state {
            text-align: center;
            opacity: 0.3;
        }
        .empty-state svg { width: 64px; height: 64px; margin-bottom: 16px; display: inline-block; }
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
        <div class="nav-controls">
            <button id="btn-prev" ${prevDisabled} data-tooltip="Previous plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M11.354 1.646L12.061 2.354 6.414 8l5.647 5.646-.707.708L5 8l6.354-6.354z"/></svg></button>
            <span class="counter">${counter}</span>
            <button id="btn-next" ${nextDisabled} data-tooltip="Next plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.646 1.646L3.939 2.354 9.586 8l-5.647 5.646.707.708L11 8 4.646 1.646z"/></svg></button>
            <button id="btn-copy" ${!hasPlots ? 'disabled' : ''} data-tooltip="Copy"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M10,13.33H3.33V4.67c0-0.37-0.3-0.67-0.67-0.67h0C2.3,4,2,4.3,2,4.67v8.67c0,0.73,0.6,1.33,1.33,1.33h6.67c0.37,0,0.67-0.3,0.67-0.67v0C10.67,13.63,10.37,13.33,10,13.33z M13.33,10.67V2.67c0-0.73-0.6-1.33-1.33-1.33H6c-0.73,0-1.33,0.6-1.33,1.33v8c0,0.73,0.6,1.33,1.33,1.33h6c0.73,0,1.33-0.6,1.33-1.33z M12,10.67H6V2.67h6V10.67z"/></svg></button>
            <button id="btn-save" ${!hasPlots ? 'disabled' : ''} data-tooltip="Save as..."><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12,10v2H4v-2H2.67v2c0,0.73,0.6,1.33,1.33,1.33h8c0.73,0,1.33-0.6,1.33-1.33v-2H12z M11.33,7.33l-0.94-0.94L8.67,8.11V2.67h-1.33v5.45L5.61,6.39L4.67,7.33l3.33,3.33 L11.33,7.33z"/></svg></button>
            <button id="btn-night-mode" ${!hasPlots ? 'disabled' : ''} data-tooltip="${this._isNightMode ? 'Switch to Day Mode' : 'Switch to Night Mode'}">${this._isNightMode ? sunIcon : moonIcon}</button>
            <button id="btn-delete" ${!hasPlots ? 'disabled' : ''} data-tooltip="Delete current plot"><svg viewBox="0 0 16 16"><path fill="none" d="M9.25,2H6.75a0.25,0.25,0,0,0-0.25,0.25V3h3V2.25A0.25,0.25,0,0,0,9.25,2Z"/><path fill="currentColor" d="M13.5,3H10.5V2.25A1.25,1.25,0,0,0,9.25,1H6.75A1.25,1.25,0,0,0,5.5,2.25V3H2.5a0.5,0.5,0,0,0,0,1H3L3.63,13.53C3.67,14.37,4.31,15,5.13,15h5.75c0.82,0,1.45-.62,1.5-1.47L13,4h0.5a0.5,0.5,0,0,0,0-1ZM6,13H6a0.5,0.5,0,0,1-.5-.48l-0.25-7a0.5,0.5,0,1,1,1-.04l0.25,7A0.5,0.5,0,0,1,6,13ZM8.5,12.5a0.5,0.5,0,0,1-1,0V5.5a0.5,0.5,0,0,1,1,0ZM9.5,3H6.5V2.25a0.25,0.25,0,0,1,.25-.25h2.5a0.25,0.25,0,0,1,.25.25Zm1,9.55a0.5,0.5,0,0,1-.5.45H10a0.5,0.5,0,0,1-.5-.52l0.25-7a0.5,0.5,0,1,1,1,.04Z"/></svg></button>
            <button id="btn-clear" ${!hasPlots ? 'disabled' : ''} data-tooltip="Clear all plots"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.91,1.81L13.85,2.76L10.04,6.57C10.75,7.59 10.85,8.83 10.25,9.63L6.04,5.41C6.84,4.81 8.07,4.91 9.1,5.63L12.91,1.81M3.95,11.71C2.61,10.37 1.79,8.77 1.57,7.28L4.82,5.89L9.78,10.85L8.39,14.1C6.89,13.87 5.29,13.05 3.95,11.71Z"/></svg></button>
        </div>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="plot-area">
        ${
            hasPlots
                ? `<img src="${plotUrl}" alt="Plot ${this._currentIndex + 1}" />`
                : `<div class="empty-state">
                       <svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h1v11h11v1H2V2zm3 8h2v3H5v-3zm3-4h2v7H8V6zm3-3h2v10h-2V3z"/></svg>
                       <p>No plots yet.<br/>
                       Any plot generated in the R Console using the default<br/>
                       graphics device will automatically appear here.</p>
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
            document.getElementById('btn-delete')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'deleteCurrent' });
            });
            document.getElementById('btn-save')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'saveAs' });
            });
            document.getElementById('btn-night-mode')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'toggleNightMode' });
            });
            document.getElementById('btn-copy')?.addEventListener('click', async () => {
                const img = document.querySelector('.plot-area img');
                if (!img) return;
                try {
                    const response = await fetch(img.src);
                    const blob = await response.blob();
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    // Visual feedback
                    const btn = document.getElementById('btn-copy');
                    const oldHtml = btn.innerHTML;
                    btn.innerHTML = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 12.2L2.1 7.8l.7-.7 3.7 3.7 7.4-7.4.7.7-8.1 8.1z"/></svg>';
                    setTimeout(() => btn.innerHTML = oldHtml, 1000);
                } catch (err) {
                    console.error('Clipboard failed', err);
                }
            });
            // Instant Tooltip Controller
            const tooltip = document.getElementById('tooltip');
            document.querySelectorAll('[data-tooltip]').forEach(el => {
                el.addEventListener('mouseenter', (e) => {
                    const text = el.getAttribute('data-tooltip');
                    if (!text) return;
                    tooltip.textContent = text;
                    tooltip.style.display = 'block';
                    const rect = el.getBoundingClientRect();
                    tooltip.style.top = (rect.bottom + 5) + 'px';

                    // Boundary detection
                    const padding = 10;
                    let left = rect.left + (rect.width/2) - (tooltip.offsetWidth/2);
                    if (left < padding) left = padding;
                    if (left + tooltip.offsetWidth > window.innerWidth - padding) {
                        left = window.innerWidth - tooltip.offsetWidth - padding;
                    }
                    tooltip.style.left = left + 'px';
                });
                el.addEventListener('mouseleave', () => {
                    tooltip.style.display = 'none';
                });
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
