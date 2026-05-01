import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Help Panel - runs R help lookups in a background `Rscript` process
 * (completely separate from the R Console), captures the output,
 * and displays the rendered documentation inline.
 *
 * This never touches the user's R Console - no disruption.
 */
export class HelpPanel {
    public static currentPanel: HelpPanel | undefined;
    public static readonly viewType = 'r-layout.helpPanel';

    private readonly _panel: vscode.WebviewPanel;
    private _recentSearches: string[] = [];
    private _helpText = '';
    private _lastQuery = '';
    private _isLoading = false;
    private _disposables: vscode.Disposable[] = [];

    // Factory

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

        HelpPanel.currentPanel = new HelpPanel(panel, extensionUri);
        return HelpPanel.currentPanel;
    }

    public reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
        this._panel.reveal(column, preserveFocus);
    }

    // State Serialization

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

    // Constructor

    private _extensionUri: vscode.Uri;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
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
                    case 'goHome':
                        this._helpText = '';
                        this._lastQuery = '';
                        this._render();
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

    // R Help via background Rscript

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
            helpExpr = `help("${query}", package = .packages(all.available = TRUE))`;
        }

        // R script that prioritizes package index if the query is an installed package
        const rScript = [
            `query <- "${query}"`,
            `is_pkg <- !grepl("::", query) && (query %in% .packages(all.available = TRUE))`,
            `success <- FALSE`,
            `if (is_pkg) {`,
            `  h_pkg <- tryCatch(help(package = (query)), error = function(e) NULL)`,
            `  if (!is.null(h_pkg)) {`,
            `     cat("<div class='help-html-content'><pre class='package-index'>")`,
            `     print(h_pkg)`,
            `     cat("</pre></div>")`,
            `     success <- TRUE`,
            `  }`,
            `}`,
            `if (!success) {`,
            `  # Try topic help first if not a package`,
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
            `       tools::Rd2HTML(p, out="")`,
            `    }`,
            `  } else {`,
            `    # Ultimate fallback to package index in case detection failed`,
            `    h_pkg <- tryCatch(help(package = (query)), error = function(e) NULL)`,
            `    if (!is.null(h_pkg)) {`,
            `       cat("<div class='help-html-content'><pre class='package-index'>")`,
            `       print(h_pkg)`,
            `       cat("</pre></div>")`,
            `    } else {`,
            `       cat(paste0("<div class='status-msg'>No documentation found for: <code>", query, "</code></div>"))`,
            `    }`,
            `  }`,
            `}`
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

    /** Find the Rscript binary - works regardless of whether rConsolePath is R, radian, or ark. */
    private _findRscript(): Promise<string> {
        const config = vscode.workspace.getConfiguration('r-layout');
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

    // Rendering

    private _render(): void {
        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const nonce = getNonce();
        const cspSource = this._panel.webview.cspSource;

        const rdocIconUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'rdocumentation.svg'));
        const rLogoUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'r-logo.svg'));
        
        const tidyverseSvgPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'tidyverse.svg').fsPath;
        let tidyverseSvg = fs.readFileSync(tidyverseSvgPath, 'utf8');
        // Make it responsive and secure
        tidyverseSvg = tidyverseSvg.replace('<svg ', '<svg class="icon" ');
        tidyverseSvg = tidyverseSvg.replace('<style>', `<style nonce="${nonce}">`);

        const bioconductorSvgPath = vscode.Uri.joinPath(this._extensionUri, 'resources', 'bioconductor.svg').fsPath;
        const bioconductorSvg = fs.readFileSync(bioconductorSvgPath, 'utf8');

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
                <div class="help-html-content">${this._helpText}</div>`;
        } else {
            mainContent = `
                <div class="empty-state">

                    ${
                        this._recentSearches.length > 0
                            ? `<div class="recent-section">
                                   <span class="section-label">Recent</span>
                                   <div class="recent-links">${recentItems}</div>
                               </div>`
                            : ''
                    }
                    <div class="quick-links">
                        <span class="section-label">External Resources</span>
                        <div class="links-grid">
                            <a class="link-card" data-url="https://www.rdocumentation.org">
                                <img src="${rdocIconUri}" class="icon" alt="Rdocumentation" />
                                Rdocumentation
                            </a>
                            <a class="link-card" data-url="https://cran.r-project.org/manuals.html">
                                <img src="${rLogoUri}" class="icon" alt="CRAN" />
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

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${cspSource} https: data:;
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
        /* Removed background on inline code blocks to prevent jarring highlights */
        p > code, li > code {
            padding: 2px 4px; border-radius: 3px;
        }

        /* Native R Syntax Highlighting Colors - RStudio inspired but theme adaptive */
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
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }
        .pane-title { font-weight: 600; letter-spacing: 0.5px; opacity: 0.7; }
        .search-bar {
            display: flex; gap: 6px; padding: 8px 12px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
            align-items: center;
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
        .btn-home {
            background: none !important;
            color: var(--vscode-foreground) !important;
            opacity: 0.6;
            padding: 5px 8px !important;
        }
        .btn-home:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground) !important; }
        .btn-home svg { width: 16px; height: 16px; display: block; }
        .content { flex: 1; overflow: auto; }
        .status-msg { padding: 20px; text-align: center; opacity: 0.6; }


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
            padding: 12px;
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
            display: block;
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
            display: flex; align-items: center; gap: 10px; padding: 8px 10px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border: 1px solid var(--vscode-editorGroup-border);
            border-radius: 6px; text-decoration: none;
            color: var(--vscode-foreground); cursor: pointer;
            white-space: nowrap;
        }
        .link-card .icon {
            width: 20px; height: 20px; flex-shrink: 0;
        }
        .link-card .icon-wide {
            height: 20px; width: auto; flex-shrink: 0;
        }
        .link-card:hover { background: var(--vscode-list-hoverBackground); }

        /* Package Index Styling (No Box, Preserves Columns) */
        .package-index {
            background: none !important;
            padding: 0 !important;
            border: none !important;
            margin: 0 !important;
            white-space: pre !important;
            overflow-x: auto !important;
            font-family: var(--vscode-editor-font-family, monospace) !important;
            font-size: 13px !important;
            line-height: 1.6 !important;
        }
        .pkg-func-link, .external-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        .pkg-func-link:hover, .external-link:hover { text-decoration: underline; }

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
    </style>
</head>
<body>
    <div class="search-bar">
        <button id="btn-home" class="btn-home" data-tooltip="Help Home">
            <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8.3 2.1l6.2 5c.2.1.3.4.1.6l-.1.1v6.2c0 .5-.4.9-1 1h-2v-4H4.5v4H2.5c-.5-.1-1-.5-1-1V7.8c0-.2.1-.4.2-.5l6.2-5.1c.1-.1.3-.1.4 0z"/></svg>
        </button>
        <input id="search-input" type="text"
               placeholder="Search for a function or package, e.g. mean, dplyr::filter, ggplot2"
               value="${escapeHtml(this._lastQuery)}" />
        <button id="btn-search">?</button>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="content">${mainContent}</div>
    <script nonce="${nonce}">
        (function() {
            // Minimal zero-dependency R syntax highlighter
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
                // R's Rd2HTML output contains raw text in <pre>. We highlight it directly.
                const raw = block.textContent || "";
                block.innerHTML = highlightR(raw);
            });

            // Smart Parser: Turn text-based package index into clickable links and URLs
            const currentPkg = "${escapeHtml(this._lastQuery)}";
            const urlRegex = /(https?:\\/\\/[^\\s>)]+)/g;

            document.querySelectorAll('pre.package-index').forEach((block) => {
                const lines = (block.textContent || "").split('\\n');
                let indexState = 0; // 0: before, 1: looking for first item, 2: inside list, 3: done
                const newLines = lines.map(line => {
                    if (indexState === 0 && line.trim() === "Index:") {
                        indexState = 1;
                        return line;
                    }

                    if (indexState === 1) {
                        if (line.trim() === "") return line;
                        indexState = 2; // Found first item
                    }

                    if (indexState === 2) {
                        if (line.trim() === "") {
                            indexState = 3; // Blank line ends the list
                            return line;
                        }

                        // Match any string starting with non-whitespace up to 2+ spaces
                        const match = line.match(/^(\\S.*?)(?:(\\s{2,})(.*))?$/);
                        if (match) {
                            const funcNamesStr = match[1];
                            const space = match[2] || "";
                            let desc = match[3] || "";

                            // Sanitize HTML entities before parsing
                            desc = escapeHtml(desc);

                            // Linkify descriptions
                            desc = desc.replace(urlRegex, '<a href="#" class="external-link" data-url="$1">$1</a>');

                            // Handle multiple functions separated by comma
                            const funcNames = funcNamesStr.split(', ');
                            const linkedFuncs = funcNames.map(fName => {
                                const escName = escapeHtml(fName);
                                return \`<a href="#" class="pkg-func-link" data-query="\${currentPkg}::\${escName}">\${escName}</a>\`;
                            }).join(', ');

                            return \`\${linkedFuncs}\${space}\${desc}\`;
                        }

                        // If it doesn't match (e.g. wrapped description starting with space), just sanitize and linkify
                        let rawLine = escapeHtml(line);
                        return rawLine.replace(urlRegex, '<a href="#" class="external-link" data-url="$1">$1</a>');
                    }

                    // State 0 and 3
                    let rawLine = escapeHtml(line);
                    return rawLine.replace(urlRegex, '<a href="#" class="external-link" data-url="$1">$1</a>');
                });
                block.innerHTML = newLines.join('\\n');
            });

            const vscode = acquireVsCodeApi();
            const input = document.getElementById('search-input');

            function doSearch() {
                const q = input.value.trim();
                if (q) { vscode.postMessage({ type: 'search', query: q }); }
            }

            // Attach listeners to the newly parsed package links
            document.querySelectorAll('.pkg-func-link').forEach(l => {
                l.addEventListener('click', e => {
                    e.preventDefault();
                    const q = l.getAttribute('data-query');
                    if (q) { input.value = q; vscode.postMessage({ type: 'search', query: q }); }
                });
            });

            // Attach listeners to newly parsed external URLs
            document.querySelectorAll('.external-link').forEach(l => {
                l.addEventListener('click', e => {
                    e.preventDefault();
                    const url = l.getAttribute('data-url');
                    if (url) { vscode.postMessage({ type: 'openLink', query: url }); }
                });
            });
            document.getElementById('btn-home')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'goHome' });
            });
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
        HelpPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

//  Utility

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
