import * as vscode from 'vscode';
import * as os from 'os';
import * as nodePath from 'path';
import * as nodeFs from 'fs';
import { execFile } from 'child_process';
import { getRscriptPath } from '../utils/rPathResolver';
import { getNonce, escapeHtml } from '../utils/webviewUtils';
import { enforceGroup3TabOrder } from '../utils/webviewUtils';
import { suppressGuardForPanelMove } from '../layout/layoutManager';

/**
 * Data Viewer Panel - displays R data.frames in a sortable HTML table.
 *
 * Uses base R write.csv to export data - no external packages required.
 *
 * Opens in ViewColumn.Three (bottom-right layout).
 */
export class DataViewerPanel {
    public static currentPanel: DataViewerPanel | undefined;
    public static readonly viewType = 'r-layout.dataViewerPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _varName = '';
    private _columns: string[] = [];
    private _rows: string[][] = [];
    private _totalRows = 0;
    private _totalCols = 0;
    private _isLoading = false;
    private _errorMessage = '';
    private _isMinimized = false;
    private _isPoppedOut: boolean = false;
    private _focusPending: boolean = false;
    private _lastRenderHash = '';
    private _disposables: vscode.Disposable[] = [];

    // 3D Matrix Navigation State
    private _is3D = false;
    private _totalSlices = 1;
    private _currentSlice = 1;
    private _sliceLabels: string[] = [];

    // Factory

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Three,
        forceReveal: boolean = true
    ): DataViewerPanel {
        if (DataViewerPanel.currentPanel) {
            if (forceReveal) {
                DataViewerPanel.currentPanel._panel.reveal(column, true);
            }
            return DataViewerPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            DataViewerPanel.viewType,
            'Data Viewer',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        DataViewerPanel.currentPanel = new DataViewerPanel(panel);
        return DataViewerPanel.currentPanel;
    }

    // Persistence
    public saveState(): { varName: string } {
        return { varName: this._varName };
    }

    public async loadState(state: { varName: string }): Promise<void> {
        if (state && state.varName) {
            await this.loadVariable(state.varName, true);
        }
    }

    // Constructor

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._render();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            (e) => {
                this._render();
                this._postPoppedState();
            },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; varName?: string; slice?: number }) => {
                switch (msg.type) {
                    case 'ready':
                        this._render();
                        if (this._focusPending) {
                            this._focusPending = false;
                            enforceGroup3TabOrder('Data Viewer').then(() => {
                                setTimeout(() => {
                                    vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                                }, 150);
                            });
                        }
                        break;
                    case 'refresh':
                        if (this._varName) {
                            // Manual refresh triggers a full R re-export.
                            await this.loadVariable(this._varName, false);
                        }
                        break;
                    case 'setSlice':
                        if (this._varName && msg.slice !== undefined) {
                            await this.loadVariable(this._varName, false, msg.slice);
                        }
                        break;
                    case 'popout':
                        this._isPoppedOut = true;
                        this._focusPending = true;
                        suppressGuardForPanelMove();
                        this._panel.reveal(vscode.ViewColumn.One, false);
                        vscode.commands.executeCommand('workbench.action.keepEditor');
                        this._postPoppedState();
                        setTimeout(() => vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'), 150);
                        break;
                    case 'restore':
                        this._isPoppedOut = false;
                        this._focusPending = true;
                        suppressGuardForPanelMove();
                        this._panel.reveal(vscode.ViewColumn.Three, false);
                        vscode.commands.executeCommand('workbench.action.keepEditor');
                        enforceGroup3TabOrder('Data Viewer');
                        this._postPoppedState();
                        setTimeout(() => vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'), 150);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * Send the popped-out state to the webview so it can dynamically
     * update the tooltip and click handler without a full HTML re-render.
     */
    private _postPoppedState(): void {
        if (this._panel.viewColumn !== undefined) {
            this._isPoppedOut = this._panel.viewColumn !== vscode.ViewColumn.Three;
        }
        this._panel.webview.postMessage({
            type: 'updatePoppedState',
            isPoppedOut: this._isPoppedOut
        });
    }

    // Public API

    public reveal(): void {
        if (!this._panel.visible) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.viewColumn === this._panel.viewColumn) {
                return;
            }
            this._panel.reveal(undefined, true);
        }
    }

    /** Hide or show all webview content (toolbar, table, controls).
     *  Used when the top-right pane is maximized so only the
     *  VS Code tab bar remains visible for the bottom-right group.
     */
    public setMinimized(minimized: boolean): void {
        this._isMinimized = minimized;
        this._lastRenderHash = ''; // force re-render
        this._render();
    }

    /** Load and display a variable from the LIVE R session.
     *
     *  We send a single short command (.r_layout_view_data) to the R terminal,
     *  which avoids polluting the user's history with massive chunks of code.
     */
    public async loadVariable(varName: string, isAutoRefresh: boolean = false, sliceIndex?: number): Promise<void> {
        this._varName = varName;
        // The user specifically requested the tab title never change from "Data Viewer"
        this._panel.title = 'Data Viewer';

        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const outDir = nodePath.join(wf, '.R-layout');
        const tmpMeta = nodePath.join(outDir, 'dv-meta.txt');

        // If sliceIndex is provided and we are already viewing a 3D matrix,
        // load the requested slice CSV fully offline without talking to R terminal!
        if (sliceIndex !== undefined && this._is3D) {
            this._currentSlice = sliceIndex;
            const sliceCsvPath = nodePath.join(outDir, `dv_slice_${this._currentSlice}.csv`);
            if (nodeFs.existsSync(sliceCsvPath)) {
                try {
                    const csvRaw = nodeFs.readFileSync(sliceCsvPath, 'utf8');
                    this._loadCsvData(csvRaw);
                    this._errorMessage = '';
                } catch (err: unknown) {
                    this._errorMessage = err instanceof Error ? err.message : String(err);
                }
                this._render();
                return;
            }
        }

        if (!isAutoRefresh) {
            this._isLoading = true;
            this._errorMessage = '';
            this._render();
        }

        if (!isAutoRefresh) {
            // Delete stale output files so we can detect when the new ones appear.
            try { nodeFs.unlinkSync(nodePath.join(outDir, 'dv.csv')); } catch {}
            try { nodeFs.unlinkSync(tmpMeta); } catch {}

            const rTerminal = require('../layout/layoutManager').getRConsoleTerminal();
            if (!rTerminal) {
                this._errorMessage = 'No R Console terminal found. Activate the R Layout layout first.';
                this._isLoading = false;
                this._render();
                return;
            }

            // Write the request to a file, then send an invisible command to trigger the R callback
            const reqFile = nodePath.join(outDir, '.view_request');
            try { nodeFs.writeFileSync(reqFile, varName, 'utf8'); } catch {}

            const hasLaterFile = nodePath.join(outDir, '.has_later');
            if (!nodeFs.existsSync(hasLaterFile)) {
                rTerminal.sendText(`View(${varName})`, true);
            }
        }

        // Poll for the meta file (up to 10s if manual, 2s if auto to handle OS buffering).
        const metaRaw = await this._waitForFile(tmpMeta, isAutoRefresh ? 2000 : 10000);
        if (metaRaw === null) {
            if (!isAutoRefresh) {
                this._errorMessage = 'Timed out waiting for R to export data. Check the R Console for errors.';
                this._isLoading = false;
                this._render();
            }
            return;
        }

        try {
            if (metaRaw.startsWith('ERROR:')) {
                throw new Error(metaRaw.slice(6).trim());
            }
            const metaLines = metaRaw.replace(/\r/g, '').trim().split('\n');
            this._totalRows = parseInt(metaLines[0], 10) || 0;
            this._totalCols = parseInt(metaLines[1], 10) || 0;

            if (metaLines[2] === '3D') {
                this._is3D = true;
                this._totalSlices = parseInt(metaLines[3], 10) || 1;
                this._sliceLabels = metaLines.slice(4, metaLines.length - 1).map(s => s.trim());
                this._varName = metaLines[metaLines.length - 1].trim(); // Extract true variable name
                if (!isAutoRefresh) {
                    this._currentSlice = 1;
                }

                const sliceCsvPath = nodePath.join(outDir, `dv_slice_${this._currentSlice}.csv`);
                // On Windows, slice CSV may still be locked when meta watcher fires.
                const csvRaw = await this._waitForCsvReady(sliceCsvPath, 3000);
                if (csvRaw === null) {
                    throw new Error(`Slice file ${sliceCsvPath} not found or not ready.`);
                }
                this._loadCsvData(csvRaw);
            } else {
                this._is3D = false;
                this._totalSlices = 1;
                this._currentSlice = 1;
                this._sliceLabels = [];
                this._varName = metaLines[3].trim(); // Extract true variable name
                const tmpCsv = nodePath.join(outDir, 'dv.csv');
                // On Windows, the CSV may still be locked/partially-written when
                // the meta file watcher fires. Poll until the file is readable.
                const csvRaw = await this._waitForCsvReady(tmpCsv, 3000);
                if (csvRaw === null) {
                    throw new Error('Timed out waiting for CSV data file to be written.');
                }
                this._loadCsvData(csvRaw);
            }
            this._errorMessage = '';
        } catch (err: unknown) {
            this._errorMessage = err instanceof Error ? err.message : String(err);
            this._columns = [];
            this._rows = [];
            this._totalRows = 0;
            this._totalCols = 0;
            this._is3D = false;
        }

        this._isLoading = false;
        this._render();
    }

    private _loadCsvData(csvRaw: string): void {
        const lines = csvRaw.replace(/\r/g, '').trim().split('\n');
        this._columns = this._parseCsvRow(lines[0]);
        this._rows = lines.slice(1).map((line: string) => {
            return this._parseCsvRow(line);
        });
    }

    /**
     * Poll for a CSV file to become readable and have a valid header row.
     * This handles the Windows FS flush race where the meta (signal) file
     * is visible before the bulk CSV data is fully written to disk.
     */
    private _waitForCsvReady(filePath: string, timeoutMs: number): Promise<string | null> {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                try {
                    if (nodeFs.existsSync(filePath)) {
                        const raw = nodeFs.readFileSync(filePath, 'utf8');
                        // A valid CSV must have at least a header line with a comma
                        if (raw.trim().length > 0 && raw.includes(',')) {
                            clearInterval(interval);
                            resolve(raw);
                            return;
                        }
                    }
                } catch {
                    // ignore ENOENT / EBUSY during write
                }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    // Last-chance read attempt
                    try {
                        const raw = nodeFs.readFileSync(filePath, 'utf8');
                        resolve(raw.trim().length > 0 ? raw : null);
                    } catch {
                        resolve(null);
                    }
                }
            }, 100);
        });
    }

    private _waitForFile(filePath: string, timeoutMs: number): Promise<string | null> {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                try {
                    if (nodeFs.existsSync(filePath)) {
                        const raw = nodeFs.readFileSync(filePath, 'utf8');
                        if (raw.trim().length > 0) {
                            clearInterval(interval);
                            resolve(raw);
                            return;
                        }
                    }
                } catch {
                    // ignore ENOENT during write
                }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    resolve(null);
                }
            }, 100); // 100ms interval for faster auto-refresh response
        });
    }

    /** RFC-4180 CSV row parser - handles quoted fields and escaped quotes. */
    private _parseCsvRow(line: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
                else { inQuotes = !inQuotes; }
            } else if (ch === ',' && !inQuotes) {
                result.push(current); current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }




    private _runRscript(rscriptPath: string, script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                rscriptPath,
                ['-e', script],
                {
                    timeout: 30000,
                    maxBuffer: 10 * 1024 * 1024, // 10 MB for large dataframes
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
                },
                (error, stdout, stderr) => {
                    if (error) {
                        const detail = stderr
                            ? `${error.message}\n\n${stderr}`
                            : error.message;
                        reject(new Error(detail));
                        return;
                    }
                    resolve(stdout || '');
                }
            );
        });
    }

    // Rendering


    private _render(): void {
        const stateToHash = JSON.stringify({
            varName: this._varName,
            err: this._errorMessage,
            loading: this._isLoading,
            cols: this._columns,
            rows: this._rows,
            totCols: this._totalCols,
            totRows: this._totalRows,
            is3D: this._is3D,
            totalSlices: this._totalSlices,
            currentSlice: this._currentSlice,
            sliceLabels: this._sliceLabels
        });

        if (this._lastRenderHash === stateToHash) {
            return; // No changes, do not rebuild DOM (preserves text selection)
        }
        this._lastRenderHash = stateToHash;

        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const nonce = getNonce();
        const activeLabel = this._is3D ? (this._sliceLabels[this._currentSlice - 1] || '').trim() : '';
        const cleanLabel = activeLabel.toLowerCase().replace(/\s+/g, '');
        const isRedundant = cleanLabel === 'page' + this._currentSlice || cleanLabel === 'slice' + this._currentSlice || cleanLabel === '';

        if (this._panel.viewColumn !== undefined) {
            this._isPoppedOut = this._panel.viewColumn !== vscode.ViewColumn.Three;
        }
        const isPoppedOut = this._isPoppedOut;
        const actualMinimized = isPoppedOut ? false : this._isMinimized;

        let mainContent: string;
        if (this._isLoading) {
            mainContent = `<div class="status-msg">Loading "${escapeHtml(this._varName)}"&hellip;</div>`;
        } else if (this._errorMessage) {
            mainContent = `<div class="status-msg error">⚠ ${escapeHtml(this._errorMessage)}</div>`;
        } else if (this._columns.length === 0 && !this._varName) {
            mainContent = `
                <div class="empty-state">
                    <svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h12v12H2V2zm1 1v2h10V3H3zm0 3v2h3V6H3zm4 0v2h6V6H7zm-4 3v2h3V9H3zm4 0v2h6V9H7zm-4 3v2h3v-2H3zm4 0v2h6v-2H7z"/></svg>
                    <p>No data loaded.<br/>
                    Click the eye icon on a data.frame in the <strong>Global Environment</strong><br/>
                    of the <strong>Workspace</strong> tab to view it here.</p>
                </div>`;
        } else if (this._columns.length === 0) {
            mainContent = `<div class="status-msg">No data available for "${escapeHtml(this._varName)}".</div>`;
        } else {
            const headerCells = this._columns
                .map((col, i) => {
                    if (i === 0) {return `<th data-col="0" class="sortable row-num"><span class="col-name"></span><span class="sort-icon">⏶⏷</span></th>`;}
                    return `<th data-col="${i}" class="sortable"><span class="col-name">${escapeHtml(col)}</span><span class="sort-icon">⏶⏷</span></th>`;
                })
                .join('');

            // Build row data as JSON for client-side sorting
            const rowsJson = JSON.stringify(this._rows);

            const truncated = this._totalRows > 1000
                ? `<div class="truncation-notice">Showing first 1,000 of ${this._totalRows.toLocaleString()} rows</div>`
                : '';

            mainContent = `
                ${truncated}
                <div class="table-wrapper">
                    <table>
                        <thead><tr>${headerCells}</tr></thead>
                        <tbody id="table-body"></tbody>
                    </table>
                </div>`;
        }

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
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
            position: relative;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 12px;
            height: 32px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap;
        }
        .toolbar::-webkit-scrollbar {
            height: 2px;
        }
        .toolbar::-webkit-scrollbar-track {
            background: transparent;
        }
        .toolbar::-webkit-scrollbar-thumb {
            background-color: transparent;
            border-radius: 2px;
        }
        .toolbar:hover::-webkit-scrollbar-thumb {
            background-color: var(--vscode-scrollbarSlider-background);
        }
        .toolbar::-webkit-scrollbar-thumb:hover {
            background-color: var(--vscode-scrollbarSlider-hoverBackground);
        }
        .toolbar::-webkit-scrollbar-thumb:active {
            background-color: var(--vscode-scrollbarSlider-activeBackground);
        }
        .toolbar > * {
            flex-shrink: 0;
        }

        .toolbar button[disabled]:hover {
            background: none;
        }
        .meta {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .toolbar-slice-nav {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: var(--vscode-font-size, 13px);
            font-family: var(--vscode-font-family);
            margin-right: 15px;
        }
        .slice-indicator {
            font-weight: 500;
            color: var(--vscode-foreground);
            font-size: 11px;
            opacity: 0.85;
        }
        .toolbar-actions { display: flex; align-items: center; gap: 6px; }
        .toolbar button {
            background: none;
            color: var(--vscode-foreground);
            border: none; padding: 3px 6px;
            border-radius: 6px; cursor: pointer;
            font-size: var(--vscode-font-size, 13px); opacity: 0.7;
            display: flex; align-items: center; justify-content: center;
        }
        .toolbar button:hover:not([disabled]) { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
        .toolbar button.active { opacity: 1; color: var(--vscode-textLink-foreground); }
        .toolbar button[disabled] {
            opacity: 0.25;
            cursor: default;
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
        .truncation-notice {
            padding: 4px 12px;
            background: var(--vscode-editorInfo-background, rgba(60, 130, 250, 0.1));
            color: var(--vscode-textLink-foreground, var(--vscode-foreground));
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .table-wrapper { flex: 1; overflow: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td {
            padding: 4px 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            border-right: 1px solid var(--vscode-editorGroup-border);
            white-space: nowrap; /* Prevent data from spilling to next line */
            font-family: var(--vscode-editor-font-family, monospace);
            vertical-align: middle;
        }
        th {
            position: sticky; top: 0; z-index: 1;
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-weight: 600; font-style: italic;
            letter-spacing: 0.5px;
            color: color-mix(in srgb, var(--vscode-editor-foreground), transparent 65%);
            opacity: 1;
            cursor: pointer; user-select: none;
            border-bottom: 2px solid var(--vscode-editorGroup-border);
        }
        th.sortable:hover {
            background: var(--vscode-editor-background);
            box-shadow: inset 0 0 0 1000px var(--vscode-list-hoverBackground);
            opacity: 1;
        }
        th.sortable .col-name { margin-right: 6px; }
        th.sortable .sort-icon {
            font-size: 0.9em; opacity: 0.4; vertical-align: middle;
            display: inline-block; min-width: 16px; text-align: center;
        }
        th.sort-asc .sort-icon, th.sort-desc .sort-icon { opacity: 1; color: var(--vscode-textLink-foreground); font-weight: bold; }
        td.row-num {
            width: 40px; text-align: right;
            padding-right: 8px !important;
            font-family: var(--vscode-font-family);
            font-weight: 600; font-style: italic;
            letter-spacing: 0.5px;
            color: color-mix(in srgb, var(--vscode-editor-foreground), transparent 65%);
        }
        th.row-num {
            width: 40px; text-align: right;
            padding-right: 8px !important;
            font-family: var(--vscode-font-family);
            font-weight: 600; font-style: italic;
            letter-spacing: 0.5px;
            color: color-mix(in srgb, var(--vscode-editor-foreground), transparent 65%);
            left: 0;
            z-index: 3;
        }
        td.row-num {
            position: sticky;
            left: 0;
            z-index: 1;
            background: var(--vscode-editor-background);
            text-align: right;
            padding-right: 8px !important;
            font-style: italic;
            letter-spacing: 0.5px;
            font-family: var(--vscode-font-family);
            color: color-mix(in srgb, var(--vscode-editor-foreground), transparent 65%);
        }
        td {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
        tbody tr:hover td.row-num { background: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-editor-background); }
        .na { opacity: 0.35; font-style: italic; }
        .content { flex: 1; overflow: auto; display: flex; flex-direction: column; }
        .status-msg { padding: 20px; text-align: center; opacity: 0.6; }
        .status-msg.error { color: var(--vscode-errorForeground); opacity: 0.9; white-space: pre-wrap; }

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

        .empty-state {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; height: 100%; text-align: center; opacity: 0.3;
        }
        .empty-state svg { width: 5em; height: 5em; margin-bottom: 16px; display: inline-block; }
        .empty-state p { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
    </style>
</head>
<body${actualMinimized ? ' class="minimized"' : ''}>
    <div class="toolbar">
        <div>
            ${this._varName ? `<span class="meta">${escapeHtml(this._varName)} (${this._totalRows.toLocaleString()} × ${this._totalCols}${this._is3D ? ` × ${this._totalSlices}` : ''})</span>` : ''}
        </div>
        <div class="toolbar-actions">
            ${this._is3D ? `
            <div class="toolbar-slice-nav">
                <button id="btn-prev" ${this._currentSlice <= 1 ? 'disabled' : ''} data-tooltip="Previous Slice">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="11 1 4 8 11 15" />
                    </svg>
                </button>
                <span class="slice-indicator">Slice ${this._currentSlice} of ${this._totalSlices}${!isRedundant ? ` (${escapeHtml(activeLabel)})` : ''}</span>
                <button id="btn-next" ${this._currentSlice >= this._totalSlices ? 'disabled' : ''} data-tooltip="Next Slice">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="5 1 12 8 5 15" />
                    </svg>
                </button>
            </div>
            ` : ''}
            <button id="btn-refresh" ${!this._varName ? 'disabled' : ''} data-tooltip="Refresh Data">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M13.29 8.69a5.33 5.33 0 1 1 -6.62 -5.86c2.6-.67 5.29.67 6.28 3.16" />
                    <path d="M13.33 2.67v3.33h-3.33" />
                </svg>
            </button>
            <button id="btn-popout" data-tooltip="${isPoppedOut ? 'Restore to Side Panel' : 'Pop-out to Main Editor'}"><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/><path d="M15 1.5V6h-1V2.707L7.854 8.854l-.708-.708L13.293 2H10V1h4.5l.5.5z"/></svg></button>
        </div>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="content">${mainContent}</div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();

            // Refresh Button
            document.getElementById('btn-refresh')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'refresh' });
            });

            // Slice Navigation Buttons
            document.getElementById('btn-prev')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'setSlice', slice: ${this._currentSlice - 1} });
            });
            document.getElementById('btn-next')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'setSlice', slice: ${this._currentSlice + 1} });
            });

            // Sorting Logic (only if table exists)
            const tbody = document.getElementById('table-body');
            if (tbody) {
                const rows = ${JSON.stringify(this._rows)};
                const columns = ${JSON.stringify(this._columns)};

                const oldState = vscode.getState() || {};
                let sortCol = oldState.sortCol !== undefined ? oldState.sortCol : -1;
                let sortAsc = oldState.sortAsc !== undefined ? oldState.sortAsc : true;

                function renderRows(data) {
                    tbody.innerHTML = data.map((row) => {
                        const cells = row.map((val, j) => {
                            let displayVal = val;
                            if (val === null || val === undefined || val === 'NA') {
                                displayVal = '<span class="na">NA</span>';
                            } else {
                                displayVal = String(val).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                            }
                            const cssClass = j === 0 ? ' class="row-num"' : '';
                            return '<td' + cssClass + '>' + displayVal + '</td>';
                        }).join('');
                        return '<tr>' + cells + '</tr>';
                    }).join('');
                }

                function applySort() {
                    document.querySelectorAll('th.sortable').forEach((t, i) => {
                        t.classList.remove('sort-asc','sort-desc');
                        t.querySelector('.sort-icon').textContent = '⏶⏷';
                        if (i === sortCol) {
                            t.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
                            t.querySelector('.sort-icon').textContent = sortAsc ? '⏶' : '⏷';
                        }
                    });

                    if (sortCol === -1) {
                        renderRows(rows);
                        vscode.setState({ sortCol, sortAsc });
                        return;
                    }

                    const sorted = [...rows].sort((a, b) => {
                        const va = a[sortCol], vb = b[sortCol];
                        if (va === null || va === undefined || va === 'NA') return 1;
                        if (vb === null || vb === undefined || vb === 'NA') return -1;

                        const sa = String(va).trim();
                        const sb = String(vb).trim();
                        const na = Number(sa);
                        const nb = Number(sb);
                        const isNumA = sa !== '' && !isNaN(na);
                        const isNumB = sb !== '' && !isNaN(nb);

                        if (isNumA && isNumB) {
                            return sortAsc ? na - nb : nb - na;
                        }
                        return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
                    });

                    renderRows(sorted);
                    vscode.setState({ sortCol, sortAsc });
                }

                document.querySelectorAll('th.sortable').forEach(th => {
                    th.addEventListener('click', () => {
                        const col = parseInt(th.getAttribute('data-col'));
                        if (sortCol === col) {
                            if (sortAsc) sortAsc = false;
                            else { sortCol = -1; sortAsc = true; }
                        }
                        else { sortCol = col; sortAsc = true; }
                        applySort();
                    });
                });

                applySort();
            }

            // Instant Tooltip Controller
            const tooltip = document.getElementById('tooltip');
            const btnPopout = document.getElementById('btn-popout');
            let isPoppedOut = ${isPoppedOut};

            // Listen for dynamic isPoppedOut state updates from the extension
            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.type === 'updatePoppedState' && msg.isPoppedOut !== undefined) {
                    isPoppedOut = msg.isPoppedOut;
                    if (btnPopout) {
                        btnPopout.setAttribute('data-tooltip', isPoppedOut ? 'Restore to Side Panel' : 'Pop-out to Main Editor');
                        // Force update tooltip if currently hovering
                        if (tooltip && tooltip.style.display === 'block' && btnPopout.matches(':hover')) {
                            tooltip.textContent = btnPopout.getAttribute('data-tooltip');
                        }
                    }
                }
            });

            btnPopout?.addEventListener('click', () => {
                vscode.postMessage({ type: isPoppedOut ? 'restore' : 'popout' });
            });

            document.querySelectorAll('[data-tooltip]').forEach(el => {
                el.addEventListener('mouseenter', (e) => {
                    const text = el.getAttribute('data-tooltip');
                    if (!text) return;
                    tooltip.textContent = text;
                    tooltip.style.display = 'block';
                    const rect = el.getBoundingClientRect();
                    tooltip.style.top = (rect.bottom + 5) + 'px';

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

            vscode.postMessage({ type: 'ready' });
        })();
    </script>
</body>
</html>`;
    }

    // Cleanup

    dispose(): void {
        DataViewerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

//  Utility


