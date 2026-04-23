import * as vscode from 'vscode';
import { execFile } from 'child_process';

/**
 * Data Viewer Panel — displays R data.frames in a sortable HTML table.
 *
 * Runs `Rscript` in the background to serialize a dataframe to JSON,
 * then renders it in a searchable, sortable table.
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
                            await this.loadVariable(this._varName);
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

    /** Load and display a variable from R's global environment. */
    public async loadVariable(varName: string): Promise<void> {
        this._varName = varName;
        this._panel.title = `Data: ${varName}`;
        this._isLoading = true;
        this._errorMessage = '';
        this._render();

        const rScript = `
tryCatch({
    if (file.exists(".RData")) load(".RData", envir = .GlobalEnv)
    obj <- get("${varName}", envir = .GlobalEnv)
    if (!is.data.frame(obj)) obj <- as.data.frame(obj)
    total_rows <- nrow(obj)
    total_cols <- ncol(obj)
    preview <- head(obj, 1000)
    result <- list(
        totalRows = total_rows,
        totalCols = total_cols,
        columns = names(preview),
        rows = preview
    )
    cat(jsonlite::toJSON(result, auto_unbox = TRUE, na = "string"))
}, error = function(e) {
    cat(paste0('{"error":"', gsub('"', '\\\\\\\\"', conditionMessage(e)), '"}'))
})`;

        const config = vscode.workspace.getConfiguration('r-quadrant');
        const rPath = config.get<string>('rConsolePath', 'R');
        const rscriptPath = rPath.replace(/R$/, 'Rscript');

        try {
            const raw = await this._runRscript(rscriptPath, rScript);
            const parsed = JSON.parse(raw);

            if (parsed.error) {
                this._errorMessage = parsed.error;
                this._columns = [];
                this._rows = [];
                this._totalRows = 0;
                this._totalCols = 0;
            } else {
                this._columns = parsed.columns || [];
                this._rows = parsed.rows || [];
                this._totalRows = parsed.totalRows || 0;
                this._totalCols = parsed.totalCols || 0;
                this._errorMessage = '';
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('jsonlite')) {
                this._errorMessage = 'R package "jsonlite" is required.\nRun: install.packages("jsonlite")';
            } else {
                this._errorMessage = msg;
            }
            this._columns = [];
            this._rows = [];
        }

        this._isLoading = false;
        this._render();
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
                    resolve(stdout || '{}');
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
                    <div class="icon">📋</div>
                    <p>No data loaded.<br/>
                    Click <strong>👁</strong> on a data.frame in the <strong>Environment</strong> tab<br/>
                    to view it here.</p>
                </div>`;
        } else if (this._columns.length === 0) {
            mainContent = `<div class="status-msg">No data available for "${escapeHtml(this._varName)}".</div>`;
        } else {
            const headerCells = this._columns
                .map((col, i) => `<th data-col="${i}" class="sortable">${escapeHtml(col)}</th>`)
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
                                    return '<td>' + (val === null || val === undefined ? '<span class="na">NA</span>' : escapeHtml(String(val))) + '</td>';
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
                                    if (va === null || va === undefined) return 1;
                                    if (vb === null || vb === undefined) return -1;
                                    if (typeof va === 'number' && typeof vb === 'number') {
                                        return sortAsc ? va - vb : vb - va;
                                    }
                                    const sa = String(va), sb = String(vb);
                                    return sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
                                });
                                // Update sort indicators
                                document.querySelectorAll('th.sortable').forEach(t => t.classList.remove('sort-asc','sort-desc'));
                                th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
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
        }
        .toolbar button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
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
        th.sort-asc::after { content: " ▲"; font-size: 9px; opacity: 0.7; }
        th.sort-desc::after { content: " ▼"; font-size: 9px; opacity: 0.7; }
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
        .empty-state {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; height: 100%; text-align: center; opacity: 0.5;
        }
        .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
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
            ${this._varName ? '<button id="btn-refresh" title="Reload data">↻</button>' : ''}
        </div>
    </div>
    <div class="content">${mainContent}</div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.getElementById('btn-refresh')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'refresh' });
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
