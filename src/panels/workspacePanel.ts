import * as vscode from 'vscode';
import { getNonce } from '../utils/webviewUtils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { getRscriptPath } from '../utils/rPathResolver';

interface VariableInfo {
    name: string;
    type: string;
    size: string;
    preview: string;
    isDataFrame: boolean;
}

interface PackageInfo {
    name: string;
    title: string;
    version: string;
    status: 'attached' | 'loaded' | 'none';
}

export class WorkspacePanel {
    public static currentPanel: WorkspacePanel | undefined;
    public static readonly viewType = 'r-layout.workspacePanel';

    private readonly _panel: vscode.WebviewPanel;
    private _variables: VariableInfo[] = [];
    private _loadedNamespaces: string[] = [];
    private _attachedNamespaces: string[] = [];
    private _packages: PackageInfo[] = [];
    private _isLoading = false;
    private _errorMessage = '';
    private _autoRefreshInterval?: ReturnType<typeof setInterval>;
    private _disposables: vscode.Disposable[] = [];
    private _onRequestDataView?: (varName: string) => void;
    private _htmlSet = false;

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Three,
        forceReveal: boolean = true
    ): WorkspacePanel {
        if (WorkspacePanel.currentPanel) {
            if (forceReveal) {
                WorkspacePanel.currentPanel._panel.reveal(column, true);
            }
            return WorkspacePanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            WorkspacePanel.viewType,
            'Workspace',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                enableFindWidget: true,
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
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            (e) => {
                this._updateMinimizedState();
                if (e.webviewPanel.visible) { this._refreshWorkspace(); }
            },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            async (msg: { type: string; varName?: string; pkgName?: string }) => {
                switch (msg.type) {
                    case 'ready':
                        this._updateMinimizedState();
                        await this._refreshWorkspace();
                        if (this._packages.length === 0) {
                            this._fetchInstalledPackages();
                        }
                        break;
                    case 'refresh':
                        await this._refreshWorkspace();
                        break;
                    case 'viewData':
                        if (msg.varName && this._onRequestDataView) {
                            this._onRequestDataView(msg.varName);
                        }
                        break;
                    case 'attachPackage':
                        if (msg.pkgName) { this._sendToRConsole(`library(${msg.pkgName})`); }
                        break;
                    case 'detachPackage':
                        if (msg.pkgName) {
                            if (msg.pkgName === 'later') {
                                this._sendToRConsole(`detach("package:${msg.pkgName}")`);
                            } else {
                                this._sendToRConsole(`detach("package:${msg.pkgName}", unload = TRUE)`);
                            }
                        }
                        break;
                    case 'removeVariable':
                        if (msg.varName) {
                            this._sendToRConsole(`rm(${msg.varName}, envir = .GlobalEnv)`);
                            await this._refreshWorkspace();
                        }
                        break;
                    case 'clearWorkspace':
                        this._sendToRConsole("rm(list = ls(all.names = TRUE), envir = .GlobalEnv)");
                        await this._refreshWorkspace();
                        break;
                    case 'refreshPackages':
                        await this._fetchInstalledPackages();
                        break;
                }
            },
            null,
            this._disposables
        );

        // Auto-refresh every 3 s (always on, no toggle)
        this._autoRefreshInterval = setInterval(() => {
            this._refreshWorkspace();
        }, 3000);

        // Set HTML last
        this._render();

        // Start background fetch of packages immediately (non-blocking)
        this._fetchInstalledPackages();
    }

    public onRequestDataView(callback: (varName: string) => void): void {
        this._onRequestDataView = callback;
    }

    public reveal(): void {
        this._panel.reveal(undefined, true);
    }

    private _isMinimized = false;

    public setMinimized(minimized: boolean): void {
        this._isMinimized = minimized;
        this._updateMinimizedState();
    }

    private _updateMinimizedState(): void {
        const isPoppedOut = this._panel.viewColumn !== vscode.ViewColumn.Three && this._panel.viewColumn !== undefined;
        const actualMinimized = isPoppedOut ? false : this._isMinimized;
        this._panel.webview.postMessage({ command: 'setMinimized', minimized: actualMinimized });
    }

    public forceRefresh(): void {
        this._refreshWorkspace();
    }

    /** Send a command to the R Console terminal */
    private _sendToRConsole(command: string): void {
        try {
            const { getRConsoleTerminal } = require('../layout/layoutManager');
            const terminal = getRConsoleTerminal();
            if (terminal) {
                terminal.sendText(command, true);
            }
        } catch {}
    }

    // ----- Internal R variable filter -----
    private static readonly INTERNAL_VAR_PATTERN = /^\.rlayout_|^\.r_layout|^null_dev$|^\.First$|^\.Last$|^View$/;

    /** Filter out internal R Layout variables so they never appear in the Environment tab */
    private _filterInternalVars(variables: VariableInfo[]): VariableInfo[] {
        return variables.filter(v => !WorkspacePanel.INTERNAL_VAR_PATTERN.test(v.name));
    }

    // ----- Refresh logic (3-tier priority) -----

    private async _refreshWorkspace(): Promise<void> {
        if (this._variables.length === 0 && this._loadedNamespaces.length === 0) {
            this._isLoading = true;
            this._render();
        }

        this._errorMessage = '';

        // Priority 1: Try the vscode-R session watcher
        const vscodeRData = this._pollVscodeR();

        if (vscodeRData && vscodeRData.variables.length > 0) {
            this._variables = this._filterInternalVars(vscodeRData.variables);
            this._loadedNamespaces = vscodeRData.loadedNamespaces;
            this._attachedNamespaces = vscodeRData.attachedNamespaces;
            this._updatePackageStatuses();
            this._isLoading = false;
            this._render();
            return;
        }

        // Priority 2: Read the auto-updated watcher file
        const watcherResult = this._readWatcherFile();
        if (watcherResult) {
            this._variables = this._filterInternalVars(watcherResult.variables || []);
            this._loadedNamespaces = watcherResult.loadedNamespaces || [];
            this._attachedNamespaces = watcherResult.attachedNamespaces || [];
            this._updatePackageStatuses();
            this._isLoading = false;
            this._render();
            return;
        }

        // Priority 3: Fall back to Rscript (only sees .RData)
        const rScript = `
tryCatch({
    if (!requireNamespace("jsonlite", quietly = TRUE)) stop("waiting_for_live_session")
    if (file.exists(".RData")) load(".RData", envir = .GlobalEnv)
    vars <- ls(envir = .GlobalEnv)
    info <- if (length(vars) == 0) list() else lapply(vars, function(nm) {
        obj <- get(nm, envir = .GlobalEnv)
        cls <- paste(class(obj), collapse = ", ")
        dims <- if (!is.null(dim(obj))) paste(dim(obj), collapse = " x ") else as.character(length(obj))
        sz <- format(object.size(obj), units = "auto")
        sz <- sub(" bytes|Bytes", " B", sz)
        sz <- sub("Kb|KB", "kB", sz)
        sz <- sub("Mb|MB", "MB", sz)
        sz <- sub("Gb|GB", "GB", sz)
        preview <- tryCatch({
            get_type <- function(x) {
                if (is.data.frame(x)) "df" else if (is.list(x)) "list" else {
                    t <- typeof(x)
                    if (t == "double") "num" else if (t == "integer") "int" else if (t == "character") "chr" else if (t == "logical") "logi" else t
                }
            }
            if (is.data.frame(obj)) {
                base_str <- paste0(nrow(obj), " obs. of ", ncol(obj), " variables")
                if (length(obj) == 0) base_str else {
                    nm_names <- names(obj)
                    if (!is.null(nm_names) && length(nm_names) > 0 && any(nm_names != "")) {
                        nm_valid <- nm_names[nm_names != ""]
                        n_show <- if (length(nm_valid) > 3) 3 else length(nm_valid)
                        types <- vapply(obj[1:n_show], get_type, character(1))
                        paste0(base_str, " {", paste0("$", head(nm_valid, n_show), ": ", types, collapse=", "), if(length(nm_valid)>3) ", ...}" else "}")
                    } else {
                        n_show <- if (length(obj) > 3) 3 else length(obj)
                        types <- vapply(obj[1:n_show], get_type, character(1))
                        paste0(base_str, " {", paste(paste0(": ", types), collapse=", "), if(length(obj)>3) ", ...}" else "}")
                    }
                }
            } else if (is.array(obj)) {
                type_lbl <- typeof(obj)
                if (type_lbl == "double") type_lbl <- "num" else if (type_lbl == "integer") type_lbl <- "int" else if (type_lbl == "character") type_lbl <- "chr" else if (type_lbl == "logical") type_lbl <- "logi"
                dim_ranges <- paste0("1:", dim(obj), collapse = ", ")
                n_show <- if (length(obj) > 3) 3 else length(obj)
                flat_vals <- as.vector(head(as.vector(obj), n_show))
                if (typeof(obj) == "character") flat_vals <- paste0('"', flat_vals, '"')
                vals_str <- paste(flat_vals, collapse = " ")
                if (length(obj) > 3) vals_str <- paste0(vals_str, " ...")
                paste0(type_lbl, " [", dim_ranges, "] ", vals_str)
            } else if (is.list(obj)) {
                if (length(obj) == 0) "List of 0" else {
                    nm_names <- names(obj)
                    if (!is.null(nm_names) && length(nm_names) > 0 && any(nm_names != "")) {
                        nm_valid <- nm_names[nm_names != ""]
                        n_show <- if (length(nm_valid) > 3) 3 else length(nm_valid)
                        types <- vapply(obj[1:n_show], get_type, character(1))
                        paste0("List of ", length(obj), " {", paste0("$", head(nm_valid, n_show), ": ", types, collapse=", "), if(length(nm_valid)>3) ", ...}" else "}")
                    } else {
                        n_show <- if (length(obj) > 3) 3 else length(obj)
                        types <- vapply(obj[1:n_show], get_type, character(1))
                        paste0("List of ", length(obj), " {", paste(paste0(": ", types), collapse=", "), if(length(obj)>3) ", ...}" else "}")
                    }
                }
            } else if (is.function(obj)) {
                "function"
            } else if (is.vector(obj)) {
                if (length(obj) == 1) {
                    if (is.character(obj)) paste0('"', obj, '"') else as.character(obj)
                } else {
                    type_lbl <- typeof(obj)
                    if (type_lbl == "double") type_lbl <- "num" else if (type_lbl == "integer") type_lbl <- "int" else if (type_lbl == "character") type_lbl <- "chr" else if (type_lbl == "logical") type_lbl <- "logi"
                    dim_range <- paste0("1:", length(obj))
                    n_show <- if (length(obj) > 3) 3 else length(obj)
                    flat_vals <- as.vector(head(obj, n_show))
                    if (typeof(obj) == "character") flat_vals <- paste0('"', flat_vals, '"')
                    vals_str <- paste(flat_vals, collapse = " ")
                    if (length(obj) > 3) vals_str <- paste0(vals_str, " ...")
                    paste0(type_lbl, " [", dim_range, "] ", vals_str)
                }
            } else {
                substr(paste(as.character(obj), collapse = " "), 1, 60)
            }
        }, error = function(e) "?")
        list(name = nm, type = cls, size = paste0(dims, " (", sz, ")"), preview = preview, isDataFrame = is.data.frame(obj) || is.matrix(obj) || (is.array(obj) && length(dim(obj)) == 3))
    })
    cat(jsonlite::toJSON(list(variables = info, loadedNamespaces = loadedNamespaces(), attachedNamespaces = search()), auto_unbox = TRUE))
}, error = function(e) {
    cat(paste0('{"error":"', gsub('"', '\\\\\\\\\\\\\\\\"', conditionMessage(e)), '"}'))
})`;

        const rscriptPath = getRscriptPath();

        try {
            const raw = await this._runRscript(rscriptPath, rScript);
            // Extract JSON from potential R warnings
            const jsonStart = raw.indexOf('{');
            const jsonEnd = raw.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1) { throw new Error('Invalid JSON response'); }
            const cleanJson = raw.substring(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(cleanJson);

            if (parsed.error === 'waiting_for_live_session') {
                this._errorMessage = '';
            } else if (parsed.error) {
                this._errorMessage = parsed.error;
            } else {
                this._variables = this._filterInternalVars(parsed.variables || []);
                this._loadedNamespaces = parsed.loadedNamespaces || [];
                this._attachedNamespaces = parsed.attachedNamespaces || [];
                this._updatePackageStatuses();
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('waiting_for_live_session')) {
                // Ignore gracefully
            } else if (msg.includes('jsonlite')) {
                this._errorMessage = 'R package "jsonlite" is required for static loading.\nRun: install.packages("jsonlite")';
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

    /** Update package statuses from loaded/attached namespace lists */
    private _updatePackageStatuses(): void {
        if (this._packages.length === 0) { return; }

        const attachedSet = new Set<string>();
        for (const ns of this._attachedNamespaces) {
            const m = ns.match(/^package:(.+)$/);
            if (m) { attachedSet.add(m[1]); }
        }

        const loadedSet = new Set(this._loadedNamespaces);

        for (const pkg of this._packages) {
            if (attachedSet.has(pkg.name)) {
                pkg.status = 'attached';
            } else if (loadedSet.has(pkg.name)) {
                pkg.status = 'loaded';
            } else {
                pkg.status = 'none';
            }
        }
    }

    /** Fetch the full installed packages list via Rscript (heavy, manual only) */
    public async _fetchInstalledPackages(): Promise<void> {
        const rscriptPath = getRscriptPath();
        const script = `
tryCatch({
    pkgs <- installed.packages(fields = "Title")[, c("Package", "Version", "Title")]
    lines <- apply(pkgs, 1, function(r) paste(r["Package"], r["Version"], gsub("\\t|\\n|\\r", " ", ifelse(is.na(r["Title"]), "", r["Title"])), sep = "\\t"))
    cat(paste(lines, collapse = "\\n"))
}, error = function(e) cat(""))`;

        try {
            const raw = await this._runRscript(rscriptPath, script);
            const lines = raw.trim().split('\n').filter(l => l.trim());
            const pkgs: PackageInfo[] = [];
            for (const line of lines) {
                const parts = line.split('\t');
                if (parts.length >= 2) {
                    pkgs.push({
                        name: parts[0].trim(),
                        version: parts[1].trim(),
                        title: (parts[2] || '').trim(),
                        status: 'none'
                    });
                }
            }
            this._packages = pkgs;
            this._updatePackageStatuses();
            this._render();
        } catch {
            // Silently ignore - packages list stays empty until next manual refresh
        }
    }

    // ----- File readers -----

    private _readWatcherFile(): {
        variables: VariableInfo[];
        loadedNamespaces: string[];
        attachedNamespaces: string[];
    } | null {
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

        const outDir = path.join(wf, '.R-layout');
        const metaFile = path.join(outDir, '.workspace_meta.txt');
        const varsFile = path.join(outDir, '.workspace_vars.tsv');
        const loadedFile = path.join(outDir, '.workspace_loaded.tsv');
        const attachedFile = path.join(outDir, '.workspace_attached.tsv');

        // Check for the atomic signal file first. If it's missing, R is actively writing the TSVs.
        if (!fs.existsSync(metaFile)) {
            return null;
        }

        if (!fs.existsSync(varsFile) && !fs.existsSync(loadedFile) && !fs.existsSync(attachedFile)) {
            return null;
        }

        try {
            const variables: VariableInfo[] = [];
            if (fs.existsSync(varsFile)) {
                const varsRaw = fs.readFileSync(varsFile, 'utf8').trim();
                if (varsRaw) {
                    const lines = varsRaw.replace(/\r/g, '').split('\n');
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
                    loadedNamespaces.push(...loadedRaw.replace(/\r/g, '').split('\n'));
                }
            }

            const attachedNamespaces: string[] = [];
            if (fs.existsSync(attachedFile)) {
                const attachedRaw = fs.readFileSync(attachedFile, 'utf8').trim();
                if (attachedRaw) {
                    attachedNamespaces.push(...attachedRaw.replace(/\r/g, '').split('\n'));
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
        if (!wf) {return null;}

        const vsRDir = path.join(wf, '.vscode', 'vscode-R');
        if (!fs.existsSync(vsRDir)) {return null;}

        try {
            const activeJsonPath = path.join(vsRDir, 'active.json');
            let sessionDir = '';

            if (fs.existsSync(activeJsonPath)) {
                const activeData = JSON.parse(fs.readFileSync(activeJsonPath, 'utf8'));
                if (activeData.pid) {
                    sessionDir = path.join(vsRDir, activeData.pid.toString());
                }
            } else {
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

            if (!sessionDir || !fs.existsSync(sessionDir)) {return null;}

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
                        isDataFrame: item.class && (item.class.includes('data.frame') || item.class.includes('matrix') || (item.class.includes('array') && item.dim && item.dim.length === 3))
                    });
                }
            }

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
                    timeout: 30000,
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

    // ----- Rendering -----

    private _lastRenderHash?: string;

    private _render(): void {
        if (!this._htmlSet) {
            this._panel.webview.html = this._getHtml();
            this._htmlSet = true;
        }

        // Sort variables alphabetically to prevent jitter from R's random ordering
        const sortedVars = [...this._variables].sort((a, b) => a.name.localeCompare(b.name));

        // Filter attached objects: exclude internal R environments
        const attachedObjects = this._attachedNamespaces.filter(ns => {
            return !ns.match(/^\.GlobalEnv$/) &&
                   !ns.match(/^package:/) &&
                   !ns.match(/^Autoloads$/) &&
                   !ns.match(/^tools:/) &&
                   !ns.match(/^org:/) &&
                   !ns.match(/^CheckExEnv$/);
        });

        const stateToHash = JSON.stringify({
            variables: sortedVars,
            packages: this._packages,
            loadedNamespaces: this._loadedNamespaces,
            attachedNamespaces: this._attachedNamespaces,
            attachedObjects,
            isLoading: this._isLoading,
            errorMessage: this._errorMessage,
        });

        if (this._lastRenderHash === stateToHash) {
            return;
        }
        this._lastRenderHash = stateToHash;

        this._panel.webview.postMessage({
            command: 'update',
            variables: sortedVars,
            packages: this._packages,
            attachedObjects,
            isLoading: this._isLoading,
            errorMessage: this._errorMessage,
        });
    }

    private _getHtml(): string {
        const nonce = getNonce();

        // Checkbox SVGs as specified
        const ICON_UNCHECKED = '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
        const ICON_ATTACHED = '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor"/><path fill="none" stroke="var(--vscode-editor-background)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M5.5 8.5l2 2 3.5-4"/></svg>';
        const ICON_LOADED = '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="5" width="6" height="6" rx="1" fill="currentColor"/></svg>';

        // Refresh icon (same as Data Viewer)
        const REFRESH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13.29 8.69a5.33 5.33 0 1 1 -6.62 -5.86c2.6-.67 5.29.67 6.28 3.16" /><path d="M13.33 2.67v3.33h-3.33" /></svg>';

        // Eye icon (pristine Feather Icons)
        const EYE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

        const TRASH_ICON = '<svg viewBox="0 0 16 16"><path fill="none" d="M9.25,2H6.75a0.25,0.25,0,0,0-0.25,0.25V3h3V2.25A0.25,0.25,0,0,0,9.25,2Z"/><path fill="currentColor" d="M13.5,3H10.5V2.25A1.25,1.25,0,0,0,9.25,1H6.75A1.25,1.25,0,0,0,5.5,2.25V3H2.5a0.5,0.5,0,0,0,0,1H3L3.63,13.53C3.67,14.37,4.31,15,5.13,15h5.75c0.82,0,1.45-.62,1.5-1.47L13,4h0.5a0.5,0.5,0,0,0,0-1ZM6,13H6a0.5,0.5,0,0,1-.5-.48l-0.25-7a0.5,0.5,0,1,1,1-.04l0.25,7A0.5,0.5,0,0,1,6,13ZM8.5,12.5a0.5,0.5,0,0,1-1,0V5.5a0.5,0.5,0,0,1,1,0ZM9.5,3H6.5V2.25a0.25,0.25,0,0,1,.25-.25h2.5a0.25,0.25,0,0,1,.25.25Zm1,9.55a0.5,0.5,0,0,1-.5.45H10a0.5,0.5,0,0,1-.5-.52l0.25-7a0.5,0.5,0,1,1,1,.04Z"/></svg>';
        const BROOM_ICON = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.91,1.81L13.85,2.76L10.04,6.57C10.75,7.59 10.85,8.83 10.25,9.63L6.04,5.41C6.84,4.81 8.07,4.91 9.1,5.63L12.91,1.81M3.95,11.71C2.61,10.37 1.79,8.77 1.57,7.28L4.82,5.89L9.78,10.85L8.39,14.1C6.89,13.87 5.29,13.05 3.95,11.71Z"/></svg>';

        // Paperclip icon (pristine Feather Icons) for attached objects
        const PAPERCLIP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-paperclip"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

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
            font-weight: 400; font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }
        body.minimized > * { display: none !important; }

        /* ── Tab Bar ── */
        .tabs {
            display: flex; align-items: center; border-bottom: 1px solid var(--vscode-editorGroup-border);
            background: var(--vscode-editor-background); flex-shrink: 0;
            overflow-x: auto; overflow-y: hidden;
        }
        .tabs::-webkit-scrollbar {
            height: 2px;
        }
        .tabs::-webkit-scrollbar-track {
            background: transparent;
        }
        .tabs::-webkit-scrollbar-thumb {
            background-color: transparent;
            border-radius: 2px;
        }
        .tabs:hover::-webkit-scrollbar-thumb {
            background-color: var(--vscode-scrollbarSlider-background);
        }
        .tabs::-webkit-scrollbar-thumb:hover {
            background-color: var(--vscode-scrollbarSlider-hoverBackground);
        }
        .tabs::-webkit-scrollbar-thumb:active {
            background-color: var(--vscode-scrollbarSlider-activeBackground);
        }
        .tab { padding: 8px 16px; cursor: pointer; opacity: 0.6; font-weight: 600; white-space: nowrap; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .tab:not(:last-child) { border-right: 1px solid var(--vscode-editorGroup-border); }
        .tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        .tab.active { opacity: 1; color: var(--vscode-textLink-foreground); }

        /* ── Content Panels ── */
        .content { flex: 1; overflow: hidden; display: none; flex-direction: column; }
        .content.active { display: flex; }

        /* ── Table Scroll Wrapper ── */
        .table-scroll-wrapper {
            flex: 1;
            overflow: auto;
            position: relative;
        }

        /* ── Tables ── */
        table { width: 100%; border-collapse: collapse; }
        thead th {
            position: sticky; top: 0; z-index: 2;
            padding: 6px 8px;
            text-align: left;
            font-weight: 600;
            font-style: italic;
            letter-spacing: 0.5px;
            text-transform: none;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            vertical-align: middle;
        }
        .var-row td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            vertical-align: middle;
            background: var(--vscode-editor-background);
        }
        thead th:first-child, .var-row td:first-child {
            padding-left: 16px;
        }
        .var-row:hover td {
            background: color-mix(in srgb, var(--vscode-list-hoverBackground) 100%, var(--vscode-editor-background));
        }

        /* ── Frozen first column ── */
        thead th.frozen-col, .var-row td.frozen-col {
            position: sticky;
            left: 0;
            z-index: 1;
            background: var(--vscode-editor-background);
        }
        thead th.frozen-col { z-index: 3; }
        .var-row:hover td.frozen-col {
            background: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-editor-background);
        }

        /* ── Column styles ── */
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
        .size-col {
            width: 1%; white-space: nowrap; padding-right: 16px !important;
            font-family: var(--vscode-editor-font-family, monospace);
            opacity: 0.6;
        }
        .preview-col {
            width: auto;
            white-space: nowrap;
            font-family: var(--vscode-editor-font-family, monospace);
            opacity: 0.8;
            vertical-align: middle;
        }

        /* ── View Button (Eye) ── */
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

        /* ── Remove & Clear Buttons ── */
        .remove-btn, .clear-all-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: none;
            cursor: pointer;
            padding: 0;
            color: var(--vscode-foreground);
            opacity: 0.5;
            vertical-align: middle;
            flex-shrink: 0;
        }
        .remove-btn { margin-right: 6px; width: 14px; height: 14px; }
        .remove-btn svg { display: block; width: 14px; height: 14px; }
        .clear-all-btn { margin-right: 6px; width: 14px; height: 14px; }
        .clear-all-btn svg { display: block; width: 14px; height: 14px; }

        .remove-btn:hover, .clear-all-btn:hover {
            opacity: 1;
            color: var(--vscode-errorForeground);
        }

        .name-header-col { white-space: nowrap; }

        /* ── Status Messages ── */
        .status-msg { padding: 20px; text-align: center; opacity: 0.6; }
        .status-msg.error { color: var(--vscode-errorForeground); opacity: 0.9; white-space: pre-wrap; }

        /* ── Empty State ── */
        .empty-state {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; height: 100%; text-align: center; opacity: 0.3;
            padding: 20px;
        }
        .empty-state svg { width: 5em; height: 5em; margin-bottom: 16px; display: inline-block; }
        .empty-state p { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
        .empty-state code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 6px;
            font-size: 0.9em;
        }

        /* ── Custom Instant Tooltip ── */
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

        /* ══════════ PACKAGES TAB ══════════ */

        .pkg-toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            background: var(--vscode-editor-background);
            flex-shrink: 0;
            position: sticky;
            top: 0;
            z-index: 5;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap;
        }
        .pkg-toolbar::-webkit-scrollbar {
            height: 2px;
        }
        .pkg-toolbar::-webkit-scrollbar-track {
            background: transparent;
        }
        .pkg-toolbar::-webkit-scrollbar-thumb {
            background-color: transparent;
            border-radius: 2px;
        }
        .pkg-toolbar:hover::-webkit-scrollbar-thumb {
            background-color: var(--vscode-scrollbarSlider-background);
        }
        .pkg-toolbar::-webkit-scrollbar-thumb:hover {
            background-color: var(--vscode-scrollbarSlider-hoverBackground);
        }
        .pkg-toolbar::-webkit-scrollbar-thumb:active {
            background-color: var(--vscode-scrollbarSlider-activeBackground);
        }
        .pkg-toolbar > * {
            flex-shrink: 0;
        }
        .pkg-search {
            flex: 1;
            min-width: 0;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 5px 10px;
            border-radius: 6px;
            font-size: var(--vscode-font-size, 13px);
            font-family: var(--vscode-font-family);
            outline: none;
        }
        .pkg-search::placeholder {
            color: var(--vscode-input-placeholderForeground);
            opacity: 1;
        }
        .pkg-search:focus {
            border-color: var(--vscode-focusBorder);
        }

        .pkg-filter-btn {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
            border: none;
            padding: 4px 10px;
            border-radius: 6px;
            cursor: pointer;
            font-size: calc(var(--vscode-font-size, 13px) - 1px);
            font-family: var(--vscode-font-family);
            white-space: nowrap;
            opacity: 0.9;
        }
        .pkg-filter-btn:hover {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .pkg-filter-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            opacity: 1;
        }

        .pkg-refresh-btn {
            background: none;
            color: var(--vscode-foreground);
            border: none;
            padding: 3px 6px;
            border-radius: 6px;
            cursor: pointer;
            opacity: 0.7;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .pkg-refresh-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .pkg-refresh-btn svg { width: 14px; height: 14px; display: block; }

        /* ── Package Table ── */
        .pkg-table-wrapper {
            flex: 1;
            overflow: auto;
        }
        .pkg-row td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            vertical-align: middle;
            font-family: var(--vscode-editor-font-family, monospace);
            background: var(--vscode-editor-background);
        }
        .pkg-row:hover td {
            background: color-mix(in srgb, var(--vscode-list-hoverBackground) 100%, var(--vscode-editor-background));
        }

        .pkg-row td.frozen-col {
            position: sticky;
            left: 0;
            z-index: 1;
            background: var(--vscode-editor-background);
        }
        .pkg-row:hover td.frozen-col {
            background: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-editor-background);
        }
        .pkg-row:hover td.pkg-name-col.frozen-col {
            background: linear-gradient(var(--vscode-list-hoverBackground), var(--vscode-list-hoverBackground)), var(--vscode-editor-background);
        }

        .pkg-checkbox {
            width: 1%;
            white-space: nowrap;
            padding-left: 12px !important;
            cursor: pointer;
        }
        .pkg-checkbox svg { width: 16px; height: 16px; display: block; }
        .pkg-name-col {
            width: 1%;
            white-space: nowrap;
            padding-right: 16px !important;
            font-weight: 600;
        }
        .pkg-row td.pkg-name-col.frozen-col {
            position: sticky;
            left: 36px;
            z-index: 1;
            background: var(--vscode-editor-background);
        }
        .pkg-title-col {
            width: auto;
            opacity: 0.7;
            white-space: nowrap;
        }
        .pkg-version-col {
            width: 1%;
            white-space: nowrap;
            opacity: 0.6;
        }

        .pkg-header th {
            position: sticky; top: 0; z-index: 2;
            padding: 6px 8px;
            text-align: left;
            font-weight: 600;
            font-style: italic;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-editorGroup-border);
        }
        .pkg-header th.frozen-col {
            position: sticky;
            left: 0;
            z-index: 3;
        }
        .pkg-header th.pkg-name-col.frozen-col {
            left: 36px;
        }

        /* ── Attached Objects List ── */
        .attached-list { list-style: none; padding: 0; margin: 0; }
        .attached-list li {
            padding: 4px 16px;
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            font-family: var(--vscode-editor-font-family, monospace);
            display: flex;
            align-items: center;
            min-height: 25px;
        }
        .attached-list li:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .attached-list li svg.icon-paperclip {
            width: 14px;
            height: 14px;
            margin-right: 8px;
            opacity: 0.6;
            flex-shrink: 0;
        }
        .attached-list .attached-name {
            font-weight: 500;
        }
    </style>
</head>
<body>
    <div id="tooltip" class="tooltip"></div>
    <div class="tabs">
        <div class="tab active" data-target="tab-env">Global Environment <span id="count-env"></span></div>
        <div class="tab" data-target="tab-packages">Packages <span id="count-packages"></span></div>
        <div class="tab" data-target="tab-attached">Attached Objects <span id="count-attached"></span></div>
    </div>

    <div id="tab-env" class="content active">
        <div class="table-scroll-wrapper" id="env-scroll"></div>
    </div>

    <div id="tab-packages" class="content">
        <div class="pkg-toolbar">
            <input type="text" class="pkg-search" id="pkg-search" placeholder="Search packages..." />
            <button class="pkg-filter-btn active" data-filter="all">All</button>
            <button class="pkg-filter-btn" data-filter="attached">Attached</button>
            <button class="pkg-filter-btn" data-filter="loaded">Loaded</button>
            <button class="pkg-refresh-btn" id="btn-pkg-refresh" data-tooltip="Refresh Installed Packages">${REFRESH_ICON}</button>
        </div>
        <div class="pkg-table-wrapper" id="pkg-scroll"></div>
    </div>

    <div id="tab-attached" class="content"></div>

    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            const ICON_UNCHECKED = '${ICON_UNCHECKED.replace(/'/g, "\\'")}';
            const ICON_ATTACHED = '${ICON_ATTACHED.replace(/'/g, "\\'")}';
            const ICON_LOADED = '${ICON_LOADED.replace(/'/g, "\\'")}';
            const EYE_ICON = '${EYE_ICON.replace(/'/g, "\\'")}';
            const TRASH_ICON = '${TRASH_ICON.replace(/'/g, "\\'")}';
            const BROOM_ICON = '${BROOM_ICON.replace(/'/g, "\\'")}';
            const PAPERCLIP_ICON = '${PAPERCLIP_ICON.replace(/'/g, "\\'")}';

            let currentFilter = 'all';
            let currentSearch = '';

            // ── Tab Switching ──
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

            // ── Update Handler ──
            window.addEventListener('message', event => {
                const msg = event.data;
                if (msg.command === 'update') {
                    renderEnvironment(msg);
                    renderPackages(msg);
                    renderAttached(msg);
                }
                if (msg.command === 'setMinimized') {
                    document.body.classList.toggle('minimized', msg.minimized);
                }
            });

            // ── Environment Rendering ──
            function renderEnvironment(msg) {
                const el = document.getElementById('env-scroll');
                const cEnv = document.getElementById('count-env');
                cEnv.textContent = msg.variables && msg.variables.length > 0 ? '(' + msg.variables.length + ')' : '';

                if (msg.isLoading && !msg.errorMessage && (!msg.variables || msg.variables.length === 0)) {
                    el.innerHTML = '<div class="status-msg">Refreshing&hellip;</div>';
                    return;
                }

                if (msg.errorMessage) {
                    el.innerHTML = '<div class="status-msg error">⚠ ' + escapeHtml(msg.errorMessage) + '</div>';
                    return;
                }

                if (!msg.variables || msg.variables.length === 0) {
                    el.innerHTML = '<div class="empty-state"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2.5h-1A2.5 2.5 0 0 0 3 5v1.5A1.5 1.5 0 0 1 1.5 8 1.5 1.5 0 0 1 3 9.5V11A2.5 2.5 0 0 0 5.5 13.5h1 M9.5 2.5h1A2.5 2.5 0 0 1 13 5v1.5A1.5 1.5 0 0 0 14.5 8 1.5 1.5 0 0 0 13 9.5V11a2.5 2.5 0 0 1-2.5 2.5h-1"/></svg><p>No variables in the global environment.<br/>Run R code to populate variables.</p></div>';
                    return;
                }

                let rows = msg.variables.map(v => {
                    const btn = v.isDataFrame
                        ? '<button class="view-btn" data-var="' + escapeHtml(v.name) + '" data-tooltip="View in Data Viewer">' + EYE_ICON + '</button>'
                        : '';
                    const removeBtn = '<button class="remove-btn" data-var="' + escapeHtml(v.name) + '" data-tooltip="Remove Variable">' + TRASH_ICON + '</button>';
                    return '<tr class="var-row">'
                        + '<td class="name-col frozen-col">' + removeBtn + '<span class="var-name">' + escapeHtml(v.name) + '</span>' + btn + '</td>'
                        + '<td class="type-col">' + escapeHtml(v.type) + '</td>'
                        + '<td class="size-col">' + escapeHtml(v.size) + '</td>'
                        + '<td class="preview-col">' + escapeHtml(v.preview) + '</td>'
                        + '</tr>';
                }).join('');
                el.innerHTML = '<table><thead><tr><th class="frozen-col name-header-col"><button class="clear-all-btn" id="btn-clear-env" data-tooltip="Clear All Variables">' + BROOM_ICON + '</button><span>Name</span></th><th>Class</th><th>Size</th><th>Value</th></tr></thead><tbody>' + rows + '</tbody></table>';

                attachViewListeners();
            }

            function attachViewListeners() {
                document.querySelectorAll('.view-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const varName = btn.getAttribute('data-var');
                        if (varName) vscode.postMessage({ type: 'viewData', varName });
                    });
                });
                document.querySelectorAll('.remove-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const varName = btn.getAttribute('data-var');
                        if (varName) vscode.postMessage({ type: 'removeVariable', varName });
                    });
                });
                const clearBtn = document.getElementById('btn-clear-env');
                if (clearBtn) {
                    clearBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'clearWorkspace' });
                    });
                }
            }

            // ── Packages Rendering ──
            function renderPackages(msg) {
                const el = document.getElementById('pkg-scroll');
                const cPkg = document.getElementById('count-packages');

                if (!msg.packages || msg.packages.length === 0) {
                    cPkg.textContent = '';
                    el.innerHTML = '<div class="empty-state"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 6h12M6 6v7"/></svg><p>No package data loaded.<br/>Click the refresh button to scan installed packages.</p></div>';
                    return;
                }

                // Apply filter
                let filtered = msg.packages;
                if (currentFilter === 'attached') {
                    filtered = filtered.filter(p => p.status === 'attached');
                } else if (currentFilter === 'loaded') {
                    filtered = filtered.filter(p => p.status === 'loaded' || p.status === 'attached');
                }

                // Apply search
                if (currentSearch) {
                    const q = currentSearch.toLowerCase();
                    filtered = filtered.filter(p =>
                        p.name.toLowerCase().includes(q) ||
                        (p.title && p.title.toLowerCase().includes(q))
                    );
                }

                // Sort: attached first, then loaded, then none — alphabetical within each
                filtered.sort((a, b) => {
                    const order = { attached: 0, loaded: 1, none: 2 };
                    const diff = order[a.status] - order[b.status];
                    if (diff !== 0) return diff;
                    return a.name.localeCompare(b.name);
                });

                cPkg.textContent = '(' + msg.packages.length + ')';

                const rows = filtered.map(p => {
                    let icon, tooltip, action;
                    if (p.status === 'attached') {
                        icon = ICON_ATTACHED;
                        tooltip = 'Detach package';
                        action = 'detach';
                    } else if (p.status === 'loaded') {
                        icon = ICON_LOADED;
                        tooltip = 'Attach package';
                        action = 'attach';
                    } else {
                        icon = ICON_UNCHECKED;
                        tooltip = 'Attach package';
                        action = 'attach';
                    }
                    return '<tr class="pkg-row">'
                        + '<td class="pkg-checkbox frozen-col" data-pkg="' + escapeHtml(p.name) + '" data-action="' + action + '" data-tooltip="' + tooltip + '">' + icon + '</td>'
                        + '<td class="pkg-name-col frozen-col">' + escapeHtml(p.name) + '</td>'
                        + '<td class="pkg-version-col">' + escapeHtml(p.version) + '</td>'
                        + '<td class="pkg-title-col">' + escapeHtml(p.title) + '</td>'
                        + '</tr>';
                }).join('');

                el.innerHTML = '<table><thead class="pkg-header"><tr><th class="frozen-col" style="width:1%"></th><th class="pkg-name-col frozen-col" style="padding-left:8px">Package</th><th>Version</th><th>Title</th></tr></thead><tbody>' + rows + '</tbody></table>';

                // Attach click handlers on checkboxes
                el.querySelectorAll('.pkg-checkbox').forEach(td => {
                    td.addEventListener('click', () => {
                        const pkg = td.getAttribute('data-pkg');
                        const action = td.getAttribute('data-action');
                        if (action === 'attach') {
                            vscode.postMessage({ type: 'attachPackage', pkgName: pkg });
                        } else {
                            vscode.postMessage({ type: 'detachPackage', pkgName: pkg });
                        }
                    });
                });
            }

            // ── Attached Objects Rendering ──
            function renderAttached(msg) {
                const el = document.getElementById('tab-attached');
                const cAttached = document.getElementById('count-attached');
                const items = msg.attachedObjects || [];
                cAttached.textContent = items.length > 0 ? '(' + items.length + ')' : '';

                if (items.length === 0) {
                    el.innerHTML = '<div class="empty-state">' + PAPERCLIP_ICON + '<p>No attached objects.<br/>Use <code>attach(data)</code> to add objects<br/>to the search path.</p></div>';
                    return;
                }

                el.innerHTML = '<ul class="attached-list">' + items.map(n => '<li>' + PAPERCLIP_ICON + '<span class="attached-name">' + escapeHtml(n) + '</span></li>').join('') + '</ul>';
            }

            // ── Package Search & Filter ──
            document.getElementById('pkg-search')?.addEventListener('input', (e) => {
                currentSearch = e.target.value;
                // Re-render packages with current state by requesting a refresh message
                // We need to store last msg and re-render locally
                if (window._lastMsg) renderPackages(window._lastMsg);
            });

            document.querySelectorAll('.pkg-filter-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.pkg-filter-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    currentFilter = btn.getAttribute('data-filter');
                    if (window._lastMsg) renderPackages(window._lastMsg);
                });
            });

            document.getElementById('btn-pkg-refresh')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'refreshPackages' });
            });

            // Store last message for local re-render (search/filter)
            window._lastMsg = null;
            const origListener = window.addEventListener;
            window.addEventListener('message', event => {
                if (event.data.command === 'update') {
                    window._lastMsg = event.data;
                }
            });

            // ── Instant Tooltip Controller ──
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

