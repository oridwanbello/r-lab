import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

interface VariableInfo {
    name: string;
    type: string;
    size: string;
    preview: string;
    isDataFrame: boolean;
}

export class WorkspacePanel {
    public static currentPanel: WorkspacePanel | undefined;
    public static readonly viewType = 'r-layout.workspacePanel';

    private readonly _panel: vscode.WebviewPanel;
    private _variables: VariableInfo[] = [];
    private _loadedNamespaces: string[] = [];
    private _attachedNamespaces: string[] = [];
    private _isLoading = false;
    private _errorMessage = '';
    private _autoRefreshInterval?: ReturnType<typeof setInterval>;
    private _disposables: vscode.Disposable[] = [];
    private _onRequestDataView?: (varName: string) => void;
    private _htmlSet = false;

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Three
    ): WorkspacePanel {
        if (WorkspacePanel.currentPanel) {
            WorkspacePanel.currentPanel._panel.reveal(column, true);
            return WorkspacePanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            WorkspacePanel.viewType,
            'Workspace',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        WorkspacePanel.currentPanel = new WorkspacePanel(panel);
        return WorkspacePanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;

        // Register ALL handlers BEFORE setting HTML
        // If _render() runs first, the webview JS executes and sends 'ready'
        // before onDidReceiveMessage is registered, and the message is dropped.
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            (e) => { if (e.webviewPanel.visible) { this._refreshWorkspace(); } },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; varName?: string }) => {
                switch (msg.type) {
                    case 'ready':
                        // Webview JS loaded - safe to postMessage now.
                        await this._refreshWorkspace();
                        break;
                    case 'refresh':
                        await this._refreshWorkspace();
                        break;
                    case 'viewData':
                        if (msg.varName && this._onRequestDataView) {
                            this._onRequestDataView(msg.varName);
                        }
                        break;
                    case 'toggleAutoRefresh':
                        this._toggleAutoRefresh();
                        break;
                }
            },
            null,
            this._disposables
        );

        // Auto-refresh every 3 s
        this._autoRefreshInterval = setInterval(() => {
            this._refreshWorkspace();
        }, 3000);

        // Set HTML last - this starts the webview JS which will send 'ready'.
        this._render();
    }


    public onRequestDataView(callback: (varName: string) => void): void {
        this._onRequestDataView = callback;
    }

    public reveal(): void {
        this._panel.reveal(undefined, true);
    }

    /** Hide or show all webview content (toolbar, tabs, data).
     *  Used when the top-right pane is maximized so only the
     *  VS Code tab bar remains visible for the bottom-right group.
     */
    public setMinimized(minimized: boolean): void {
        this._panel.webview.postMessage({ command: 'setMinimized', minimized });
    }

    /** Force an immediate workspace refresh - called on layout re-activation. */
    public forceRefresh(): void {
        this._refreshWorkspace();
    }

    private _toggleAutoRefresh(): void {
        if (this._autoRefreshInterval) {
            clearInterval(this._autoRefreshInterval);
            this._autoRefreshInterval = undefined;
        } else {
            this._autoRefreshInterval = setInterval(() => {
                this._refreshWorkspace();
            }, 3000);
        }
        this._render();
    }

    private async _refreshWorkspace(): Promise<void> {
        if (this._variables.length === 0 && this._loadedNamespaces.length === 0) {
            this._isLoading = true;
            this._render();
        }

        this._errorMessage = '';

        // Priority 1: Try the vscode-R session watcher
        const vscodeRData = this._pollVscodeR();

        if (vscodeRData && vscodeRData.variables.length > 0) {
            this._variables = vscodeRData.variables;
            this._loadedNamespaces = vscodeRData.loadedNamespaces;
            this._attachedNamespaces = vscodeRData.attachedNamespaces;
            this._isLoading = false;
            this._render();
            return;
        }

        // Priority 2: Read the auto-updated watcher file
        // The R task callback (injected at activation) writes
        // .r_layout/.workspace_data.json after every R command.
        // Read directly from disk - no terminal interaction needed.
        const watcherResult = this._readWatcherFile();
        if (watcherResult) {
            this._variables = watcherResult.variables || [];
            this._loadedNamespaces = watcherResult.loadedNamespaces || [];
            this._attachedNamespaces = watcherResult.attachedNamespaces || [];
            this._isLoading = false;
            this._render();
            return;
        }

        // Priority 3: Fall back to Rscript (only sees .RData)
        const rScript = `
tryCatch({
    if (file.exists(".RData")) load(".RData", envir = .GlobalEnv)
    vars <- ls(envir = .GlobalEnv)
    info <- if (length(vars) == 0) list() else lapply(vars, function(nm) {
        obj <- get(nm, envir = .GlobalEnv)
        cls <- paste(class(obj), collapse = ", ")
        dims <- if (!is.null(dim(obj))) paste(dim(obj), collapse = " x ") else as.character(length(obj))
        preview <- tryCatch({
            if (is.data.frame(obj) || is.matrix(obj)) paste0(nrow(obj), " obs. of ", ncol(obj), " variables")
            else if (is.list(obj)) paste0("List of ", length(obj))
            else if (is.function(obj)) "function"
            else if (is.character(obj) && length(obj) == 1) paste0('"', substr(obj, 1, 60), '"')
            else if (is.numeric(obj) && length(obj) <= 6) paste(head(obj, 6), collapse = " ")
            else paste(head(obj, 3), collapse = " ")
        }, error = function(e) "?")
        list(name = nm, type = cls, size = dims, preview = preview, isDataFrame = is.data.frame(obj))
    })
    cat(jsonlite::toJSON(list(variables = info, loadedNamespaces = loadedNamespaces(), attachedNamespaces = search()), auto_unbox = TRUE))
}, error = function(e) {
    cat(paste0('{"error":"', gsub('"', '\\\\\\\\\\\\\\\\"', conditionMessage(e)), '"}'))
})`;

        const rscriptPath = await this._findRscript();

        try {
            const raw = await this._runRscript(rscriptPath, rScript);
            const parsed = JSON.parse(raw);

            if (parsed.error) {
                this._errorMessage = parsed.error;
            } else {
                this._variables = parsed.variables || [];
                this._loadedNamespaces = parsed.loadedNamespaces || [];
                this._attachedNamespaces = parsed.attachedNamespaces || [];
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('jsonlite')) {
                this._errorMessage = 'R package "jsonlite" is required.\nRun: install.packages("jsonlite")';
            } else if (msg.includes('ENOENT') || msg.includes('not found')) {
                this._errorMessage =
                    'Could not find Rscript on PATH.\n' +
                    'Enable the vscode-R session watcher for live environment data,\n' +
                    'or ensure Rscript is available on your system PATH.';
            } else {
                this._errorMessage = msg;
            }
        }

        this._isLoading = false;
        this._render();
    }

    /**
     * Read the workspace data file written by the R task callback.
     * This is a pure file read - no terminal interaction.
     */
    private _readWatcherFile(): {
        variables: VariableInfo[];
        loadedNamespaces: string[];
        attachedNamespaces: string[];
    } | null {
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

        const outDir = path.join(wf, '.r_layout');
        const varsFile = path.join(outDir, '.workspace_vars.tsv');
        const loadedFile = path.join(outDir, '.workspace_loaded.tsv');
        const attachedFile = path.join(outDir, '.workspace_attached.tsv');

        // Need at least one of these to exist to consider it a successful read
        if (!fs.existsSync(varsFile) && !fs.existsSync(loadedFile) && !fs.existsSync(attachedFile)) {
            return null;
        }

        try {
            const variables: VariableInfo[] = [];
            if (fs.existsSync(varsFile)) {
                const varsRaw = fs.readFileSync(varsFile, 'utf8').trim();
                if (varsRaw) {
                    const lines = varsRaw.split('\n');
                    for (const line of lines) {
                        const parts = line.split('\t');
                        if (parts.length >= 5) {
                            variables.push({
                                name: parts[0],
                                type: parts[1],
                                size: parts[2],
                                preview: parts[3],
                                isDataFrame: parts[4] === 'true'
                            });
                        }
                    }
                }
            }

            const loadedNamespaces: string[] = [];
            if (fs.existsSync(loadedFile)) {
                const loadedRaw = fs.readFileSync(loadedFile, 'utf8').trim();
                if (loadedRaw) {
                    loadedNamespaces.push(...loadedRaw.split('\n'));
                }
            }

            const attachedNamespaces: string[] = [];
            if (fs.existsSync(attachedFile)) {
                const attachedRaw = fs.readFileSync(attachedFile, 'utf8').trim();
                if (attachedRaw) {
                    attachedNamespaces.push(...attachedRaw.split('\n'));
                }
            }

            return { variables, loadedNamespaces, attachedNamespaces };
        } catch {
            return null;
        }
    }

    private _pollVscodeR(): {
        variables: VariableInfo[];
        loadedNamespaces: string[];
        attachedNamespaces: string[];
    } | null {
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wf) return null;

        const vsRDir = path.join(wf, '.vscode', 'vscode-R');
        if (!fs.existsSync(vsRDir)) return null;

        try {
            const activeJsonPath = path.join(vsRDir, 'active.json');
            let sessionDir = '';

            if (fs.existsSync(activeJsonPath)) {
                const activeData = JSON.parse(fs.readFileSync(activeJsonPath, 'utf8'));
                if (activeData.pid) {
                    sessionDir = path.join(vsRDir, activeData.pid.toString());
                }
            } else {
                // No active.json - find the most recently modified session directory
                const dirs = fs.readdirSync(vsRDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .map(d => ({
                        name: d.name,
                        time: fs.statSync(path.join(vsRDir, d.name)).mtimeMs
                    }))
                    .sort((a, b) => b.time - a.time);

                if (dirs.length > 0) {
                    sessionDir = path.join(vsRDir, dirs[0].name);
                }
            }

            if (!sessionDir || !fs.existsSync(sessionDir)) return null;

            // Read global environment
            const variables: VariableInfo[] = [];
            const globalEnvPath = path.join(sessionDir, 'globalenv.json');
            if (fs.existsSync(globalEnvPath)) {
                const rawEnv = fs.readFileSync(globalEnvPath, 'utf8');
                const env = JSON.parse(rawEnv);

                for (const key of Object.keys(env)) {
                    const item = env[key];
                    variables.push({
                        name: key,
                        type: item.class ? (Array.isArray(item.class) ? item.class.join(', ') : item.class) : 'unknown',
                        size: item.dim ? item.dim.join(' x ') : (item.length ? String(item.length) : '1'),
                        preview: item.str || '',
                        isDataFrame: item.class && item.class.includes('data.frame')
                    });
                }
            }

            // Read loaded namespaces
            let loadedNamespaces: string[] = [];
            const loadedPath = path.join(sessionDir, 'loaded_namespaces.json');
            if (fs.existsSync(loadedPath)) {
                try {
                    const raw = fs.readFileSync(loadedPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        loadedNamespaces = parsed;
                    }
                } catch {}
            }

            // Read attached namespaces (search path)
            let attachedNamespaces: string[] = [];
            const searchPath = path.join(sessionDir, 'search.json');
            if (fs.existsSync(searchPath)) {
                try {
                    const raw = fs.readFileSync(searchPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        attachedNamespaces = parsed;
                    }
                } catch {}
            }

            // Only return data if we actually found something
            if (variables.length > 0 || loadedNamespaces.length > 0 || attachedNamespaces.length > 0) {
                return { variables, loadedNamespaces, attachedNamespaces };
            }
        } catch {
            // Ignore parse errors
        }
        return null;
    }

    private _runRscript(rscriptPath: string, script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(
                rscriptPath,
                ['-e', script],
                {
                    timeout: 10000,
                    maxBuffer: 1024 * 1024,
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
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

    /**
     * Find the Rscript binary path.
     *
     * Rscript is a standalone binary that ships with R, independent of
     * whether the user's console is standard R, radian, or ark.
     * Attempts "Rscript" on PATH first, then checks common R installation paths.
     */
    private async _findRscript(): Promise<string> {
        // First, try the R console path setting - if it's plain "R", derive "Rscript"
        const config = vscode.workspace.getConfiguration('r-layout');
        const rPath = config.get<string>('rConsolePath', 'R');

        // Only derive from setting if it looks like it ends with /R or is just "R"
        if (rPath === 'R' || rPath.endsWith('/R')) {
            return rPath.replace(/R$/, 'Rscript');
        }

        // For radian/ark/other wrappers, try to find Rscript independently
        const { execFile: execFileCb } = require('child_process');

        return new Promise<string>((resolve) => {
            // Try "which Rscript" to find it on PATH
            execFileCb('which', ['Rscript'], { timeout: 3000 },
                (error: Error | null, stdout: string) => {
                    if (!error && stdout && stdout.trim()) {
                        resolve(stdout.trim());
                    } else {
                        // Fallback: try common paths
                        const commonPaths = [
                            '/usr/local/bin/Rscript',
                            '/usr/bin/Rscript',
                            '/opt/homebrew/bin/Rscript',
                            '/opt/R/arm64/bin/Rscript',
                            '/Library/Frameworks/R.framework/Resources/bin/Rscript',
                        ];
                        for (const p of commonPaths) {
                            if (fs.existsSync(p)) {
                                resolve(p);
                                return;
                            }
                        }
                        // Last resort - just try "Rscript" and let it fail with a clear error
                        resolve('Rscript');
                    }
                }
            );
        });
    }

    private _lastRenderHash?: string;

    private _render(): void {
        if (!this._htmlSet) {
            this._panel.webview.html = this._getHtml();
            this._htmlSet = true;
        }

        const stateToHash = JSON.stringify({
            variables: this._variables,
            loadedNamespaces: this._loadedNamespaces,
            attachedNamespaces: this._attachedNamespaces,
            isLoading: this._isLoading,
            errorMessage: this._errorMessage,
            autoOn: !!this._autoRefreshInterval
        });

        if (this._lastRenderHash === stateToHash) {
            return; // No changes, do not rebuild DOM (preserves text selection)
        }
        this._lastRenderHash = stateToHash;

        this._panel.webview.postMessage({
            command: 'update',
            variables: this._variables,
            loadedNamespaces: this._loadedNamespaces,
            attachedNamespaces: this._attachedNamespaces,
            isLoading: this._isLoading,
            errorMessage: this._errorMessage,
            autoOn: !!this._autoRefreshInterval
        });
    }

    private _getHtml(): string {
        const nonce = getNonce();

        return `<!DOCTYPE html>
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
            font-weight: 400; font-size: var(--vscode-font-size, 13px); letter-spacing: 0.3px; color: var(--vscode-editor-foreground); opacity: 1;           background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        body.minimized > * { display: none !important; }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding: 0 12px;
            height: 32px;
            background: var(--vscode-editor-background); /* Matches active tab */
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            flex-shrink: 0;
        }
        .pane-title {
            font-weight: 600;
            letter-spacing: 0.5px; opacity: 0.7;
        }
        .toolbar-actions { display: flex; align-items: center; gap: 6px; }
        .toolbar button {
            background: none;
            color: var(--vscode-foreground);
            border: none;
            padding: 3px 6px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
            opacity: 0.7;
        }
        .toolbar button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
        .toolbar button.active { opacity: 1; color: var(--vscode-textLink-foreground); }
        .toolbar button svg { width: 14px; height: 14px; display: block; }
        .toolbar button[disabled] {
            opacity: 0.3;
            cursor: default;
            pointer-events: auto; /* Allow hover for tooltips */
        }
        .toolbar button[disabled]:hover {
            background: none;
        }

        .tabs { display: flex; border-bottom: 1px solid var(--vscode-editorGroup-border); background: var(--vscode-editor-background); }
        .tab { padding: 8px 12px; cursor: pointer; opacity: 0.6; font-weight: 600; letter-spacing: 0.5px; border-bottom: 2px solid transparent; }
        .tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        .tab.active { opacity: 1; border-bottom: 2px solid var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); }

        .content { flex: 1; overflow: auto; display: none; }
        .content.active { display: block; }

        table { width: 100%; border-collapse: collapse; }
        thead th {
            position: sticky; top: 0; z-index: 1;
            padding: 6px 8px;
            text-align: left;
            font-weight: 600;
            font-style: italic;
            text-transform: none;
            letter-spacing: 0.3px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            vertical-align: middle;
        }
        .var-row td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            vertical-align: middle;
        }
        .var-row:hover td { background: var(--vscode-list-hoverBackground); }
        .name-col { width: 1%; white-space: nowrap; padding-right: 16px !important; }
        .var-name {
            font-family: var(--vscode-editor-font-family, monospace);
            font-weight: 600;
        }
        .type-col {
            width: 1%;
            white-space: nowrap;
            padding-right: 16px !important;
            font-family: var(--vscode-editor-font-family, monospace);
            opacity: 0.7;
        }
        .size-col { width: 1%; white-space: nowrap; padding-right: 16px !important; opacity: 0.6; }
        .preview-col {
            width: auto;
            font-family: var(--vscode-editor-font-family, monospace);
            opacity: 0.8;
            vertical-align: middle;
        }
        .simple-list { list-style: none; padding: 0; margin: 0; }
        .simple-list li {
            padding: 4px 12px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            font-family: var(--vscode-editor-font-family, monospace);
            display: flex;
            align-items: center;
            min-height: 25px; /* Ensures height parity with table rows */
        }
        .view-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: none;
            cursor: pointer;
            padding: 0;
            margin-left: 6px;
            color: var(--vscode-textLink-foreground);
            opacity: 1;
            vertical-align: middle;
            flex-shrink: 0;
        }
        .view-btn:hover { opacity: 1; }
        .view-btn svg { display: block; }
        .status-msg { padding: 20px; text-align: center; opacity: 0.6; }
        .status-msg.error { color: var(--vscode-errorForeground); opacity: 0.9; white-space: pre-wrap; }

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

        .empty-state {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; height: 100%; text-align: center; opacity: 0.5;
            padding: 20px;
        }
        .empty-state .icon { font-size: 40px; margin-bottom: 12px; }
        .empty-state p { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="toolbar-actions">
            <button id="btn-auto" data-tooltip="Auto-Refresh Off">
                <svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.7 8.5L4.5 13.5V3.5l8.2 5z"/></svg>
            </button>
        </div>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="tabs">
        <div class="tab active" data-target="tab-global">Global Environment <span id="count-global"></span></div>
        <div class="tab" data-target="tab-loaded">Loaded Namespaces <span id="count-loaded"></span></div>
        <div class="tab" data-target="tab-attached">Attached Namespaces <span id="count-attached"></span></div>
    </div>

    <div id="tab-global" class="content active"></div>
    <div id="tab-loaded" class="content"></div>
    <div id="tab-attached" class="content"></div>

    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();

            document.querySelectorAll('.tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
                    tab.classList.add('active');
                    document.getElementById(tab.getAttribute('data-target')).classList.add('active');
                });
            });

            function escapeHtml(text) {
                if (!text) return '';
                return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }

            function attachViewListeners() {
                document.querySelectorAll('.view-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const varName = btn.getAttribute('data-var');
                        if (varName) vscode.postMessage({ type: 'viewData', varName });
                    });
                });
            }

            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.command === 'update') {
                    const autoBtn = document.getElementById('btn-auto');
                    if (msg.autoOn) {
                        autoBtn.classList.add('active');
                        autoBtn.innerHTML = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3 3h4v10H3V3zm6 0h4v10H9V3z"/></svg>';
                        autoBtn.setAttribute('data-tooltip', 'Auto-Refresh On (3s)');
                        autoBtn.title = '';
                    } else {
                        autoBtn.classList.remove('active');
                        autoBtn.innerHTML = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.7 8.5L4.5 13.5V3.5l8.2 5z"/></svg>';
                        autoBtn.setAttribute('data-tooltip', 'Auto-Refresh Off');
                        autoBtn.title = '';
                    }

                    if (msg.isLoading && !msg.errorMessage && msg.variables.length === 0) {
                        document.getElementById('tab-global').innerHTML = '<div class="status-msg">⏳ Refreshing…</div>';
                        return;
                    }

                    if (msg.errorMessage) {
                        document.getElementById('tab-global').innerHTML = '<div class="status-msg error">⚠ ' + escapeHtml(msg.errorMessage) + '</div>';
                        return;
                    }

                    const globalEl = document.getElementById('tab-global');
                    const cGlobal = document.getElementById('count-global');
                    cGlobal.textContent = msg.variables && msg.variables.length > 0 ? '(' + msg.variables.length + ')' : '';

                    if (!msg.variables || msg.variables.length === 0) {
                        globalEl.innerHTML = '<div class="empty-state"><div class="icon">📦</div><p>No variables in the global environment.<br/>Run R code to populate variables, then click <strong>Refresh</strong>.</p></div>';
                    } else {
                        const EYE = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>';
                        let rows = msg.variables.map(v => {
                            const btn = v.isDataFrame
                                ? '<button class="view-btn" data-var="' + escapeHtml(v.name) + '" data-tooltip="View in Data Viewer">' + EYE + '</button>'
                                : '';
                            return '<tr class="var-row">'
                                + '<td class="name-col"><span class="var-name">' + escapeHtml(v.name) + '</span>' + btn + '</td>'
                                + '<td class="type-col">' + escapeHtml(v.type) + '</td>'
                                + '<td class="size-col">' + escapeHtml(v.size) + '</td>'
                                + '<td class="preview-col">' + escapeHtml(v.preview) + '</td>'
                                + '</tr>';
                        }).join('');
                        globalEl.innerHTML = \`<table><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Value</th></tr></thead><tbody>\${rows}</tbody></table>\`;
                    }

                    const cLoaded = document.getElementById('count-loaded');
                    cLoaded.textContent = msg.loadedNamespaces && msg.loadedNamespaces.length > 0 ? '(' + msg.loadedNamespaces.length + ')' : '';
                    if (msg.loadedNamespaces) {
                        document.getElementById('tab-loaded').innerHTML = \`<ul class="simple-list">\${msg.loadedNamespaces.map(n => \`<li>\${escapeHtml(n)}</li>\`).join('')}</ul>\`;
                    }

                    const cAttached = document.getElementById('count-attached');
                    cAttached.textContent = msg.attachedNamespaces && msg.attachedNamespaces.length > 0 ? '(' + msg.attachedNamespaces.length + ')' : '';
                    if (msg.attachedNamespaces) {
                        document.getElementById('tab-attached').innerHTML = \`<ul class="simple-list">\${msg.attachedNamespaces.map(n => \`<li>\${escapeHtml(n)}</li>\`).join('')}</ul>\`;
                    }

                    attachViewListeners();
                }
            });

            document.getElementById('btn-refresh')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'refresh' });
            });
            document.getElementById('btn-auto')?.addEventListener('click', () => {
                const btn = document.getElementById('btn-auto');
                const isOff = btn.getAttribute('data-tooltip') === 'Auto-Refresh Off';
                btn.setAttribute('data-tooltip', isOff ? 'Auto-Refresh On' : 'Auto-Refresh Off');
                vscode.postMessage({ type: 'toggleAutoRefresh' });
            });

            // Instant Tooltip Controller
            const tooltip = document.getElementById('tooltip');
            function setupTooltips() {
                document.querySelectorAll('[data-tooltip]').forEach(el => {
                    if (el._hasTooltip) return;
                    el._hasTooltip = true;
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
            }
            setupTooltips();
            const observer = new MutationObserver(() => setupTooltips());
            observer.observe(document.body, { childList: true, subtree: true });

            vscode.postMessage({ type: 'ready' });

            // Minimize/restore handler for top-pane maximize
            window.addEventListener('message', function _minHandler(event) {
                const msg = event.data;
                if (msg.command === 'setMinimized') {
                    document.body.classList.toggle('minimized', msg.minimized);
                }
            });
        })();
    </script>
</body>
</html>`;
    }

    public dispose(): void {
        WorkspacePanel.currentPanel = undefined;
        if (this._autoRefreshInterval) {
            clearInterval(this._autoRefreshInterval);
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
