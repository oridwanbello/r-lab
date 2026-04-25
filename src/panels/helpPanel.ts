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

    public reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
        this._panel.reveal(column, preserveFocus);
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
                                <svg class="icon" viewBox="0 0 100 100">
                                    <rect x="0" y="0" width="100" height="100" rx="20" fill="#05192D" />
                                    <path d="M31.5,25 H51.5 C61.5,25 66.5,30 66.5,38 C66.5,46 61.5,51 51.5,51 H39.5 V75 H31.5 V25 M39.5,44 H51.5 C56.5,44 58.5,42 58.5,38 C58.5,34 56.5,32 51.5,32 H39.5 V44 M54.5,51 L68.5,75 H59.5 L46.5,51 H54.5" fill="#F2F2F2" />
                                </svg>
                                Rdocumentation
                            </a>
                            <a class="link-card" data-url="https://cran.r-project.org/manuals.html">
                                <svg class="icon" viewBox="0 0 256 197.411">
                                    <defs>
                                        <linearGradient id="r-logo-a" x1="0" x2="256" y1="-105.397" y2="276.848" gradientUnits="userSpaceOnUse" spreadMethod="pad">
                                            <stop offset="0" stop-color="#cbced0"/><stop offset="1" stop-color="#84838b"/>
                                        </linearGradient>
                                        <linearGradient id="r-logo-b" x1="105.473" x2="246.77" y1="53.23" y2="197.411" gradientUnits="userSpaceOnUse" spreadMethod="pad">
                                            <stop offset="0" stop-color="#276dc3"/><stop offset="1" stop-color="#165caa"/>
                                        </linearGradient>
                                    </defs>
                                    <g fill-rule="evenodd">
                                        <path d="M128 171.45c-70.692 0-128-38.38-128-85.725S57.308 0 128 0s128 38.38 128 85.725-57.307 85.725-128 85.725zm19.593-137.935c-53.732 0-97.29 26.24-97.29 58.605s43.56 58.605 97.29 58.605 93.386-17.94 93.386-58.605c0-40.654-39.654-58.605-93.386-58.605z" fill="url(#r-logo-a)"/>
                                        <path d="M194.937 132.776s7.747 2.338 12.248 4.615c1.562.8 4.264 2.367 6.213 4.438 1.91 2.028 2.84 4.083 2.84 4.083l30.53 51.477-49.347.022-23.076-43.334s-4.725-8.12-7.633-10.473c-2.425-1.964-3.46-2.663-5.858-2.663H149.13l.01 56.438-43.667.02V53.23h87.69s39.94.72 39.94 38.72-38.164 40.827-38.164 40.827zm-18.993-48.274l-26.436-.017-.013 24.514h26.45s12.248-.038 12.248-12.47c0-12.682-12.248-12.018-12.248-12.018z" fill="url(#r-logo-b)"/>
                                    </g>
                                </svg>
                                CRAN
                            </a>
                            <a class="link-card" data-url="https://www.tidyverse.org">
                                <style nonce="${nonce}">
                                    .tidy-st0{fill:#141227;}.tidy-st1{opacity:0.94;}.tidy-st2{fill:#FFFFFF;}.tidy-st3{fill:#E6B35A;}.tidy-st4{opacity:0.8;fill:#F2F2F2;}.tidy-st5{fill:#F7A238;}.tidy-st6{fill:#0088C5;}.tidy-st7{fill:#7FB036;}.tidy-st8{fill:#F9ECC6;}.tidy-st9{fill:#FFF34D;}.tidy-st10{fill:#B57AB4;}.tidy-st11{fill:#DB1F26;}.tidy-st12{fill:#F26524;}.tidy-st13{fill:#00A5DC;}.tidy-st14{fill:#164F86;}.tidy-st15{fill:#36A85D;}.tidy-st16{fill:#FFFEF9;}.tidy-st17{fill:#EF4782;}.tidy-st18{fill:currentColor;}
                                </style>
                                <svg class="icon" viewBox="0 0 2521 2911">
                                    <g>
                                        <polygon class="tidy-st0" points="2453.1,767.5 1260.5,78.9 1260.5,78.9 67.9,767.5 67.9,2144.2 1260.5,2832.8 2453.1,2144.2 	"/>
                                        <g class="tidy-st1">
                                            <path class="tidy-st2" d="M325.6,1254.6v84.7H398v40.8h-72.4v159.2c0,36.7,9.9,57.3,38.1,57.3c9.9,0,19.9-1,29.5-3.8l2.4,40.1c-9.6,4.1-25.4,7.2-44.9,7.2c-23.7,0-42.5-7.9-54.6-22.6c-14.4-15.8-19.6-42.2-19.6-76.8v-160.9H233V1339h43.2v-70.7L325.6,1254.6z"/>
                                            <path class="tidy-st2" d="M499.9,1256.3c1,17.2-11.7,31.9-28.8,32.9c-1,0-2.4,0-3.4,0c-17.8,0-30.5-14.8-30.5-32.9c0-18.9,13.4-33.6,31.6-33.6C487.9,1223.1,499.9,1237.5,499.9,1256.3z M443.6,1634.8v-295h50.8v295H443.6z"/>
                                            <path class="tidy-st2" d="M807.3,1201.5v356.8c0,26.1,0.7,56.3,2.4,76.2h-45.3l-2.4-51.1h-1c-15.4,32.9-49.4,58-95,58c-67.2,0-119.1-60.4-119.1-149.9c-0.7-98.1,57-158.5,124.9-158.5c42.5,0,71.4,21.3,84.1,45.3h1v-176.3h50.4V1201.5z M756.5,1459.4c0-7.5-0.7-15.1-2.4-22.6c-7.5-34.3-35-62.1-73.1-62.1c-52.5,0-83.4,48.7-83.4,113.9c0,59.7,27.8,109.1,82.3,109.1c34,0,64.8-23.7,74.1-64.2c1.7-7.5,2.4-15.4,2.4-23.3V1459.4z"/>
                                            <path class="tidy-st2" d="M898.2,1339.4l61.1,174.3c6.5,19.6,13.4,42.5,17.8,60.4h1c5.1-17.8,11-40.1,17.8-61.8l55.2-172.9h53.5l-75.8,210.3c-36.4,101.2-61.1,153-95.4,184.9c-24.7,23.3-49.4,32.2-62.1,34.7l-12.7-44.9c16.5-5.8,31.6-14.8,44.3-26.1c18.5-16.5,33.3-36.7,42.5-59.7c2.1-4.1,3.4-8.2,4.1-12.7c-0.3-4.8-1.7-9.6-3.4-14.1l-102.9-272.1L898.2,1339.4z"/>
                                            <path class="tidy-st2" d="M1165.8,1339.4l54.6,166c9.3,26.8,16.8,51.1,22.3,75.5h1.7c6.5-24.4,14.4-48.7,23.7-75.5l54.2-166h52.8l-109.4,295h-48.4l-106-295H1165.8z"/>
                                            <path class="tidy-st2" d="M1433.8,1496.8c1,72.7,44.9,102.6,95.4,102.6c36.4,0,58-6.9,77.2-15.4l8.6,38.4c-17.8,8.6-48.4,18.2-92.6,18.2c-85.8,0-136.9-59.7-136.9-148.9c0-89.2,49.4-159.2,130.7-159.2c90.9,0,114.9,84.7,114.9,139.3c0,8.2-0.7,16.8-1.7,25H1433.8z M1582.3,1458.4c0.7-34.3-13.4-87.1-70.3-87.1c-51.1,0-73.8,50.1-77.5,87.1H1582.3z"/>
                                            <path class="tidy-st2" d="M1682.2,1431.3c0-34.7-0.7-64.5-2.4-91.9h44.3l1.7,58h2.4c12.7-39.8,43.2-64.8,77.2-64.8c4.8,0,9.6,0.7,14.4,2.1v50.8c-5.5-1.4-11.3-2.1-17.2-1.7c-35.7,0-61.1,28.8-67.9,69c-1.4,8.2-2.1,16.5-2.4,25v157.5h-50.1V1431.3z"/>
                                            <path class="tidy-st2" d="M1852,1579.9c19.9,13,42.9,20.6,66.9,21.3c36.7,0,54.2-19.6,54.2-43.9c0-25.7-14.4-39.5-51.8-54.2c-50.1-18.9-73.8-48-73.8-83.7c0-47.7,36.4-86.5,96.1-86.5c24-0.3,47.7,6.2,68.3,18.2l-12.7,39.1c-16.8-11-36.7-17.2-57-17.2c-29.8,0-46.7,18.2-46.7,40.1c0,24.4,16.8,35.3,52.8,50.1c48.4,19.6,73.1,45.3,73.1,89.2c0,51.8-38.1,88.5-104,88.5c-30.5,0-58.7-7.9-78.2-20.2L1852,1579.9z"/>
                                            <path class="tidy-st2" d="M2103.5,1496.8c1,72.7,44.9,102.6,95.4,102.6c36.4,0,58-6.9,77.2-15.4l8.6,38.4c-17.8,8.6-48.4,18.2-92.6,18.2c-85.8,0-136.9-59.7-136.9-148.9c0-89.2,49.4-159.2,130.7-159.2c90.9,0,114.9,84.7,114.9,138.9c0,8.2-0.7,16.8-1.7,25h-195.6L2103.5,1496.8L2103.5,1496.8z M2252,1458.4c0.7-34.3-13.4-87.1-70.3-87.1c-51.1,0-73.8,50.1-77.9,87.1H2252z"/>
                                        </g>
                                        <path class="tidy-st3" d="M1270.1,2143.5c1-1,2.1-2.1,3.1-3.1h-1C1271.8,2141.5,1270.8,2142.5,1270.1,2143.5z"/>
                                        <polyline class="tidy-st4" points="1156.4,223.8 1169.2,216.4 1182.3,223.8 1182.3,238.6 1169.2,246 1156.4,238.6 1156.4,223.8 	"/>
                                        <polyline class="tidy-st4" points="969.6,383.2 985.3,374.3 1000.8,383.2 1000.8,401.1 985.3,410 969.6,401.1 969.6,383.2 	"/>
                                        <polyline class="tidy-st4" points="1139.7,583.9 1161.3,571.6 1183.3,583.9 1183.3,609 1161.3,621.3 1139.7,609 1139.7,583.9 	"/>
                                        <polyline class="tidy-st5" points="1359.3,690.3 1380.9,677.9 1402.9,690.3 1402.9,715.3 1380.9,727.7 1359.3,715.3 1359.3,690.3 	"/>
                                        <polyline class="tidy-st4" points="1528.5,303.3 1550.1,290.9 1572,303.3 1572,328.3 1550.1,340.7 1528.5,328.3 1528.5,303.3 	"/>
                                        <polyline class="tidy-st4" points="1454.7,563 1476.6,551 1498.3,563.3 1498.3,588.4 1476.6,600.4 1454.7,588 1454.7,563 	"/>
                                        <polygon class="tidy-st6" points="1156.5,804.9 1156.5,779.8 1135.3,767.5 1113.3,779.8 1113.3,804.9 1135.3,817.2 	"/>
                                        <polyline class="tidy-st4" points="436.4,721.1 458,708.8 479.6,721.1 479.6,746.2 458,758.5 436.4,746.2 436.4,721.1 	"/>
                                        <polyline class="tidy-st4" points="817.9,832.6 839.9,820.3 861.5,832.6 861.5,857.7 839.9,870 817.9,857.7 817.9,832.6 	"/>
                                        <polyline class="tidy-st7" points="1624.5,985.7 1646.5,973.3 1668.1,985.7 1668.1,1010.7 1646.5,1023.1 1624.5,1010.7 1624.5,985.7 	"/>
                                        <polyline class="tidy-st4" points="348.2,1763.4 369.8,1751.1 391.8,1763.4 391.8,1788.5 369.8,1800.8 348.2,1788.5 348.2,1763.4 	"/>
                                        <polyline class="tidy-st8" points="485.1,1849.9 520.5,1830 555.5,1849.9 555.5,1890.3 520.5,1910.2 485.1,1890.3 485.1,1849.9 	"/>
                                        <polyline class="tidy-st9" points="753.1,1967.2 764.1,1961 775.4,1967.2 775.4,1979.9 764.1,1986.1 753.1,1979.9 753.1,1967.2 	"/>
                                        <polyline class="tidy-st4" points="731.8,1784.7 753.4,1772.7 775.4,1785 775.4,1810.1 753.4,1822.1 731.8,1809.7 731.8,1784.7 	"/>
                                        <polyline class="tidy-st4" points="146.5,1982.3 157.5,1976.1 168.1,1982.3 168.1,1994.6 157.5,2000.8 146.5,1994.6 146.5,1982.3 	"/>
                                        <polyline class="tidy-st10" points="419.9,2173.4 454.9,2153.8 489.9,2173.7 489.9,2213.9 454.9,2233.4 419.9,2213.9 419.9,2173.4 	"/>
                                        <polyline class="tidy-st4" points="362,1917.5 377.1,1908.9 392.1,1917.5 392.1,1934.9 377.1,1943.5 362,1934.9 362,1917.5 	"/>
                                        <polyline class="tidy-st4" points="116,1400.1 129,1392.9 142.4,1400.1 142.4,1415.2 129,1422.7 116,1415.2 116,1400.1 	"/>
                                        <polyline class="tidy-st4" points="150.3,1105.4 172.2,1093 193.8,1105.4 193.8,1130.4 172.2,1142.8 150.3,1130.4 150.3,1105.4 	"/>
                                        <polyline class="tidy-st9" points="921.2,735.9 956.2,716.3 991.2,736.2 991.2,776.4 956.2,796.3 921.2,776.4 921.2,735.9 	"/>
                                        <polyline class="tidy-st4" points="2036.6,935.2 2055.8,924.2 2075,935.2 2075,957.5 2055.8,968.5 2036.6,957.5 2036.6,935.2 	"/>
                                        <polyline class="tidy-st11" points="1067,964 1102.7,943.8 1138.4,964 1138.4,1005.2 1102.7,1025.1 1067,1004.9 1067,964 	"/>
                                        <polyline class="tidy-st4" points="1602.2,887.2 1623.8,874.8 1645.8,887.2 1645.8,912.2 1623.8,924.6 1602.2,912.2 1602.2,887.2 	"/>
                                        <polyline class="tidy-st4" points="1008.7,1792.6 1030.3,1780.6 1052.2,1792.9 1052.2,1818 1030.3,1830 1008.7,1817.6 1008.7,1792.6 	"/>
                                        <polyline class="tidy-st11" points="1179.9,1952.8 1194.3,1944.6 1208.7,1952.8 1208.7,1969.6 1194.3,1977.5 1179.9,1969.3 1179.9,1952.8 	"/>
                                        <polyline class="tidy-st4" points="1399.4,2059.1 1413.9,2050.9 1428.6,2059.1 1428.6,2076 1413.9,2084.2 1399.4,2075.6 1399.4,2059.1 	"/>
                                        <polyline class="tidy-st4" points="1360,1739.7 1384.4,1726 1409.4,1740.1 1409.4,1768.6 1384.4,1782.3 1360,1768.2 1360,1739.7 	"/>
                                        <polyline class="tidy-st4" points="1510.6,1813.2 1544.9,1793.6 1578.9,1813.2 1578.9,1852.3 1544.9,1871.5 1510.6,1852.3 1510.6,1813.2 	"/>
                                        <polyline class="tidy-st4" points="1864.7,1067 1886.3,1054.6 1908.2,1067 1908.2,1092 1886.3,1104.4 1864.7,1092 1864.7,1067 	"/>
                                        <polyline class="tidy-st4" points="2247.6,1202.1 2283.2,1181.9 2318.9,1202.1 2318.9,1243.3 2283.2,1263.5 2247.6,1243.3 2247.6,1202.1 	"/>
                                        <polyline class="tidy-st4" points="1706.5,546.9 1723.3,537.3 1740.1,546.9 1740.1,566.1 1723.3,575.7 1706.5,566.1 1706.5,546.9 	"/>
                                        <polyline class="tidy-st7" points="1532.6,761.3 1554.5,748.9 1576.1,761.3 1576.1,786.3 1554.5,798.7 1532.6,786.3 1532.6,761.3 	"/>
                                        <polyline class="tidy-st4" points="1942.2,568.1 1964.2,555.8 1985.8,568.1 1985.8,593.2 1964.2,605.5 1942.2,593.2 1942.2,568.1 	"/>
                                        <polyline class="tidy-st4" points="1778.6,748.2 1793.3,740 1808.4,748.2 1808.4,765.4 1793.3,774 1778.6,765.4 1778.6,748.2 	"/>
                                        <polyline class="tidy-st4" points="1728.5,1806.6 1750.4,1794.6 1772,1807 1772,1832 1750.4,1844 1728.5,1831.7 1728.5,1806.6 	"/>
                                        <polyline class="tidy-st4" points="1626.2,1926 1653,1910.9 1679.4,1926 1679.4,1956.6 1653,1971.3 1626.2,1956.6 1626.2,1926 	"/>
                                        <polyline class="tidy-st9" points="2183.4,1801.1 2205.4,1788.8 2227,1801.1 2227,1826.2 2205.4,1838.5 2183.4,1826.2 2183.4,1801.1 	"/>
                                        <polyline class="tidy-st4" points="893.1,2274.6 914.7,2262.2 936.6,2274.6 936.6,2299.6 914.7,2312 893.1,2299.6 893.1,2274.6 	"/>
                                        <polyline class="tidy-st9" points="1282.8,2400.2 1296.5,2392.3 1310.2,2400.2 1310.2,2415.9 1296.5,2423.5 1282.8,2415.6 1282.8,2400.2 	"/>
                                        <polyline class="tidy-st11" points="643.6,2310.4 665.2,2298.1 687.2,2310.4 687.2,2335.5 665.2,2347.8 643.6,2335.5 643.6,2310.4 	"/>
                                        <polyline class="tidy-st8" points="828.9,2460.2 864.2,2440.3 899.6,2460.5 899.6,2501 864.2,2520.9 828.9,2500.7 828.9,2460.2 	"/>
                                        <polyline class="tidy-st11" points="1057,2520.9 1092.4,2501 1127.7,2521.3 1127.7,2561.7 1092.4,2581.6 1057,2561.4 1057,2520.9 	"/>
                                        <polyline class="tidy-st4" points="1757.3,2030.3 1778.9,2018 1800.9,2030.3 1800.9,2055.4 1778.9,2067.7 1757.3,2055.4 1757.3,2030.3 	"/>
                                        <polyline class="tidy-st4" points="1567.6,2290.2 1581.3,2282.7 1594.7,2290.2 1594.7,2305.6 1581.3,2313.5 1567.6,2305.6 1567.6,2290.2 	"/>
                                        <polyline class="tidy-st4" points="2184.8,2147.7 2199.9,2139.1 2215,2147.7 2215,2165.2 2199.9,2173.7 2184.8,2165.2 2184.8,2147.7 	"/>
                                        <polyline class="tidy-st5" points="1750.4,634.7 1772,622.3 1794,634.7 1794,659.7 1772,672.1 1750.4,659.7 1750.4,634.7 	"/>
                                        <polyline class="tidy-st4" points="1694.2,1109.5 1716.1,1097.2 1737.7,1109.5 1737.7,1134.6 1716.1,1146.9 1694.2,1134.6 1694.2,1109.5 	"/>
                                        <polyline class="tidy-st4" points="1327.1,1022 1337.7,1015.8 1348.7,1022 1348.7,1034.4 1337.7,1040.5 1327.1,1034.4 1327.1,1022 	"/>
                                        <polyline class="tidy-st4" points="2142.6,1918.5 2164.5,1906.5 2186.1,1918.8 2186.1,1943.9 2164.5,1955.9 2142.6,1943.5 2142.6,1918.5 	"/>
                                        <polyline class="tidy-st8" points="1620.1,2081.8 1658.8,2059.8 1697.9,2082.1 1697.9,2127.1 1658.8,2148.7 1620.1,2126.7 1620.1,2081.8 	"/>
                                        <polyline class="tidy-st4" points="2281.5,827.8 2303.1,815.5 2325.1,827.8 2325.1,852.9 2303.1,865.2 2281.5,852.9 2281.5,827.8 	"/>
                                        <polyline class="tidy-st4" points="2316.2,964.4 2353.2,943.5 2390.3,964.7 2390.3,1007.3 2353.2,1028.2 2316.2,1007.3 2316.2,964.4 	"/>
                                        <polygon class="tidy-st5" points="1023.1,535.2 1023.1,493.7 987.7,473.8 952.1,493.7 952.1,535.2 987.7,555.4 	"/>
                                        <polygon class="tidy-st5" points="1216.2,545.1 1216.2,557.5 1226.9,563.7 1237.5,557.5 1237.5,545.1 1226.9,539 	"/>
                                        <polygon class="tidy-st12" points="1498.3,672.1 1498.3,659.4 1487.3,652.9 1476.3,659.4 1476.3,672.1 1487.3,678.6 	"/>
                                        <polygon class="tidy-st5" points="1422.8,308.1 1422.8,333.1 1444.4,345.5 1465.7,333.1 1465.7,308.1 1444.4,295.7 	"/>
                                        <polygon class="tidy-st13" points="1190.9,318.3 1190.9,293.3 1169.7,280.9 1147.7,293.3 1147.7,318.3 1169.7,330.7 	"/>
                                        <polygon class="tidy-st14" points="1199.1,427.5 1236.5,448.7 1273.2,427.5 1273.2,384.6 1236.5,363.7 1199.1,384.6 	"/>
                                        <polygon class="tidy-st14" points="825.8,751 825.8,725.9 804.5,713.9 782.9,725.9 782.9,751 804.5,763.3 	"/>
                                        <polygon class="tidy-st14" points="1366.5,582.2 1366.5,565.7 1352.4,557.5 1337.7,565.7 1337.7,582.2 1352.4,590.4 	"/>
                                        <polygon class="tidy-st14" points="1084.5,541.7 1084.5,523.2 1068.7,513.9 1052.6,523.2 1052.6,541.7 1068.7,551 	"/>
                                        <polygon class="tidy-st13" points="1134.9,496.8 1156.5,509.1 1177.8,496.8 1177.8,471.7 1156.5,459.4 1134.9,471.7 	"/>
                                        <polygon class="tidy-st13" points="1278.3,683.4 1278.3,667.3 1264.3,659 1250.2,667.3 1250.2,683.4 1264.3,691.6 	"/>
                                        <polygon class="tidy-st9" points="1301.7,213.1 1301.7,188 1280.7,175.7 1258.8,188 1258.8,213.1 1280.7,225.4 	"/>
                                        <polygon class="tidy-st15" points="1453.3,283.4 1453.3,258.3 1432,246 1410.4,258.3 1410.4,283.4 1432,295.7 	"/>
                                        <polygon class="tidy-st11" points="1009.7,671.7 1031.3,684.1 1052.6,671.7 1052.6,646.7 1031.3,634.3 1009.7,646.7 	"/>
                                        <polygon class="tidy-st15" points="1476.3,1150.7 1476.3,1125.6 1455,1113.3 1433.4,1125.6 1433.4,1150.7 1455,1163 	"/>
                                        <polygon class="tidy-st9" points="1125.7,472.1 1125.7,447 1104.4,434.7 1082.8,447 1082.8,472.1 1104.4,484.4 	"/>
                                        <polygon class="tidy-st11" points="254.6,946.9 254.6,984.6 287.2,1003.2 320.1,984.6 320.1,946.9 287.2,928.4 	"/>
                                        <polygon class="tidy-st13" points="398.7,1107.4 398.7,1082.4 377.1,1070.1 355.1,1082.1 355.1,1107.1 377.1,1119.8 	"/>
                                        <polygon class="tidy-st9" points="605.5,942.8 605.5,910.2 577.1,894.1 548.9,909.8 548.9,942.4 577.1,958.6 	"/>
                                        <polygon class="tidy-st9" points="626.5,688.9 626.5,648.1 591.8,628.2 556.5,648.1 556.5,688.9 591.8,708.8 	"/>
                                        <polygon class="tidy-st9" points="279.6,1032.7 279.6,1046 291.3,1052.6 302.6,1046 302.6,1032.7 291.3,1026.1 	"/>
                                        <polygon class="tidy-st12" points="513.9,1060.4 513.9,1075.9 527.3,1083.8 540.4,1075.9 540.4,1060.4 527.3,1052.9 	"/>
                                        <polygon class="tidy-st5" points="755.5,862.5 755.5,837.4 734.2,825.1 712.2,837.4 712.2,862.5 734.2,874.8 	"/>
                                        <polygon class="tidy-st14" points="479.6,854.9 479.6,842.3 469,836.4 458,842.3 458,854.9 469,861.1 	"/>
                                        <polygon class="tidy-st6" points="883.1,965.8 883.1,940.7 861.8,928.4 839.9,940.7 839.9,965.8 861.8,978.1 	"/>
                                        <polygon class="tidy-st9" points="161.6,921.8 161.6,938 175.7,945.9 189.4,938 189.4,921.8 175.7,914 	"/>
                                        <polygon class="tidy-st16" points="754.4,962 712.9,938 670.4,962 670.4,1011 712.9,1035.1 754.4,1011 	"/>
                                        <polygon class="tidy-st14" points="479.6,1029.6 479.6,997.7 452.2,981.9 424.4,997.7 424.4,1029.6 452.2,1045.7 	"/>
                                        <polygon class="tidy-st14" points="662.2,1141.8 662.2,1116.7 640.9,1104.7 619.3,1116.7 619.3,1141.8 640.9,1154.1 	"/>
                                        <polygon class="tidy-st11" points="591.5,749.3 591.5,738.3 582.2,732.8 572.6,738.3 572.6,749.3 582.2,754.8 	"/>
                                        <polygon class="tidy-st15" points="621,800.1 621,816.9 635.7,825.1 649.8,816.9 649.8,800.1 635.7,791.8 	"/>
                                        <polygon class="tidy-st15" points="267.6,817.6 267.6,853.2 298.5,870.7 328.7,853.2 328.7,817.6 298.5,800.1 	"/>
                                        <polygon class="tidy-st11" points="394.2,926.6 394.2,914 383.6,907.8 372.2,914 372.2,926.6 383.6,933.2 	"/>
                                        <polygon class="tidy-st5" points="280,1947.6 280,1933.2 268,1926 255.6,1933.2 255.6,1947.6 268,1954.5 	"/>
                                        <polygon class="tidy-st5" points="147.9,1510.9 147.9,1531.8 166.1,1542.5 183.9,1531.8 183.9,1510.9 166.1,1500.6 	"/>
                                        <polyline class="tidy-st5" points="557.6,2239.9 557.6,2253.3 569.3,2259.8 580.6,2253.3 580.6,2239.9 569.3,2233.4 	"/>
                                        <polygon class="tidy-st14" points="753.1,2328.5 753.1,2340.8 764.1,2347.3 774.7,2340.8 774.7,2328.5 764.1,2322.3 	"/>
                                        <polygon class="tidy-st9" points="123.2,1838.9 123.2,1872.5 152.7,1889 181.1,1872.5 181.1,1838.9 152.7,1822.1 	"/>
                                        <polygon class="tidy-st11" points="221.8,2064.6 221.8,2103.7 255.8,2123.3 289.4,2103.7 289.4,2064.6 255.8,2045.1 	"/>
                                        <polygon class="tidy-st14" points="166.1,1305.4 166.1,1287.2 150.6,1278 134.5,1287.2 134.5,1305.4 150.6,1314.7 	"/>
                                        <polygon class="tidy-st5" points="147.2,1662.5 147.2,1649.9 136.5,1643.7 125.2,1649.9 125.2,1662.5 136.5,1669.1 	"/>
                                        <polygon class="tidy-st5" points="787.7,542.1 787.7,523.2 771.9,513.9 755.5,523.2 755.5,542.1 771.9,551.3 	"/>
                                        <polygon class="tidy-st8" points="288.2,1781.3 288.2,1742.1 254.9,1722.9 220.9,1742.1 220.9,1781.3 254.9,1800.8 	"/>
                                        <polygon class="tidy-st5" points="609,1825.2 609,1841.6 623.4,1849.9 637.5,1841.6 637.5,1825.2 623.4,1817.3 	"/>
                                        <polygon class="tidy-st5" points="816.5,1959.7 816.5,1984.7 838.2,1997 859.8,1984.7 859.8,1959.7 838.2,1947.6 	"/>
                                        <polygon class="tidy-st9" points="373.6,2059.1 373.6,2076 388.7,2084.5 403.1,2076 403.1,2059.1 388.7,2050.6 	"/>
                                        <polygon class="tidy-st14" points="666.3,1864.3 666.3,1903 699.9,1922.3 732.8,1903 732.8,1864.3 699.9,1845.4 	"/>
                                        <polygon class="tidy-st14" points="474.1,1959 474.1,1984 495.8,1996.4 517,1984 517,1959 495.8,1946.6 	"/>
                                        <polygon class="tidy-st14" points="623.7,1786.1 623.7,1769.6 610,1761.7 595.9,1769.6 595.9,1786.1 610,1793.9 	"/>
                                        <polygon class="tidy-st14" points="1048.1,2011.8 1048.1,1987.1 1026.9,1974.7 1005.2,1987.1 1005.2,2011.8 1026.9,2024.1 	"/>
                                        <polygon class="tidy-st9" points="479.6,1783.3 479.6,1768.9 467.6,1761.7 454.9,1768.9 454.9,1783.3 467.6,1790.2 	"/>
                                        <polygon class="tidy-st9" points="679.7,2166.2 679.7,2184.4 695.4,2193.6 711.2,2184.4 711.2,2166.2 695.4,2156.9 	"/>
                                        <polygon class="tidy-st5" points="1359.3,792.8 1322.3,771.6 1284.2,792.8 1284.2,836.8 1322.3,858.4 1359.3,836.8 	"/>
                                        <polygon class="tidy-st5" points="1367.2,925.6 1389.2,938 1410.4,925.6 1410.4,900.6 1389.2,888.2 1367.2,900.6 	"/>
                                        <polygon class="tidy-st12" points="1005.6,931.8 1016.6,938 1027.2,931.8 1027.2,919.4 1016.6,913.3 1005.6,919.4 	"/>
                                        <polygon class="tidy-st14" points="1348.3,1122.5 1307.2,1098.9 1265,1122.5 1265,1171.3 1307.2,1194.9 1348.3,1171.3 	"/>
                                        <polygon class="tidy-st5" points="1179.9,1183.3 1179.9,1158.2 1158.6,1145.9 1137,1158.2 1137,1183.3 1158.6,1195.6 	"/>
                                        <polygon class="tidy-st13" points="1237.5,965.8 1216.2,953.4 1194.6,965.8 1194.6,990.8 1216.2,1003.2 1237.5,990.8 	"/>
                                        <polygon class="tidy-st15" points="1549,991.8 1527.8,979.8 1505.8,991.8 1505.8,1017.2 1527.8,1029.6 1549,1017.2 	"/>
                                        <polygon class="tidy-st11" points="970.2,1114 970.2,1123.9 978.8,1128.7 987.1,1123.9 987.1,1114 978.8,1109.2 	"/>
                                        <polygon class="tidy-st8" points="847.4,1077.9 847.4,1044 818.3,1027.2 788.8,1044 788.8,1077.9 818.3,1094.8 	"/>
                                        <polygon class="tidy-st11" points="926,1934.9 926,1947.6 936.6,1953.8 947.3,1947.6 947.3,1934.9 936.6,1928.8 	"/>
                                        <polygon class="tidy-st5" points="1248.8,1922.3 1248.8,1937.4 1262.2,1944.9 1274.9,1937.4 1274.9,1922.3 1262.2,1914.7 	"/>
                                        <polygon class="tidy-st5" points="1532.2,2093.4 1532.2,2061.2 1505.1,2045.4 1477,2061.2 1477,2093.4 1505.1,2109.2 	"/>
                                        <polygon class="tidy-st14" points="1284.2,1759 1284.2,1742.5 1270.4,1734.6 1256.4,1742.5 1256.4,1759 1270.4,1766.8 	"/>
                                        <polygon class="tidy-st17" points="793.9,2140.8 793.9,2192.3 838.5,2218 882.4,2192.3 882.4,2140.8 838.5,2115.7 	"/>
                                        <polygon class="tidy-st11" points="1429.3,1942.2 1429.3,1899.3 1392.6,1878 1355.2,1899.3 1355.2,1942.2 1392.6,1963.4 	"/>
                                        <polygon class="tidy-st9" points="1102.7,1897.9 1102.7,1872.9 1081.4,1860.5 1059.5,1872.9 1059.5,1897.9 1081.4,1910.2 	"/>
                                        <polygon class="tidy-st6" points="1210.8,1853.3 1210.8,1828.3 1189.5,1815.9 1167.9,1828.3 1167.9,1853.3 1189.5,1865.6 	"/>
                                        <polygon class="tidy-st14" points="1283.1,2027.9 1283.1,2053 1304.8,2065.3 1326,2053 1326,2027.9 1304.8,2015.6 	"/>
                                        <polygon class="tidy-st5" points="2140.9,1182.9 2140.9,1208 2162.5,1220.3 2183.7,1208 2183.7,1182.9 2162.5,1170.9 	"/>
                                        <polygon class="tidy-st5" points="1554.9,1105.4 1554.9,1130.4 1576.5,1142.8 1597.8,1130.4 1597.8,1105.4 1576.5,1093 	"/>
                                        <polygon class="tidy-st14" points="1886.3,1169.5 1886.3,1194.6 1908.2,1206.9 1929.5,1194.6 1929.5,1169.5 1908.2,1157.2 	"/>
                                        <polygon class="tidy-st9" points="1998.5,1055.3 1998.5,1103.3 2040.3,1127.3 2081.2,1103.3 2081.2,1055.3 2040.3,1031.3 	"/>
                                        <polygon class="tidy-st15" points="2173.8,1118.4 2173.8,1130.4 2184.4,1136.6 2194.7,1130.4 2194.7,1118.4 2184.4,1112.3 	"/>
                                        <polygon class="tidy-st5" points="1639.3,568.1 1639.3,543.1 1617.7,530.7 1596,543.1 1596,568.1 1617.7,580.5 	"/>
                                        <polygon class="tidy-st14" points="1467.4,881.7 1498.6,899.5 1529.5,881.7 1529.5,845.7 1498.6,827.8 1467.4,845.7 	"/>
                                        <polygon class="tidy-st7" points="1583.7,447.7 1583.7,395.6 1539.4,370.2 1494.1,395.6 1494.1,447.7 1539.4,473.8 	"/>
                                        <polygon class="tidy-st11" points="1841.3,952.7 1841.3,901.3 1797.8,876.2 1752.8,901.3 1752.8,952.7 1797.8,978.1 	"/>
                                        <polygon class="tidy-st5" points="2228,771.2 2228,783.6 2238.6,789.4 2249.3,783.6 2249.3,771.2 2238.6,765.4 	"/>
                                        <polygon class="tidy-st14" points="1950.1,678.6 1950.1,629.5 1908.6,605.5 1866,629.5 1866,678.6 1908.6,702.6 	"/>
                                        <polygon class="tidy-st5" points="2037.9,777.1 2037.9,752 2016.7,740 1995,752 1995,777.1 2016.7,789.4 	"/>
                                        <polygon class="tidy-st14" points="2000.5,890.6 2000.5,872.8 1985.1,863.9 1969.7,872.8 1969.7,890.6 1985.1,899.5 	"/>
                                        <polygon class="tidy-st14" points="2095.2,671.7 2095.2,659.7 2084.9,653.6 2074.3,659.7 2074.3,671.7 2084.9,677.9 	"/>
                                        <polygon class="tidy-st13" points="1700.3,758.9 1700.3,733.8 1679.1,721.8 1657.1,733.8 1657.1,758.9 1679.1,771.6 	"/>
                                        <polygon class="tidy-st15" points="1878.4,823.4 1878.4,848.4 1900.4,860.8 1921.6,848.4 1921.6,823.4 1900.4,811 	"/>
                                        <polygon class="tidy-st15" points="1692.8,1027.5 1692.8,1036.4 1700.3,1040.5 1707.9,1036.4 1707.9,1027.5 1700.3,1023.1 	"/>
                                        <polygon class="tidy-st5" points="2051.3,1796.7 2051.3,1821.7 2072.9,1834.1 2094.2,1821.7 2094.2,1796.7 2072.9,1784.3 	"/>
                                        <polygon class="tidy-st9" points="1866.7,1817.3 1866.7,1792.2 1845.5,1779.9 1823.5,1792.2 1823.5,1817.3 1845.5,1829.6 	"/>
                                        <polygon class="tidy-st14" points="1841.3,1881.1 1841.3,1921.2 1876.3,1941.1 1910.6,1921.2 1910.6,1881.1 1876.3,1861.2 	"/>
                                        <polygon class="tidy-st14" points="1991.3,1813.8 1991.3,1788.8 1970,1776.4 1948.4,1788.8 1948.4,1813.8 1970,1826.2 	"/>
                                        <polygon class="tidy-st15" points="1553.8,1952.4 1553.8,1934.3 1538.4,1925.3 1522.6,1934.3 1522.6,1952.4 1538.4,1961.4 	"/>
                                        <polygon class="tidy-st15" points="1608.2,2517 1608.2,2498.8 1592.8,2489.9 1577,2498.8 1577,2517 1592.8,2525.9 	"/>
                                        <polygon class="tidy-st15" points="1126.7,1784 1137,1790.2 1147.6,1784 1147.6,1772 1137,1766.2 1126.7,1772 	"/>
                                        <polygon class="tidy-st15" points="1215.6,2146.3 1215.6,2090.4 1168.2,2063.3 1119.8,2090.4 1119.8,2146.3 1168.2,2173.7 	"/>
                                        <polygon class="tidy-st5" points="1026.9,2224.8 1026.9,2249.9 1048.5,2262.2 1069.7,2249.9 1069.7,2224.8 1048.5,2212.5 	"/>
                                        <polygon class="tidy-st5" points="557.5,1978.5 557.5,1995 571.9,2003.2 586,1995 586,1978.5 571.9,1970.3 	"/>
                                        <polygon class="tidy-st5" points="1270.1,2520.2 1270.1,2545.3 1291.7,2557.6 1313,2545.3 1313,2520.2 1291.7,2507.9 	"/>
                                        <polygon class="tidy-st4" points="1320.9,2664.4 1320.9,2692.1 1344.8,2705.7 1368.2,2692.1 1368.2,2664.4 1344.8,2650.8 	"/>
                                        <polygon class="tidy-st14" points="1373.6,2299.3 1373.6,2324.3 1395.2,2336.7 1416.5,2324.3 1416.5,2299.3 1395.2,2287.3 	"/>
                                        <polygon class="tidy-st14" points="1005.2,2465.7 1005.2,2481.8 1019.3,2490 1033.4,2481.8 1033.4,2465.7 1019.3,2457.5 	"/>
                                        <polygon class="tidy-st14" points="1148.8,2650.9 1148.8,2671.5 1166.7,2681.5 1183.8,2671.5 1183.8,2650.9 1166.7,2641 	"/>
                                        <polygon class="tidy-st9" points="1023.8,2323 1023.8,2309.9 1012.8,2303.8 1001.8,2309.9 1001.8,2323 1012.8,2329.1 	"/>
                                        <polygon class="tidy-st14" points="687.2,2046.4 687.2,2071.5 708.8,2084.2 730.1,2071.5 730.1,2046.4 708.8,2034.4 	"/>
                                        <polygon class="tidy-st5" points="1200.1,2285.6 1200.1,2310.6 1221.7,2323 1243,2310.6 1243,2285.6 1221.7,2273.2 	"/>
                                        <polygon class="tidy-st5" points="2011.2,1952.8 2011.2,1938 1998.5,1930.5 1985.4,1938 1985.4,1952.8 1998.5,1960.3 	"/>
                                        <polygon class="tidy-st5" points="1423,2430.4 1423,2477.7 1464.1,2501 1504.6,2477.7 1504.6,2430.4 1464.1,2407 	"/>
                                        <polygon class="tidy-st5" points="2006,2170 2006,2212.5 2043.1,2233.4 2079.1,2212.5 2079.1,2170 2043.1,2148.7 	"/>
                                        <polygon class="tidy-st14" points="2205.2,2046.8 2205.2,2062.6 2218.9,2070.5 2232.3,2062.6 2232.3,2046.8 2218.9,2038.9 	"/>
                                        <polygon class="tidy-st11" points="1862.6,2203.9 1862.6,2219.4 1876,2226.9 1889,2219.4 1889,2203.9 1876,2196.4 	"/>
                                        <polygon class="tidy-st11" points="1662.1,2382.1 1662.1,2402.4 1679.6,2412.3 1696.7,2402.4 1696.7,2382.1 1679.6,2372.2 	"/>
                                        <polygon class="tidy-st14" points="1832.3,2362.8 1832.3,2377.6 1845,2384.8 1857.6,2377.6 1857.6,2362.8 1845,2355.6 	"/>
                                        <polygon class="tidy-st14" points="1876,2089.7 1876,2114.7 1897.6,2127.1 1918.9,2114.7 1918.9,2089.7 1897.6,2077.3 	"/>
                                        <polygon class="tidy-st15" points="2042.7,2047.5 2042.7,2022.4 2021.5,2010.1 1999.5,2022.4 1999.5,2047.5 2021.5,2059.8 	"/>
                                        <polygon class="tidy-st9" points="1504.4,2227.2 1504.4,2214.9 1493.8,2208.7 1482.8,2214.9 1482.8,2227.2 1493.8,2233.4 	"/>
                                        <polygon class="tidy-st15" points="1686.6,2223.8 1686.6,2255 1713.7,2270.5 1740.1,2255 1740.1,2223.8 1713.7,2208.7 	"/>
                                        <polygon class="tidy-st17" points="2289.8,1740.8 2289.8,1766.8 2312.7,1779.9 2335,1766.8 2335,1740.8 2312.7,1727.7 	"/>
                                        <polygon class="tidy-st15" points="2397.5,1604.6 2397.5,1586.7 2382.4,1577.8 2366.6,1586.7 2366.6,1604.6 2382.4,1613.5 	"/>
                                        <polygon class="tidy-st5" points="2165.6,869.4 2165.6,883.1 2177.6,889.9 2189.2,883.1 2189.2,869.4 2177.6,862.8 	"/>
                                        <polygon class="tidy-st15" points="2162.1,772.3 2162.1,747.2 2140.9,734.9 2119.2,747.2 2119.2,772.3 2140.9,784.6 	"/>
                                        <polygon class="tidy-st5" points="2367.6,1147.6 2367.6,1135.2 2357,1129.4 2346.7,1135.2 2346.7,1147.6 2357,1153.4 	"/>
                                        <polygon class="tidy-st15" points="2217,987.7 2217,1012.8 2239,1025.1 2260.3,1012.8 2260.3,987.7 2239,975.7 	"/>
                                        <polyline class="tidy-st4" points="2368,1954.2 2383.4,1945.2 2398.9,1954.2 2398.9,1972 2383.4,1980.9 2368,1972 2368,1954.2 	"/>
                                        <polyline class="tidy-st10" points="2366.6,1349.7 2382.1,1341.1 2397.5,1350 2397.5,1367.8 2382.1,1376.4 2366.6,1367.5 2366.6,1349.7 	"/>
                                        <path class="tidy-st18" d="M2521,2183.3V727.7l-100.5-58l-953.1-550.3L1260.5,0l-206.9,119.4L100.5,669.7L0,727.7v1455.7l100.5,58l965.1,557.2l195.2,112.5l195.2-112.5l965.1-557.2L2521,2183.3z M100.5,2128.8V789.4l1160-670l0,0l1160,669.7v1339.4l-1160,670L100.5,2128.8z"/>
                                    </g>
                                </svg>
                                Tidyverse
                            </a>
                            <a class="link-card" data-url="https://www.bioconductor.org">
                                <svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" version="1.1" id="svg2" xml:space="preserve" viewBox="0 0 429.62668 123.62667" class="icon-wide" sodipodi:docname="bioconductor_logo_rgb.eps"><metadata id="metadata8"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format><dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage" /></cc:Work></rdf:RDF></metadata><defs id="defs6" /><sodipodi:namedview pagecolor="#ffffff" bordercolor="#666666" borderopacity="1" objecttolerance="10" gridtolerance="10" guidetolerance="10" inkscape:pageopacity="0" inkscape:pageshadow="2" inkscape:window-width="640" inkscape:window-height="480" id="namedview4" /><g id="g10" inkscape:groupmode="layer" inkscape:label="ink_ext_XXXXXX" transform="matrix(1.3333333,0,0,-1.3333333,0,123.62667)"><g id="g12" transform="scale(0.1)"><path d="m 822.406,779.391 c -2.047,18.664 -18.832,32.136 -37.496,30.089 -18.648,-2.042 -32.117,-18.828 -30.082,-37.488 2.043,-18.656 18.824,-32.117 37.481,-30.09 18.664,2.047 32.132,18.836 30.097,37.489" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path14" /><path d="m 879.23,896.68 c 4.211,9.097 0.258,19.871 -8.832,24.09 -9.089,4.218 -19.878,0.269 -24.097,-8.817 -4.223,-9.098 -0.266,-19.879 8.832,-24.105 9.082,-4.207 19.879,-0.254 24.097,8.832" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path16" /><path d="m 388.672,798.965 c -2.219,20.293 12.449,38.555 32.734,40.777 20.293,2.215 38.555,-12.441 40.774,-32.738 2.222,-20.293 -12.434,-38.551 -32.727,-40.777 -20.293,-2.223 -38.555,12.445 -40.781,32.738" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path18" /><path d="m 396.801,854.703 c -0.938,8.496 -8.555,14.613 -17.035,13.676 -8.481,-0.934 -14.621,-8.555 -13.696,-17.031 0.938,-8.5 8.563,-14.629 17.055,-13.703 8.492,0.937 14.609,8.57 13.676,17.058" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path20" /><path d="m 756.719,706.777 c -1.746,16.02 -16.16,27.594 -32.188,25.844 -16.015,-1.754 -27.59,-16.168 -25.84,-32.199 1.758,-16.02 16.164,-27.586 32.2,-25.824 16.011,1.75 27.586,16.156 25.828,32.179" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path22" /><path d="m 678.535,668.793 c 5.879,12.668 0.371,27.711 -12.297,33.59 -12.683,5.879 -27.715,0.371 -33.593,-12.309 -5.875,-12.664 -0.372,-27.711 12.296,-33.59 12.688,-5.879 27.727,-0.371 33.594,12.309" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path24" /><path d="m 828.598,732.75 c -0.809,7.473 4.59,14.199 12.07,15.023 7.48,0.821 14.199,-4.585 15.012,-12.07 0.82,-7.461 -4.571,-14.183 -12.063,-15.012 -7.469,-0.812 -14.187,4.586 -15.019,12.059" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path26" /><path d="m 717.578,821.711 c -0.82,7.473 4.578,14.207 12.039,15.027 7.492,0.817 14.211,-4.59 15.039,-12.074 0.824,-7.461 -4.59,-14.191 -12.066,-15.012 -7.485,-0.812 -14.199,4.582 -15.012,12.059" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path28" /><path d="m 665.313,852.781 c -1.165,10.684 6.55,20.301 17.226,21.473 10.691,1.164 20.305,-6.563 21.465,-17.234 1.172,-10.692 -6.531,-20.297 -17.227,-21.457 -10.683,-1.172 -20.293,6.542 -21.464,17.218" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path30" /><path d="m 611.02,872.82 c -8.485,11.121 -6.356,27.004 4.746,35.461 11.105,8.496 26.972,6.371 35.449,-4.726 8.476,-11.114 6.359,-26.992 -4.746,-35.469 -11.082,-8.477 -26.973,-6.348 -35.449,4.734" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path32" /><path d="m 533.191,898.184 c -1.57,14.359 8.789,27.285 23.161,28.855 14.367,1.57 27.281,-8.797 28.859,-23.164 1.57,-14.359 -8.789,-27.285 -23.168,-28.84 -14.363,-1.578 -27.281,8.793 -28.852,23.149" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path34" /><path d="m 492.34,841.664 1.621,0.57 c 16.519,6.317 25.254,24.579 19.445,40.731 -5.617,15.574 -22.715,23.699 -38.937,18.465 l -1.555,-0.547 c -16.523,-6.305 -25.273,-24.574 -19.445,-40.727 5.59,-15.636 22.668,-23.734 38.871,-18.492" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path36" /><path d="m 330.176,734.809 c -1.875,17.086 10.469,32.464 27.551,34.328 17.097,1.875 32.468,-10.465 34.336,-27.559 1.863,-17.086 -10.469,-32.457 -27.559,-34.32 -17.094,-1.875 -32.461,10.461 -34.328,27.551" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path38" /><path d="m 265.879,717.227 c -1.367,12.371 7.582,23.527 19.957,24.886 12.394,1.344 23.535,-7.605 24.883,-19.98 1.355,-12.391 -7.574,-23.524 -19.965,-24.883 -12.391,-1.352 -23.527,7.586 -24.875,19.977" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path40" /><path d="m 351.836,883.227 c -1.406,12.828 -12.93,22.074 -25.762,20.675 -12.82,-1.402 -22.07,-12.937 -20.676,-25.75 1.411,-12.804 12.942,-22.074 25.762,-20.672 12.817,1.422 22.082,12.938 20.676,25.747" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path42" /><path d="m 287.23,873.559 c -1.57,14.418 -14.55,24.828 -28.964,23.254 -14.422,-1.583 -24.832,-14.551 -23.262,-28.965 1.578,-14.422 14.547,-24.856 28.976,-23.27 14.418,1.59 24.825,14.563 23.25,28.981" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path44" /><path d="m 856.07,851.469 c -1.64,15.019 -15.156,25.879 -30.187,24.234 -15.024,-1.64 -25.871,-15.172 -24.238,-30.199 1.64,-15.016 15.164,-25.859 30.203,-24.219 15.015,1.641 25.871,15.16 24.222,30.184" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path46" /><path d="m 611.98,702.715 c -1.16,10.683 -10.769,18.387 -21.445,17.215 -10.691,-1.16 -18.394,-10.766 -17.234,-21.446 1.172,-10.691 10.769,-18.406 21.465,-17.234 10.683,1.172 18.386,10.777 17.214,21.465" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path48" /><path d="m 554.844,731.785 c -0.938,8.559 -8.621,14.703 -17.156,13.778 -8.547,-0.934 -14.727,-8.622 -13.793,-17.168 0.941,-8.536 8.625,-14.704 17.168,-13.778 8.554,0.949 14.718,8.625 13.781,17.168" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path50" /><path d="m 505.488,770.523 c -0.703,6.426 -6.472,11.04 -12.883,10.336 -6.406,-0.699 -11.042,-6.457 -10.332,-12.871 0.707,-6.406 6.465,-11.035 12.872,-10.336 6.418,0.696 11.039,6.481 10.343,12.871" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path52" /><path d="M 173.816,754.426 200.602,733.07 V 120.645 C 199.27,55.4375 126.391,0 70.9063,0 54.2109,0 37.4883,0.722656 24.1211,10.4688 2.75781,26.2109 -0.609375,52.4414 0.078125,80.1836 2.06641,146.895 72.2344,198.578 129.746,200.859 c 13.977,0.606 27.992,-0.328 44.313,-9.453 3.183,-1.777 -0.243,563.02 -0.243,563.02" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path54" /><path d="m 231.016,826.469 c -1.813,16.527 -16.668,28.402 -33.161,26.613 -16.503,-1.805 -28.445,-16.652 -26.632,-33.172 1.808,-16.484 16.652,-28.402 33.164,-26.609 16.515,1.832 28.441,16.66 26.629,33.168" fill="#3792ad" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path56" /><path d="m 871.773,716.07 c -1.164,10.684 6.551,20.297 17.227,21.469 10.691,1.168 20.301,-6.562 21.465,-17.23 1.172,-10.696 -6.535,-20.301 -17.227,-21.461 -10.683,-1.172 -20.293,6.543 -21.465,17.222" fill="#8aca25" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path58" /><path d="m 417.418,227.363 c 4.941,-0.707 11.551,-1.328 19.848,-1.847 8.277,-0.532 17.015,-0.813 26.191,-0.813 13.754,0 27.25,1.242 40.481,3.719 13.23,2.473 24.949,6.691 35.187,12.707 10.223,5.984 18.434,13.934 24.602,23.797 6.171,9.879 9.265,22.226 9.265,37.047 0,14.808 -2.644,27.25 -7.941,37.3 -5.289,10.067 -12.528,18.254 -21.696,24.61 -9.171,6.351 -19.933,10.93 -32.281,13.754 -12.347,2.828 -25.578,4.226 -39.683,4.226 h -53.973 z m 50.27,188.907 c 28.578,0 49.48,6.347 62.703,19.046 13.23,12.7 19.843,29.278 19.843,49.743 0,19.05 -6.968,35 -20.898,47.879 -13.941,12.878 -35.898,19.328 -65.879,19.328 -9.176,0 -17.914,-0.364 -26.191,-1.067 -8.297,-0.707 -14.907,-1.41 -19.848,-2.121 V 416.27 Z m -86.782,161.921 c 3.528,0.344 8.551,0.875 15.086,1.579 6.52,0.707 13.488,1.418 20.899,2.125 7.406,0.703 14.894,1.226 22.488,1.589 7.586,0.344 14.371,0.52 20.371,0.52 41.621,0 73.555,-8.024 95.777,-24.074 22.227,-16.051 33.336,-41.008 33.336,-74.871 0,-10.938 -1.679,-20.903 -5.031,-29.899 -3.348,-9 -7.852,-17.113 -13.484,-24.344 -5.653,-7.23 -12.262,-13.316 -19.852,-18.253 -7.586,-4.946 -15.433,-8.645 -23.543,-11.11 10.93,-1.414 21.516,-4.324 31.754,-8.734 10.223,-4.414 19.313,-10.582 27.246,-18.52 7.938,-7.933 14.285,-17.82 19.051,-29.625 4.758,-11.824 7.141,-26.035 7.141,-42.601 0,-19.039 -3.793,-35.469 -11.375,-49.203 -7.59,-13.766 -18.172,-25.235 -31.747,-34.403 -13.585,-9.187 -29.632,-15.976 -48.156,-20.375 -18.519,-4.414 -38.719,-6.613 -60.59,-6.613 -5.636,0 -11.996,0.184 -19.05,0.535 -7.051,0.344 -14.196,0.785 -21.422,1.324 -7.239,0.516 -14.293,1.242 -21.172,2.121 -6.875,0.871 -12.793,1.672 -17.727,2.379 v 380.453" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path60" /><path d="m 660.82,533.738 c -0.351,3.176 -0.617,7.059 -0.793,11.645 -0.183,4.578 -0.261,8.461 -0.261,11.644 0,2.817 0.078,6.34 0.261,10.578 0.176,4.235 0.442,7.754 0.793,10.586 3.172,0.344 7.055,0.61 11.645,0.793 4.582,0.172 8.465,0.258 11.637,0.258 2.828,0 6.347,-0.086 10.586,-0.258 4.234,-0.183 7.753,-0.449 10.585,-0.793 0.348,-2.832 0.606,-6.351 0.797,-10.586 0.164,-4.238 0.258,-7.761 0.258,-10.578 0,-3.183 -0.094,-7.066 -0.258,-11.644 -0.191,-4.586 -0.449,-8.469 -0.797,-11.645 -2.832,-0.355 -6.351,-0.617 -10.585,-0.8 -4.239,-0.176 -7.758,-0.254 -10.586,-0.254 -3.172,0 -7.055,0.078 -11.637,0.254 -4.59,0.183 -8.473,0.445 -11.645,0.8 z m 17.461,-95.769 h -33.867 c -0.355,1.754 -0.621,3.871 -0.785,6.336 -0.184,2.472 -0.27,5.121 -0.27,7.945 0,2.816 0.086,5.641 0.27,8.469 0.164,2.82 0.43,5.109 0.785,6.883 h 68.793 V 197.738 c -2.113,-0.347 -5.023,-0.629 -8.73,-0.8 -3.711,-0.172 -6.618,-0.274 -8.731,-0.274 -1.769,0 -4.59,0.102 -8.465,0.274 -3.89,0.171 -6.886,0.453 -9,0.8 v 240.231" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path62" /><path d="m 888.883,222.078 c 28.222,0 49.297,9.863 63.23,29.621 13.934,19.754 20.899,46.742 20.899,80.961 0,34.215 -6.965,61.195 -20.899,80.965 -13.933,19.75 -35.008,29.629 -63.23,29.629 -28.223,0 -49.297,-9.879 -63.238,-29.629 -13.942,-19.77 -20.895,-46.75 -20.895,-80.965 0,-34.219 6.953,-61.207 20.895,-80.961 13.941,-19.758 35.015,-29.621 63.238,-29.621 z m 0,-30.699 c -20.11,0 -37.746,3.609 -52.914,10.848 -15.176,7.222 -27.781,17.187 -37.832,29.902 -10.055,12.699 -17.555,27.68 -22.496,44.98 -4.938,17.266 -7.403,35.797 -7.403,55.551 0,19.75 2.465,38.278 7.403,55.567 4.941,17.281 12.441,32.273 22.496,44.976 10.051,12.703 22.656,22.66 37.832,29.891 15.168,7.226 32.804,10.851 52.914,10.851 20.109,0 37.656,-3.625 52.648,-10.851 14.989,-7.231 27.524,-17.188 37.574,-29.891 10.051,-12.703 17.637,-27.695 22.755,-44.976 5.11,-17.289 7.67,-35.817 7.67,-55.567 0,-19.754 -2.56,-38.285 -7.67,-55.551 -5.118,-17.3 -12.704,-32.281 -22.755,-44.98 -10.05,-12.715 -22.585,-22.68 -37.574,-29.902 -14.992,-7.239 -32.539,-10.848 -52.648,-10.848" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path64" /><path d="m 1243.41,231.602 c 1.76,-3.536 3.44,-8.317 5.03,-14.301 1.58,-5.996 2.73,-10.938 3.44,-14.813 -8.83,-3.172 -18.88,-5.824 -30.16,-7.945 -11.3,-2.102 -23.81,-3.164 -37.58,-3.164 -44.1,0 -77.61,12.074 -100.54,36.242 -22.93,24.164 -34.39,59.176 -34.39,105.039 0,20.11 2.82,38.719 8.47,55.824 5.63,17.11 13.93,32.016 24.86,44.719 10.94,12.703 24.61,22.66 41.02,29.891 16.4,7.226 35.36,10.851 56.88,10.851 13.4,0 26.2,-0.976 38.36,-2.91 12.17,-1.949 21.78,-4.152 28.85,-6.609 0,-4.59 -0.63,-9.883 -1.86,-15.875 -1.24,-6.008 -2.56,-10.77 -3.97,-14.293 -7.06,2.469 -15.97,4.582 -26.72,6.347 -10.76,1.762 -22.31,2.649 -34.66,2.649 -15.87,0 -29.72,-2.738 -41.54,-8.199 -11.82,-5.477 -21.69,-13.153 -29.63,-23.024 -7.94,-9.875 -13.85,-21.515 -17.73,-34.922 -3.88,-13.41 -5.82,-28.218 -5.82,-44.449 0,-38.09 9.08,-66.062 27.25,-83.867 18.17,-17.82 42.78,-26.715 73.82,-26.715 10.58,0 20.72,0.871 30.43,2.625 9.69,1.781 18.42,4.067 26.19,6.899" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path66" /><path d="m 1393.17,222.078 c 28.21,0 49.29,9.863 63.23,29.621 13.93,19.754 20.89,46.742 20.89,80.961 0,34.215 -6.96,61.195 -20.89,80.965 -13.94,19.75 -35.02,29.629 -63.23,29.629 -28.24,0 -49.31,-9.879 -63.24,-29.629 -13.94,-19.77 -20.9,-46.75 -20.9,-80.965 0,-34.219 6.96,-61.207 20.9,-80.961 13.93,-19.758 35,-29.621 63.24,-29.621 z m 0,-30.699 c -20.12,0 -37.76,3.609 -52.92,10.848 -15.18,7.222 -27.78,17.187 -37.84,29.902 -10.05,12.699 -17.55,27.68 -22.49,44.98 -4.94,17.266 -7.41,35.797 -7.41,55.551 0,19.75 2.47,38.278 7.41,55.567 4.94,17.281 12.44,32.273 22.49,44.976 10.06,12.703 22.66,22.66 37.84,29.891 15.16,7.226 32.8,10.851 52.92,10.851 20.1,0 37.64,-3.625 52.64,-10.851 15,-7.231 27.52,-17.188 37.57,-29.891 10.05,-12.703 17.64,-27.695 22.75,-44.976 5.12,-17.289 7.68,-35.817 7.68,-55.567 0,-19.754 -2.56,-38.285 -7.68,-55.551 -5.11,-17.3 -12.7,-32.281 -22.75,-44.98 -10.05,-12.715 -22.57,-22.68 -37.57,-29.902 -15,-7.239 -32.54,-10.848 -52.64,-10.848" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path68" /><path d="m 1558.83,467.602 c 2.82,0.343 5.56,0.605 8.21,0.785 2.64,0.168 5.2,0.265 7.67,0.265 2.82,0 5.47,-0.097 7.94,-0.265 2.45,-0.18 5.1,-0.442 7.93,-0.785 0.7,-6.364 1.23,-14.293 1.59,-23.817 0.35,-9.527 0.53,-17.816 0.53,-24.875 3.52,6.348 8.11,12.785 13.76,19.32 5.64,6.528 12.26,12.438 19.84,17.723 7.58,5.285 16.31,9.61 26.2,12.965 9.86,3.352 20.62,5.027 32.27,5.027 31.05,0 53.62,-9.257 67.73,-27.785 14.12,-18.519 21.18,-44.535 21.18,-78.047 V 197.738 c -2.12,-0.347 -5.04,-0.629 -8.73,-0.8 -3.71,-0.172 -6.62,-0.274 -8.74,-0.274 -1.77,0 -4.58,0.102 -8.47,0.274 -3.89,0.171 -6.89,0.453 -8.99,0.8 v 159.789 c 0,29.989 -4.68,51.504 -14.03,64.563 -9.34,13.043 -23.38,19.582 -42.06,19.582 -12.35,0 -24,-2.473 -34.93,-7.414 -10.94,-4.938 -20.37,-12.086 -28.3,-21.426 -7.95,-9.355 -14.21,-20.902 -18.79,-34.664 -4.59,-13.758 -6.88,-29.457 -6.88,-47.094 V 197.738 c -2.11,-0.347 -5.02,-0.629 -8.74,-0.8 -3.7,-0.172 -6.61,-0.274 -8.73,-0.274 -1.76,0 -4.58,0.102 -8.46,0.274 -3.88,0.171 -6.88,0.453 -9,0.8 v 269.864" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path70" /><path d="m 2020.25,431.617 c -7.06,2.821 -16.06,5.371 -27,7.668 -10.93,2.297 -22.22,3.434 -33.86,3.434 -16.58,0 -30.95,-2.821 -43.14,-8.461 -12.14,-5.645 -22.31,-13.492 -30.42,-23.543 -8.1,-10.063 -14.19,-22.141 -18.26,-36.25 -4.06,-14.113 -6.07,-29.629 -6.07,-46.57 0,-36.684 8.74,-63.422 26.18,-80.157 17.47,-16.765 42.26,-25.133 74.36,-25.133 11.64,0 22.76,0.602 33.33,1.848 10.58,1.231 18.87,2.742 24.88,4.488 z m 0,155.043 c 2.12,0.344 5.1,0.606 8.97,0.785 3.9,0.172 6.72,0.27 8.49,0.27 2.11,0 5.01,-0.098 8.71,-0.27 3.71,-0.179 6.62,-0.441 8.74,-0.785 V 204.063 c -10.94,-3.52 -24.51,-6.504 -40.74,-8.985 -16.22,-2.457 -33.16,-3.699 -50.79,-3.699 -19.42,0 -37.57,2.301 -54.5,6.875 -16.94,4.582 -31.6,12.172 -43.93,22.746 -12.35,10.602 -22.15,24.535 -29.37,41.801 -7.23,17.304 -10.84,38.633 -10.84,64.039 0,23.289 3.16,44 9.52,62.172 6.35,18.172 15.35,33.511 26.99,46.043 11.65,12.519 25.66,22.129 42.07,28.84 16.4,6.699 34.47,10.05 54.23,10.05 11.65,0 23.19,-0.976 34.67,-2.91 11.45,-1.949 20.72,-4.152 27.78,-6.609 V 586.66" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path72" /><path d="m 2114.61,467.602 c 2.1,0.343 5.12,0.605 8.99,0.785 3.89,0.168 6.7,0.265 8.47,0.265 2.12,0 5.03,-0.097 8.74,-0.265 3.71,-0.18 6.61,-0.442 8.74,-0.785 V 315.73 c 0,-19.05 1.92,-34.66 5.81,-46.824 3.87,-12.183 9.6,-21.703 17.19,-28.578 7.58,-6.887 16.84,-11.64 27.78,-14.293 10.92,-2.637 23.3,-3.957 37.04,-3.957 11.64,0 22.05,0.594 31.23,1.84 9.16,1.238 17.27,2.906 24.33,5.023 v 238.661 c 2.12,0.343 5.12,0.605 9,0.785 3.87,0.168 6.71,0.265 8.48,0.265 2.11,0 5.01,-0.097 8.73,-0.265 3.69,-0.18 6.62,-0.442 8.72,-0.785 V 204.605 c -13.07,-3.535 -27.6,-6.613 -43.66,-9.246 -16.05,-2.66 -32.53,-3.98 -49.47,-3.98 -16.6,0 -32.19,1.582 -46.82,4.769 -14.65,3.168 -27.34,9.258 -38.11,18.247 -10.78,9.003 -19.33,21.433 -25.66,37.304 -6.35,15.883 -9.53,36.508 -9.53,61.91 v 153.993" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path74" /><path d="m 2578.27,231.602 c 1.76,-3.536 3.43,-8.317 5.03,-14.301 1.57,-5.996 2.72,-10.938 3.43,-14.813 -8.82,-3.172 -18.87,-5.824 -30.15,-7.945 -11.3,-2.102 -23.82,-3.164 -37.58,-3.164 -44.1,0 -77.61,12.074 -100.54,36.242 -22.93,24.164 -34.39,59.176 -34.39,105.039 0,20.11 2.82,38.719 8.46,55.824 5.64,17.11 13.95,32.016 24.89,44.719 10.91,12.703 24.6,22.66 40.98,29.891 16.43,7.226 35.37,10.851 56.9,10.851 13.4,0 26.18,-0.976 38.37,-2.91 12.16,-1.949 21.76,-4.152 28.83,-6.609 0,-4.59 -0.62,-9.883 -1.84,-15.875 -1.25,-6.008 -2.57,-10.77 -3.99,-14.293 -7.06,2.469 -15.97,4.582 -26.71,6.347 -10.77,1.762 -22.33,2.649 -34.66,2.649 -15.88,0 -29.73,-2.738 -41.55,-8.199 -11.81,-5.477 -21.67,-13.153 -29.62,-23.024 -7.94,-9.875 -13.85,-21.515 -17.74,-34.922 -3.88,-13.41 -5.81,-28.218 -5.81,-44.449 0,-38.09 9.07,-66.062 27.25,-83.867 18.18,-17.82 42.78,-26.715 73.82,-26.715 10.59,0 20.71,0.871 30.43,2.625 9.69,1.781 18.43,4.067 26.19,6.899" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path76" /><path d="m 2669.28,437.969 h -46.02 c -0.36,1.754 -0.63,4.043 -0.82,6.875 -0.18,2.816 -0.26,5.633 -0.26,8.465 0,2.824 0.08,5.461 0.26,7.929 0.19,2.473 0.46,4.59 0.82,6.364 h 46.02 v 50.793 l 32.8,32.281 h 2.13 v -83.074 h 73.01 c 0.35,-1.774 0.62,-3.891 0.79,-6.364 0.18,-2.468 0.27,-5.105 0.27,-7.929 0,-2.832 -0.09,-5.649 -0.27,-8.465 -0.17,-2.832 -0.44,-5.121 -0.79,-6.875 h -73.01 V 262.285 c 0,-8.828 1.13,-15.793 3.42,-20.898 2.29,-5.117 5.31,-9.074 9.02,-11.91 3.71,-2.821 7.92,-4.68 12.68,-5.559 4.76,-0.875 9.62,-1.313 14.56,-1.313 12.34,0 23.11,1.59 32.28,4.758 2.47,-9.183 4.22,-19.054 5.29,-29.625 -12.69,-3.89 -27.52,-5.824 -44.46,-5.824 -20.1,0 -36.43,5.371 -48.93,16.137 -12.53,10.754 -18.79,28.301 -18.79,52.637 v 177.281" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path78" /><path d="m 2919.03,222.078 c 28.22,0 49.29,9.863 63.22,29.621 13.94,19.754 20.91,46.742 20.91,80.961 0,34.215 -6.97,61.195 -20.91,80.965 -13.93,19.75 -35,29.629 -63.22,29.629 -28.23,0 -49.31,-9.879 -63.24,-29.629 -13.94,-19.77 -20.9,-46.75 -20.9,-80.965 0,-34.219 6.96,-61.207 20.9,-80.961 13.93,-19.758 35.01,-29.621 63.24,-29.621 z m 0,-30.699 c -20.11,0 -37.75,3.609 -52.91,10.848 -15.17,7.222 -27.79,17.187 -37.84,29.902 -10.05,12.699 -17.55,27.68 -22.5,44.98 -4.95,17.266 -7.41,35.797 -7.41,55.551 0,19.75 2.46,38.278 7.41,55.567 4.95,17.281 12.45,32.273 22.5,44.976 10.05,12.703 22.67,22.66 37.84,29.891 15.16,7.226 32.8,10.851 52.91,10.851 20.11,0 37.64,-3.625 52.64,-10.851 15,-7.231 27.51,-17.188 37.58,-29.891 10.04,-12.703 17.64,-27.695 22.76,-44.976 5.11,-17.289 7.68,-35.817 7.68,-55.567 0,-19.754 -2.57,-38.285 -7.68,-55.551 -5.12,-17.3 -12.72,-32.281 -22.76,-44.98 -10.07,-12.715 -22.58,-22.68 -37.58,-29.902 -15,-7.239 -32.53,-10.848 -52.64,-10.848" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path80" /><path d="m 3094.7,467.602 c 2.82,0.343 5.57,0.605 8.19,0.785 2.66,0.168 5.21,0.265 7.68,0.265 2.82,0 5.48,-0.097 7.95,-0.265 2.46,-0.18 5.1,-0.442 7.93,-0.785 0.7,-6.364 1.23,-13.852 1.58,-22.5 0.35,-8.641 0.53,-16.489 0.53,-23.543 7.07,13.046 16.93,24.074 29.65,33.066 12.69,9 29.43,13.504 50.25,13.504 1.77,0 3.63,0 5.55,0 1.95,0 4.17,-0.184 6.62,-0.527 1.06,-6.008 1.6,-11.649 1.6,-16.934 0,-5.652 -0.54,-11.121 -1.6,-16.41 -2.83,0.347 -5,0.527 -6.62,0.527 -1.58,0 -3.26,0 -5,0 -24,0 -43.22,-7.578 -57.69,-22.754 -14.47,-15.172 -21.69,-40.394 -21.69,-75.668 V 197.738 c -2.12,-0.347 -5.03,-0.629 -8.74,-0.8 -3.7,-0.172 -6.61,-0.274 -8.73,-0.274 -1.77,0 -4.6,0.102 -8.46,0.274 -3.89,0.171 -6.89,0.453 -9,0.8 v 269.864" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path82" /><path d="m 406.344,34.8242 c 3.777,0 7.047,0.7227 9.804,2.2071 2.762,1.4648 5.047,3.6015 6.86,6.4062 1.82,2.8008 3.18,6.1602 4.082,10.0977 0.914,3.9257 1.367,8.3789 1.367,13.3789 0,4.9218 -0.453,9.3554 -1.367,13.3203 -0.902,3.9844 -2.262,7.3437 -4.082,10.0976 -1.813,2.7735 -4.098,4.8828 -6.86,6.3672 -2.757,1.4649 -6.027,2.1953 -9.804,2.1953 -3.785,0 -7.051,-0.7304 -9.817,-2.1953 -2.757,-1.4844 -5.043,-3.5937 -6.859,-6.3672 -1.816,-2.7539 -3.18,-6.1132 -4.082,-10.0976 -0.906,-3.9649 -1.356,-8.3985 -1.356,-13.3203 0,-5 0.45,-9.4532 1.356,-13.3789 0.902,-3.9375 2.266,-7.2969 4.082,-10.0977 1.816,-2.8047 4.102,-4.9414 6.859,-6.4062 2.766,-1.4844 6.032,-2.2071 9.817,-2.2071 z m 0,-9.9804 c -5.906,0 -10.996,1.0351 -15.313,3.1171 -4.312,2.0782 -7.883,4.9883 -10.718,8.7266 -2.84,3.75 -4.954,8.1953 -6.352,13.332 -1.402,5.1368 -2.102,10.7813 -2.102,16.8946 0,6.1211 0.7,11.7578 2.102,16.8945 1.398,5.1562 3.512,9.5898 6.352,13.3398 2.835,3.7306 6.406,6.6606 10.718,8.7896 4.317,2.109 9.407,3.164 15.313,3.164 5.898,0 10.996,-1.055 15.304,-3.164 4.313,-2.129 7.887,-5.059 10.723,-8.7896 2.832,-3.75 4.938,-8.1836 6.297,-13.3398 1.355,-5.1367 2.039,-10.7734 2.039,-16.8945 0,-6.1133 -0.684,-11.7578 -2.039,-16.8946 -1.359,-5.1367 -3.465,-9.582 -6.297,-13.332 -2.836,-3.7383 -6.41,-6.6484 -10.723,-8.7266 -4.308,-2.082 -9.406,-3.1171 -15.304,-3.1171" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path84" /><path d="m 477.676,65.7813 c 1.211,-0.1563 2.273,-0.2657 3.183,-0.3438 0.903,-0.0664 2.227,-0.1055 3.965,-0.1055 2.344,0 4.668,0.2344 6.977,0.7305 2.304,0.4883 4.359,1.3789 6.187,2.668 1.801,1.289 3.262,3.0468 4.356,5.2812 1.097,2.2188 1.648,5.1094 1.648,8.6641 0,3.1055 -0.472,5.7109 -1.418,7.832 -0.949,2.1211 -2.246,3.8164 -3.914,5.1055 -1.664,1.2812 -3.664,2.1875 -6.008,2.7265 -2.343,0.5157 -4.882,0.793 -7.597,0.793 -2.805,0 -5.254,-0.1289 -7.379,-0.3437 z m -11.567,42.0707 c 1.141,0.156 2.481,0.312 4.028,0.457 1.547,0.148 3.179,0.285 4.879,0.402 1.703,0.117 3.402,0.207 5.101,0.281 1.703,0.071 3.344,0.11 4.938,0.11 4.148,0 8.109,-0.411 11.843,-1.25 3.747,-0.832 7.04,-2.266 9.875,-4.305 2.836,-2.043 5.082,-4.7384 6.743,-8.1095 1.66,-3.3672 2.504,-7.5781 2.504,-12.6445 0,-5.293 -0.891,-9.6875 -2.676,-13.2227 -1.766,-3.5078 -4.11,-6.3281 -7.028,-8.4375 -2.914,-2.1211 -6.214,-3.6133 -9.925,-4.4844 -3.703,-0.8671 -7.485,-1.2968 -11.336,-1.2968 -1.442,0 -2.711,0.0195 -3.801,0.039 -1.102,0.0469 -2.285,0.1446 -3.578,0.293 V 26.1992 c -1.813,-0.2304 -3.735,-0.3398 -5.781,-0.3398 -0.903,0 -1.872,0.0195 -2.887,0.0586 -1.024,0.039 -1.988,0.1367 -2.899,0.2812 v 81.6528" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path86" /><path d="m 538.809,107.754 h 44.8 c 0.223,-1.524 0.34,-3.184 0.34,-5 0,-0.84 -0.019,-1.699 -0.058,-2.609 -0.039,-0.9067 -0.129,-1.7466 -0.282,-2.5005 H 550.375 V 74.2852 h 26.539 c 0.152,-0.75 0.266,-1.5704 0.344,-2.4297 0.07,-0.8789 0.109,-1.7188 0.109,-2.5586 0,-0.8281 -0.039,-1.6992 -0.109,-2.6094 -0.078,-0.9062 -0.192,-1.7461 -0.344,-2.5078 H 550.375 V 36.2891 h 34.137 c 0.23,-1.5039 0.347,-3.1641 0.347,-4.9805 0,-0.8398 -0.019,-1.7109 -0.054,-2.6172 -0.047,-0.8984 -0.137,-1.7383 -0.293,-2.4922 h -45.703 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path88" /><path d="m 608.105,107.754 c 0.836,0.144 1.719,0.254 2.665,0.332 0.945,0.078 1.835,0.117 2.668,0.117 0.832,0 1.722,-0.039 2.667,-0.117 0.942,-0.078 1.829,-0.188 2.665,-0.332 l 35.5,-61.2501 v 61.2501 c 0.91,0.144 1.847,0.254 2.839,0.332 0.977,0.078 1.961,0.117 2.942,0.117 0.828,0 1.695,-0.039 2.605,-0.117 0.914,-0.078 1.782,-0.188 2.617,-0.332 V 26.1992 c -0.835,-0.1445 -1.722,-0.2617 -2.671,-0.3398 -0.946,-0.0781 -1.832,-0.1172 -2.664,-0.1172 -0.833,0 -1.719,0.0391 -2.665,0.1172 -0.949,0.0781 -1.835,0.1953 -2.664,0.3398 L 618.992,87.1094 V 26.1992 c -0.824,-0.1445 -1.719,-0.2617 -2.66,-0.3398 -0.949,-0.0781 -1.875,-0.1172 -2.781,-0.1172 -0.985,0 -1.946,0.0391 -2.899,0.1172 -0.941,0.0781 -1.789,0.1953 -2.547,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path90" /><path d="m 727.078,38.5625 c 2.5,-0.9062 5.106,-1.707 7.824,-2.3906 2.719,-0.6641 6.051,-1.0156 9.981,-1.0156 6.195,0 10.836,1.2695 13.894,3.7968 3.063,2.5391 4.598,5.9688 4.598,10.2657 0,2.121 -0.324,3.9257 -0.973,5.4492 -0.632,1.5039 -1.601,2.8125 -2.886,3.9062 -1.289,1.1133 -2.891,2.1094 -4.821,3.0078 -1.925,0.8985 -4.172,1.8946 -6.75,2.9493 l -6.461,2.6054 c -2.199,0.9102 -4.199,1.9258 -6.011,3.0196 -1.817,1.0937 -3.387,2.4335 -4.707,4.0234 -1.325,1.582 -2.364,3.4101 -3.121,5.4961 -0.758,2.082 -1.141,4.5508 -1.141,7.4336 0,6.875 2.348,12.2656 7.035,16.1526 4.688,3.906 11.27,5.84 19.738,5.84 3.633,0 7.071,-0.293 10.321,-0.899 3.254,-0.605 6.125,-1.367 8.621,-2.265 -0.379,-3.184 -1.207,-6.3208 -2.496,-9.4146 -2.043,0.7618 -4.407,1.4258 -7.086,2.0313 -2.692,0.6055 -5.727,0.918 -9.129,0.918 -4.77,0 -8.442,-0.9649 -11.004,-2.9024 -2.57,-1.9219 -3.856,-4.8125 -3.856,-8.6601 0,-1.6016 0.321,-3.0196 0.961,-4.2774 0.649,-1.2305 1.496,-2.3437 2.555,-3.2734 1.055,-0.9453 2.305,-1.8047 3.742,-2.5469 1.438,-0.7617 2.942,-1.4453 4.532,-2.0508 l 6.355,-2.4922 c 3.02,-1.2187 5.711,-2.4687 8.055,-3.8047 2.343,-1.3203 4.34,-2.8632 6.011,-4.6523 1.657,-1.7656 2.93,-3.875 3.793,-6.2969 0.871,-2.4023 1.317,-5.2539 1.317,-8.4961 0,-7.7929 -2.699,-13.9257 -8.059,-18.4375 -5.375,-4.4922 -12.898,-6.7382 -22.574,-6.7382 -2.344,0 -4.457,0.0585 -6.352,0.2148 -1.882,0.1562 -3.64,0.3906 -5.269,0.6836 -1.629,0.3125 -3.195,0.6836 -4.711,1.1328 -1.516,0.4688 -3.059,0.9453 -4.649,1.4844 0.153,1.6601 0.493,3.3594 1.028,5.0976 0.519,1.7383 1.094,3.4453 1.695,5.1055" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path92" /><path d="m 830.859,34.8242 c 3.782,0 7.039,0.7227 9.809,2.2071 2.762,1.4648 5.047,3.6015 6.855,6.4062 1.825,2.8008 3.18,6.1602 4.082,10.0977 0.915,3.9257 1.368,8.3789 1.368,13.3789 0,4.9218 -0.453,9.3554 -1.368,13.3203 -0.902,3.9844 -2.257,7.3437 -4.082,10.0976 -1.808,2.7735 -4.093,4.8828 -6.855,6.3672 -2.77,1.4649 -6.027,2.1953 -9.809,2.1953 -3.781,0 -7.05,-0.7304 -9.812,-2.1953 -2.766,-1.4844 -5.047,-3.5937 -6.863,-6.3672 -1.817,-2.7539 -3.176,-6.1132 -4.082,-10.0976 -0.907,-3.9649 -1.364,-8.3985 -1.364,-13.3203 0,-5 0.457,-9.4532 1.364,-13.3789 0.906,-3.9375 2.265,-7.2969 4.082,-10.0977 1.816,-2.8047 4.097,-4.9414 6.863,-6.4062 2.762,-1.4844 6.031,-2.2071 9.812,-2.2071 z m 0,-9.9804 c -5.902,0 -11,1.0351 -15.316,3.1171 -4.309,2.0782 -7.875,4.9883 -10.715,8.7266 -2.832,3.75 -4.949,8.1953 -6.351,13.332 -1.403,5.1368 -2.098,10.7813 -2.098,16.8946 0,6.1211 0.695,11.7578 2.098,16.8945 1.402,5.1562 3.519,9.5898 6.351,13.3398 2.84,3.7306 6.406,6.6606 10.715,8.7896 4.316,2.109 9.414,3.164 15.316,3.164 5.899,0 11,-1.055 15.309,-3.164 4.316,-2.129 7.887,-5.059 10.723,-8.7896 2.832,-3.75 4.929,-8.1836 6.293,-13.3398 1.363,-5.1367 2.035,-10.7734 2.035,-16.8945 0,-6.1133 -0.672,-11.7578 -2.035,-16.8946 -1.364,-5.1367 -3.461,-9.582 -6.293,-13.332 -2.836,-3.7383 -6.407,-6.6484 -10.723,-8.7266 -4.309,-2.082 -9.41,-3.1171 -15.309,-3.1171" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path94" /><path d="m 889.836,107.754 c 1.805,0.215 3.773,0.332 5.891,0.332 2.043,0 3.937,-0.117 5.675,-0.332 V 61.4648 c 0,-4.6875 0.293,-8.6914 0.903,-12.0117 0.609,-3.3203 1.59,-6.0351 2.961,-8.1054 1.355,-2.0899 3.14,-3.6133 5.379,-4.5899 2.226,-0.9961 4.968,-1.4844 8.222,-1.4844 3.246,0 5.969,0.4883 8.164,1.4844 2.188,0.9766 3.965,2.5 5.332,4.5899 1.36,2.0703 2.344,4.7851 2.946,8.1054 0.609,3.3203 0.914,7.3242 0.914,12.0117 v 46.2892 c 1.882,0.215 3.812,0.332 5.785,0.332 2.113,0 4.082,-0.117 5.89,-0.332 V 59.4336 c 0,-5.4492 -0.503,-10.332 -1.531,-14.6367 -1.019,-4.3086 -2.683,-7.9414 -4.984,-10.8789 -2.317,-2.961 -5.32,-5.1992 -9.02,-6.75 -3.707,-1.5547 -8.207,-2.3242 -13.496,-2.3242 -5.293,0 -9.789,0.7695 -13.5,2.3242 -3.703,1.5508 -6.711,3.789 -9.015,6.75 -2.309,2.9375 -3.969,6.5703 -4.989,10.8789 -1.027,4.3047 -1.527,9.1875 -1.527,14.6367 v 48.3204" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path96" /><path d="m 975.805,107.852 c 1.66,0.156 3.172,0.312 4.539,0.457 1.355,0.148 2.691,0.285 4.019,0.402 1.325,0.117 2.703,0.207 4.145,0.281 1.433,0.071 3.015,0.11 4.762,0.11 3.855,0 7.67,-0.383 11.45,-1.133 3.79,-0.75 7.15,-2.071 10.09,-3.965 2.96,-1.895 5.35,-4.4454 7.21,-7.6563 1.85,-3.2149 2.78,-7.2852 2.78,-12.1875 0,-2.9493 -0.49,-5.6446 -1.47,-8.0664 -0.99,-2.4141 -2.24,-4.5625 -3.75,-6.4571 -1.51,-1.8945 -3.24,-3.5351 -5.16,-4.9297 -1.93,-1.4062 -3.79,-2.5507 -5.62,-3.457 l -1.35,-0.6836 23.7,-34.3672 c -2.04,-0.2304 -4.35,-0.3398 -6.92,-0.3398 -2.04,0 -4.08,0.1094 -6.12,0.3398 l -26.094,37.7656 v 0.4493 l 0.91,0.2226 c 2.047,0.5391 4.199,1.25 6.465,2.168 2.269,0.9101 4.369,2.1016 6.299,3.5664 1.93,1.4844 3.53,3.2617 4.81,5.332 1.29,2.0782 1.94,4.5899 1.94,7.5508 0,5.4375 -1.61,9.4805 -4.82,12.1289 -3.22,2.6445 -7.54,3.961 -12.991,3.961 -1.285,0 -2.481,-0.0391 -3.57,-0.1055 -1.098,-0.0781 -2.325,-0.1953 -3.688,-0.3438 V 26.1992 c -0.832,-0.0664 -1.762,-0.1445 -2.781,-0.2304 -1.02,-0.0704 -1.985,-0.1094 -2.891,-0.1094 -0.906,0 -1.894,0.0195 -2.949,0.0586 -1.059,0.039 -2.039,0.1367 -2.945,0.2812 v 81.6528" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path98" /><path d="m 1102.14,38.1055 c 1.66,-3.2422 2.72,-6.3867 3.18,-9.4141 -3.18,-1.3476 -6.43,-2.3437 -9.76,-2.9492 -3.32,-0.5977 -6.92,-0.8984 -10.77,-0.8984 -5.89,0 -11.21,0.957 -15.93,2.8906 -4.73,1.9336 -8.72,4.6875 -11.97,8.2734 -3.25,3.5899 -5.75,7.9649 -7.49,13.0938 -1.73,5.1562 -2.61,10.9375 -2.61,17.3632 0,6.504 0.88,12.375 2.61,17.6368 1.74,5.2539 4.24,9.7265 7.49,13.4375 3.25,3.7109 7.22,6.5629 11.91,8.5549 4.69,2 9.94,3.008 15.76,3.008 4.31,0 8.01,-0.293 11.12,-0.899 3.1,-0.605 5.86,-1.328 8.28,-2.148 -0.16,-1.758 -0.47,-3.352 -0.96,-4.825 -0.5,-1.4839 -1.08,-3.0464 -1.76,-4.7066 -1.14,0.3711 -2.24,0.7032 -3.3,1.0157 -1.06,0.2929 -2.18,0.5664 -3.4,0.8007 -1.21,0.2149 -2.54,0.3907 -4.02,0.5079 -1.48,0.1054 -3.16,0.1562 -5.05,0.1562 -8.24,0 -14.65,-2.793 -19.22,-8.3789 -4.58,-5.6055 -6.87,-13.6523 -6.87,-24.1602 0,-5.371 0.64,-10.0195 1.93,-13.957 1.29,-3.9219 3.1,-7.1758 5.45,-9.7344 2.34,-2.5898 5.16,-4.5117 8.44,-5.8007 3.29,-1.2891 6.98,-1.9219 11.06,-1.9219 3.18,0 6.05,0.2617 8.63,0.789 2.56,0.5274 4.98,1.2891 7.25,2.2657" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path100" /><path d="m 1128.68,107.754 h 44.8 c 0.23,-1.524 0.35,-3.184 0.35,-5 0,-0.84 -0.03,-1.699 -0.07,-2.609 -0.03,-0.9067 -0.13,-1.7466 -0.28,-2.5005 h -33.23 V 74.2852 h 26.54 c 0.15,-0.75 0.27,-1.5704 0.33,-2.4297 0.08,-0.8789 0.12,-1.7188 0.12,-2.5586 0,-0.8281 -0.04,-1.6992 -0.12,-2.6094 -0.06,-0.9062 -0.18,-1.7461 -0.33,-2.5078 h -26.54 V 36.2891 h 34.13 c 0.23,-1.5039 0.35,-3.1641 0.35,-4.9805 0,-0.8398 -0.02,-1.7109 -0.06,-2.6172 -0.04,-0.8984 -0.13,-1.7383 -0.29,-2.4922 h -45.7 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path102" /><path d="m 1231.32,38.5625 c 2.49,-0.9062 5.1,-1.707 7.82,-2.3906 2.73,-0.6641 6.05,-1.0156 9.99,-1.0156 6.2,0 10.83,1.2695 13.9,3.7968 3.05,2.5391 4.58,5.9688 4.58,10.2657 0,2.121 -0.32,3.9257 -0.96,5.4492 -0.64,1.5039 -1.61,2.8125 -2.9,3.9062 -1.28,1.1133 -2.89,2.1094 -4.8,3.0078 -1.94,0.8985 -4.18,1.8946 -6.76,2.9493 l -6.47,2.6054 c -2.19,0.9102 -4.2,1.9258 -6,3.0196 -1.82,1.0937 -3.39,2.4335 -4.72,4.0234 -1.32,1.582 -2.36,3.4101 -3.11,5.4961 -0.76,2.082 -1.14,4.5508 -1.14,7.4336 0,6.875 2.35,12.2656 7.03,16.1526 4.7,3.906 11.27,5.84 19.74,5.84 3.63,0 7.07,-0.293 10.33,-0.899 3.24,-0.605 6.11,-1.367 8.61,-2.265 -0.38,-3.184 -1.21,-6.3208 -2.5,-9.4146 -2.03,0.7618 -4.4,1.4258 -7.08,2.0313 -2.69,0.6055 -5.73,0.918 -9.14,0.918 -4.76,0 -8.42,-0.9649 -10.99,-2.9024 -2.58,-1.9219 -3.86,-4.8125 -3.86,-8.6601 0,-1.6016 0.32,-3.0196 0.96,-4.2774 0.65,-1.2305 1.5,-2.3437 2.56,-3.2734 1.06,-0.9453 2.3,-1.8047 3.74,-2.5469 1.43,-0.7617 2.95,-1.4453 4.53,-2.0508 l 6.36,-2.4922 c 3.02,-1.2187 5.7,-2.4687 8.05,-3.8047 2.34,-1.3203 4.34,-2.8632 6.01,-4.6523 1.66,-1.7656 2.93,-3.875 3.8,-6.2969 0.87,-2.4023 1.3,-5.2539 1.3,-8.4961 0,-7.7929 -2.68,-13.9257 -8.05,-18.4375 -5.38,-4.4922 -12.89,-6.7382 -22.57,-6.7382 -2.34,0 -4.46,0.0585 -6.35,0.2148 -1.89,0.1562 -3.65,0.3906 -5.27,0.6836 -1.63,0.3125 -3.2,0.6836 -4.71,1.1328 -1.52,0.4688 -3.06,0.9453 -4.65,1.4844 0.15,1.6601 0.49,3.3594 1.01,5.0976 0.54,1.7383 1.11,3.4453 1.71,5.1055" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path104" /><path d="m 1335.1,34.8242 c 3.78,0 7.05,0.7227 9.81,2.2071 2.76,1.4648 5.05,3.6015 6.85,6.4062 1.83,2.8008 3.19,6.1602 4.09,10.0977 0.92,3.9257 1.37,8.3789 1.37,13.3789 0,4.9218 -0.45,9.3554 -1.37,13.3203 -0.9,3.9844 -2.26,7.3437 -4.09,10.0976 -1.8,2.7735 -4.09,4.8828 -6.85,6.3672 -2.76,1.4649 -6.03,2.1953 -9.81,2.1953 -3.78,0 -7.05,-0.7304 -9.81,-2.1953 -2.76,-1.4844 -5.05,-3.5937 -6.86,-6.3672 -1.81,-2.7539 -3.18,-6.1132 -4.08,-10.0976 -0.91,-3.9649 -1.36,-8.3985 -1.36,-13.3203 0,-5 0.45,-9.4532 1.36,-13.3789 0.9,-3.9375 2.27,-7.2969 4.08,-10.0977 1.81,-2.8047 4.1,-4.9414 6.86,-6.4062 2.76,-1.4844 6.03,-2.2071 9.81,-2.2071 z m 0,-9.9804 c -5.9,0 -11,1.0351 -15.31,3.1171 -4.31,2.0782 -7.88,4.9883 -10.72,8.7266 -2.84,3.75 -4.95,8.1953 -6.35,13.332 -1.4,5.1368 -2.1,10.7813 -2.1,16.8946 0,6.1211 0.7,11.7578 2.1,16.8945 1.4,5.1562 3.51,9.5898 6.35,13.3398 2.84,3.7306 6.41,6.6606 10.72,8.7896 4.31,2.109 9.41,3.164 15.31,3.164 5.9,0 11,-1.055 15.31,-3.164 4.31,-2.129 7.88,-5.059 10.72,-8.7896 2.83,-3.75 4.93,-8.1836 6.29,-13.3398 1.36,-5.1367 2.05,-10.7734 2.05,-16.8945 0,-6.1133 -0.69,-11.7578 -2.05,-16.8946 -1.36,-5.1367 -3.46,-9.582 -6.29,-13.332 -2.84,-3.7383 -6.41,-6.6484 -10.72,-8.7266 -4.31,-2.082 -9.41,-3.1171 -15.31,-3.1171" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path106" /><path d="m 1394.86,107.754 h 42.65 c 0.15,-0.762 0.26,-1.574 0.35,-2.441 0.06,-0.879 0.11,-1.719 0.11,-2.559 0,-0.84 -0.05,-1.699 -0.11,-2.609 -0.09,-0.9067 -0.2,-1.7466 -0.35,-2.5005 h -31.07 v -23.914 h 25.97 c 0.15,-0.8399 0.26,-1.6992 0.34,-2.5586 0.07,-0.8711 0.11,-1.7305 0.11,-2.5586 0,-0.832 -0.04,-1.6797 -0.11,-2.5508 -0.08,-0.8672 -0.19,-1.7187 -0.34,-2.5469 h -25.97 V 26.1992 c -0.91,-0.1445 -1.84,-0.2617 -2.79,-0.3398 -0.94,-0.0781 -1.94,-0.1172 -3.01,-0.1172 -0.97,0 -1.98,0.0391 -3,0.1172 -1.01,0.0781 -1.94,0.1953 -2.78,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path108" /><path d="m 1474.6,97.6445 h -21.21 c -0.15,0.7539 -0.26,1.5938 -0.34,2.5005 -0.08,0.91 -0.12,1.769 -0.12,2.609 0,0.84 0.04,1.68 0.12,2.559 0.08,0.867 0.19,1.679 0.34,2.441 h 53.99 c 0.14,-0.762 0.26,-1.555 0.33,-2.402 0.08,-0.821 0.12,-1.653 0.12,-2.481 0,-0.84 -0.04,-1.719 -0.12,-2.668 -0.07,-0.9452 -0.19,-1.8046 -0.33,-2.5585 h -21.21 V 26.1992 c -1.75,-0.2304 -3.63,-0.3398 -5.68,-0.3398 -2.11,0 -4.08,0.1094 -5.89,0.3398 v 71.4453" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path110" /><path d="m 1521.78,107.754 c 0.83,0.144 1.87,0.254 3.12,0.332 1.25,0.078 2.39,0.117 3.45,0.117 1.06,0 2.14,-0.039 3.24,-0.117 1.09,-0.078 2.1,-0.188 3,-0.332 l 13.95,-67.9415 16.79,67.9415 c 0.91,0.144 1.91,0.254 3,0.332 1.1,0.078 2.14,0.117 3.13,0.117 0.9,0 1.92,-0.039 3.06,-0.117 1.13,-0.078 2.11,-0.188 2.95,-0.332 l 16.9,-68.6329 14.17,68.6329 c 0.83,0.144 1.72,0.254 2.67,0.332 0.94,0.078 1.87,0.117 2.78,0.117 1.05,0 2.14,-0.039 3.23,-0.117 1.1,-0.078 2.05,-0.188 2.89,-0.332 l -19.62,-81.5548 c -0.91,-0.1445 -1.97,-0.2617 -3.18,-0.3398 -1.21,-0.0781 -2.3,-0.1172 -3.29,-0.1172 -1.06,0 -2.23,0.0391 -3.52,0.1172 -1.27,0.0781 -2.45,0.1953 -3.51,0.3398 l -16.11,63.8594 -16.32,-63.8594 c -1.07,-0.1445 -2.21,-0.2617 -3.46,-0.3398 -1.25,-0.0781 -2.4,-0.1172 -3.46,-0.1172 -0.91,0 -1.95,0.0391 -3.12,0.1172 -1.17,0.0781 -2.21,0.1953 -3.12,0.3398 l -19.62,81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path112" /><path d="m 1651.41,55.1172 h 24.84 l -12.49,41.6211 z m 27.9,-10.0899 h -30.97 l -5.55,-18.8281 c -0.98,-0.1445 -1.97,-0.2617 -2.95,-0.3398 -0.99,-0.0781 -1.96,-0.1172 -2.95,-0.1172 -1.06,0 -2.1,0.0391 -3.12,0.1172 -1.02,0.0781 -1.94,0.1953 -2.78,0.3398 l 26.54,81.5548 c 0.99,0.144 2.05,0.254 3.18,0.332 1.14,0.078 2.31,0.117 3.51,0.117 1.06,0 2.16,-0.039 3.29,-0.117 1.14,-0.078 2.23,-0.188 3.3,-0.332 l 26.42,-81.5548 c -0.9,-0.1445 -1.93,-0.2617 -3.06,-0.3398 -1.14,-0.0781 -2.23,-0.1172 -3.3,-0.1172 -0.97,0 -1.97,0.0391 -3,0.1172 -1.03,0.0781 -1.98,0.1953 -2.89,0.3398 l -5.67,18.8281" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path114" /><path d="m 1717.88,107.852 c 1.66,0.156 3.17,0.312 4.54,0.457 1.35,0.148 2.69,0.285 4.01,0.402 1.33,0.117 2.71,0.207 4.15,0.281 1.44,0.071 3.02,0.11 4.76,0.11 3.85,0 7.67,-0.383 11.45,-1.133 3.78,-0.75 7.15,-2.071 10.1,-3.965 2.95,-1.895 5.34,-4.4454 7.21,-7.6563 1.84,-3.2149 2.77,-7.2852 2.77,-12.1875 0,-2.9493 -0.49,-5.6446 -1.47,-8.0664 -0.99,-2.4141 -2.25,-4.5625 -3.74,-6.4571 -1.52,-1.8945 -3.24,-3.5351 -5.17,-4.9297 -1.92,-1.4062 -3.8,-2.5507 -5.62,-3.457 l -1.35,-0.6836 23.71,-34.3672 c -2.05,-0.2304 -4.37,-0.3398 -6.93,-0.3398 -2.04,0 -4.09,0.1094 -6.12,0.3398 l -26.09,37.7656 v 0.4493 l 0.91,0.2226 c 2.05,0.5391 4.19,1.25 6.46,2.168 2.28,0.9101 4.37,2.1016 6.3,3.5664 1.93,1.4844 3.53,3.2617 4.81,5.332 1.29,2.0782 1.93,4.5899 1.93,7.5508 0,5.4375 -1.6,9.4805 -4.81,12.1289 -3.22,2.6445 -7.54,3.961 -12.99,3.961 -1.28,0 -2.48,-0.0391 -3.57,-0.1055 -1.09,-0.0781 -2.32,-0.1953 -3.69,-0.3438 V 26.1992 c -0.82,-0.0664 -1.76,-0.1445 -2.77,-0.2304 -1.02,-0.0704 -2,-0.1094 -2.9,-0.1094 -0.91,0 -1.89,0.0195 -2.94,0.0586 -1.07,0.039 -2.05,0.1367 -2.95,0.2812 v 81.6528" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path116" /><path d="m 1793.85,107.754 h 44.81 c 0.22,-1.524 0.34,-3.184 0.34,-5 0,-0.84 -0.02,-1.699 -0.07,-2.609 -0.04,-0.9067 -0.12,-1.7466 -0.27,-2.5005 h -33.24 V 74.2852 h 26.56 c 0.13,-0.75 0.25,-1.5704 0.32,-2.4297 0.08,-0.8789 0.12,-1.7188 0.12,-2.5586 0,-0.8281 -0.04,-1.6992 -0.12,-2.6094 -0.07,-0.9062 -0.19,-1.7461 -0.32,-2.5078 h -26.56 V 36.2891 h 34.16 c 0.2,-1.5039 0.33,-3.1641 0.33,-4.9805 0,-0.8398 -0.02,-1.7109 -0.06,-2.6172 -0.04,-0.8984 -0.14,-1.7383 -0.27,-2.4922 h -45.73 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path118" /><path d="m 1898.55,107.754 h 42.64 c 0.15,-0.762 0.26,-1.574 0.35,-2.441 0.07,-0.879 0.11,-1.719 0.11,-2.559 0,-0.84 -0.04,-1.699 -0.11,-2.609 -0.09,-0.9067 -0.2,-1.7466 -0.35,-2.5005 h -31.09 v -23.914 h 25.99 c 0.15,-0.8399 0.26,-1.6992 0.33,-2.5586 0.09,-0.8711 0.12,-1.7305 0.12,-2.5586 0,-0.832 -0.03,-1.6797 -0.12,-2.5508 -0.07,-0.8672 -0.18,-1.7187 -0.33,-2.5469 H 1910.1 V 26.1992 c -0.9,-0.1445 -1.83,-0.2617 -2.77,-0.3398 -0.95,-0.0781 -1.93,-0.1172 -3.01,-0.1172 -0.99,0 -1.98,0.0391 -3,0.1172 -1.01,0.0781 -1.95,0.1953 -2.77,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path120" /><path d="m 1995.61,34.8242 c 3.8,0 7.06,0.7227 9.83,2.2071 2.75,1.4648 5.04,3.6015 6.86,6.4062 1.81,2.8008 3.17,6.1602 4.08,10.0977 0.91,3.9257 1.37,8.3789 1.37,13.3789 0,4.9218 -0.46,9.3554 -1.37,13.3203 -0.91,3.9844 -2.27,7.3437 -4.08,10.0976 -1.82,2.7735 -4.11,4.8828 -6.86,6.3672 -2.77,1.4649 -6.03,2.1953 -9.83,2.1953 -3.76,0 -7.04,-0.7304 -9.79,-2.1953 -2.77,-1.4844 -5.05,-3.5937 -6.86,-6.3672 -1.82,-2.7539 -3.17,-6.1132 -4.09,-10.0976 -0.9,-3.9649 -1.36,-8.3985 -1.36,-13.3203 0,-5 0.46,-9.4532 1.36,-13.3789 0.92,-3.9375 2.27,-7.2969 4.09,-10.0977 1.81,-2.8047 4.09,-4.9414 6.86,-6.4062 2.75,-1.4844 6.03,-2.2071 9.79,-2.2071 z m 0,-9.9804 c -5.88,0 -10.99,1.0351 -15.3,3.1171 -4.32,2.0782 -7.87,4.9883 -10.72,8.7266 -2.84,3.75 -4.95,8.1953 -6.34,13.332 -1.41,5.1368 -2.1,10.7813 -2.1,16.8946 0,6.1211 0.69,11.7578 2.1,16.8945 1.39,5.1562 3.5,9.5898 6.34,13.3398 2.85,3.7306 6.4,6.6606 10.72,8.7896 4.31,2.109 9.42,3.164 15.3,3.164 5.91,0 11.02,-1.055 15.32,-3.164 4.31,-2.129 7.88,-5.059 10.73,-8.7896 2.83,-3.75 4.93,-8.1836 6.29,-13.3398 1.36,-5.1367 2.04,-10.7734 2.04,-16.8945 0,-6.1133 -0.68,-11.7578 -2.04,-16.8946 -1.36,-5.1367 -3.46,-9.582 -6.29,-13.332 -2.85,-3.7383 -6.42,-6.6484 -10.73,-8.7266 -4.3,-2.082 -9.41,-3.1171 -15.32,-3.1171" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path122" /><path d="m 2055.62,107.852 c 1.66,0.156 3.17,0.312 4.53,0.457 1.36,0.148 2.72,0.285 4.03,0.402 1.32,0.117 2.7,0.207 4.14,0.281 1.44,0.071 3.02,0.11 4.76,0.11 3.86,0 7.67,-0.383 11.46,-1.133 3.78,-0.75 7.15,-2.071 10.09,-3.965 2.94,-1.895 5.35,-4.4454 7.21,-7.6563 1.85,-3.2149 2.77,-7.2852 2.77,-12.1875 0,-2.9493 -0.48,-5.6446 -1.46,-8.0664 -0.99,-2.4141 -2.24,-4.5625 -3.75,-6.4571 -1.52,-1.8945 -3.23,-3.5351 -5.16,-4.9297 -1.93,-1.4062 -3.81,-2.5507 -5.62,-3.457 l -1.36,-0.6836 23.72,-34.3672 c -2.05,-0.2304 -4.36,-0.3398 -6.93,-0.3398 -2.04,0 -4.09,0.1094 -6.13,0.3398 l -26.08,37.7656 v 0.4493 l 0.91,0.2226 c 2.03,0.5391 4.19,1.25 6.46,2.168 2.27,0.9101 4.37,2.1016 6.29,3.5664 1.93,1.4844 3.55,3.2617 4.83,5.332 1.27,2.0782 1.92,4.5899 1.92,7.5508 0,5.4375 -1.61,9.4805 -4.82,12.1289 -3.22,2.6445 -7.53,3.961 -12.97,3.961 -1.3,0 -2.49,-0.0391 -3.59,-0.1055 -1.09,-0.0781 -2.32,-0.1953 -3.69,-0.3438 V 26.1992 c -0.82,-0.0664 -1.76,-0.1445 -2.77,-0.2304 -1.02,-0.0704 -1.97,-0.1094 -2.9,-0.1094 -0.9,0 -1.89,0.0195 -2.94,0.0586 -1.07,0.039 -2.05,0.1367 -2.95,0.2812 v 81.6528" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path124" /><path d="m 2178.56,35.1563 c 1.06,-0.1485 2.39,-0.2735 4.03,-0.3321 1.62,-0.0898 3.23,-0.1172 4.83,-0.1172 2.71,0 5.27,0.2227 7.64,0.6836 2.39,0.4492 4.49,1.2305 6.29,2.3242 1.82,1.0938 3.26,2.5586 4.32,4.4219 1.06,1.8555 1.59,4.211 1.59,7.0821 0,2.7929 -0.49,5.164 -1.46,7.0898 -1,1.9336 -2.34,3.4766 -4.04,4.6484 -1.7,1.1797 -3.73,2.0039 -6.08,2.5 -2.34,0.4883 -4.86,0.7227 -7.6,0.7227 h -9.52 z m 8.28,38.5742 c 5.15,0 9.08,1.1054 11.81,3.3398 2.7,2.2266 4.06,5.5742 4.06,10.0391 0,4.3086 -1.44,7.5195 -4.35,9.6289 -2.92,2.1172 -6.88,3.1836 -11.85,3.1836 -1.51,0 -2.97,-0.0391 -4.38,-0.1172 -1.39,-0.0781 -2.57,-0.1875 -3.57,-0.332 V 73.7305 Z m -19.75,34.0235 c 1.91,0.359 4.56,0.672 7.96,0.898 3.4,0.227 6.84,0.34 10.32,0.34 4.3,0 8.23,-0.379 11.79,-1.14 3.56,-0.743 6.6,-1.973 9.13,-3.68 2.54,-1.703 4.5,-3.899 5.91,-6.5743 1.39,-2.6954 2.09,-5.9571 2.09,-9.8164 0,-2.3321 -0.35,-4.5196 -1.09,-6.5118 -0.7,-2.0117 -1.67,-3.789 -2.88,-5.3437 -1.2,-1.5508 -2.61,-2.8203 -4.2,-3.8555 -1.58,-1.0156 -3.21,-1.7578 -4.87,-2.207 2.11,-0.2266 4.25,-0.7813 6.4,-1.6992 2.15,-0.8985 4.1,-2.1875 5.84,-3.8594 1.74,-1.668 3.17,-3.7578 4.26,-6.2891 1.1,-2.5273 1.64,-5.6133 1.64,-9.2461 0,-4.3867 -0.86,-8.1054 -2.61,-11.1718 -1.75,-3.0664 -4.1,-5.5391 -7.09,-7.4297 -2.98,-1.8867 -6.5,-3.2539 -10.53,-4.0742 -4.06,-0.8399 -8.38,-1.25 -12.99,-1.25 -2.88,0 -6.02,0.125 -9.43,0.3906 -3.4,0.2734 -6.61,0.5859 -9.65,0.9648 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path126" /><path d="m 2242.97,107.754 c 0.91,0.144 1.85,0.254 2.84,0.332 0.97,0.078 1.97,0.117 2.94,0.117 0.98,0 1.97,-0.039 2.96,-0.117 0.97,-0.078 1.93,-0.188 2.84,-0.332 V 26.1992 c -0.91,-0.1445 -1.85,-0.2617 -2.79,-0.3398 -0.94,-0.0781 -1.95,-0.1172 -3.01,-0.1172 -0.97,0 -1.98,0.0391 -2.99,0.1172 -1.02,0.0781 -1.97,0.1953 -2.79,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path128" /><path d="m 2314.42,34.8242 c 3.79,0 7.05,0.7227 9.81,2.2071 2.77,1.4648 5.05,3.6015 6.87,6.4062 1.81,2.8008 3.17,6.1602 4.08,10.0977 0.9,3.9257 1.37,8.3789 1.37,13.3789 0,4.9218 -0.47,9.3554 -1.37,13.3203 -0.91,3.9844 -2.27,7.3437 -4.08,10.0976 -1.82,2.7735 -4.1,4.8828 -6.87,6.3672 -2.76,1.4649 -6.02,2.1953 -9.81,2.1953 -3.77,0 -7.04,-0.7304 -9.81,-2.1953 -2.76,-1.4844 -5.04,-3.5937 -6.85,-6.3672 -1.83,-2.7539 -3.18,-6.1132 -4.09,-10.0976 -0.9,-3.9649 -1.36,-8.3985 -1.36,-13.3203 0,-5 0.46,-9.4532 1.36,-13.3789 0.91,-3.9375 2.26,-7.2969 4.09,-10.0977 1.81,-2.8047 4.09,-4.9414 6.85,-6.4062 2.77,-1.4844 6.04,-2.2071 9.81,-2.2071 z m 0,-9.9804 c -5.89,0 -11,1.0351 -15.3,3.1171 -4.32,2.0782 -7.88,4.9883 -10.73,8.7266 -2.83,3.75 -4.95,8.1953 -6.34,13.332 -1.42,5.1368 -2.1,10.7813 -2.1,16.8946 0,6.1211 0.68,11.7578 2.1,16.8945 1.39,5.1562 3.51,9.5898 6.34,13.3398 2.85,3.7306 6.41,6.6606 10.73,8.7896 4.3,2.109 9.41,3.164 15.3,3.164 5.9,0 11.01,-1.055 15.31,-3.164 4.32,-2.129 7.88,-5.059 10.72,-8.7896 2.84,-3.75 4.94,-8.1836 6.29,-13.3398 1.37,-5.1367 2.04,-10.7734 2.04,-16.8945 0,-6.1133 -0.67,-11.7578 -2.04,-16.8946 -1.35,-5.1367 -3.45,-9.582 -6.29,-13.332 -2.84,-3.7383 -6.4,-6.6484 -10.72,-8.7266 -4.3,-2.082 -9.41,-3.1171 -15.31,-3.1171" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path130" /><path d="m 2374.17,107.754 c 0.9,0.144 1.86,0.254 2.86,0.332 0.97,0.078 1.95,0.117 2.94,0.117 0.98,0 1.97,-0.039 2.95,-0.117 0.97,-0.078 1.93,-0.188 2.83,-0.332 V 26.1992 c -0.9,-0.1445 -1.83,-0.2617 -2.79,-0.3398 -0.94,-0.0781 -1.94,-0.1172 -2.99,-0.1172 -0.99,0 -1.98,0.0391 -3,0.1172 -1.03,0.0781 -1.96,0.1953 -2.8,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path132" /><path d="m 2414.21,107.754 c 0.83,0.144 1.73,0.254 2.67,0.332 0.95,0.078 1.84,0.117 2.68,0.117 0.82,0 1.69,-0.039 2.64,-0.117 0.96,-0.078 1.85,-0.188 2.68,-0.332 l 35.51,-61.2501 v 61.2501 c 0.89,0.144 1.84,0.254 2.81,0.332 0.98,0.078 1.97,0.117 2.96,0.117 0.84,0 1.7,-0.039 2.61,-0.117 0.9,-0.078 1.79,-0.188 2.6,-0.332 V 26.1992 c -0.81,-0.1445 -1.72,-0.2617 -2.65,-0.3398 -0.95,-0.0781 -1.85,-0.1172 -2.67,-0.1172 -0.84,0 -1.72,0.0391 -2.67,0.1172 -0.94,0.0781 -1.83,0.1953 -2.67,0.3398 l -35.6,60.9102 V 26.1992 c -0.84,-0.1445 -1.73,-0.2617 -2.66,-0.3398 -0.96,-0.0781 -1.89,-0.1172 -2.79,-0.1172 -0.98,0 -1.96,0.0391 -2.89,0.1172 -0.95,0.0781 -1.8,0.1953 -2.56,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path134" /><path d="m 2499.85,107.754 h 42.64 c 0.13,-0.762 0.27,-1.574 0.34,-2.441 0.07,-0.879 0.1,-1.719 0.1,-2.559 0,-0.84 -0.03,-1.699 -0.1,-2.609 -0.07,-0.9067 -0.21,-1.7466 -0.34,-2.5005 h -31.08 v -23.914 h 25.98 c 0.14,-0.8399 0.26,-1.6992 0.32,-2.5586 0.09,-0.8711 0.13,-1.7305 0.13,-2.5586 0,-0.832 -0.04,-1.6797 -0.13,-2.5508 -0.06,-0.8672 -0.18,-1.7187 -0.32,-2.5469 h -25.98 V 26.1992 c -0.91,-0.1445 -1.83,-0.2617 -2.78,-0.3398 -0.94,-0.0781 -1.95,-0.1172 -3,-0.1172 -1,0 -1.99,0.0391 -3.01,0.1172 -1.02,0.0781 -1.95,0.1953 -2.77,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path136" /><path d="m 2596.92,34.8242 c 3.79,0 7.05,0.7227 9.82,2.2071 2.76,1.4648 5.04,3.6015 6.86,6.4062 1.81,2.8008 3.18,6.1602 4.08,10.0977 0.92,3.9257 1.36,8.3789 1.36,13.3789 0,4.9218 -0.44,9.3554 -1.36,13.3203 -0.9,3.9844 -2.27,7.3437 -4.08,10.0976 -1.82,2.7735 -4.1,4.8828 -6.86,6.3672 -2.77,1.4649 -6.03,2.1953 -9.82,2.1953 -3.77,0 -7.04,-0.7304 -9.81,-2.1953 -2.75,-1.4844 -5.03,-3.5937 -6.85,-6.3672 -1.83,-2.7539 -3.18,-6.1132 -4.09,-10.0976 -0.91,-3.9649 -1.36,-8.3985 -1.36,-13.3203 0,-5 0.45,-9.4532 1.36,-13.3789 0.91,-3.9375 2.26,-7.2969 4.09,-10.0977 1.82,-2.8047 4.1,-4.9414 6.85,-6.4062 2.77,-1.4844 6.04,-2.2071 9.81,-2.2071 z m 0,-9.9804 c -5.89,0 -10.99,1.0351 -15.31,3.1171 -4.3,2.0782 -7.88,4.9883 -10.72,8.7266 -2.84,3.75 -4.95,8.1953 -6.34,13.332 -1.41,5.1368 -2.1,10.7813 -2.1,16.8946 0,6.1211 0.69,11.7578 2.1,16.8945 1.39,5.1562 3.5,9.5898 6.34,13.3398 2.84,3.7306 6.42,6.6606 10.72,8.7896 4.32,2.109 9.42,3.164 15.31,3.164 5.9,0 11.01,-1.055 15.31,-3.164 4.32,-2.129 7.89,-5.059 10.71,-8.7896 2.85,-3.75 4.95,-8.1836 6.3,-13.3398 1.38,-5.1367 2.04,-10.7734 2.04,-16.8945 0,-6.1133 -0.66,-11.7578 -2.04,-16.8946 -1.35,-5.1367 -3.45,-9.582 -6.3,-13.332 -2.82,-3.7383 -6.39,-6.6484 -10.71,-8.7266 -4.3,-2.082 -9.41,-3.1171 -15.31,-3.1171" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path138" /><path d="m 2656.92,107.852 c 1.66,0.156 3.16,0.312 4.54,0.457 1.35,0.148 2.71,0.285 4.02,0.402 1.32,0.117 2.71,0.207 4.14,0.281 1.44,0.071 3.03,0.11 4.76,0.11 3.86,0 7.67,-0.383 11.46,-1.133 3.77,-0.75 7.14,-2.071 10.09,-3.965 2.95,-1.895 5.35,-4.4454 7.21,-7.6563 1.85,-3.2149 2.78,-7.2852 2.78,-12.1875 0,-2.9493 -0.49,-5.6446 -1.48,-8.0664 -0.98,-2.4141 -2.23,-4.5625 -3.73,-6.4571 -1.53,-1.8945 -3.24,-3.5351 -5.17,-4.9297 -1.92,-1.4062 -3.81,-2.5507 -5.62,-3.457 l -1.36,-0.6836 23.71,-34.3672 c -2.05,-0.2304 -4.35,-0.3398 -6.93,-0.3398 -2.02,0 -4.07,0.1094 -6.12,0.3398 l -26.08,37.7656 v 0.4493 l 0.92,0.2226 c 2.03,0.5391 4.18,1.25 6.45,2.168 2.27,0.9101 4.36,2.1016 6.3,3.5664 1.92,1.4844 3.54,3.2617 4.83,5.332 1.27,2.0782 1.91,4.5899 1.91,7.5508 0,5.4375 -1.61,9.4805 -4.82,12.1289 -3.21,2.6445 -7.54,3.961 -12.98,3.961 -1.29,0 -2.47,-0.0391 -3.58,-0.1055 -1.09,-0.0781 -2.31,-0.1953 -3.69,-0.3438 V 26.1992 c -0.83,-0.0664 -1.76,-0.1445 -2.76,-0.2304 -1.03,-0.0704 -1.99,-0.1094 -2.91,-0.1094 -0.91,0 -1.88,0.0195 -2.93,0.0586 -1.08,0.039 -2.04,0.1367 -2.96,0.2812 v 81.6528" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path140" /><path d="m 2735.16,107.754 c 0.91,0.144 1.94,0.254 3.11,0.332 1.19,0.078 2.29,0.117 3.36,0.117 1.06,0 2.21,-0.039 3.45,-0.117 1.25,-0.078 2.29,-0.188 3.12,-0.332 l 21.1,-51.0431 21.2,51.0431 c 0.76,0.144 1.71,0.254 2.84,0.332 1.14,0.078 2.22,0.117 3.31,0.117 0.96,0 2.07,-0.039 3.28,-0.117 1.21,-0.078 2.23,-0.188 3.05,-0.332 l 3.86,-81.5548 c -0.92,-0.1445 -1.84,-0.2617 -2.78,-0.3398 -0.95,-0.0781 -1.9,-0.1172 -2.88,-0.1172 -1,0 -1.96,0.0391 -2.9,0.1172 -0.95,0.0781 -1.83,0.1953 -2.67,0.3398 l -2.6,63.4102 -19.96,-46.5156 c -1.52,-0.2227 -3.06,-0.3204 -4.66,-0.3204 -1.44,0 -2.87,0.0977 -4.3,0.3204 l -19.29,46.8359 -2.61,-63.7305 c -0.83,-0.1445 -1.7,-0.2617 -2.61,-0.3398 -0.89,-0.0781 -1.77,-0.1172 -2.6,-0.1172 -0.98,0 -1.93,0.0391 -2.83,0.1172 -0.91,0.0781 -1.78,0.1953 -2.61,0.3398 l 3.62,81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path142" /><path d="m 2846.2,55.1172 h 24.83 l -12.47,41.6211 z m 27.9,-10.0899 h -30.96 l -5.57,-18.8281 c -0.98,-0.1445 -1.96,-0.2617 -2.94,-0.3398 -0.99,-0.0781 -1.98,-0.1172 -2.95,-0.1172 -1.07,0 -2.1,0.0391 -3.12,0.1172 -1.02,0.0781 -1.94,0.1953 -2.78,0.3398 l 26.53,81.5548 c 0.99,0.144 2.05,0.254 3.18,0.332 1.14,0.078 2.3,0.117 3.52,0.117 1.06,0 2.15,-0.039 3.29,-0.117 1.13,-0.078 2.24,-0.188 3.29,-0.332 l 26.42,-81.5548 c -0.9,-0.1445 -1.93,-0.2617 -3.06,-0.3398 -1.13,-0.0781 -2.23,-0.1172 -3.28,-0.1172 -1,0 -2,0.0391 -3.02,0.1172 -1.01,0.0781 -1.98,0.1953 -2.89,0.3398 l -5.66,18.8281" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path144" /><path d="m 2919.24,97.6445 h -21.21 c -0.14,0.7539 -0.26,1.5938 -0.34,2.5005 -0.07,0.91 -0.1,1.769 -0.1,2.609 0,0.84 0.03,1.68 0.1,2.559 0.08,0.867 0.2,1.679 0.34,2.441 h 53.99 c 0.15,-0.762 0.26,-1.555 0.34,-2.402 0.08,-0.821 0.11,-1.653 0.11,-2.481 0,-0.84 -0.03,-1.719 -0.11,-2.668 -0.08,-0.9452 -0.19,-1.8046 -0.34,-2.5585 h -21.2 V 26.1992 c -1.75,-0.2304 -3.64,-0.3398 -5.68,-0.3398 -2.12,0 -4.08,0.1094 -5.9,0.3398 v 71.4453" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path146" /><path d="m 2973.34,107.754 c 0.91,0.144 1.85,0.254 2.84,0.332 0.98,0.078 1.97,0.117 2.95,0.117 0.97,0 1.97,-0.039 2.95,-0.117 0.97,-0.078 1.93,-0.188 2.84,-0.332 V 26.1992 c -0.91,-0.1445 -1.84,-0.2617 -2.79,-0.3398 -0.94,-0.0781 -1.94,-0.1172 -3,-0.1172 -0.98,0 -1.98,0.0391 -3,0.1172 -1.02,0.0781 -1.96,0.1953 -2.79,0.3398 v 81.5548" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path148" /><path d="m 3065.43,38.1055 c 1.66,-3.2422 2.74,-6.3867 3.2,-9.4141 -3.2,-1.3476 -6.45,-2.3437 -9.78,-2.9492 -3.31,-0.5977 -6.91,-0.8984 -10.76,-0.8984 -5.9,0 -11.22,0.957 -15.94,2.8906 -4.72,1.9336 -8.71,4.6875 -11.97,8.2734 -3.25,3.5899 -5.75,7.9649 -7.48,13.0938 -1.74,5.1562 -2.6,10.9375 -2.6,17.3632 0,6.504 0.86,12.375 2.6,17.6368 1.73,5.2539 4.23,9.7265 7.48,13.4375 3.26,3.7109 7.23,6.5629 11.92,8.5549 4.68,2 9.93,3.008 15.76,3.008 4.31,0 8,-0.293 11.12,-0.899 3.1,-0.605 5.85,-1.328 8.27,-2.148 -0.16,-1.758 -0.47,-3.352 -0.96,-4.825 -0.49,-1.4839 -1.08,-3.0464 -1.76,-4.7066 -1.13,0.3711 -2.23,0.7032 -3.28,1.0157 -1.07,0.2929 -2.19,0.5664 -3.41,0.8007 -1.2,0.2149 -2.55,0.3907 -4.03,0.5079 -1.47,0.1054 -3.15,0.1562 -5.04,0.1562 -8.24,0 -14.64,-2.793 -19.23,-8.3789 -4.56,-5.6055 -6.86,-13.6523 -6.86,-24.1602 0,-5.371 0.65,-10.0195 1.92,-13.957 1.29,-3.9219 3.11,-7.1758 5.45,-9.7344 2.35,-2.5898 5.17,-4.5117 8.45,-5.8007 3.29,-1.2891 6.97,-1.9219 11.06,-1.9219 3.18,0 6.04,0.2617 8.63,0.789 2.58,0.5274 4.98,1.2891 7.24,2.2657" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path150" /><path d="m 3089.92,38.5625 c 2.5,-0.9062 5.11,-1.707 7.84,-2.3906 2.71,-0.6641 6.03,-1.0156 9.97,-1.0156 6.21,0 10.84,1.2695 13.9,3.7968 3.05,2.5391 4.59,5.9688 4.59,10.2657 0,2.121 -0.32,3.9257 -0.97,5.4492 -0.64,1.5039 -1.59,2.8125 -2.88,3.9062 -1.3,1.1133 -2.89,2.1094 -4.83,3.0078 -1.93,0.8985 -4.18,1.8946 -6.74,2.9493 l -6.47,2.6054 c -2.19,0.9102 -4.2,1.9258 -6.01,3.0196 -1.81,1.0937 -3.38,2.4335 -4.71,4.0234 -1.32,1.582 -2.36,3.4101 -3.12,5.4961 -0.76,2.082 -1.13,4.5508 -1.13,7.4336 0,6.875 2.34,12.2656 7.04,16.1526 4.68,3.906 11.26,5.84 19.72,5.84 3.63,0 7.08,-0.293 10.32,-0.899 3.25,-0.605 6.13,-1.367 8.63,-2.265 -0.39,-3.184 -1.22,-6.3208 -2.5,-9.4146 -2.04,0.7618 -4.41,1.4258 -7.09,2.0313 -2.68,0.6055 -5.73,0.918 -9.13,0.918 -4.75,0 -8.43,-0.9649 -11,-2.9024 -2.57,-1.9219 -3.87,-4.8125 -3.87,-8.6601 0,-1.6016 0.34,-3.0196 0.99,-4.2774 0.63,-1.2305 1.49,-2.3437 2.54,-3.2734 1.07,-0.9453 2.32,-1.8047 3.74,-2.5469 1.44,-0.7617 2.94,-1.4453 4.54,-2.0508 l 6.36,-2.4922 c 3.02,-1.2187 5.71,-2.4687 8.03,-3.8047 2.35,-1.3203 4.37,-2.8632 6.02,-4.6523 1.67,-1.7656 2.94,-3.875 3.81,-6.2969 0.86,-2.4023 1.29,-5.2539 1.29,-8.4961 0,-7.7929 -2.67,-13.9257 -8.04,-18.4375 -5.36,-4.4922 -12.89,-6.7382 -22.57,-6.7382 -2.35,0 -4.46,0.0585 -6.35,0.2148 -1.9,0.1562 -3.65,0.3906 -5.28,0.6836 -1.62,0.3125 -3.21,0.6836 -4.7,1.1328 -1.5,0.4688 -3.07,0.9453 -4.66,1.4844 0.16,1.6601 0.5,3.3594 1.03,5.0976 0.52,1.7383 1.09,3.4453 1.69,5.1055" fill="currentColor" fill-opacity="1" fill-rule="nonzero" stroke="none" id="path152" /></g></g></svg>

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
        .pane-title { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.7; }
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
            display: flex; align-items: center; gap: 10px; padding: 8px 10px;
            background: var(--vscode-editorGroupHeader-tabsBackground);
            border: 1px solid var(--vscode-editorGroup-border);
            border-radius: 6px; text-decoration: none;
            color: var(--vscode-foreground); font-size: 12px; cursor: pointer;
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
            font-size: 11px;
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
