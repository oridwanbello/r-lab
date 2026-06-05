import * as vscode from 'vscode';
import { getNonce, escapeHtml } from '../utils/webviewUtils';

/**
 * Problems Panel - a WebviewPanel (editor tab) that mirrors
 * VS Code's built-in Problems view by displaying diagnostics
 * from `vscode.languages.getDiagnostics()`.
 *
 * Opens in ViewColumn.Two (bottom-left layout) alongside
 * R Console and Terminal tabs.
 */
export class ProblemsPanel {
    public static currentPanel: ProblemsPanel | undefined;
    public static readonly viewType = 'r-layout.problemsPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _diagnosticsListener?: vscode.Disposable;
    private _disposables: vscode.Disposable[] = [];

    // Factory

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
                enableFindWidget: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        ProblemsPanel.currentPanel = new ProblemsPanel(panel);
        return ProblemsPanel.currentPanel;
    }

    // Constructor

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

    // Rendering

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

            const fileProblemCount = diagnostics.length;

            fileGroups.push(`
                <div class="file-group expanded">
                    <div class="file-header">
                        <div class="file-header-left">
                            <i class="codicon codicon-chevron-right chevron"></i>
                            <span class="file-name">${escapeHtml(fileName)}</span>
                        </div>
                        <span class="file-badge">${fileProblemCount}</span>
                    </div>
                    <div class="file-content">
                        <table>${rows}</table>
                    </div>
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
                   style-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
                   font-src https://cdn.jsdelivr.net;
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.min.css" rel="stylesheet">
    <style nonce="${nonce}">
        * { margin: 0; padding: 0; box-sizing: border-box; }
        ::selection { background: var(--vscode-editor-selectionBackground); color: var(--vscode-editor-selectionForeground); }
        body {
            font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
            font-size: var(--vscode-editor-font-size, var(--vscode-font-size, 13px));
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
            padding: 0 12px 0 16px;
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
        .pane-title { font-weight: 600; text-transform: uppercase; opacity: 0.7; }
        .summary { opacity: 0.7; }
        .content { flex: 1; overflow: auto; }
        .file-group { margin-bottom: 2px; }
        .file-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 12px 4px 16px;
            color: var(--vscode-textLink-foreground);
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            position: sticky;
            top: 0;
            z-index: 1;
            cursor: pointer;
        }
        .file-header:hover {
            background: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-editor-background);
        }
        .file-header-left {
            display: flex;
            align-items: center;
        }
        .file-name { font-weight: 600; }
        .chevron {
            margin-right: 4px;
            transition: transform 0.1s;
            font-size: 1.3em;
        }
        .file-group.expanded .chevron {
            transform: rotate(90deg);
        }
        .file-content {
            display: none;
        }
        .file-group.expanded .file-content {
            display: block;
        }
        .file-badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 11px;
            font-size: 0.9em;
            font-weight: 600;
            line-height: 1;
            min-width: 18px;
            text-align: center;
        }
        table { width: 100%; border-collapse: collapse; }
        .diag-row { cursor: pointer; }
        .diag-row:hover td { background: var(--vscode-list-hoverBackground); }
        td { padding: 4px 6px; vertical-align: top; }
        .icon-col { width: 36px; text-align: center; vertical-align: middle; padding-left: 16px !important; }
        .icon-col i { font-size: 1.3em; }
        .loc-col { width: 50px; opacity: 0.6; font-family: var(--vscode-editor-font-family, monospace); vertical-align: middle; }
        .msg-col { word-break: break-word; white-space: normal; vertical-align: middle; }
        
        .icon-error { color: var(--vscode-problemsErrorIcon-foreground, var(--vscode-editorError-foreground, #f14c4c)); }
        .icon-warning { color: var(--vscode-problemsWarningIcon-foreground, var(--vscode-editorWarning-foreground, #cca700)); }
        .icon-info { color: var(--vscode-problemsInfoIcon-foreground, var(--vscode-editorInfo-foreground, #3794ff)); }
        
        /* Empty State Styling */
        .empty-state {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            height: 100%; text-align: center; opacity: 0.3;
        }
        .empty-state svg { width: 5em; height: 5em; margin-bottom: 16px; display: inline-block; }
        .empty-state p { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
    </style>
</head>
<body>
    <div class="toolbar">
        <span class="summary">${totalCount > 0 ? summary : ''}</span>
    </div>
    <div class="content">
        ${
            totalCount > 0
                ? fileGroups.join('')
                : `<div class="empty-state">
                       <svg viewBox="0 0 16 16"><path fill="currentColor" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/></svg>
                       <p>No problems detected!</p>
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

            // File Group Collapsible Logic
            document.querySelectorAll('.file-header').forEach(header => {
                header.addEventListener('click', () => {
                    header.parentElement.classList.toggle('expanded');
                });
            });
        })();
    </script>
</body>
</html>`;
    }

    // Cleanup

    dispose(): void {
        ProblemsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

//  Utility

function severityIcon(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error: return '<i class="codicon codicon-error icon-error"></i>';
        case vscode.DiagnosticSeverity.Warning: return '<i class="codicon codicon-warning icon-warning"></i>';
        case vscode.DiagnosticSeverity.Information: return '<i class="codicon codicon-info icon-info"></i>';
        case vscode.DiagnosticSeverity.Hint: return '<i class="codicon codicon-lightbulb icon-info"></i>';
        default: return '<i class="codicon codicon-record"></i>';
    }
}


