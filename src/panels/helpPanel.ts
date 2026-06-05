import * as vscode from 'vscode';
import { getNonce, escapeHtml } from '../utils/webviewUtils';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getRConsoleTerminal } from '../layout/layoutManager';
import { getRscriptPath } from '../utils/rPathResolver';

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
        column: vscode.ViewColumn = vscode.ViewColumn.Two
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
                enableFindWidget: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        HelpPanel.currentPanel = new HelpPanel(panel, extensionUri);
        return HelpPanel.currentPanel;
    }

    public reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
        if (!this._panel.visible) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.viewColumn === this._panel.viewColumn) {
                return;
            }
            this._panel.reveal(column, preserveFocus);
        }
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
                let requiresFocusRestore = true;
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
                
                if (requiresFocusRestore) {
                    setTimeout(() => {
                        vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                    }, 150);
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

        // Use intToUtf8(c(...)) to safely inject arbitrary strings into R script
        // without risking Windows command line quoting nightmares.
        const toRString = (str: string) => {
            if (!str) {return '""';}
            const codes = Array.from(str).map(c => c.charCodeAt(0)).join(',');
            return `intToUtf8(c(${codes}))`;
        };

        const rQuery = toRString(query);

        // Build the R expression
        let helpExpr: string;
        if (query.includes('::')) {
            const [pkg, func] = query.split('::');
            helpExpr = `help(${toRString(func)}, package=${toRString(pkg)})`;
        } else {
            helpExpr = `help(${rQuery}, package = .packages(all.available = TRUE))`;
        }

        // R script that prioritizes package index if the query is an installed package
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
            `       pkg <- basename(dirname(dirname(h[1])))`,
            `       html_out <- capture.output(tools::Rd2HTML(p))`,
            `       html_str <- paste(html_out, collapse="\\n")`,
            `       html_str <- sub("R Documentation", pkg, html_str, fixed=TRUE)`,
            `       cat(html_str)`,
            `    }`,
            `  } else {`,
            `    # Ultimate fallback to package index in case detection failed`,
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

            // Extract the body content from the HTML output
            const bodyMatch = raw.match(/<body>([\s\S]*?)<\/body>/i);
            let content = bodyMatch ? bodyMatch[1] : raw;

            // Post-process: clean up function help top table
            content = content.replace(
                /<table[^>]*>.*?<tr>\s*<td>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>.*?<\/table>/is,
                '<div class="help-top-title">$1 {$2}</div>'
            );

            // Post-process: replace broken lifecycle badge <img> tags with styled inline badges.
            // R's Rd2HTML emits relative paths like ../help/figures/lifecycle-deprecated.svg
            // which don't resolve inside a VS Code webview.
            content = content.replace(
                /<img\s[^>]*src="[^"]*lifecycle[- _]([a-z-]+)\.svg"[^>]*>/gi,
                (_match, stage: string) => {
                    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
                    return `<span class="lifecycle-badge lifecycle-${stage.toLowerCase()}">${label}</span>`;
                }
            );

            // Remove any remaining <img> tags with relative src paths (no protocol)
            // that can't resolve in the webview.
            content = content.replace(
                /<img\s[^>]*src="(?!https?:\/\/|data:)[^"]*"[^>]*>/gi,
                ''
            );

            this._helpText = content;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this._helpText = `<p class="error">Error fetching help for "${query}":<br/><br/>${escapeHtml(msg)}</p>`;
        }

        this._isLoading = false;
        this._render();
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
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
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
        const rLogoUri = this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'r_logo.svg'));

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
                                   <h2>Recent</h2>
                                   <div class="recent-links">${recentItems}</div>
                               </div>`
                            : ''
                    }
                    <div class="quick-links">
                        <h2>External Resources</h2>
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
                   font-src https://cdn.jsdelivr.net;
                   style-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
                   script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
    <script src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
    <style nonce="${nonce}">
        /* Code Block Styling using VS Code theme variables */
        pre {
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-editor-foreground);
            border-radius: 6px; padding: 10px; overflow-x: auto; margin: 10px 0;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        code {
            font-family: var(--vscode-editor-font-family, monospace);
        }
        /* Removed background on inline code blocks to prevent jarring highlights */
        p > code, li > code {
            padding: 2px 4px; border-radius: 6px;
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
            font-size: var(--vscode-font-size, 13px);
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
        .pane-title { font-weight: 600; opacity: 0.7; }
        .search-bar {
            display: flex; gap: 6px; padding: 8px 12px;
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
            padding: 5px 10px; border-radius: 6px; font-size: var(--vscode-font-size, 13px); outline: none;
        }
        .search-bar input:focus { border-color: var(--vscode-focusBorder); }
        .search-bar input::placeholder { color: var(--vscode-input-placeholderForeground); }
        .search-bar button {
            background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 1.1em; font-weight: 600;
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
            font-size: var(--vscode-font-size, 13px); line-height: 1.6;
        }
        h3 {
            margin-bottom: 1em;
            color: var(--vscode-editor-foreground);
            font-weight: 700;
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

        /* Function Documentation Spacing */
        .help-html-content h2, .help-html-content h3 {
            margin-top: 1.1em;
        }
        /* Home Page Spacing */
        .empty-state h2 {
            margin-top: 1.5em;
            text-align: left;
            margin-bottom: 1em;
            color: var(--vscode-editor-foreground);
            font-weight: 700;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            padding-bottom: 8px;
            position: relative;
            font-size: var(--vscode-font-size, 13px);
        }
        .empty-state h2::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            width: 40px;
            height: 3px;
            background: var(--vscode-textLink-foreground);
            border-radius: 6px;
        }
        .empty-state > div:first-child h2 {
            margin-top: 0.5em;
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
        .help-html-content pre:hover .run-code-btn {
            opacity: 1;
        }
        .run-code-btn:hover {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
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
        .tip { font-size: var(--vscode-font-size, 13px); opacity: 0.6; line-height: 1.7; margin-bottom: 18px; }
        .tip code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 5px; border-radius: 6px; font-size: 0.9em;
        }

        .recent-links { display: flex; flex-wrap: wrap; gap: 6px; }
        .recent-link {
            color: var(--vscode-textLink-foreground); text-decoration: none;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.9em; cursor: pointer;
            padding: 3px 8px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border-radius: 6px;
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

        /* Lifecycle Badges (replace broken <img> from Rd2HTML) */
        .lifecycle-badge {
            display: inline-block;
            font-size: 0.85em;
            font-weight: 600;
            padding: 1px 7px;
            border-radius: 4px;
            vertical-align: middle;
            border: 1px solid;
        }
        .lifecycle-stable       { background: #d0f0d0; color: #1a7a1a; border-color: #a0d0a0; }
        .lifecycle-experimental  { background: #fff3cd; color: #856404; border-color: #ffc107; }
        .lifecycle-deprecated    { background: #fdd; color: #c33; border-color: #e99; }
        .lifecycle-superseded    { background: #d0e8ff; color: #2060a0; border-color: #a0c8f0; }
        .lifecycle-defunct       { background: #e0e0e0; color: #666; border-color: #bbb; }
        .lifecycle-questioning   { background: #e8d8f0; color: #6a3d7d; border-color: #c8a8d8; }
        .lifecycle-maturing      { background: #d0f0d0; color: #1a7a1a; border-color: #a0d0a0; }
        .lifecycle-soft-deprecated { background: #fdd; color: #c33; border-color: #e99; }
        .lifecycle-archived      { background: #e0e0e0; color: #666; border-color: #bbb; }

        /* Package Index Styling (No Box, Preserves Columns) */
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
    </style>
</head>
<body>
    <div class="search-bar">
        <button id="btn-home" class="btn-home" data-tooltip="Help Home">
            <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8.3 2.1l6.2 5c.2.1.3.4.1.6l-.1.1v6.2c0 .5-.4.9-1 1h-2v-4H4.5v4H2.5c-.5-.1-1-.5-1-1V7.8c0-.2.1-.4.2-.5l6.2-5.1c.1-.1.3-.1.4 0z"/></svg>
        </button>
        <input id="search-input" type="text"
               placeholder="Search R packages, functions, operators, etc."
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
            const currentPkg = ${JSON.stringify(this._lastQuery).replace(/</g, '\\u003c')};
            const urlRegex = /(https?:\\/\\/[^\\s>)]+)/g;

            // Linkify URLs in the plain text description block
            document.querySelectorAll('pre.package-description').forEach((block) => {
                let html = escapeHtml(block.textContent || "");
                html = html.replace(urlRegex, (url) => {
                    return \`<a href="#" class="external-link" data-url="\${url}">\${url}</a>\`;
                });
                block.innerHTML = html;
            });

            document.querySelectorAll('pre.package-index').forEach((block) => {
                const lines = (block.textContent || "").split('\\n');
                let indexState = 1; // 1: looking for first item, 2: inside list, 3: done
                const newLines = lines.map(line => {

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

            // Smart Linker: Turn plain <code> tags in "See Also" into clickable links
            const headers = Array.from(document.querySelectorAll('.help-html-content h3'));
            const seeAlsoHeader = headers.find(h => h.textContent.trim().toLowerCase() === 'see also');
            if (seeAlsoHeader) {
                let node = seeAlsoHeader.nextElementSibling;
                while (node && node.tagName !== 'H2' && node.tagName !== 'H3') {
                    node.querySelectorAll('code').forEach(code => {
                        if (code.closest('a')) return; // skip if already linked

                        const q = code.textContent.trim();
                        // Only linkify valid R identifiers
                        if (/^[a-zA-Z._][a-zA-Z0-9._]*$/.test(q)) {
                            const a = document.createElement('a');
                            a.href = '#';
                            a.className = 'pkg-func-link';
                            a.setAttribute('data-query', q);

                            while(code.firstChild) {
                                a.appendChild(code.firstChild);
                            }
                            code.appendChild(a);
                        }
                    });
                    node = node.nextElementSibling;
                }
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

            // Run Button specifically for the "Examples" section
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

                            let codeText = clone.textContent || '';
                            if (codeText) {
                                vscode.postMessage({ type: 'runCode', query: codeText });
                            }
                        });

                        pre.appendChild(btn);
                    });
                    node = node.nextElementSibling;
                }
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

            // Process KaTeX Mathematics
            function processMathHTML() {
                if (typeof katex === 'undefined') return;
                const macros = { "\\R": "\\textsf{R}", "\\mbox": "\\text", "\\code": "\\texttt"};
                document.querySelectorAll('.reqn').forEach(e => {
                    try {
                        katex.render(e.textContent, e, { throwOnError: false, macros });
                    } catch (err) {
                        console.error('KaTeX rendering error:', err);
                    }
                });
            }
            processMathHTML();

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


