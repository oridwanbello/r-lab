import * as vscode from 'vscode';
import * as os from 'os';
import * as nodePath from 'path';
import * as nodeFs from 'fs';
import { execFile } from 'child_process';

/**
 * Data Viewer Panel — displays R data.frames in a sortable HTML table.
 *
 * Uses base R write.csv to export data — no external packages required.
 *
 * Opens in ViewColumn.Four (bottom-right layout).
 */
export class DataViewerPanel {
    public static currentPanel: DataViewerPanel | undefined;
    public static readonly viewType = 'r-layout.dataViewerPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _varName = '';
    private _columns: string[] = [];
    private _rows: Record<string, unknown>[] = [];
    private _totalRows = 0;
    private _totalCols = 0;
    private _isLoading = false;
    private _errorMessage = '';
    private _lastRenderHash = '';
    private _disposables: vscode.Disposable[] = [];

    // ── Factory ─────────────────────────────────────────────

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Four
    ): DataViewerPanel {
        if (DataViewerPanel.currentPanel) {
            DataViewerPanel.currentPanel._panel.reveal(column, true);
            return DataViewerPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            DataViewerPanel.viewType,
            'Data Viewer',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        DataViewerPanel.currentPanel = new DataViewerPanel(panel);
        return DataViewerPanel.currentPanel;
    }

    // ── Persistence ─────────────────────────────────────────
    public saveState(): { varName: string } {
        return { varName: this._varName };
    }

    public async loadState(state: { varName: string }): Promise<void> {
        if (state && state.varName) {
            await this.loadVariable(state.varName, true);
        }
    }

    // ── Constructor ─────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._render();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; varName?: string }) => {
                switch (msg.type) {
                    case 'refresh':
                        if (this._varName) {
                            // Manual refresh just re-reads the disk (silent).
                            await this.loadVariable(this._varName, true);
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    // ── Public API ──────────────────────────────────────────

    /** Bring this panel's tab to the front. */
    public reveal(): void {
        this._panel.reveal(undefined, true);
    }

    /** Load and display a variable from the LIVE R session.
     *
     *  We send a single short command (.r_layout_export_data) to the R terminal,
     *  which avoids polluting the user's history with massive chunks of code.
     */
    public async loadVariable(varName: string, isAutoRefresh: boolean = false): Promise<void> {
        this._varName = varName;
        // The user specifically requested the tab title never change from "Data Viewer"
        this._panel.title = 'Data Viewer';

        if (!isAutoRefresh) {
            this._isLoading = true;
            this._errorMessage = '';
            this._render();
        }

        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wf) {
            this._errorMessage = 'No workspace folder open.';
            this._isLoading = false;
            if (!isAutoRefresh) this._render();
            return;
        }

        const outDir = nodePath.join(wf, '.r-layout');
        if (!nodeFs.existsSync(outDir)) {
            nodeFs.mkdirSync(outDir, { recursive: true });
        }

        const tmpCsv  = nodePath.join(outDir, 'dv.csv');
        const tmpMeta = nodePath.join(outDir, 'dv-meta.txt');

        if (!isAutoRefresh) {
            // Delete stale output files so we can detect when the new ones appear.
            try { nodeFs.unlinkSync(tmpCsv);  } catch {}
            try { nodeFs.unlinkSync(tmpMeta); } catch {}

            const rTerminal = require('../layout/layoutManager').getRConsoleTerminal();
            if (!rTerminal) {
                this._errorMessage = 'No R Console terminal found. Activate the R Layout layout first.';
                this._isLoading = false;
                this._render();
                return;
            }

            // Send the clean command directly. The invisible path-setting is no longer needed
            // because the paths are pre-set securely in the Rprofile hook.
            rTerminal.sendText(`.r_layout_export_data("${varName}")`, true);
        }

        // Poll for the meta file (up to 10 s if manual, 0s if auto).
        const metaRaw = await this._waitForFile(tmpMeta, isAutoRefresh ? 0 : 10000);
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
            const metaLines = metaRaw.trim().split('\n');
            this._totalRows = parseInt(metaLines[0], 10) || 0;
            this._totalCols = parseInt(metaLines[1], 10) || 0;
            const csvRaw = nodeFs.readFileSync(tmpCsv, 'utf8');
            const lines = csvRaw.trim().split('\n');
            this._columns = this._parseCsvRow(lines[0]);
            this._rows = lines.slice(1).map((line: string) => {
                const vals = this._parseCsvRow(line);
                const obj: Record<string, unknown> = {};
                this._columns.forEach((col, i) => { obj[col] = vals[i] ?? null; });
                return obj;
            });
            this._errorMessage = '';
        } catch (err: unknown) {
            this._errorMessage = err instanceof Error ? err.message : String(err);
            this._columns = [];
            this._rows = [];
            this._totalRows = 0;
            this._totalCols = 0;
        }

        this._isLoading = false;
        this._render();
    }

    /** Poll for a file to appear, return its contents or null on timeout. */
    private _waitForFile(filePath: string, timeoutMs: number): Promise<string | null> {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                if (nodeFs.existsSync(filePath)) {
                    clearInterval(interval);
                    resolve(nodeFs.readFileSync(filePath, 'utf8'));
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    resolve(null);
                }
            }, 200);
        });
    }

    /** RFC-4180 CSV row parser — handles quoted fields and escaped quotes. */
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


    /** Find the Rscript binary — works regardless of whether rConsolePath is R, radian, or ark. */
    private _findRscript(): Promise<string> {
        const config = vscode.workspace.getConfiguration('r-layout');
        const rPath = config.get<string>('rConsolePath', 'R');
        // If rConsolePath ends with 'R' or 'Rscript', use that directory.
        if (/[/\\]R$/.test(rPath)) {
            return Promise.resolve(rPath.replace(/[/\\]R$/, '/Rscript'));
        }
        if (/[Rr]script$/i.test(rPath)) {
            return Promise.resolve(rPath);
        }
        // radian / ark / unknown — fall back to 'which Rscript'
        return new Promise((resolve) => {
            require('child_process').execFile(
                'which', ['Rscript'],
                (err: Error | null, stdout: string) => resolve(err ? 'Rscript' : stdout.trim() || 'Rscript')
            );
        });
    }

    private _runRscript(rscriptPath: string, script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                rscriptPath,
                ['-e', script],
                {
                    timeout: 30000,
                    maxBuffer: 10 * 1024 * 1024, // 10 MB for large dataframes
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
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

    // ── Rendering ───────────────────────────────────────────


    private _render(): void {
        const stateToHash = JSON.stringify({
            varName: this._varName,
            err: this._errorMessage,
            loading: this._isLoading,
            cols: this._columns,
            rows: this._rows,
            totCols: this._totalCols,
            totRows: this._totalRows
        });

        if (this._lastRenderHash === stateToHash) {
            return; // No changes, do not rebuild DOM (preserves text selection)
        }
        this._lastRenderHash = stateToHash;

        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const nonce = getNonce();

        let mainContent: string;
        if (this._isLoading) {
            mainContent = `<div class="status-msg">⏳ Loading "${escapeHtml(this._varName)}"…</div>`;
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
                .map((col, i) => `<th data-col="${i}" class="sortable"><span class="col-name">${escapeHtml(col)}</span><span class="sort-icon">⏶⏷</span></th>`)
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
                        <thead><tr><th class="row-num"><span style="opacity: 0.35;">#</span></th>${headerCells}</tr></thead>
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
            font-size: 12px;
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
            justify-content: space-between; /* Meta left, Actions right */
            padding: 0 12px;
            height: 32px;
            background: var(--vscode-editor-background); /* Matches active tab */
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }

        .toolbar button[disabled]:hover {
            background: none;
        }
        .meta {
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .toolbar-actions { display: flex; align-items: center; gap: 6px; }
        .toolbar button {
            background: none;
            color: var(--vscode-foreground);
            border: none; padding: 3px 6px;
            border-radius: 3px; cursor: pointer;
            font-size: 13px; opacity: 0.7;
            display: flex; align-items: center; justify-content: center;
        }
        .toolbar button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
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
            font-size: 11px;
            background: var(--vscode-editorInfo-background, rgba(60, 130, 250, 0.1));
            color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        .table-wrapper { flex: 1; overflow: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td {
            padding: 4px 10px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            border-right: 1px solid var(--vscode-editorGroup-border);
            white-space: nowrap; /* Prevent data from spilling to next line */
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
        }
        th {
            position: sticky; top: 0; z-index: 1;
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-weight: 900; font-size: 11px; letter-spacing: 0.3px; color: var(--vscode-editor-foreground); opacity: 1;
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
            font-size: 12px; opacity: 0.4; vertical-align: middle;
            display: inline-block; min-width: 16px; text-align: center;
        }
        th.sort-asc .sort-icon, th.sort-desc .sort-icon { opacity: 1; color: var(--vscode-textLink-foreground); font-weight: bold; }
        td.row-num {
            width: 40px; text-align: right; opacity: 0.35;
            font-size: 10px; padding-right: 8px !important;
        }
        th.row-num {
            width: 40px; text-align: right;
            font-size: 10px; padding-right: 8px !important;
            opacity: 1;
        }
        td {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
        .na { opacity: 0.35; font-style: italic; }
        .content { flex: 1; overflow: auto; display: flex; flex-direction: column; }
        .status-msg { padding: 20px; text-align: center; opacity: 0.6; }
        .status-msg.error { color: var(--vscode-errorForeground); opacity: 0.9; white-space: pre-wrap; }

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

        .empty-state {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; height: 100%; text-align: center; opacity: 0.3;
        }
        .empty-state svg { width: 64px; height: 64px; margin-bottom: 16px; display: inline-block; }
        .empty-state p { font-size: 13px; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="toolbar">
        <span>
            ${this._varName ? `<span class="meta">${escapeHtml(this._varName)} (${this._totalRows.toLocaleString()} × ${this._totalCols})</span>` : ''}
        </span>
        <div class="toolbar-actions">
            <button id="btn-refresh" ${!this._varName ? 'disabled' : ''} data-tooltip="Refresh Data">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M13.29 8.69a5.33 5.33 0 1 1 -6.62 -5.86c2.6-.67 5.29.67 6.28 3.16" />
                    <path d="M13.33 2.67v3.33h-3.33" />
                </svg>
            </button>
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

            // Sorting Logic (only if table exists)
            const tbody = document.getElementById('table-body');
            if (tbody) {
                const rows = ${JSON.stringify(this._rows)};
                const columns = ${JSON.stringify(this._columns)};

                const oldState = vscode.getState() || {};
                let sortCol = oldState.sortCol !== undefined ? oldState.sortCol : -1;
                let sortAsc = oldState.sortAsc !== undefined ? oldState.sortAsc : true;

                function renderRows(data) {
                    tbody.innerHTML = data.map((row, i) => {
                        const cells = columns.map(col => {
                            const val = row[col];
                            let displayVal = val;
                            if (val === null || val === undefined || val === 'NA') {
                                displayVal = '<span class="na">NA</span>';
                            } else {
                                displayVal = String(val).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                            }
                            return '<td>' + displayVal + '</td>';
                        }).join('');
                        return '<tr><td class="row-num">' + (i + 1) + '</td>' + cells + '</tr>';
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

                    const key = columns[sortCol];
                    const sorted = [...rows].sort((a, b) => {
                        const va = a[key], vb = b[key];
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
        })();
    </script>
</body>
</html>`;
    }

    // ── Cleanup ─────────────────────────────────────────────

    dispose(): void {
        DataViewerPanel.currentPanel = undefined;
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

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
