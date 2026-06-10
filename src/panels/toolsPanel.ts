import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { getNonce, escapeHtml } from '../utils/webviewUtils';
import { getRConsoleTerminal, recordLayoutFocus } from '../layout/layoutManager';
import { getRscriptPath } from '../utils/rPathResolver';

type ToolTab = 'problems' | 'help';

interface ToolsState {
    activeTab?: ToolTab;
    recentSearches?: string[];
    helpText?: string;
    lastQuery?: string;
}

export class ToolsPanel {
    public static currentPanel: ToolsPanel | undefined;
    public static readonly viewType = 'r-layout.toolsPanel';
    public static lastClosedState: ToolsState | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _activeTab: ToolTab = 'help';
    private _recentSearches: string[] = [];
    private _helpText = '';
    private _lastQuery = '';
    private _isLoading = false;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Two
    ): ToolsPanel {
        if (ToolsPanel.currentPanel) {
            ToolsPanel.currentPanel._panel.reveal(column, true);
            return ToolsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ToolsPanel.viewType,
            'Tools',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        ToolsPanel.currentPanel = new ToolsPanel(panel, extensionUri);
        return ToolsPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._render();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.active) {
                    recordLayoutFocus('Tools', e.webviewPanel.viewColumn);
                }
            },
            null,
            this._disposables
        );

        this._disposables.push(vscode.languages.onDidChangeDiagnostics(() => {
            if (this._activeTab === 'problems') {
                this._render();
            }
        }));

        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; tab?: ToolTab; file?: string; line?: number; query?: string }) => {
                switch (msg.type) {
                    case 'switchTab':
                        if (msg.tab === 'problems' || msg.tab === 'help') {
                            this._activeTab = msg.tab;
                            this._render();
                        }
                        break;
                    case 'openFile':
                        if (msg.file) {
                            const uri = vscode.Uri.parse(msg.file);
                            const line = msg.line ?? 0;
                            await vscode.window.showTextDocument(uri, {
                                viewColumn: vscode.ViewColumn.One,
                                selection: new vscode.Range(line, 0, line, 0),
                                preserveFocus: false,
                            });
                        }
                        break;
                    case 'search':
                        if (msg.query) {
                            await this._searchHelp(msg.query);
                        }
                        break;
                    case 'goHome':
                        this._helpText = '';
                        this._lastQuery = '';
                        this._activeTab = 'help';
                        this._render();
                        break;
                    case 'openLink':
                        if (msg.query) {
                            await vscode.env.openExternal(vscode.Uri.parse(msg.query));
                        }
                        break;
                    case 'runCode':
                        if (msg.query) {
                            const term = getRConsoleTerminal();
                            if (term) {
                                term.show(false);
                                term.sendText(msg.query);
                            } else {
                                vscode.window.showErrorMessage('R Console terminal not found. Please activate the layout first.');
                            }
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public reveal(column?: vscode.ViewColumn, preserveFocus: boolean = true): void {
        this._panel.reveal(column, preserveFocus);
    }

    public revealTool(tab: ToolTab, column?: vscode.ViewColumn, preserveFocus: boolean = true): void {
        this._activeTab = tab;
        this._render();
        this._panel.reveal(column, preserveFocus);
    }

    public saveState(): ToolsState {
        return {
            activeTab: this._activeTab,
            recentSearches: this._recentSearches,
            helpText: this._helpText,
            lastQuery: this._lastQuery,
        };
    }

    public loadState(state: ToolsState | undefined): void {
        if (!state) { return; }
        this._activeTab = state.activeTab === 'problems' ? 'problems' : 'help';
        this._recentSearches = state.recentSearches || [];
        this._helpText = state.helpText || '';
        this._lastQuery = state.lastQuery || '';
        this._render();
    }

    private async _searchHelp(query: string): Promise<void> {
        this._recentSearches = [
            query,
            ...this._recentSearches.filter((s) => s !== query),
        ].slice(0, 8);

        this._activeTab = 'help';
        this._lastQuery = query;
        this._isLoading = true;
        this._helpText = '';
        this._render();

        const toRString = (str: string) => {
            if (!str) { return '""'; }
            const codes = Array.from(str).map(c => c.charCodeAt(0)).join(',');
            return `intToUtf8(c(${codes}))`;
        };

        const rQuery = toRString(query);
        let helpExpr: string;
        if (query.includes('::')) {
            const [pkg, func] = query.split('::');
            helpExpr = `help(${toRString(func)}, package=${toRString(pkg)})`;
        } else {
            helpExpr = `help(${rQuery}, package = .packages(all.available = TRUE))`;
        }

        const rScript = [
            `options(help_type = "text")`,
            `query <- ${rQuery}`,
            `print_pkg <- function(h) {`,
            `  cat(paste0("<h2>Package '", h$name, "'</h2>\\n"))`,
            `  if (length(h$info) >= 1) {`,
            `    cat("<h3>Description</h3><pre class='package-description'>\\n")`,
            `    cat(paste0(h$info[[1]], collapse="\\n"), "</pre>\\n")`,
            `  }`,
            `  if (length(h$info) >= 2 && length(h$info[[2]]) > 0) {`,
            `    cat("<h3>Index</h3><pre class='package-index'>\\n")`,
            `    cat(paste0(h$info[[2]], collapse="\\n"), "</pre>\\n")`,
            `  }`,
            `}`,
            `is_pkg <- !grepl("::", query) && (query %in% .packages(all.available = TRUE))`,
            `success <- FALSE`,
            `if (is_pkg) {`,
            `  h_pkg <- tryCatch(help(package = (query)), error = function(e) NULL)`,
            `  if (!is.null(h_pkg)) {`,
            `     cat("<div class='container'><main>")`,
            `     print_pkg(h_pkg)`,
            `     cat("</main></div>")`,
            `     success <- TRUE`,
            `  }`,
            `}`,
            `if (!success) {`,
            `  h <- tryCatch(${helpExpr}, error = function(e) NULL)`,
            `  if (!is.null(h) && length(h) > 0) {`,
            `    if (length(h) > 1) {`,
            `       pkgs <- basename(dirname(dirname(h)))`,
            `       cat("<div class='help-html-content'>")`,
            `       cat(paste0("<h2>Multiple Matches Found</h2><p>Documentation for <code>", query, "</code> was found in multiple packages. Please select one:</p><ul style='list-style: none; padding-left: 0;'>"))`,
            `       for (pkg in pkgs) {`,
            `          cat(paste0("<li style='margin-bottom: 8px;'><a href='#' class='pkg-func-link' data-query='", pkg, "::", query, "'><b>", pkg, "</b>::", query, "</a></li>"))`,
            `       }`,
            `       cat("</ul></div>")`,
            `    } else {`,
            `       p <- utils:::.getHelpFile(h)`,
            `       pkg <- basename(dirname(dirname(h[1])))`,
            `       html_out <- capture.output(tools::Rd2HTML(p))`,
            `       html_str <- paste(html_out, collapse="\\n")`,
            `       html_str <- sub("R Documentation", pkg, html_str, fixed=TRUE)`,
            `       cat(html_str)`,
            `    }`,
            `  } else {`,
            `    h_pkg <- tryCatch(help(package = (query)), error = function(e) NULL)`,
            `    if (!is.null(h_pkg)) {`,
            `       cat("<div class='container'><main>")`,
            `       print_pkg(h_pkg)`,
            `       cat("</main></div>")`,
            `    } else {`,
            `       cat(paste0("<div class='status-msg'>No documentation found for: <code>", query, "</code></div>"))`,
            `    }`,
            `  }`,
            `}`
        ].join('\n');

        try {
            const rscriptPath = await getRscriptPath();
            const raw = await this._runRscript(rscriptPath, rScript);
            const bodyMatch = raw.match(/<body>([\s\S]*?)<\/body>/i);
            let content = bodyMatch ? bodyMatch[1] : raw;

            content = content.replace(
                /<table[^>]*>.*?<tr>\s*<td>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>.*?<\/table>/is,
                '<div class="help-top-title">$1 {$2}</div>'
            );
            content = content.replace(
                /<img\s[^>]*src="[^"]*lifecycle[- _]([a-z-]+)\.svg"[^>]*>/gi,
                (_match, stage: string) => {
                    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
                    return `<span class="lifecycle-badge lifecycle-${stage.toLowerCase()}">${label}</span>`;
                }
            );
            content = content.replace(
                /<img\s[^>]*src="(?!https?:\/\/|data:)[^"]*"[^>]*>/gi,
                ''
            );

            this._helpText = content;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._helpText = `<p class="error">Error fetching help for "${escapeHtml(query)}":<br><br>${escapeHtml(msg)}</p>`;
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
                    timeout: 15000,
                    maxBuffer: 1024 * 1024,
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
                },
                (error, stdout, stderr) => {
                    if (error) {
                        const detail = stderr ? `${error.message}\n\n${stderr}` : error.message;
                        reject(new Error(detail));
                        return;
                    }
                    resolve(stdout || stderr || 'No output');
                }
            );
        });
    }

    private _render(): void {
        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const nonce = getNonce();
        const cspSource = this._panel.webview.cspSource;
        const codicons = this._activeTab === 'problems'
            ? '<link href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.min.css" rel="stylesheet">'
            : '';
        const katex = this._activeTab === 'help'
            ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
               <script src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>`
            : '';

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${cspSource} https: data:;
                   font-src https://cdn.jsdelivr.net;
                   style-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
                   script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${codicons}
    ${katex}
    <style nonce="${nonce}">
        * { margin: 0; padding: 0; box-sizing: border-box; }
        ::selection { background: var(--vscode-editor-selectionBackground); color: var(--vscode-editor-selectionForeground); }
        html, body {
            height: 100%;
        }
        body {
            font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
            font-weight: 400;
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100%;
            overflow: hidden;
        }
        .tabs {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            align-items: stretch;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            background: var(--vscode-editor-background);
            flex-shrink: 0;
            overflow: hidden;
            min-width: 0;
        }
        .tab {
            min-width: 0;
            padding: 8px 10px;
            cursor: pointer;
            opacity: 0.6;
            font-size: var(--vscode-font-size, 13px);
            font-weight: normal;
            letter-spacing: 0.3px;
            white-space: nowrap;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            position: relative;
            overflow: hidden;
            text-overflow: ellipsis;
            background: transparent;
            color: var(--vscode-editor-foreground);
            border: 0;
        }
        .tab-label {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .tab:not(:last-child) { border-right: 1px solid var(--vscode-editorGroup-border); }
        .tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        .tab.active {
            opacity: 1;
            color: var(--vscode-foreground);
        }
        .tab.active::after {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 3px;
            background: var(--vscode-button-background);
        }
        .tool-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .problems-view {
            flex: 1;
            min-height: 0;
            display: flex;
            flex-direction: column;
            font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
            font-size: var(--vscode-editor-font-size, var(--vscode-font-size, 13px));
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
        .summary { opacity: 0.7; }
        .content { flex: 1; overflow: auto; }
        .status-msg {
            min-height: 100%;
            padding: 20px;
            text-align: center;
            opacity: 0.6;
            display: flex;
            align-items: center;
            justify-content: center;
        }
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
        .file-header-left { display: flex; align-items: center; }
        .file-name { font-weight: 600; }
        .chevron { margin-right: 4px; transition: transform 0.1s; font-size: 1.3em; }
        .file-group.expanded .chevron { transform: rotate(90deg); }
        .file-content { display: none; }
        .file-group.expanded .file-content { display: block; }
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
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            text-align: center;
            opacity: 0.3;
        }
        .empty-state svg { width: 5em; height: 5em; margin-bottom: 16px; display: inline-block; }
        .empty-state p {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
            line-height: 1.6;
        }
        pre {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-editor-foreground);
            border-radius: 6px;
            padding: 10px;
            overflow-x: auto;
            margin: 10px 0;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        code { font-family: var(--vscode-editor-font-family, monospace); }
        p > code, li > code { padding: 2px 4px; border-radius: 6px; }
        body.vscode-light .token.keyword { color: #0000FF; }
        body.vscode-light .token.string { color: #A31515; }
        body.vscode-light .token.number { color: #098658; }
        body.vscode-light .token.comment { color: #008000; font-style: italic; }
        body.vscode-light .token.function { color: #795E26; }
        body.vscode-light .token.operator { color: #000000; }
        body.vscode-dark .token.keyword { color: #569cd6; }
        body.vscode-dark .token.string { color: #ce9178; }
        body.vscode-dark .token.number { color: #b5cea8; }
        body.vscode-dark .token.comment { color: #6a9955; font-style: italic; }
        body.vscode-dark .token.function { color: #dcdcaa; }
        body.vscode-dark .token.operator { color: #d4d4d4; }
        .search-bar {
            display: flex;
            gap: 6px;
            padding: 8px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
            align-items: center;
        }
        .search-bar input {
            flex: 1;
            min-width: 0;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 5px 10px;
            border-radius: 6px;
            font-size: var(--vscode-font-size, 13px);
            outline: none;
        }
        .search-bar input:focus { border-color: var(--vscode-focusBorder); }
        .search-bar input::placeholder { color: var(--vscode-input-placeholderForeground); }
        .search-bar button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 1.1em;
            font-weight: 600;
        }
        .search-bar button:hover { background: var(--vscode-button-hoverBackground); }
        .btn-home {
            background: none !important;
            color: var(--vscode-foreground) !important;
            opacity: 0.6;
            padding: 5px 8px !important;
        }
        .btn-home:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground) !important; }
        .btn-home svg { width: 16px; height: 16px; display: block; }
        .loading-msg { gap: 4px; }
        .loading-var {
            color: var(--vscode-textPreformat-foreground, var(--vscode-editor-foreground));
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .help-html-content {
            padding: 16px 20px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
            line-height: 1.6;
        }
        h3 {
            margin-bottom: 1em;
            color: var(--vscode-editor-foreground);
            font-weight: 700;
            font-family: var(--vscode-font-family);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            padding-bottom: 8px;
            position: relative;
            font-size: var(--vscode-font-size, 13px);
        }
        h3::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            width: 40px;
            height: 3px;
            background: var(--vscode-textLink-foreground);
            border-radius: 6px;
        }
        h2 {
            font-size: 1.1em;
            text-align: center;
            font-weight: 700;
            font-family: var(--vscode-font-family);
            margin-bottom: 0.75em;
            color: var(--vscode-editor-foreground);
        }
        .help-top-title {
            font-size: 0.9em;
            opacity: 0.7;
            margin-bottom: 0.75em;
            font-weight: 600;
        }
        pre.package-index, pre.package-description {
            background: transparent !important;
            padding: 0 !important;
            border: none !important;
            margin: 0 0 2em 0 !important;
            font-family: var(--vscode-editor-font-family, monospace) !important;
        }
        .help-html-content h2, .help-html-content h3 { margin-top: 1.1em; }
        .empty-help { padding: 20px; opacity: 1; }
        .empty-help h2 {
            margin-top: 1.5em;
            text-align: left;
            margin-bottom: 1em;
            color: var(--vscode-editor-foreground);
            font-weight: 700;
            font-family: var(--vscode-font-family);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            padding-bottom: 8px;
            position: relative;
            font-size: var(--vscode-font-size, 13px);
        }
        .empty-help h2::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            width: 40px;
            height: 3px;
            background: var(--vscode-textLink-foreground);
            border-radius: 6px;
        }
        .help-html-content pre {
            position: relative;
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            margin: 10px 0;
        }
        .run-code-btn {
            position: absolute;
            top: 6px;
            right: 6px;
            background: var(--vscode-button-secondaryBackground, rgba(130, 130, 130, 0.15));
            color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
            border: 1px solid var(--vscode-editorGroup-border);
            padding: 3px 10px;
            border-radius: 4px;
            font-size: 0.9em;
            font-weight: 600;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s ease, background-color 0.2s ease;
        }
        .help-html-content pre:hover .run-code-btn { opacity: 1; }
        .run-code-btn:hover {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .help-html-content p { margin-bottom: 1em; }
        .help-html-content a { color: var(--vscode-textLink-foreground); text-decoration: none; }
        .help-html-content a:hover { text-decoration: underline; }
        .help-html-content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .help-html-content th, .help-html-content td {
            text-align: left;
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        .help-html-content th { font-weight: 600; }
        .recent-links { display: flex; flex-wrap: wrap; gap: 6px; }
        .recent-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em;
            cursor: pointer;
            padding: 3px 8px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-radius: 6px;
        }
        .recent-link:hover { text-decoration: underline; }
        .links-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .link-card {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border: 1px solid var(--vscode-editorGroup-border);
            border-radius: 6px;
            text-decoration: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            white-space: nowrap;
            font-family: var(--vscode-font-family);
            font-weight: 600;
        }
        .link-card .icon { width: 20px; height: 20px; flex-shrink: 0; }
        .link-card .icon-wide { height: 20px; width: auto; flex-shrink: 0; }
        .link-card:hover { background: var(--vscode-list-hoverBackground); }
        .lifecycle-badge {
            display: inline-block;
            font-size: 0.85em;
            font-weight: 600;
            padding: 1px 7px;
            border-radius: 4px;
            vertical-align: middle;
            border: 1px solid;
        }
        .lifecycle-stable { background: #d0f0d0; color: #1a7a1a; border-color: #a0d0a0; }
        .lifecycle-experimental { background: #fff3cd; color: #856404; border-color: #ffc107; }
        .lifecycle-deprecated { background: #fdd; color: #c33; border-color: #e99; }
        .lifecycle-superseded { background: #d0e8ff; color: #2060a0; border-color: #a0c8f0; }
        .lifecycle-defunct { background: #e0e0e0; color: #666; border-color: #bbb; }
        .lifecycle-questioning { background: #e8d8f0; color: #6a3d7d; border-color: #c8a8d8; }
        .lifecycle-maturing { background: #d0f0d0; color: #1a7a1a; border-color: #a0d0a0; }
        .lifecycle-soft-deprecated { background: #fdd; color: #c33; border-color: #e99; }
        .lifecycle-archived { background: #e0e0e0; color: #666; border-color: #bbb; }
        .package-index {
            background: none !important;
            padding: 0 !important;
            border: none !important;
            margin: 0 !important;
            white-space: pre !important;
            overflow-x: auto !important;
            font-family: var(--vscode-editor-font-family, monospace) !important;
            font-size: var(--vscode-font-size, 13px) !important;
            line-height: 1.6 !important;
        }
        .pkg-func-link, .external-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        .pkg-func-link:hover, .external-link:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="tabs">
        <button class="tab ${this._activeTab === 'help' ? 'active' : ''}" data-tab="help"><span class="tab-label">R Help</span></button>
        <button class="tab ${this._activeTab === 'problems' ? 'active' : ''}" data-tab="problems"><span class="tab-label">Problems</span></button>
    </div>
    <div class="tool-body">
        ${this._activeTab === 'problems' ? this._getProblemsBody() : this._getHelpBody(nonce)}
    </div>
    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            document.querySelectorAll('.tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    vscode.postMessage({ type: 'switchTab', tab: tab.getAttribute('data-tab') });
                });
            });
            ${this._activeTab === 'problems' ? this._getProblemsScript() : this._getHelpScript()}
        })();
    </script>
</body>
</html>`;
    }

    private _getProblemsBody(): string {
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

                    return `<tr class="diag-row" data-file="${escapeHtml(uri.toString())}" data-line="${d.range.start.line}">
                        <td class="icon-col">${icon}</td>
                        <td class="loc-col">${line}:${col}</td>
                        <td class="msg-col">${src}${escapeHtml(d.message)}</td>
                    </tr>`;
                })
                .join('');

            fileGroups.push(`
                <div class="file-group expanded">
                    <div class="file-header">
                        <div class="file-header-left">
                            <i class="codicon codicon-chevron-right chevron"></i>
                            <span class="file-name">${escapeHtml(fileName)}</span>
                        </div>
                        <span class="file-badge">${diagnostics.length}</span>
                    </div>
                    <div class="file-content"><table>${rows}</table></div>
                </div>
            `);
        }

        const totalCount = errorCount + warningCount + infoCount;
        const summaryParts: string[] = [];
        if (errorCount > 0) { summaryParts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`); }
        if (warningCount > 0) { summaryParts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`); }
        if (infoCount > 0) { summaryParts.push(`${infoCount} info`); }
        const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'No problems';

        return `<div class="problems-view">
            <div class="toolbar"><span class="summary">${totalCount > 0 ? summary : ''}</span></div>
            <div class="content">
                ${totalCount > 0
                    ? fileGroups.join('')
                    : `<div class="empty-state">
                           <svg viewBox="0 0 16 16"><path fill="currentColor" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/></svg>
                           <p>No problems detected!</p>
                       </div>`}
            </div>
        </div>`;
    }

    private _getHelpBody(nonce: string): string {
        const rdocIconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'rdocumentation.svg'));
        const rLogoUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'r_logo.svg'));
        const tidyverseSvgPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'tidyverse.svg').fsPath;
        let tidyverseSvg = fs.readFileSync(tidyverseSvgPath, 'utf8');
        tidyverseSvg = tidyverseSvg.replace('<svg ', '<svg class="icon" ');
        tidyverseSvg = tidyverseSvg.replace('<style>', `<style nonce="${nonce}">`);

        const bioconductorSvgPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'bioconductor.svg').fsPath;
        const bioconductorSvg = fs.readFileSync(bioconductorSvgPath, 'utf8');

        const recentItems = this._recentSearches
            .map((s) => `<a href="#" class="recent-link" data-query="${escapeHtml(s)}">?${escapeHtml(s)}</a>`)
            .join('');

        let mainContent: string;
        if (this._isLoading) {
            mainContent = `<div class="status-msg loading-msg"><span>Loading help for</span><span class="loading-var">${escapeHtml(this._lastQuery)}</span><span>...</span></div>`;
        } else if (this._helpText) {
            mainContent = `<div class="help-html-content">${this._helpText}</div>`;
        } else {
            mainContent = `
                <div class="empty-help">
                    ${this._recentSearches.length > 0
                        ? `<div class="recent-section">
                               <h2>Recent</h2>
                               <div class="recent-links">${recentItems}</div>
                           </div>`
                        : ''}
                    <div class="quick-links">
                        <h2>External Resources</h2>
                        <div class="links-grid">
                            <a class="link-card" data-url="https://www.rdocumentation.org">
                                <img src="${rdocIconUri}" class="icon" alt="Rdocumentation">
                                Rdocumentation
                            </a>
                            <a class="link-card" data-url="https://cran.r-project.org/manuals.html">
                                <img src="${rLogoUri}" class="icon" alt="CRAN">
                                CRAN
                            </a>
                            <a class="link-card" data-url="https://www.tidyverse.org">
                                ${tidyverseSvg}
                                Tidyverse
                            </a>
                            <a class="link-card" data-url="https://www.bioconductor.org" aria-label="Bioconductor">
                                ${bioconductorSvg}
                            </a>
                        </div>
                    </div>
                </div>`;
        }

        return `
            <div class="search-bar">
                <button id="btn-home" class="btn-home">
                    <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8.3 2.1l6.2 5c.2.1.3.4.1.6l-.1.1v6.2c0 .5-.4.9-1 1h-2v-4H4.5v4H2.5c-.5-.1-1-.5-1-1V7.8c0-.2.1-.4.2-.5l6.2-5.1c.1-.1.3-.1.4 0z"/></svg>
                </button>
                <input id="search-input" type="text" placeholder="Search R packages, functions, operators, etc." value="${escapeHtml(this._lastQuery)}">
                <button id="btn-search">?</button>
            </div>
            <div class="content">${mainContent}</div>`;
    }

    private _getProblemsScript(): string {
        return `
            document.querySelectorAll('.diag-row').forEach(row => {
                row.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'openFile',
                        file: row.getAttribute('data-file'),
                        line: parseInt(row.getAttribute('data-line') || '0', 10)
                    });
                });
            });
            document.querySelectorAll('.file-header').forEach(header => {
                header.addEventListener('click', () => {
                    header.parentElement.classList.toggle('expanded');
                });
            });`;
    }

    private _getHelpScript(): string {
        return `
            function escapeHtml(str) {
                return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }
            function highlightR(code) {
                const escaped = escapeHtml(code);
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
            document.querySelectorAll('pre:not(.package-index)').forEach((block) => {
                const raw = block.textContent || "";
                block.innerHTML = highlightR(raw);
            });

            const currentPkg = ${JSON.stringify(this._lastQuery).replace(/</g, '\\u003c')};
            const urlRegex = /(https?:\\/\\/[^\\s>)]+)/g;

            document.querySelectorAll('pre.package-description').forEach((block) => {
                let html = escapeHtml(block.textContent || "");
                html = html.replace(urlRegex, (url) => '<a href="#" class="external-link" data-url="' + url + '">' + url + '</a>');
                block.innerHTML = html;
            });

            document.querySelectorAll('pre.package-index').forEach((block) => {
                const lines = (block.textContent || "").split('\\n');
                let indexState = 1;
                const newLines = lines.map(line => {
                    if (indexState === 1) {
                        if (line.trim() === "") return line;
                        indexState = 2;
                    }
                    if (indexState === 2) {
                        if (line.trim() === "") {
                            indexState = 3;
                            return line;
                        }
                        const match = line.match(/^(\\S.*?)(?:(\\s{2,})(.*))?$/);
                        if (match) {
                            const funcNamesStr = match[1];
                            const space = match[2] || "";
                            let desc = escapeHtml(match[3] || "");
                            desc = desc.replace(urlRegex, '<a href="#" class="external-link" data-url="$1">$1</a>');
                            const linkedFuncs = funcNamesStr.split(', ').map(fName => {
                                const escName = escapeHtml(fName);
                                return '<a href="#" class="pkg-func-link" data-query="' + currentPkg + '::' + escName + '">' + escName + '</a>';
                            }).join(', ');
                            return linkedFuncs + space + desc;
                        }
                    }
                    return escapeHtml(line).replace(urlRegex, '<a href="#" class="external-link" data-url="$1">$1</a>');
                });
                block.innerHTML = newLines.join('\\n');
            });

            const input = document.getElementById('search-input');
            function doSearch() {
                const q = input.value.trim();
                if (q) { vscode.postMessage({ type: 'search', query: q }); }
            }

            const headers = Array.from(document.querySelectorAll('.help-html-content h3'));
            const seeAlsoHeader = headers.find(h => h.textContent.trim().toLowerCase() === 'see also');
            if (seeAlsoHeader) {
                let node = seeAlsoHeader.nextElementSibling;
                while (node && node.tagName !== 'H2' && node.tagName !== 'H3') {
                    node.querySelectorAll('code').forEach(code => {
                        if (code.closest('a')) return;
                        const q = code.textContent.trim();
                        if (/^[a-zA-Z._][a-zA-Z0-9._]*$/.test(q)) {
                            const a = document.createElement('a');
                            a.href = '#';
                            a.className = 'pkg-func-link';
                            a.setAttribute('data-query', q);
                            while (code.firstChild) { a.appendChild(code.firstChild); }
                            code.appendChild(a);
                        }
                    });
                    node = node.nextElementSibling;
                }
            }

            document.querySelectorAll('.pkg-func-link').forEach(l => {
                l.addEventListener('click', e => {
                    e.preventDefault();
                    const q = l.getAttribute('data-query');
                    if (q) { input.value = q; vscode.postMessage({ type: 'search', query: q }); }
                });
            });
            document.querySelectorAll('.external-link').forEach(l => {
                l.addEventListener('click', e => {
                    e.preventDefault();
                    const url = l.getAttribute('data-url');
                    if (url) { vscode.postMessage({ type: 'openLink', query: url }); }
                });
            });
            document.getElementById('btn-home')?.addEventListener('click', () => vscode.postMessage({ type: 'goHome' }));
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
            const examplesHeader = headers.find(h => h.textContent.trim().toLowerCase() === 'examples');
            if (examplesHeader) {
                let node = examplesHeader.nextElementSibling;
                while (node && node.tagName !== 'H2' && node.tagName !== 'H3') {
                    const preBlocks = node.tagName === 'PRE' ? [node] : Array.from(node.querySelectorAll('pre'));
                    preBlocks.forEach(pre => {
                        if (pre.classList.contains('package-index')) return;
                        const btn = document.createElement('button');
                        btn.className = 'run-code-btn';
                        btn.textContent = 'Run';
                        btn.title = 'Send to R Console';
                        btn.addEventListener('click', () => {
                            const codeEl = pre.querySelector('code') || pre;
                            const clone = codeEl.cloneNode(true);
                            const btnInClone = clone.querySelector('.run-code-btn');
                            if (btnInClone) btnInClone.remove();
                            const codeText = clone.textContent || '';
                            if (codeText) vscode.postMessage({ type: 'runCode', query: codeText });
                        });
                        pre.appendChild(btn);
                    });
                    node = node.nextElementSibling;
                }
            }
            function processMathHTML() {
                if (typeof katex === 'undefined') return;
                const macros = { "\\\\R": "\\\\textsf{R}", "\\\\mbox": "\\\\text", "\\\\code": "\\\\texttt" };
                document.querySelectorAll('.reqn').forEach(e => {
                    try { katex.render(e.textContent, e, { throwOnError: false, macros }); } catch {}
                });
            }
            processMathHTML();`;
    }

    dispose(): void {
        ToolsPanel.lastClosedState = this.saveState();
        ToolsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

function severityIcon(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return '<i class="codicon codicon-error icon-error"></i>';
        case vscode.DiagnosticSeverity.Warning:
            return '<i class="codicon codicon-warning icon-warning"></i>';
        case vscode.DiagnosticSeverity.Information:
        case vscode.DiagnosticSeverity.Hint:
        default:
            return '<i class="codicon codicon-info icon-info"></i>';
    }
}
