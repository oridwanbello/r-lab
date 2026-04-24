import * as vscode from 'vscode';
import { execFile } from 'child_process';

/**
 * Help Panel — runs R help lookups in a background `Rscript` process
 * (completely separate from the R Console), captures the output,
 * and displays the rendered documentation inline.
 *
 * This never touches the user's R Console — no disruption.
 */
export class HelpPanel {
    public static currentPanel: HelpPanel | undefined;
    public static readonly viewType = 'r-quadrant.helpPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _recentSearches: string[] = [];
    private _helpText = '';
    private _lastQuery = '';
    private _isLoading = false;
    private _disposables: vscode.Disposable[] = [];

    // ── Factory ─────────────────────────────────────────────

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Four
    ): HelpPanel {
        if (HelpPanel.currentPanel) {
            HelpPanel.currentPanel._panel.reveal(column, true);
            return HelpPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            HelpPanel.viewType,
            'R Help',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        HelpPanel.currentPanel = new HelpPanel(panel);
        return HelpPanel.currentPanel;
    }

    // ── State Serialization ─────────────────────────────────

    public saveState(): any {
        return {
            recentSearches: this._recentSearches,
            helpText: this._helpText,
            lastQuery: this._lastQuery
        };
    }

    public loadState(state: any): void {
        if (state) {
            this._recentSearches = state.recentSearches || [];
            this._helpText = state.helpText || '';
            this._lastQuery = state.lastQuery || '';
            this._render();
        }
    }

    // ── Constructor ─────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._render();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; query?: string }) => {
                switch (msg.type) {
                    case 'search':
                        if (msg.query) {
                            await this._searchHelp(msg.query);
                        }
                        break;
                    case 'openLink':
                        if (msg.query) {
                            await vscode.env.openExternal(
                                vscode.Uri.parse(msg.query)
                            );
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    // ── R Help via background Rscript ───────────────────────

    private async _searchHelp(query: string): Promise<void> {
        // Update search history
        this._recentSearches = [
            query,
            ...this._recentSearches.filter((s) => s !== query),
        ].slice(0, 8);

        this._lastQuery = query;
        this._isLoading = true;
        this._helpText = '';
        this._render();

        // Build the R expression
        let helpExpr: string;
        if (query.includes('::')) {
            const [pkg, func] = query.split('::');
            helpExpr = `help("${func}", package="${pkg}")`;
        } else {
            helpExpr = `help("${query}")`;
        }

        // R script that prints HTML help text to stdout
        const rScript = [
            `h <- ${helpExpr}`,
            'if (length(h) == 0) {',
            `  cat("<p>No documentation found for: <code>${query}</code></p>")`,
            '} else {',
            '  p <- utils:::.getHelpFile(h)',
            '  tools::Rd2HTML(p, out="")',
            '}'
        ].join('\n');

        try {
            const rscriptPath = await this._findRscript();
            const raw = await this._runRscript(rscriptPath, rScript);
            
            // Extract the body content from the HTML output
            const bodyMatch = raw.match(/<body>([\s\S]*?)<\/body>/i);
            const content = bodyMatch ? bodyMatch[1] : raw;
            
            this._helpText = content;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._helpText = `<p class="error">Error fetching help for "${query}":<br/><br/>${escapeHtml(msg)}</p>`;
        }

        this._isLoading = false;
        this._render();
    }

    /** Find the Rscript binary — works regardless of whether rConsolePath is R, radian, or ark. */
    private _findRscript(): Promise<string> {
        const config = vscode.workspace.getConfiguration('r-quadrant');
        const rPath = config.get<string>('rConsolePath', 'R');
        if (/[/\\]R$/.test(rPath)) {
            return Promise.resolve(rPath.replace(/[/\\]R$/, '/Rscript'));
        }
        if (/[Rr]script$/i.test(rPath)) {
            return Promise.resolve(rPath);
        }
        return new Promise((resolve) => {
            execFile('which', ['Rscript'], (err, stdout) => {
                if (!err && stdout) resolve(stdout.trim());
                else resolve('Rscript');
            });
        });
    }

    /**
     * Runs an R script via `Rscript -e` in the background.
     * Returns stdout. Rejects on error.
     */
    private _runRscript(rscriptPath: string, script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                rscriptPath,
                ['-e', script],
                {
                    timeout: 15000, // 15s timeout
                    maxBuffer: 1024 * 1024, // 1 MB
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                },
                (error, stdout, stderr) => {
                    if (error) {
                        // Include stderr for context (R warnings, etc.)
                        const detail = stderr
                            ? `${error.message}\n\n${stderr}`
                            : error.message;
                        reject(new Error(detail));
                        return;
                    }
                    resolve(stdout || stderr || 'No output');
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

        const recentItems = this._recentSearches
            .map(
                (s) =>
                    `<a href="#" class="recent-link" data-query="${escapeHtml(s)}">?${escapeHtml(s)}</a>`
            )
            .join('');

        // Determine what to show in the main area
        let mainContent: string;
        if (this._isLoading) {
            mainContent = `<div class="status-msg">⏳ Loading help for "${escapeHtml(this._lastQuery)}"…</div>`;
        } else if (this._helpText) {
            mainContent = `
                <div class="help-header">
                    <span class="help-topic">?${escapeHtml(this._lastQuery)}</span>
                </div>
                <div class="help-html-content">${this._helpText}</div>`;
        } else {
            mainContent = `
                <div class="empty-state">
                    <p class="tip">
                        Type a function or package name and press <strong>Enter</strong>.<br/>
                        Help will be displayed here — just like RStudio.<br/><br/>
                        <code>mean</code> · <code>dplyr::filter</code> · <code>ggplot2</code>
                    </p>
                    ${
                        this._recentSearches.length > 0
                            ? `<div class="recent-section">
                                   <span class="section-label">Recent</span>
                                   <div class="recent-links">${recentItems}</div>
                               </div>`
                            : ''
                    }
                    <div class="quick-links">
                        <span class="section-label">Quick Reference</span>
                        <div class="links-grid">
                            <a class="link-card" data-url="https://www.rdocumentation.org">📖 R Docs</a>
                            <a class="link-card" data-url="https://cran.r-project.org/manuals.html">📚 CRAN</a>
                            <a class="link-card" data-url="https://www.tidyverse.org">🔧 Tidyverse</a>
                            <a class="link-card" data-url="https://www.bioconductor.org">🧬 Bioconductor</a>
                        </div>
                    </div>
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
        /* Code Block Styling using VS Code theme variables */
        pre {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-editor-foreground);
            border-radius: 4px; padding: 10px; overflow-x: auto; margin: 10px 0;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        code {
            font-family: var(--vscode-editor-font-family, monospace);
        }
        p > code, li > code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px; border-radius: 3px;
        }

        /* Native R Syntax Highlighting Colors */
        .token.keyword { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
        .token.string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
        .token.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
        .token.comment { color: var(--vscode-editorLineNumber-foreground, #6a9955); font-style: italic; }
        .token.boolean { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
        .token.function { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
        .token.operator { color: var(--vscode-editor-foreground); }
        * { margin: 0; padding: 0; box-sizing: border-box; }
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
            justify-content: space-between;
            padding: 6px 12px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }
        .pane-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7; }
        .search-bar {
            display: flex; gap: 6px; padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }
        .search-bar input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 5px 10px; border-radius: 4px; font-size: 13px; outline: none;
        }
        .search-bar input:focus { border-color: var(--vscode-focusBorder); }
        .search-bar input::placeholder { color: var(--vscode-input-placeholderForeground); }
        .search-bar button {
            background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600;
        }
        .search-bar button:hover { background: var(--vscode-button-hoverBackground); }
        .content { flex: 1; overflow: auto; }
        .status-msg { padding: 20px; text-align: center; opacity: 0.6; }
        .help-header {
            padding: 8px 14px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            position: sticky; top: 0; z-index: 1;
        }
        .help-topic {
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px; font-weight: 600;
            color: var(--vscode-textLink-foreground);
        }
        .help-html-content {
            padding: 16px 20px;
            font-size: 13px; line-height: 1.6;
        }
        .help-html-content h2, .help-html-content h3 {
            margin-top: 1.5em; margin-bottom: 0.8em;
            color: var(--vscode-editor-foreground);
            font-weight: 600;
            border-bottom: 3px double currentColor;
            padding-bottom: 4px;
        }
        .help-html-content h2 { font-size: 16px; }
        .help-html-content h3 { font-size: 14px; }
        .help-html-content pre {
            padding: 0;
            border-radius: 4px;
            overflow-x: auto;
            margin: 10px 0;
        }
        .help-html-content p { margin-bottom: 1em; }
        .help-html-content a { color: var(--vscode-textLink-foreground); text-decoration: none; }
        .help-html-content a:hover { text-decoration: underline; }
        .help-html-content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .help-html-content th, .help-html-content td {
            text-align: left; padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        .help-html-content th { font-weight: 600; }
        .empty-state { padding: 20px; }
        .tip { font-size: 13px; opacity: 0.6; line-height: 1.7; margin-bottom: 18px; }
        .tip code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 5px; border-radius: 3px; font-size: 12px;
        }
        .section-label {
            display: block; font-size: 11px; text-transform: uppercase;
            letter-spacing: 0.5px; opacity: 0.5; margin-bottom: 6px; margin-top: 14px;
        }
        .recent-links { display: flex; flex-wrap: wrap; gap: 6px; }
        .recent-link {
            color: var(--vscode-textLink-foreground); text-decoration: none;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 12px; cursor: pointer;
            padding: 3px 8px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-radius: 4px;
        }
        .recent-link:hover { text-decoration: underline; }
        .links-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .link-card {
            display: block; padding: 8px 10px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border: 1px solid var(--vscode-editorGroup-border);
            border-radius: 6px; text-decoration: none;
            color: var(--vscode-foreground); font-size: 12px; cursor: pointer;
        }
        .link-card:hover { background: var(--vscode-list-hoverBackground); }
    </style>
</head>
<body>
    <div class="toolbar"><span class="pane-title">R Help</span></div>
    <div class="search-bar">
        <input id="search-input" type="text"
               placeholder="Search R help… e.g. mean, dplyr::filter"
               value="${escapeHtml(this._lastQuery)}" />
        <button id="btn-search">?</button>
    </div>
    <div class="content">${mainContent}</div>
    <script nonce="${nonce}">
        (function() {
            // Minimal zero-dependency R syntax highlighter
            function highlightR(code) {
                const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const regex = /(#[^\\n]*)|((["'])(?:(?=(\\\\?))\\4.)*?\\3)|\\b(if|else|repeat|while|function|for|in|next|break|TRUE|FALSE|NULL|Inf|NaN|NA)\\b|\\b(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b|\\b([a-zA-Z._][a-zA-Z0-9._]*\\b)(?=\\s*\\()|(\\+|\\-|\\*|\\/|\\^|%%|%\\/%|%\\*%|%o%|%x%|%in%|&lt;-|&lt;&lt;-|-&gt;|-&gt;&gt;|=|==|!=|&lt;=|&gt;=|&lt;|&gt;|!|&|&&|\\||\\|\\|)/g;
                return escaped.replace(regex, (match, comment, string, q1, q2, keyword, number, func, operator) => {
                    if (comment) return '<span class="token comment">' + comment + '</span>';
                    if (string) return '<span class="token string">' + string + '</span>';
                    if (keyword) return '<span class="token keyword">' + keyword + '</span>';
                    if (number) return '<span class="token number">' + number + '</span>';
                    if (func) return '<span class="token function">' + func + '</span>';
                    if (operator) return '<span class="token operator">' + operator + '</span>';
                    return match;
                });
            }

            document.querySelectorAll('pre').forEach((block) => {
                // R's Rd2HTML output contains raw text in <pre>. We highlight it directly.
                const raw = block.textContent || "";
                block.innerHTML = highlightR(raw);
            });

            const vscode = acquireVsCodeApi();
            const input = document.getElementById('search-input');

            function doSearch() {
                const q = input.value.trim();
                if (q) { vscode.postMessage({ type: 'search', query: q }); }
            }
            document.getElementById('btn-search')?.addEventListener('click', doSearch);
            input?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

            document.querySelectorAll('.link-card').forEach(c => {
                c.addEventListener('click', () => {
                    const url = c.getAttribute('data-url');
                    if (url) vscode.postMessage({ type: 'openLink', query: url });
                });
            });
            document.querySelectorAll('.recent-link').forEach(l => {
                l.addEventListener('click', e => {
                    e.preventDefault();
                    const q = l.getAttribute('data-query');
                    if (q) { input.value = q; vscode.postMessage({ type: 'search', query: q }); }
                });
            });
        })();
    </script>
</body>
</html>`;
    }

    // ── Cleanup ─────────────────────────────────────────────

    dispose(): void {
        HelpPanel.currentPanel = undefined;
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

/**
 * Strips terminal overstrike sequences from R's Rd2txt output.
 *
 * R uses two overstrike conventions:
 *   Bold:      char + \b + char  →  e.g. "L\bL" displays as bold L
 *   Underline: _ + \b + char     →  e.g. "_\bL" displays as underlined L
 *              (headers show as _L_o_a_d when \b is lost in pipe capture)
 *
 * We strip both forms and also remove any remaining bare ANSI escape codes.
 */
function stripTerminalFormatting(text: string): string {
    return text
        // Remove overstrike: "X\bX" (bold) → "X"
        .replace(/.\x08/g, '')
        // Remove underscore-letter overstrike remnants: "_L" style headers
        // Pattern: repeated _CHAR sequence like _L_o_a_d_i_n_g
        .replace(/(?:_([A-Za-z\/]))+/g, (match) => {
            // Extract just the letters/slashes
            return match.replace(/_/g, '');
        })
        // Remove ANSI escape codes
        .replace(/\x1b\[[0-9;]*m/g, '')
        // Normalize any remaining stray backspaces
        .replace(/\x08/g, '');
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
