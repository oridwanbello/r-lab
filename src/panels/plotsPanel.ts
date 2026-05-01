import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getRConsoleTerminal } from '../layout/layoutManager';

/**
 * Plots Panel - a WebviewPanel (editor tab) that watches a directory
 * for new plot images and displays them with history navigation.
 *
 * Opens in ViewColumn.Three (bottom-right layout).
 */
export class PlotsPanel {
    public static currentPanel: PlotsPanel | undefined;
    public static readonly viewType = 'r-layout.plotsPanel';

    private static _sessionCustomPlotDir: string | undefined;
    private static _sessionLastDirAction: 'view' | 'outview' | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private _plots: vscode.Uri[] = [];
    private _currentIndex = -1;
    private _watcher?: vscode.FileSystemWatcher;
    private _disposables: vscode.Disposable[] = [];
    private _isNightMode: boolean = false;
    private _isMinimized: boolean = false;
    private _customPlotDir?: string;
    private _lastDirAction: 'view' | 'outview' | undefined = undefined;
    private _extensionUri: vscode.Uri;

    // Factory

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

        PlotsPanel.currentPanel = new PlotsPanel(panel, extensionUri);
        return PlotsPanel.currentPanel;
    }

    public static resetSessionState(): void {
        PlotsPanel._sessionCustomPlotDir = undefined;
        PlotsPanel._sessionLastDirAction = undefined;
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

    public reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
        this._panel.reveal(column, preserveFocus);
    }

    /** Hide or show all webview content (toolbar, plots, controls).
     *  Used when the top-right pane is maximized so only the
     *  VS Code tab bar remains visible for the bottom-right group.
     */
    public setMinimized(minimized: boolean): void {
        this._isMinimized = minimized;
        this._render();
    }

    // Constructor

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Restore persisted state from static session memory
        this._customPlotDir = PlotsPanel._sessionCustomPlotDir;
        this._lastDirAction = PlotsPanel._sessionLastDirAction;

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
                    case 'navigateTo':
                        this._currentIndex = (msg as any).index;
                        this._render();
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
                    case 'setCustomDir':
                        this._handleSetCustomDir((msg as any).path, false);
                        break;
                    case 'setOutViewDir':
                        this._handleSetCustomDir((msg as any).path, true);
                        break;
                    case 'browseCustomDir':
                        this._handleBrowseCustomDir();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private _handleSetCustomDir(dirPath: string | undefined, setOutput: boolean): void {
        const resolved = dirPath && dirPath.trim() ? dirPath.trim() : undefined;
        this._customPlotDir = resolved;

        // Update localResourceRoots to allow loading images from the new directory
        const roots = PlotsPanel._getResourceRoots(this._extensionUri);
        if (this._customPlotDir) {
            const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const normalizedPath = path.isAbsolute(this._customPlotDir) || !base
                ? path.normalize(this._customPlotDir)
                : path.join(base, this._customPlotDir);
            const customUri = vscode.Uri.file(normalizedPath);
            roots.push(customUri);
        }
        this._panel.webview.options = {
            ...this._panel.webview.options,
            localResourceRoots: roots
        };

        // If setOutput is true, redirect R's plot output to this directory via options().
        // If clearing (resolved is undefined), reset back to the default .r-layout/plots.
        if (setOutput) {
            const term = getRConsoleTerminal();
            if (term) {
                if (resolved) {
                    const escaped = resolved.replace(/\\/g, '/');
                    term.sendText(`options(.rlayout_plot_dir = "${escaped}")`, true);
                } else {
                    term.sendText('options(.rlayout_plot_dir = NULL)', true);
                }
            }
        }

        // Track which action was last used so we can show persistent active state in the UI.
        this._lastDirAction = resolved ? (setOutput ? 'outview' : 'view') : undefined;

        // Persist to session memory
        PlotsPanel._sessionCustomPlotDir = this._customPlotDir;
        PlotsPanel._sessionLastDirAction = this._lastDirAction;

        this.clear(); // Clear existing plots
        this._startWatcher(); // Restart watcher on new dir
        this.syncPlots(); // Load existing plots from new dir
    }

    private async _handleBrowseCustomDir(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const defaultUri = workspaceFolder ? workspaceFolder.uri : undefined;

        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Plot Directory',
            defaultUri: defaultUri
        });

        if (uris && uris.length > 0) {
            // Browse only sets the view dir - user must click Set Out/View Dir to redirect output
            this._handleSetCustomDir(uris[0].fsPath, false);
        }
    }

    private _handleDeleteCurrent(): void {
        if (this._currentIndex < 0 || this._currentIndex >= this._plots.length) { return; }
        const uri = this._plots[this._currentIndex];

        // Only allow physical deletion for files inside the .r-layout directory.
        // User-specified directories must not be modified - we only display them.
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const rLayoutDir = wf ? path.join(wf, '.r-layout') : undefined;
        if (!rLayoutDir || !uri.fsPath.startsWith(rLayoutDir)) {
            vscode.window.showWarningMessage(
                'Deletion is only permitted for plots in the .r-layout directory. ' +
                'To remove plots from a custom folder, delete them manually.'
            );
            return;
        }

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

    // File System Watcher

    private _startWatcher(): void {
        // Dispose existing watcher if any
        if (this._watcher) {
            this._watcher.dispose();
            const idx = this._disposables.indexOf(this._watcher);
            if (idx > -1) {
                this._disposables.splice(idx, 1);
            }
            this._watcher = undefined;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        let watchDirFsPath: string;
        if (this._customPlotDir) {
            watchDirFsPath = path.isAbsolute(this._customPlotDir)
                ? this._customPlotDir
                : path.join(workspaceFolder.uri.fsPath, this._customPlotDir);
        } else {
            const config = vscode.workspace.getConfiguration('r-layout');
            const plotDir = '.r-layout/plots';
            watchDirFsPath = path.join(workspaceFolder.uri.fsPath, plotDir);
        }

        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(watchDirFsPath),
            '*.{png,jpg,jpeg,svg,gif,bmp,webp,ico}'
        );

        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this._watcher.onDidCreate((uri) => {
            this._plots.push(uri);
            this._currentIndex = this._plots.length - 1;
            this._render();
            // Automatically bring Plots panel to front without stealing focus
            this._panel.reveal(undefined, true);
        });
        this._watcher.onDidChange(() => {
            // Re-render current plot to pick up the updated file content
            this._render();
            // Automatically bring Plots panel to front without stealing focus
            this._panel.reveal(undefined, true);
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

    // Public API

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
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return; }

        let dir: string;
        if (this._customPlotDir) {
            dir = path.isAbsolute(this._customPlotDir)
                ? this._customPlotDir
                : path.join(workspaceFolder.uri.fsPath, this._customPlotDir);
        } else {
            const config = vscode.workspace.getConfiguration('r-layout');
            const plotDir = '.r-layout/plots';
            dir = path.join(workspaceFolder.uri.fsPath, plotDir);
        }

        if (!fs.existsSync(dir)) { return; }

        const exts = new Set(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.bmp', '.webp', '.ico']);
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

    // Rendering

    private _render(): void {
        if (!this._panel.webview.html) {
            this._panel.webview.html = this._getHtml();
        } else {
            this._postState();
        }
    }

    private _postState(): void {
        const plots = this._plots.map(uri => this._panel.webview.asWebviewUri(uri).toString() + `?t=${Date.now()}`);
        this._panel.webview.postMessage({
            type: 'updateState',
            state: {
                plots: plots,
                currentIndex: this._currentIndex,
                isNightMode: this._isNightMode,
                customPlotDir: this._customPlotDir,
                lastDirAction: this._lastDirAction
            }
        });
    }

    private _getHtml(): string {
        const nonce = getNonce();

        const moonIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/></svg>';
        const sunIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 0zm0 13a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 13zm8-5a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2a.5.5 0 01.5.5zM3 8a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2A.5.5 0 013 8zm10.657-5.657a.5.5 0 010 .707l-1.414 1.415a.5.5 0 11-.707-.708l1.414-1.414a.5.5 0 01.707 0zm-9.193 9.193a.5.5 0 010 .707L3.05 13.657a.5.5 0 01-.707-.707l1.414-1.414a.5.5 0 01.707 0zm9.193 2.121a.5.5 0 01-.707 0l-1.414-1.414a.5.5 0 01.707-.707l1.414 1.414a.5.5 0 010 .707zM4.464 2.343a.5.5 0 01-.707 0L2.343 3.757a.5.5 0 11.707.707l1.414-1.414a.5.5 0 010-.707z"/></svg>';

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
        body.minimized > * { display: none !important; }
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
            font-weight: normal;
            z-index: 1000;
            pointer-events: none;
            display: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            white-space: nowrap;
        }

        .main-container {
            display: flex;
            flex-direction: row;
            flex: 1;
            overflow: hidden;
        }

        .thumbnail-sidebar {
            width: 120px;
            background: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-editorGroup-border);
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 12px;
            overflow-y: auto;
            flex-shrink: 0;
        }
        .thumbnail-sidebar::-webkit-scrollbar {
            width: 6px;
        }
        .thumbnail-sidebar::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 3px;
        }
        .thumbnail {
            width: 100%;
            height: auto;
            object-fit: contain;
            border: 2px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
            background: white;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            opacity: 0.6;
            filter: grayscale(20%);
        }
        .thumbnail.active {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 8px var(--vscode-focusBorder);
            opacity: 1;
            filter: grayscale(0%);
            transform: scale(1.04);
        }
        .thumbnail:hover:not(.active) {
            border-color: var(--vscode-button-secondaryHoverBackground);
            opacity: 0.9;
            filter: grayscale(0%);
        }

        .plot-area {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: auto;
            padding: 8px;
        }
        .plot-area img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            background: white;
            padding: 16px;
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

        /* Dropdown styles */
        .dir-dropdown {
            position: absolute;
            top: 32px;
            right: 12px;
            background: var(--vscode-editorHoverWidget-background, #252526);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            border-radius: 6px;
            padding: 10px;
            display: none;
            z-index: 1000;
            flex-direction: column;
            gap: 8px;
            width: 300px;
        }
        .dir-dropdown.open {
            display: flex;
        }
        .dir-dropdown .input-row {
            display: flex;
            gap: 4px;
        }
        .dir-dropdown input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 12px;
            outline: none;
        }
        .dir-dropdown input::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 1;
        }
        .dir-dropdown input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .dir-dropdown .btn-browse {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            opacity: 1;
        }
        .dir-dropdown .btn-browse:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .dir-dropdown .btn-browse svg {
            width: 14px;
            height: 14px;
            display: block;
            margin: auto;
        }
        .dir-dropdown .action-row {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
        }
        .dir-dropdown .action-row button {
            background: color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
            color: var(--vscode-button-background);
            border: 1px solid var(--vscode-button-background);
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11.5px;
            opacity: 1;
            white-space: nowrap;
        }
        .dir-dropdown .action-row button:hover,
        .dir-dropdown .action-row button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-custom-dir.active {
            color: var(--vscode-textLink-foreground) !important;
            opacity: 1 !important;
        }
    </style>
</head>
<body${this._isMinimized ? ' class="minimized"' : ''}>
    <div class="toolbar">
        <div class="nav-controls">
            <button id="btn-prev" disabled data-tooltip="Previous Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M11.354 1.646L12.061 2.354 6.414 8l5.647 5.646-.707.708L5 8l6.354-6.354z"/></svg></button>
            <span class="counter">-</span>
            <button id="btn-next" disabled data-tooltip="Next Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.646 1.646L3.939 2.354 9.586 8l-5.647 5.646.707.708L11 8 4.646 1.646z"/></svg></button>
            <button id="btn-copy" disabled data-tooltip="Copy Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M10,13.33H3.33V4.67c0-0.37-0.3-0.67-0.67-0.67h0C2.3,4,2,4.3,2,4.67v8.67c0,0.73,0.6,1.33,1.33,1.33h6.67c0.37,0,0.67-0.3,0.67-0.67v0C10.67,13.63,10.37,13.33,10,13.33z M13.33,10.67V2.67c0-0.73-0.6-1.33-1.33-1.33H6c-0.73,0-1.33,0.6-1.33,1.33v8c0,0.73,0.6,1.33,1.33,1.33h6c0.73,0,1.33-0.6,1.33-1.33z M12,10.67H6V2.67h6V10.67z"/></svg></button>
            <button id="btn-save" disabled data-tooltip="Save Plot As..."><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12,10v2H4v-2H2.67v2c0,0.73,0.6,1.33,1.33,1.33h8c0.73,0,1.33-0.6,1.33-1.33v-2H12z M11.33,7.33l-0.94-0.94L8.67,8.11V2.67h-1.33v5.45L5.61,6.39L4.67,7.33l3.33,3.33 L11.33,7.33z"/></svg></button>
            <button id="btn-night-mode" disabled data-tooltip="Switch to Night Mode">${moonIcon}</button>
            <button id="btn-delete" disabled data-tooltip="Delete Current Plot"><svg viewBox="0 0 16 16"><path fill="none" d="M9.25,2H6.75a0.25,0.25,0,0,0-0.25,0.25V3h3V2.25A0.25,0.25,0,0,0,9.25,2Z"/><path fill="currentColor" d="M13.5,3H10.5V2.25A1.25,1.25,0,0,0,9.25,1H6.75A1.25,1.25,0,0,0,5.5,2.25V3H2.5a0.5,0.5,0,0,0,0,1H3L3.63,13.53C3.67,14.37,4.31,15,5.13,15h5.75c0.82,0,1.45-.62,1.5-1.47L13,4h0.5a0.5,0.5,0,0,0,0-1ZM6,13H6a0.5,0.5,0,0,1-.5-.48l-0.25-7a0.5,0.5,0,1,1,1-.04l0.25,7A0.5,0.5,0,0,1,6,13ZM8.5,12.5a0.5,0.5,0,0,1-1,0V5.5a0.5,0.5,0,0,1,1,0ZM9.5,3H6.5V2.25a0.25,0.25,0,0,1,.25-.25h2.5a0.25,0.25,0,0,1,.25.25Zm1,9.55a0.5,0.5,0,0,1-.5.45H10a0.5,0.5,0,0,1-.5-.52l0.25-7a0.5,0.5,0,1,1,1,.04Z"/></svg></button>
            <button id="btn-clear" disabled data-tooltip="Clear All Plots"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.91,1.81L13.85,2.76L10.04,6.57C10.75,7.59 10.85,8.83 10.25,9.63L6.04,5.41C6.84,4.81 8.07,4.91 9.1,5.63L12.91,1.81M3.95,11.71C2.61,10.37 1.79,8.77 1.57,7.28L4.82,5.89L9.78,10.85L8.39,14.1C6.89,13.87 5.29,13.05 3.95,11.71Z"/></svg></button>
            <button id="btn-custom-dir" class="btn-custom-dir" data-tooltip="Set Custom Plot Directory"><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m7.52 2c-0.00591-2.1e-4 -0.0118-3.1e-4 -0.0178-3.1e-4l-1.2-1.6c-0.0932-0.124-0.214-0.225-0.353-0.294-0.139-0.0694-0.292-0.106-0.447-0.106h-3.5c-0.53 0-1.04 0.211-1.41 0.586-0.375 0.375-0.586 0.884-0.586 1.41v10c0 0.53 0.211 1.04 0.586 1.41 0.375 0.375 0.884 0.586 1.41 0.586h4v-1h-4c-0.265 0-0.52-0.105-0.707-0.293-0.188-0.188-0.293-0.442-0.293-0.707v-7l3.88 3e-5c0.203 1.9e-4 0.383 3.5e-4 0.557-0.0415 0.153-0.0368 0.299-0.0974 0.434-0.18 0.153-0.0936 0.279-0.221 0.423-0.365l1.41-1.41h6.29c0.265 0 0.52 0.105 0.707 0.293s0.293 0.442 0.293 0.707v2h1v-2c0-0.53-0.211-1.04-0.586-1.41s-0.884-0.586-1.41-0.586h-6.48zm-2.02-1 1.2 1.6-1.08 1.08c-0.19 0.19-0.229 0.225-0.268 0.248-0.0447 0.0274-0.0935 0.0476-0.145 0.0599-0.0442 0.0106-0.0969 0.0138-0.365 0.0138h-3.84v-2c0-0.265 0.105-0.52 0.293-0.707 0.188-0.188 0.442-0.293 0.707-0.293h3.5z" clip-rule="evenodd" fill="currentColor" fill-rule="evenodd"/><path d="m11.5 7c0.276 0 0.5 0.224 0.5 0.5v3.5h3.5c0.276 0 0.5 0.224 0.5 0.5s-0.224 0.5-0.5 0.5h-3.5v3.5c0 0.276-0.224 0.5-0.5 0.5s-0.5-0.224-0.5-0.5v-3.5h-3.5c-0.276 0-0.5-0.224-0.5-0.5s0.224-0.5 0.5-0.5h3.5v-3.5c0-0.276 0.224-0.5 0.5-0.5z" fill="currentColor"/></svg></button>
        </div>
    </div>
    <div id="dir-dropdown" class="dir-dropdown">
        <div class="input-row">
            <input type="text" id="dir-input" placeholder="Custom plot directory (absolute or relative)..." value="" />
            <button id="btn-browse" class="btn-browse" data-tooltip="Browse for Folder"><svg fill="none" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m14 3h-6.5l-1.2-1.6c-0.0932-0.124-0.214-0.225-0.353-0.294-0.139-0.0694-0.292-0.106-0.447-0.106h-3.5c-0.53 0-1.04 0.211-1.41 0.586-0.375 0.375-0.586 0.884-0.586 1.41v10c0 0.53 0.211 1.04 0.586 1.41 0.375 0.375 0.884 0.586 1.41 0.586h12c0.53 0 1.04-0.211 1.41-0.586s0.586-0.884 0.586-1.41v-8c0-0.53-0.211-1.04-0.586-1.41-0.375-0.375-0.884-0.586-1.41-0.586zm-7.3 0.6c0.0932 0.124 0.214 0.225 0.353 0.294 0.139 0.0694 0.292 0.106 0.447 0.106h6.5c0.265 0 0.52 0.105 0.707 0.293 0.188 0.188 0.293 0.442 0.293 0.707v8c0 0.265-0.105 0.52-0.293 0.707s-0.442 0.293-0.707 0.293h-12c-0.265 0-0.52-0.105-0.707-0.293-0.188-0.188-0.293-0.442-0.293-0.707v-10c0-0.265 0.105-0.52 0.293-0.707 0.188-0.188 0.442-0.293 0.707-0.293h3.5l1.2 1.6z" fill="currentColor"/></svg></button>
        </div>
        <div class="action-row">
            <button id="btn-clear-dir" class="btn-clear">Clear</button>
            <button id="btn-set-view-dir" class="">Set View Dir</button>
            <button id="btn-set-out-view-dir" class="">Set View/Out Dir</button>
        </div>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="main-container">
        <div class="plot-area">
            <img id="main-image" src="" alt="Plot" style="display: none;" />
            <div id="empty-state" class="empty-state">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h1v11h11v1H2V2zm3 8h2v3H5v-3zm3-4h2v7H8V6zm3-3h2v10h-2V3z"/></svg>
                <p>No plots yet.<br/>
                Plots generated in the R Console or found in your<br/>
                custom directory will automatically appear here.</p>
            </div>
        </div>
        <div class="thumbnail-sidebar" id="thumbnail-sidebar"></div>
    </div>
    <script nonce="${nonce}">
        const moonIcon = \`${moonIcon}\`;
        const sunIcon = \`${sunIcon}\`;
        
        const initialState = {
            plots: ${JSON.stringify(this._plots.map(uri => this._panel.webview.asWebviewUri(uri).toString() + `?t=${Date.now()}`))},
            currentIndex: ${this._currentIndex},
            isNightMode: ${this._isNightMode},
            customPlotDir: ${JSON.stringify(this._customPlotDir || '')},
            lastDirAction: ${JSON.stringify(this._lastDirAction || null)}
        };

        let currentPlots = [];

        function renderState(state) {
            const hasPlots = state.plots.length > 0;
            const mainImg = document.getElementById('main-image');
            const emptyState = document.getElementById('empty-state');
            const plotBg = state.isNightMode ? '#C8C8C8' : 'white';

            if (hasPlots) {
                mainImg.src = state.plots[state.currentIndex];
                mainImg.style.background = plotBg;
                mainImg.style.display = 'block';
                emptyState.style.display = 'none';
            } else {
                mainImg.style.display = 'none';
                emptyState.style.display = 'block';
            }

            const sidebar = document.getElementById('thumbnail-sidebar');
            if (state.plots.length !== currentPlots.length) {
                const scrollTop = sidebar.scrollTop;
                sidebar.innerHTML = state.plots.map((url, i) => 
                    \`<img src="\${url}" class="thumbnail \${i === state.currentIndex ? 'active' : ''}" data-index="\${i}" loading="lazy" style="background: \${plotBg}" />\`
                ).join('');
                sidebar.scrollTop = scrollTop;
                currentPlots = state.plots;
            } else {
                const thumbs = sidebar.querySelectorAll('.thumbnail');
                thumbs.forEach((t, i) => {
                    t.style.background = plotBg;
                    if (i === state.currentIndex) t.classList.add('active');
                    else t.classList.remove('active');
                });
            }

            const activeThumb = sidebar.querySelector('.thumbnail.active');
            if (activeThumb) {
                const sidebarRect = sidebar.getBoundingClientRect();
                const thumbRect = activeThumb.getBoundingClientRect();
                if (thumbRect.top < sidebarRect.top || thumbRect.bottom > sidebarRect.bottom) {
                    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }

            document.querySelector('.counter').textContent = hasPlots ? \`\${state.currentIndex + 1} / \${state.plots.length}\` : '-';
            
            const btnPrev = document.getElementById('btn-prev');
            const btnNext = document.getElementById('btn-next');
            if (state.currentIndex <= 0) btnPrev.setAttribute('disabled', 'true');
            else btnPrev.removeAttribute('disabled');
            if (state.currentIndex >= state.plots.length - 1 || !hasPlots) btnNext.setAttribute('disabled', 'true');
            else btnNext.removeAttribute('disabled');

            const toggleDisabled = (id, condition) => {
                const btn = document.getElementById(id);
                if (condition) btn.setAttribute('disabled', 'true');
                else btn.removeAttribute('disabled');
            };

            toggleDisabled('btn-copy', !hasPlots);
            toggleDisabled('btn-save', !hasPlots);
            toggleDisabled('btn-night-mode', !hasPlots);
            toggleDisabled('btn-delete', !hasPlots);
            toggleDisabled('btn-clear', !hasPlots);

            const nightModeBtn = document.getElementById('btn-night-mode');
            nightModeBtn.innerHTML = state.isNightMode ? sunIcon : moonIcon;
            nightModeBtn.setAttribute('data-tooltip', state.isNightMode ? 'Switch to Day Mode' : 'Switch to Night Mode');

            const btnCustomDir = document.getElementById('btn-custom-dir');
            if (state.customPlotDir) btnCustomDir.classList.add('active');
            else btnCustomDir.classList.remove('active');

            const dirInput = document.getElementById('dir-input');
            dirInput.value = state.customPlotDir || '';

            document.getElementById('btn-set-view-dir').className = state.lastDirAction === 'view' ? 'active' : '';
            document.getElementById('btn-set-out-view-dir').className = state.lastDirAction === 'outview' ? 'active' : '';
        }

        (function() {
            const vscode = acquireVsCodeApi();

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.type === 'updateState') {
                    renderState(message.state);
                }
            });

            renderState(initialState);

            document.getElementById('thumbnail-sidebar')?.addEventListener('click', (e) => {
                if (e.target && e.target.classList.contains('thumbnail')) {
                    const index = parseInt(e.target.getAttribute('data-index'), 10);
                    vscode.postMessage({ type: 'navigateTo', index: index });
                }
            });

            document.getElementById('btn-prev')?.addEventListener('click', () => {
                if (!document.getElementById('btn-prev').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'navigatePrev' });
                }
            });
            document.getElementById('btn-next')?.addEventListener('click', () => {
                if (!document.getElementById('btn-next').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'navigateNext' });
                }
            });
            document.getElementById('btn-clear')?.addEventListener('click', () => {
                if (!document.getElementById('btn-clear').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'clear' });
                }
            });
            document.getElementById('btn-delete')?.addEventListener('click', () => {
                if (!document.getElementById('btn-delete').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'deleteCurrent' });
                }
            });
            document.getElementById('btn-save')?.addEventListener('click', () => {
                if (!document.getElementById('btn-save').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'saveAs' });
                }
            });
            document.getElementById('btn-night-mode')?.addEventListener('click', () => {
                if (!document.getElementById('btn-night-mode').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'toggleNightMode' });
                }
            });
            document.getElementById('btn-copy')?.addEventListener('click', async () => {
                if (document.getElementById('btn-copy').hasAttribute('disabled')) return;
                const img = document.querySelector('.plot-area img');
                if (!img || img.style.display === 'none') return;
                try {
                    const response = await fetch(img.src);
                    const blob = await response.blob();
                    await navigator.clipboard.write([
                        new ClipboardItem({ 'image/png': blob })
                    ]);
                    const btn = document.getElementById('btn-copy');
                    const oldHtml = btn.innerHTML;
                    btn.innerHTML = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 12.2L2.1 7.8l.7-.7 3.7 3.7 7.4-7.4.7.7-8.1 8.1z"/></svg>';
                    setTimeout(() => btn.innerHTML = oldHtml, 1000);
                } catch (err) {
                    console.error('Clipboard failed', err);
                }
            });

            // Custom Directory Dropdown Logic
            const btnCustomDir = document.getElementById('btn-custom-dir');
            const dropdown = document.getElementById('dir-dropdown');
            const btnSetViewDir = document.getElementById('btn-set-view-dir');
            const btnSetOutViewDir = document.getElementById('btn-set-out-view-dir');
            const btnClearDir = document.getElementById('btn-clear-dir');
            const btnBrowse = document.getElementById('btn-browse');
            const dirInput = document.getElementById('dir-input');

            btnCustomDir?.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown.classList.toggle('open');
                if (dropdown.classList.contains('open')) {
                    dirInput.focus();
                }
            });

            dropdown?.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent clicks inside from closing it
            });

            document.addEventListener('click', () => {
                dropdown.classList.remove('open');
            });

            btnSetViewDir?.addEventListener('click', () => {
                dropdown.classList.remove('open');
                vscode.postMessage({ type: 'setCustomDir', path: dirInput.value });
            });

            btnSetOutViewDir?.addEventListener('click', () => {
                dropdown.classList.remove('open');
                vscode.postMessage({ type: 'setOutViewDir', path: dirInput.value });
            });

            dirInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    dropdown.classList.remove('open');
                    vscode.postMessage({ type: 'setCustomDir', path: dirInput.value });
                }
            });

            btnClearDir?.addEventListener('click', () => {
                dropdown.classList.remove('open');
                dirInput.value = '';
                vscode.postMessage({ type: 'setOutViewDir', path: '' });
            });

            btnBrowse?.addEventListener('click', () => {
                dropdown.classList.remove('open');
                vscode.postMessage({ type: 'browseCustomDir' });
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

    // Cleanup

    dispose(): void {
        PlotsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

//  Utility

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
