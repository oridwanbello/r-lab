import * as vscode from 'vscode';
import { getNonce } from '../utils/webviewUtils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
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
        // Also allow loading from home directory fallback for no-workspace mode
        roots.push(vscode.Uri.file(os.homedir()));
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
                        this._handleSaveAs((msg as any).format, (msg as any).width, (msg as any).height, (msg as any).unit);
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
                    case 'openViewer':
                        vscode.commands.executeCommand('r-layout.focusViewer');
                        break;
                    case 'copyImage':
                        this._handleCopyImage();
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
            const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
            const normalizedPath = path.isAbsolute(this._customPlotDir)
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
        // If clearing (resolved is undefined), reset back to the default .r_layout/plots.
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
        const defaultUri = workspaceFolder ? workspaceFolder.uri : vscode.Uri.file(os.homedir());

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

        if (uri.fsPath.includes('_interactive.svg')) {
            vscode.window.showWarningMessage('Interactive widget placeholders can only be deleted from the Viewer tab.');
            return;
        }

        // Only allow physical deletion for files inside the .r_layout directory.
        // User-specified directories must not be modified - we only display them.
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const rLayoutDir = path.join(wf, '.r_layout');
        const relative = path.relative(rLayoutDir, uri.fsPath);
        const isInside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
        if (!isInside) {
            vscode.window.showWarningMessage(
                'Deletion is only permitted for plots in the .r_layout directory. ' +
                'To remove plots from a custom folder, delete them manually.'
            );
            return;
        }

        try {
            if (fs.existsSync(uri.fsPath)) {
                fs.unlinkSync(uri.fsPath);
                const rdsPath = uri.fsPath.replace(/\.(png|jpg|jpeg|svg|gif|bmp|webp|ico)$/i, '.rds');
                if (fs.existsSync(rdsPath)) {
                    fs.unlinkSync(rdsPath);
                }
            }
            // The watcher will pick up the deletion and update the UI
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to delete plot: ${err.message}`);
        }
    }

    private async _handleSaveAs(format: string, widthStr: string, heightStr: string, unit: string): Promise<void> {
        if (this._currentIndex < 0) { return; }
        const sourceUri = this._plots[this._currentIndex];

        const filterName = format.toUpperCase();
        const ext = format;
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.basename(sourceUri.fsPath).replace('.png', `.${ext}`)),
            filters: { [filterName]: [ext] }
        });

        if (saveUri) {
            try {
                // Plot ID is the basename without extension, e.g., 'plot_00002'
                const plotId = path.basename(sourceUri.fsPath, '.png');
                const plotDir = path.dirname(sourceUri.fsPath);
                const reqPath = path.join(plotDir, '..', '.plot_req');
                const reqContent = [
                    plotId,
                    format,
                    widthStr,
                    heightStr,
                    unit,
                    saveUri.fsPath
                ].join('\n');

                fs.writeFileSync(reqPath, reqContent, 'utf8');
                vscode.window.showInformationMessage(`Exporting plot to ${saveUri.fsPath}...`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to export plot: ${err.message}`);
            }
        }
    }

    private async _handleCopyImage(): Promise<void> {
        if (this._plots.length === 0 || this._currentIndex < 0 || this._currentIndex >= this._plots.length) return;
        const currentPlotPath = this._plots[this._currentIndex].fsPath;
        
        try {
            const platform = os.platform();
            if (platform === 'darwin') {
                // macOS: copy as TIFF because JPEG/PNG sometimes loses transparency depending on the clipboard consumer
                child_process.execSync(`osascript -e 'set the clipboard to (read (POSIX file "${currentPlotPath}") as TIFF picture)'`);
            } else if (platform === 'win32') {
                // Windows: use PowerShell
                child_process.execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${currentPlotPath}'))"`);
            } else {
                // Linux: requires xclip
                child_process.execSync(`xclip -selection clipboard -t image/png -i "${currentPlotPath}"`);
            }
            vscode.window.showInformationMessage('Plot copied to clipboard');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to copy plot to clipboard: ${e.message || e}`);
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

        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

        let watchDirFsPath: string;
        if (this._customPlotDir) {
            watchDirFsPath = path.isAbsolute(this._customPlotDir)
                ? this._customPlotDir
                : path.join(effectiveRoot, this._customPlotDir);
        } else {
            const config = vscode.workspace.getConfiguration('r-layout');
            const plotDir = '.r_layout/plots';
            watchDirFsPath = path.join(effectiveRoot, plotDir);
        }

        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(watchDirFsPath),
            '*.{png,jpg,jpeg,svg,gif,bmp,webp,ico}'
        );

        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this._watcher.onDidCreate(async (uri) => {
            // Guard against duplicates
            if (this._plots.some(p => p.fsPath === uri.fsPath)) { return; }

            // Windows race condition prevention (Rule #15): 
            // Wait for R to finish flushing the image file to disk before exposing it to the UI.
            for (let i = 0; i < 10; i++) {
                try {
                    const stats = fs.statSync(uri.fsPath);
                    if (stats.size > 0) break;
                } catch (e) {
                    // ignore ENOENT if OS hasn't materialized it yet
                }
                await new Promise(r => setTimeout(r, 100));
            }

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
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const rLayoutDir = path.join(wf, '.r_layout');

        // Physically delete files only if they are inside the .r_layout directory
        for (const uri of this._plots) {
            if (uri.fsPath.includes('_interactive.svg')) continue; // Skip widget placeholders
            
            const relative = path.relative(rLayoutDir, uri.fsPath);
            const isInside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
            if (isInside) {
                try {
                    if (fs.existsSync(uri.fsPath)) {
                        fs.unlinkSync(uri.fsPath);
                        // Delete the corresponding .rds file if it exists
                        const rdsPath = uri.fsPath.replace(/\.(png|jpg|jpeg|svg|gif|bmp|webp|ico)$/i, '.rds');
                        if (fs.existsSync(rdsPath)) {
                            fs.unlinkSync(rdsPath);
                        }
                    }
                } catch (e) {}
            }
        }

        // Retain widget placeholders, clear everything else
        this._plots = this._plots.filter(p => p.fsPath.includes('_interactive.svg'));
        this._currentIndex = this._plots.length > 0 ? this._plots.length - 1 : -1;
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
        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

        let dir: string;
        if (this._customPlotDir) {
            dir = path.isAbsolute(this._customPlotDir)
                ? this._customPlotDir
                : path.join(effectiveRoot, this._customPlotDir);
        } else {
            const config = vscode.workspace.getConfiguration('r-layout');
            const plotDir = '.r_layout/plots';
            dir = path.join(effectiveRoot, plotDir);
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

        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const homedir = os.homedir();
        let defaultDir = effectiveRoot;
        if (defaultDir.startsWith(homedir)) {
            defaultDir = defaultDir.replace(homedir, '~');
        }

        this._panel.webview.postMessage({
            type: 'updateState',
            state: {
                plots: plots,
                currentIndex: this._currentIndex,
                isNightMode: this._isNightMode,
                minimized: this._isMinimized,
                customPlotDir: this._customPlotDir,
                defaultDir: defaultDir,
                lastDirAction: this._lastDirAction
            }
        });
    }

    private _getHtml(): string {
        const nonce = getNonce();

        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const homedir = os.homedir();
        let defaultDir = effectiveRoot;
        if (defaultDir.startsWith(homedir)) {
            defaultDir = defaultDir.replace(homedir, '~');
        }

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
            font-size: var(--vscode-font-size, 13px);
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
            font-size: 0.9em;
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
            border-radius: 6px;
            cursor: pointer;
            font-size: var(--vscode-font-size, 13px);
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
            padding: 4px 8px;
            border-radius: 6px;
            font-size: calc(1em - 1px);
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
            border-radius: 6px;
        }
        .thumbnail {
            width: 100%;
            height: auto;
            object-fit: contain;
            border: 2px solid transparent;
            border-radius: 6px;
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
            overflow: hidden; /* Changed from auto to hide overflow during zoom */
            padding: 8px;
            cursor: grab;
            user-select: none;
        }
        .plot-area:active {
            cursor: grabbing;
        }
        .plot-area img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            background: white;
            border-radius: 6px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            transition: background-color 0.2s ease;
            pointer-events: none; /* Let drag events fall through to the area */
        }
        .empty-state {
            text-align: center;
            opacity: 0.3;
        }
        .empty-state svg { width: 5em; height: 5em; margin-bottom: 16px; display: inline-block; }
        .empty-state p { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
        .empty-state code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 6px;
            font-size: 0.9em;
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
            border-radius: 6px;
            font-size: 0.9em;
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
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
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
            justify-content: flex-start;
            gap: 6px;
        }
        .dir-dropdown .action-row button {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
            border: none;
            padding: 4px 8px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.85em;
            opacity: 0.9;
            white-space: nowrap;
        }
        .dir-dropdown .action-row button:hover,
        .dir-dropdown .action-row button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            opacity: 1;
        }
        .btn-custom-dir.active {
            color: var(--vscode-textLink-foreground) !important;
            opacity: 1 !important;
        }
        .export-dropdown {
            position: absolute;
            top: 32px;
            right: 48px;
            background: var(--vscode-editorHoverWidget-background, #252526);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            border-radius: 6px;
            padding: 12px;
            display: none;
            z-index: 1000;
            flex-direction: column;
            gap: 10px;
            width: 220px;
        }
        .export-dropdown.open {
            display: flex;
        }
        .export-dropdown label {
            font-size: 0.9em;
            opacity: 0.9;
            display: block;
            margin-bottom: 4px;
        }
        .export-dropdown select, .export-dropdown input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 0.9em;
            outline: none;
            width: 100%;
            box-sizing: border-box;
        }
        .export-dropdown input {
            padding-left: 10px;
        }
        .export-dropdown select {
            padding-right: 32px;
        }
        .export-dropdown select:focus, .export-dropdown input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .export-dropdown .row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .export-dropdown .row > div {
            flex: 1;
        }
        .export-dropdown .btn-export {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px;
            border-radius: 4px;
            cursor: pointer;
            margin-top: 4px;
            text-align: center;
            font-size: 0.9em;
        }
        .export-dropdown .btn-export:hover {
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body${this._isMinimized ? ' class="minimized"' : ''}>
    <div class="toolbar">
        <div class="nav-controls">
            <button id="btn-prev" disabled data-tooltip="Previous Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M11.354 1.646L12.061 2.354 6.414 8l5.647 5.646-.707.708L5 8l6.354-6.354z"/></svg></button>
            <span class="counter">-</span>
            <button id="btn-next" disabled data-tooltip="Next Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.646 1.646L3.939 2.354 9.586 8l-5.647 5.646.707.708L11 8 4.646 1.646z"/></svg></button>
            <button id="btn-zoom-in" disabled data-tooltip="Zoom In">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <circle cx="7" cy="7" r="6" />
                    <line x1="11.2" y1="11.2" x2="14.8" y2="14.8" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="4" y1="7" x2="10" y2="7" />
                    <line x1="7" y1="4" x2="7" y2="10" />
                </svg>
            </button>
            <button id="btn-zoom-out" disabled data-tooltip="Zoom Out">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <circle cx="7" cy="7" r="6" />
                    <line x1="11.2" y1="11.2" x2="14.8" y2="14.8" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="4" y1="7" x2="10" y2="7" />
                </svg>
            </button>
            <button id="btn-reset-zoom" disabled data-tooltip="Reset Zoom">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <path d="M5 2H2v3 M11 2h3v3 M2 11v3h3 M14 11v3h-3" />
                    <circle cx="8" cy="8" r="2.5" />
                    <circle cx="8" cy="8" r="0.5" fill="currentColor" stroke="none" />
                </svg>
            </button>
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
    <div id="export-dropdown" class="export-dropdown">
        <div class="row">
            <div>
                <label>Format</label>
                <select id="export-format">
                    <option value="pdf">PDF</option>
                    <option value="svg">SVG</option>
                    <option value="eps">EPS</option>
                    <option value="png">PNG</option>
                    <option value="jpg">JPG</option>
                </select>
            </div>
            <div>
                <label>Units</label>
                <select id="export-unit">
                    <option value="in">in</option>
                    <option value="px">px</option>
                </select>
            </div>
        </div>
        <div class="row">
            <div>
                <label>Width</label>
                <input type="text" id="export-width" value="8" />
            </div>
            <div>
                <label>Height</label>
                <input type="text" id="export-height" value="6" />
            </div>
        </div>
        <button id="btn-export-confirm" class="btn-export">Export Plot</button>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="main-container">
        <div class="plot-area" style="position: relative;">
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
            minimized: ${this._isMinimized},
            customPlotDir: ${JSON.stringify(this._customPlotDir || '')},
            defaultDir: ${JSON.stringify(defaultDir)},
            lastDirAction: ${JSON.stringify(this._lastDirAction || null)}
        };

        let currentPlots = [];
        let currentImageSrc = '';

        // Pan and Zoom State
        let scale = 1;
        let translateX = 0;
        let translateY = 0;

        function updateTransform() {
            const img = document.getElementById('main-image');
            if (img) {
                img.style.transform = \`translate(\${translateX}px, \${translateY}px) scale(\${scale})\`;
            }
        }

        function resetZoom() {
            scale = 1;
            translateX = 0;
            translateY = 0;
            updateTransform();
        }

        function renderState(state) {
            document.body.classList.toggle('minimized', !!state.minimized);
            const hasPlots = state.plots.length > 0;
            const mainImg = document.getElementById('main-image');
            const emptyState = document.getElementById('empty-state');
            const plotBg = state.isNightMode ? '#C8C8C8' : 'white';

            function getInteractiveSvgUri(isNightMode) {
                const linkColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-textLink-foreground').trim() || '#007acc';
                
                // Minimalist dot grid colors
                const bgColor = '#151515';
                const dotColor = '#2d2d2d';

                const svgStr = '<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">' +
                    '<defs>' +
                        '<pattern id="dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">' +
                            '<circle cx="2" cy="2" r="1.5" fill="' + dotColor + '"/>' +
                        '</pattern>' +
                    '</defs>' +
                    '<rect width="800" height="600" fill="' + bgColor + '"/>' +
                    '<rect width="800" height="600" fill="url(#dot-grid)"/>' +
                    '<g fill="' + linkColor + '" transform="translate(352, 170) scale(6)">' +
                        '<path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/>' +
                        '<path d="M15 1.5V6h-1V2.707L7.854 8.854l-.708-.708L13.293 2H10V1h4.5l.5.5z"/>' +
                    '</g>' +
                    '<text x="400" y="340" fill="' + linkColor + '" font-family="sans-serif" font-size="36" text-anchor="middle">Open</text>' +
                    '<text x="400" y="390" fill="' + linkColor + '" font-family="sans-serif" font-size="36" text-anchor="middle">Interactive Widget(s)</text>' +
                '</svg>';
                return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
            }

            if (hasPlots) {
                const originalSrc = state.plots[state.currentIndex];
                const isInteractive = originalSrc.includes('_interactive.svg');
                const newSrc = isInteractive ? getInteractiveSvgUri(state.isNightMode) : originalSrc;
                
                let srcChanged = currentImageSrc !== originalSrc;
                let themeChanged = window.__lastNightMode !== state.isNightMode;
                window.__lastNightMode = state.isNightMode;

                if (srcChanged || (isInteractive && themeChanged)) {
                    currentImageSrc = originalSrc;
                    mainImg.src = newSrc;
                    if (srcChanged) resetZoom();
                    
                    if (isInteractive) {
                        mainImg.setAttribute('data-tooltip', 'Open in Viewer Tab');
                        mainImg.style.cursor = 'pointer';
                        mainImg.style.pointerEvents = 'auto'; // allow click to go through
                    } else {
                        mainImg.removeAttribute('data-tooltip');
                        mainImg.style.cursor = '';
                        mainImg.style.pointerEvents = 'none'; // allow drag through
                    }
                }
                mainImg.style.background = plotBg;
                mainImg.style.display = 'block';
                emptyState.style.display = 'none';
            } else {
                currentImageSrc = '';
                mainImg.style.display = 'none';
                emptyState.style.display = 'block';
                resetZoom();
            }

            const sidebar = document.getElementById('thumbnail-sidebar');
            let themeChangedThumb = window.__lastNightModeThumb !== state.isNightMode;
            window.__lastNightModeThumb = state.isNightMode;

            // Sync DOM nodes natively instead of destroying innerHTML to prevent flickering
            while (sidebar.children.length > state.plots.length) {
                sidebar.removeChild(sidebar.lastChild);
            }
            while (sidebar.children.length < state.plots.length) {
                const img = document.createElement('img');
                img.className = 'thumbnail';
                img.onerror = function() {
                    if (!this.dataset.retried) {
                        this.dataset.retried = 'true';
                        setTimeout(() => this.src = this.dataset.originalSrc, 200);
                    }
                };
                sidebar.appendChild(img);
            }
            currentPlots = state.plots;

            // Update attributes safely
            const thumbs = sidebar.querySelectorAll('.thumbnail');
            thumbs.forEach((t, i) => {
                const url = state.plots[i];
                const thumbUrl = url.includes('_interactive.svg') ? getInteractiveSvgUri(state.isNightMode) : url;
                
                if (t.getAttribute('src') !== thumbUrl || (themeChangedThumb && url.includes('_interactive.svg'))) {
                    t.dataset.originalSrc = thumbUrl;
                    t.setAttribute('src', thumbUrl);
                    delete t.dataset.retried;
                }
                
                t.dataset.index = i;
                t.style.background = plotBg;
                
                if (i === state.currentIndex) t.classList.add('active');
                else t.classList.remove('active');
            });

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

            const isWidget = hasPlots && state.plots[state.currentIndex] && state.plots[state.currentIndex].includes('_interactive.svg');

            toggleDisabled('btn-zoom-in', !hasPlots);
            toggleDisabled('btn-zoom-out', !hasPlots);
            toggleDisabled('btn-reset-zoom', !hasPlots);
            toggleDisabled('btn-copy', !hasPlots);
            toggleDisabled('btn-save', !hasPlots);
            toggleDisabled('btn-night-mode', !hasPlots);
            toggleDisabled('btn-delete', !hasPlots || isWidget);
            toggleDisabled('btn-clear', !hasPlots);

            const nightModeBtn = document.getElementById('btn-night-mode');
            nightModeBtn.innerHTML = state.isNightMode ? sunIcon : moonIcon;
            nightModeBtn.setAttribute('data-tooltip', state.isNightMode ? 'Switch to Day Mode' : 'Switch to Night Mode');

            const btnCustomDir = document.getElementById('btn-custom-dir');
            if (state.customPlotDir) btnCustomDir.classList.add('active');
            else btnCustomDir.classList.remove('active');

            const dirInput = document.getElementById('dir-input');
            dirInput.value = state.customPlotDir || '';
            dirInput.placeholder = state.defaultDir || 'Custom plot directory...';

            document.getElementById('btn-set-view-dir').className = state.lastDirAction === 'view' ? 'active' : '';
            document.getElementById('btn-set-out-view-dir').className = (state.lastDirAction === 'outview' || !state.lastDirAction) ? 'active' : '';
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
            const btnSave = document.getElementById('btn-save');
            const exportDropdown = document.getElementById('export-dropdown');
            const formatSelect = document.getElementById('export-format');
            const unitSelect = document.getElementById('export-unit');
            const widthInput = document.getElementById('export-width');
            const heightInput = document.getElementById('export-height');

            btnSave?.addEventListener('click', (e) => {
                if (!btnSave.hasAttribute('disabled')) {
                    e.stopPropagation();
                    exportDropdown.classList.toggle('open');
                    document.getElementById('dir-dropdown').classList.remove('open');
                }
            });

            let currentUnit = unitSelect.value;

            formatSelect.addEventListener('change', () => {
                const isRaster = formatSelect.value === 'png' || formatSelect.value === 'jpg';
                if (isRaster) {
                    unitSelect.value = 'px';
                    widthInput.value = '1600';
                    heightInput.value = '1200';
                } else {
                    unitSelect.value = 'in';
                    widthInput.value = '8';
                    heightInput.value = '6';
                }
                currentUnit = unitSelect.value;
            });

            unitSelect.addEventListener('change', () => {
                const w = parseFloat(widthInput.value) || 0;
                const h = parseFloat(heightInput.value) || 0;
                if (currentUnit === 'in' && unitSelect.value === 'px') {
                    widthInput.value = Math.round(w * 300).toString();
                    heightInput.value = Math.round(h * 300).toString();

                    const isRaster = formatSelect.value === 'png' || formatSelect.value === 'jpg';
                    if (!isRaster) {
                        formatSelect.value = 'png';
                    }
                } else if (currentUnit === 'px' && unitSelect.value === 'in') {
                    widthInput.value = Number((w / 300).toFixed(2)).toString();
                    heightInput.value = Number((h / 300).toFixed(2)).toString();

                    const isRaster = formatSelect.value === 'png' || formatSelect.value === 'jpg';
                    if (isRaster) {
                        formatSelect.value = 'pdf';
                    }
                }
                currentUnit = unitSelect.value;
            });

            document.getElementById('main-image')?.addEventListener('click', (e) => {
                if (currentImageSrc && currentImageSrc.includes('_interactive.svg')) {
                    vscode.postMessage({ type: 'openViewer' });
                }
            });

            document.getElementById('btn-export-confirm')?.addEventListener('click', () => {
                exportDropdown.classList.remove('open');
                vscode.postMessage({
                    type: 'saveAs',
                    format: formatSelect.value,
                    unit: unitSelect.value,
                    width: widthInput.value,
                    height: heightInput.value
                });
            });

            // Close dropdowns on outside click
            document.addEventListener('click', (e) => {
                if (!exportDropdown.contains(e.target) && e.target !== btnSave && !btnSave.contains(e.target)) {
                    exportDropdown.classList.remove('open');
                }
            });
            document.getElementById('btn-night-mode')?.addEventListener('click', () => {
                if (!document.getElementById('btn-night-mode').hasAttribute('disabled')) {
                    vscode.postMessage({ type: 'toggleNightMode' });
                }
            });
            document.getElementById('btn-copy')?.addEventListener('click', () => {
                if (document.getElementById('btn-copy').hasAttribute('disabled')) return;
                vscode.postMessage({ type: 'copyImage' });
                
                const btn = document.getElementById('btn-copy');
                const oldHtml = btn.innerHTML;
                btn.innerHTML = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 12.2L2.1 7.8l.7-.7 3.7 3.7 7.4-7.4.7.7-8.1 8.1z"/></svg>';
                setTimeout(() => btn.innerHTML = oldHtml, 1000);
            });

            // Zoom and Pan Logic
            const plotArea = document.querySelector('.plot-area');

            function applyZoom(zoomFactor, mouseX, mouseY) {
                const img = document.getElementById('main-image');
                if (!img || img.style.display === 'none') return;

                let newScale = scale * zoomFactor;
                if (newScale < 0.1) newScale = 0.1;
                if (newScale > 50) newScale = 50;

                const actualZoomFactor = newScale / scale;
                const rect = img.getBoundingClientRect();
                const plotRect = plotArea.getBoundingClientRect();

                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                const viewportCenterX = plotRect.left + plotRect.width / 2;
                const viewportCenterY = plotRect.top + plotRect.height / 2;

                const cx = mouseX !== undefined ? mouseX : viewportCenterX;
                const cy = mouseY !== undefined ? mouseY : viewportCenterY;

                // Adjust translate so the point under the cursor stays in place
                translateX += (cx - centerX) * (1 - actualZoomFactor);
                translateY += (cy - centerY) * (1 - actualZoomFactor);

                scale = newScale;
                updateTransform();
            }

            plotArea.addEventListener('wheel', (e) => {
                const img = document.getElementById('main-image');
                if (!img || img.style.display === 'none') return;
                e.preventDefault();

                const zoomIntensity = 0.002;
                const zoomFactor = Math.exp(-e.deltaY * zoomIntensity);
                applyZoom(zoomFactor, e.clientX, e.clientY);
            }, { passive: false });

            let isDragging = false;
            let dragStartX, dragStartY;

            plotArea.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return; // Only drag with left click
                const img = document.getElementById('main-image');
                if (!img || img.style.display === 'none') return;

                isDragging = true;
                dragStartX = e.clientX - translateX;
                dragStartY = e.clientY - translateY;
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                e.preventDefault();
                translateX = e.clientX - dragStartX;
                translateY = e.clientY - dragStartY;
                updateTransform();
            });

            window.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                }
            });

            plotArea.addEventListener('dblclick', resetZoom);

            document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
                if (!document.getElementById('btn-zoom-in').hasAttribute('disabled')) {
                    applyZoom(1.2);
                }
            });
            document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
                if (!document.getElementById('btn-zoom-out').hasAttribute('disabled')) {
                    applyZoom(1 / 1.2);
                }
            });
            document.getElementById('btn-reset-zoom')?.addEventListener('click', () => {
                if (!document.getElementById('btn-reset-zoom').hasAttribute('disabled')) {
                    resetZoom();
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
            const setupTooltip = (el) => {
                if (!el) return;
                el.addEventListener('mouseenter', (e) => {
                    const text = el.getAttribute('data-tooltip');
                    if (!text) return;
                    tooltip.textContent = text;
                    tooltip.style.display = 'block';
                    const rect = el.getBoundingClientRect();
                    
                    if (el.id === 'main-image') {
                        // Place tooltip near the top middle to avoid obscuring the center text
                        tooltip.style.top = (rect.top + 20) + 'px';
                    } else {
                        tooltip.style.top = (rect.bottom + 5) + 'px';
                    }

                    // Boundary detection
                    const padding = 10;
                    let left = rect.left + (rect.width/2) - (tooltip.offsetWidth/2);
                    
                    if (el.id === 'main-image') {
                        // For large images, just center it in the window width if image spans the whole width
                        left = window.innerWidth / 2 - tooltip.offsetWidth / 2;
                    }
                    
                    if (left < padding) left = padding;
                    if (left + tooltip.offsetWidth > window.innerWidth - padding) {
                        left = window.innerWidth - tooltip.offsetWidth - padding;
                    }
                    tooltip.style.left = left + 'px';
                });
                el.addEventListener('mouseleave', () => {
                    tooltip.style.display = 'none';
                });
            };

            document.querySelectorAll('[data-tooltip]').forEach(setupTooltip);
            setupTooltip(document.getElementById('main-image'));

            // Keyboard Navigation for Plots
            window.addEventListener('keydown', (e) => {
                // Do not trigger if typing in an input field
                if (e.target && e.target.tagName === 'INPUT') return;

                if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    const btnPrev = document.getElementById('btn-prev');
                    if (btnPrev && !btnPrev.hasAttribute('disabled')) {
                        vscode.postMessage({ type: 'navigatePrev' });
                    }
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    const btnNext = document.getElementById('btn-next');
                    if (btnNext && !btnNext.hasAttribute('disabled')) {
                        vscode.postMessage({ type: 'navigateNext' });
                    }
                }
            });

            // Immediate minimize/restore handler
            window.addEventListener('message', function _minHandler(event) {
                const msg = event.data;
                if (msg.command === 'setMinimized') {
                    document.body.classList.toggle('minimized', msg.minimized);
                }
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

