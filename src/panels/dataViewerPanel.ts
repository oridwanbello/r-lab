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
 * Opens in ViewColumn.Four (bottom-right quadrant).
 */
export class DataViewerPanel {
    public static currentPanel: DataViewerPanel | undefined;
    public static readonly viewType = 'r-quadrant.dataViewerPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _varName = '';
    private _columns: string[] = [];
    private _rows: Record<string, unknown>[] = [];
    private _totalRows = 0;
    private _totalCols = 0;
    private _isLoading = false;
    private _errorMessage = '';
    private _autoRefreshInterval?: ReturnType<typeof setInterval>;
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
                            await this.loadVariable(this._varName, false);
                        }
                        break;
                    case 'toggleAutoRefresh':
                        if (this._autoRefreshInterval) {
                            clearInterval(this._autoRefreshInterval);
                            this._autoRefreshInterval = undefined;
                        } else {
                            this._autoRefreshInterval = setInterval(() => {
                                if (this._varName && !this._isLoading) {
                                    this.loadVariable(this._varName, true);
                                }
                            }, 3000);
                        }
                        this._render();
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
     *  We send a single short command (.r_quadrant_export_data) to the R terminal,
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
            
            // Start auto-refresh automatically on manual load, per user request
            if (!this._autoRefreshInterval) {
                this._autoRefreshInterval = setInterval(() => {
                    if (this._varName && !this._isLoading) {
                        this.loadVariable(this._varName, true);
                    }
                }, 3000);
            }
        }

        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wf) {
            this._errorMessage = 'No workspace folder open.';
            this._isLoading = false;
            if (!isAutoRefresh) this._render();
            return;
        }

        const outDir = nodePath.join(wf, '.r-quadrant');
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
                this._errorMessage = 'No R Console terminal found. Activate the R Quadrant layout first.';
                this._isLoading = false;
                this._render();
                return;
            }

            // Send the clean command directly. The invisible path-setting is no longer needed
            // because the paths are pre-set securely in the Rprofile hook.
            rTerminal.sendText(`.r_quadrant_export_data("${varName}")`, true);
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
        const config = vscode.workspace.getConfiguration('r-quadrant');
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
                    Click the eye icon on a data.frame in the <strong>Workspace</strong> tab<br/>
                    to view it here.</p>
                </div>`;
        } else if (this._columns.length === 0) {
            mainContent = `<div class="status-msg">No data available for "${escapeHtml(this._varName)}".</div>`;
        } else {
            const headerCells = this._columns
                .map((col, i) => `<th data-col="${i}" class="sortable"><span class="col-name">${escapeHtml(col)}</span><span class="sort-icon">⇅</span></th>`)
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
                        <thead><tr><th class="row-num">#</th>${headerCells}</tr></thead>
                        <tbody id="table-body"></tbody>
                    </table>
                </div>
                <script nonce="${nonce}">
                    (function() {
                        const rows = ${rowsJson};
                        const columns = ${JSON.stringify(this._columns)};
                        let sortCol = -1;
                        let sortAsc = true;

                        function renderRows(data) {
                            const tbody = document.getElementById('table-body');
                            tbody.innerHTML = data.map((row, i) => {
                                const cells = columns.map(col => {
                                    const val = row[col];
                                    return '<td>' + (val === null || val === undefined || val === 'NA' ? '<span class="na">NA</span>' : escapeHtml(String(val))) + '</td>';
                                }).join('');
                                return '<tr><td class="row-num">' + (i + 1) + '</td>' + cells + '</tr>';
                            }).join('');
                        }

                        function escapeHtml(s) {
                            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                        }

                        document.querySelectorAll('th.sortable').forEach(th => {
                            th.addEventListener('click', () => {
                                const col = parseInt(th.getAttribute('data-col'));
                                if (sortCol === col) { sortAsc = !sortAsc; }
                                else { sortCol = col; sortAsc = true; }
                                const key = columns[col];
                                rows.sort((a, b) => {
                                    const va = a[key], vb = b[key];
                                    if (va === null || va === undefined || va === 'NA') return 1;
                                    if (vb === null || vb === undefined || vb === 'NA') return -1;
                                    if (typeof va === 'number' && typeof vb === 'number') {
                                        return sortAsc ? va - vb : vb - va;
                                    }
                                    const sa = String(va), sb = String(vb);
                                    return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
                                });
                                document.querySelectorAll('th.sortable').forEach(t => {
                                    t.classList.remove('sort-asc','sort-desc');
                                    t.querySelector('.sort-icon').textContent = '⇅';
                                });
                                th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
                                th.querySelector('.sort-icon').textContent = sortAsc ? '▲' : '▼';
                                renderRows(rows);
                            });
                        });

                        renderRows(rows);
                    })();
                </script>`;
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
            justify-content: space-between;
            padding: 6px 12px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }
        .pane-title {
            font-weight: 600; font-size: 11px;
            text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7;
        }
        .meta {
            font-size: 11px; opacity: 0.5;
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
        .truncation-notice {
            padding: 4px 12px;
            font-size: 11px;
            background: var(--vscode-editorInfo-background, rgba(60, 130, 250, 0.1));
            color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        .table-wrapper { flex: 1; overflow: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        thead th {
            position: sticky; top: 0; z-index: 1;
            padding: 5px 8px;
            text-align: left;
            font-weight: 600;
            font-size: 11px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 2px solid var(--vscode-editorGroup-border);
            white-space: nowrap;
        }
        th.sortable { cursor: pointer; user-select: none; }
        th.sortable:hover { background: var(--vscode-list-hoverBackground); }
        th.sortable .col-name { margin-right: 4px; }
        th.sortable .sort-icon { font-size: 9px; opacity: 0.35; }
        th.sort-asc .sort-icon, th.sort-desc .sort-icon { opacity: 1; color: var(--vscode-textLink-foreground); }
        .row-num {
            width: 40px; text-align: right; opacity: 0.35;
            font-size: 10px; padding-right: 8px !important;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        tbody td {
            padding: 3px 8px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 11px;
            white-space: nowrap;
            max-width: 300px;
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
            background: var(--vscode-notifications-background, #252526);
            color: var(--vscode-notifications-foreground, #cccccc);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            z-index: 1000;
            pointer-events: none;
            display: none;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            border: 1px solid var(--vscode-widget-border, #454545);
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
            <span class="pane-title">Data Viewer</span>
            ${this._varName ? `<span class="meta"> — ${escapeHtml(this._varName)} (${this._totalRows.toLocaleString()} × ${this._totalCols})</span>` : ''}
        </span>
        <div class="toolbar-actions">
            ${this._varName ? `
            <button id="btn-auto" data-tooltip="${this._autoRefreshInterval ? 'Auto-refresh ON (3s)' : 'Auto-refresh OFF'}" class="${this._autoRefreshInterval ? 'active' : ''}">
                ${this._autoRefreshInterval 
                    ? '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3 3h4v10H3V3zm6 0h4v10H9V3z"/></svg>' 
                    : '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.7 8.5L4.5 13.5V3.5l8.2 5z"/></svg>'}
            </button>
            <button id="btn-refresh" data-tooltip="Refresh data"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.71 3.29a6.6 6.6 0 0 0-2.12-1.43 6.75 6.75 0 0 0-5.19 0c-0.79.33-1.51.82-2.12 1.43s-1.1 1.33-1.43 2.12a6.63 6.63 0 0 0-0.53 2.59h1.33c0-0.72.14-1.42.42-2.07.27-.63.65-1.21 1.15-1.69.49-.49 1.06-.87 1.69-1.14 1.31-.55 2.84-.55 4.15 0 .63.27 1.21.65 1.69 1.15.11.11.22.23.32.35L10.67 6.01h4V2l-1.63 1.63c-.1-.12-.21-.24-.32-.35m0.2 6.79c-.27.63-.65 1.21-1.15 1.69-.49.49-1.06.87-1.69 1.14-1.31.55-2.84.55-4.15 0-.63-.27-1.21-.65-1.69-1.15-.11-.11-.22-.23-.32-.35l1.42-1.42H1.33v4l1.63-1.63c.1.12.21.24.32.35.61.61 1.33 1.09 2.12 1.43.82.35 1.69.53 2.59.53s1.77-.17 2.59-.53c0.79-.33 1.51-.82 2.12-1.43s1.09-1.33 1.43-2.12c.35-.82.53-1.69.53-2.59h-1.33c0 0.72-.14 1.42-.42 2.07Z"/></svg></button>
            ` : ''}
        </div>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="content">${mainContent}</div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.getElementById('btn-refresh')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'refresh' });
            });
            document.getElementById('btn-auto')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'toggleAutoRefresh' });
            });

            // Instant Tooltip Controller
            const tooltip = document.getElementById('tooltip');
            document.querySelectorAll('[data-tooltip]').forEach(el => {
                el.addEventListener('mouseenter', (e) => {
                    const text = el.getAttribute('data-tooltip');
                    if (!text || el.disabled) return;
                    tooltip.textContent = text;
                    tooltip.style.display = 'block';
                    const rect = el.getBoundingClientRect();
                    tooltip.style.top = (rect.bottom + 5) + 'px';
                    tooltip.style.left = (rect.left + (rect.width/2) - (tooltip.offsetWidth/2)) + 'px';
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
        if (this._autoRefreshInterval) {
            clearInterval(this._autoRefreshInterval);
            this._autoRefreshInterval = undefined;
        }
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
