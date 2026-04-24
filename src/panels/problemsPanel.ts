import * as vscode from 'vscode';

/**
 * Problems Panel — a WebviewPanel (editor tab) that mirrors
 * VS Code's built-in Problems view by displaying diagnostics
 * from `vscode.languages.getDiagnostics()`.
 *
 * Opens in ViewColumn.Two (bottom-left quadrant) alongside
 * R Console and Terminal tabs.
 */
export class ProblemsPanel {
    public static currentPanel: ProblemsPanel | undefined;
    public static readonly viewType = 'r-quadrant.problemsPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _diagnosticsListener?: vscode.Disposable;
    private _disposables: vscode.Disposable[] = [];

    // ── Factory ─────────────────────────────────────────────

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Two
    ): ProblemsPanel {
        if (ProblemsPanel.currentPanel) {
            ProblemsPanel.currentPanel._panel.reveal(column, true);
            return ProblemsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ProblemsPanel.viewType,
            'Problems',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        ProblemsPanel.currentPanel = new ProblemsPanel(panel);
        return ProblemsPanel.currentPanel;
    }

    // ── Constructor ─────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._render();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Auto-refresh when diagnostics change
        this._diagnosticsListener = vscode.languages.onDidChangeDiagnostics(
            () => this._render()
        );
        this._disposables.push(this._diagnosticsListener);

        // Handle navigation clicks
        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; file?: string; line?: number }) => {
                if (msg.type === 'openFile' && msg.file) {
                    const uri = vscode.Uri.parse(msg.file);
                    const line = msg.line ?? 0;
                    await vscode.window.showTextDocument(uri, {
                        viewColumn: vscode.ViewColumn.One,
                        selection: new vscode.Range(line, 0, line, 0),
                        preserveFocus: false,
                    });
                }
            },
            null,
            this._disposables
        );
    }

    // ── Rendering ───────────────────────────────────────────

    private _render(): void {
        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const nonce = getNonce();
        const allDiagnostics = vscode.languages.getDiagnostics();

        let errorCount = 0;
        let warningCount = 0;
        let infoCount = 0;

        const fileGroups: string[] = [];

        for (const [uri, diagnostics] of allDiagnostics) {
            if (diagnostics.length === 0) { continue; }

            const fileName = vscode.workspace.asRelativePath(uri);
            const rows = diagnostics
                .sort((a, b) => a.range.start.line - b.range.start.line)
                .map((d) => {
                    const icon = severityIcon(d.severity);
                    const line = d.range.start.line + 1;
                    const col = d.range.start.character + 1;
                    const src = d.source ? `[${escapeHtml(d.source)}] ` : '';

                    if (d.severity === vscode.DiagnosticSeverity.Error) { errorCount++; }
                    else if (d.severity === vscode.DiagnosticSeverity.Warning) { warningCount++; }
                    else { infoCount++; }

                    return `<tr class="diag-row"
                                data-file="${escapeHtml(uri.toString())}"
                                data-line="${d.range.start.line}">
                        <td class="icon-col">${icon}</td>
                        <td class="loc-col">${line}:${col}</td>
                        <td class="msg-col">${src}${escapeHtml(d.message)}</td>
                    </tr>`;
                })
                .join('');

            fileGroups.push(`
                <div class="file-group">
                    <div class="file-header">${escapeHtml(fileName)}</div>
                    <table>${rows}</table>
                </div>
            `);
        }

        const totalCount = errorCount + warningCount + infoCount;
        const summaryParts: string[] = [];
        if (errorCount > 0) { summaryParts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`); }
        if (warningCount > 0) { summaryParts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`); }
        if (infoCount > 0) { summaryParts.push(`${infoCount} info`); }
        const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'No problems';

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
        .pane-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7; }
        .summary { font-size: 11px; opacity: 0.7; }
        .content { flex: 1; overflow: auto; }
        .file-group { margin-bottom: 2px; }
        .file-header {
            padding: 4px 12px;
            font-weight: 600;
            font-size: 11px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            position: sticky;
            top: 0;
            z-index: 1;
        }
        table { width: 100%; border-collapse: collapse; }
        .diag-row { cursor: pointer; }
        .diag-row:hover td { background: var(--vscode-list-hoverBackground); }
        td { padding: 3px 6px; vertical-align: top; border-bottom: 1px solid var(--vscode-editorGroup-border); }
        .icon-col { width: 20px; text-align: center; }
        .loc-col { width: 50px; opacity: 0.6; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
        .msg-col { word-break: break-word; white-space: normal; }
        .empty-state {
            display: flex; align-items: center; justify-content: center;
            height: 100%; text-align: center; opacity: 0.5;
        }
        .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
        .empty-state p { font-size: 13px; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="toolbar">
        <span class="pane-title">Problems</span>
        <span class="summary">${summary}</span>
    </div>
    <div class="content">
        ${
            totalCount > 0
                ? fileGroups.join('')
                : `<div class="empty-state">
                       <div>
                           <div class="icon">✅</div>
                           <p>No problems detected.</p>
                       </div>
                   </div>`
        }
    </div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.querySelectorAll('.diag-row').forEach(row => {
                row.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'openFile',
                        file: row.getAttribute('data-file'),
                        line: parseInt(row.getAttribute('data-line') || '0', 10)
                    });
                });
            });
        })();
    </script>
</body>
</html>`;
    }

    // ── Cleanup ─────────────────────────────────────────────

    dispose(): void {
        ProblemsPanel.currentPanel = undefined;
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

function severityIcon(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return '⊘';
        case vscode.DiagnosticSeverity.Warning: return '⚠';
        case vscode.DiagnosticSeverity.Information: return 'ℹ';
        case vscode.DiagnosticSeverity.Hint: return '💡';
        default: return '•';
    }
}

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
