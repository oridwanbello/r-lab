import * as vscode from 'vscode';
import { getNonce } from '../utils/webviewUtils';
import { suppressGuardForPanelMove } from '../layout/layoutManager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { enforceGroup3TabOrder } from '../utils/webviewUtils';
import * as childProcess from 'child_process';
import { getRConsoleTerminal } from '../layout/layoutManager';
import { getRscriptPath } from '../utils/rPathResolver';

/**
 * Plots Panel - a WebviewPanel (editor tab) that watches a directory
 * for new plot images and displays them with history navigation.
 *
 * Opens in ViewColumn.Three (bottom-right layout).
 */
export class PlotsPanel {
    public static currentPanel: PlotsPanel | undefined;
    public static readonly viewType = 'r-layout.plotsPanel';

    private static _sessionCustomPlotDir: string | undefined;
    private static _sessionLastDirAction: 'view' | 'outview' | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private _plots: vscode.Uri[] = [];
    private _currentIndex = -1;
    private _watcher?: vscode.FileSystemWatcher;
    private _isMinimized = false;
    private _isPoppedOut: boolean = false;
    private _focusPending: boolean = false;
    private _disposables: vscode.Disposable[] = [];
    private _isNightMode = false;
    private _lastRenderedDims: Map<string, { w: number, h: number, res: number, renderScale: number }> = new Map();
    private _resizeRenderTokens: Map<string, number> = new Map();
    private _previewRenderToken = 0;
    private _customPlotDir: string | undefined;
    private _lastDirAction: 'outview' | 'view' | undefined;
    private _extensionUri: vscode.Uri;

    // Factory

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Three,
        forceReveal: boolean = true
    ): PlotsPanel {
        if (PlotsPanel.currentPanel) {
            if (forceReveal) {
                PlotsPanel.currentPanel._panel.reveal(column, true);
            }
            return PlotsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            PlotsPanel.viewType,
            'Plots',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                localResourceRoots: PlotsPanel._getResourceRoots(extensionUri),
                retainContextWhenHidden: true,
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        PlotsPanel.currentPanel = new PlotsPanel(panel, extensionUri);
        return PlotsPanel.currentPanel;
    }

    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): void {
        PlotsPanel.currentPanel = new PlotsPanel(panel, extensionUri);
    }

    public static resetSessionState(): void {
        PlotsPanel._sessionCustomPlotDir = undefined;
        PlotsPanel._sessionLastDirAction = undefined;
    }

    private static _getResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
        const roots: vscode.Uri[] = [extensionUri];
        if (vscode.workspace.workspaceFolders) {
            for (const folder of vscode.workspace.workspaceFolders) {
                roots.push(folder.uri);
            }
        }
        // Also allow loading from home directory fallback for no-workspace mode
        roots.push(vscode.Uri.file(os.homedir()));
        return roots;
    }

    public reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
        this._panel.reveal(column, preserveFocus);
    }

    /** Hide or show all webview content (toolbar, plots, controls).
     *  Used when the top-right pane is maximized so only the
     *  VS Code tab bar remains visible for the bottom-right group.
     */
    public setMinimized(minimized: boolean): void {
        this._isMinimized = minimized;
        this._render();
    }

    // Constructor

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Restore persisted state from static session memory, falling back to VS Code settings
        const configPlotDir = vscode.workspace.getConfiguration('r-layout').get<string>('plotOutputDir');
        if (PlotsPanel._sessionCustomPlotDir === undefined && configPlotDir && configPlotDir.trim() !== '') {
            this._customPlotDir = configPlotDir.trim();
        } else {
            this._customPlotDir = PlotsPanel._sessionCustomPlotDir;
        }
        this._lastDirAction = PlotsPanel._sessionLastDirAction;

        this._render();
        this._startWatcher();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            (e) => { this._postState(); },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            (msg: { type: string }) => {
                switch (msg.type) {
                    case 'ready':
                        this._postState();
                        if (this._focusPending) {
                            this._focusPending = false;
                            enforceGroup3TabOrder('Plots').then(() => {
                                setTimeout(() => {
                                    vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                                }, 150);
                            });
                        }
                        break;
                    case 'navigatePrev':
                        if (this._currentIndex > 0) {
                            this._currentIndex--;
                            this._render();
                        }
                        break;
                    case 'navigateNext':
                        if (this._currentIndex < this._plots.length - 1) {
                            this._currentIndex++;
                            this._render();
                        }
                        break;
                    case 'navigateTo':
                        this._currentIndex = (msg as any).index;
                        this._render();
                        break;
                    case 'clear':
                        this.clear();
                        break;
                    case 'saveAs':
                        this._handleSaveAs((msg as any).format, (msg as any).width, (msg as any).height, (msg as any).unit);
                        break;
                    case 'previewRender':
                        this._handleRequestPreviewRender(
                            (msg as any).format,
                            (msg as any).width,
                            (msg as any).height,
                            (msg as any).unit,
                            (msg as any).requestId
                        );
                        break;
                    case 'deleteCurrent':
                        this._handleDeleteCurrent();
                        break;
                    case 'toggleNightMode':
                        this._isNightMode = !this._isNightMode;
                        this._render();
                        break;
                    case 'resize':
                        this._handleResize((msg as any).width, (msg as any).height, (msg as any).pixelRatio);
                        break;
                    case 'resizePlot':
                        this._handleResize(
                            (msg as any).width,
                            (msg as any).height,
                            (msg as any).pixelRatio,
                            (msg as any).index
                        );
                        break;
                    case 'setCustomDir':
                        this._handleSetCustomDir((msg as any).path, false);
                        break;
                    case 'setOutViewDir':
                        this._handleSetCustomDir((msg as any).path, true);
                        break;
                    case 'openViewer':
                        vscode.commands.executeCommand('r-layout.focusViewer');
                        break;
                    case 'copyImage':
                        this._handleCopyImage();
                        break;
                    case 'browseCustomDir':
                        this._handleBrowseCustomDir();
                        break;
                    case 'popout':
                        this._focusPending = true;
                        suppressGuardForPanelMove();
                        this._panel.reveal(vscode.ViewColumn.One, false);
                        vscode.commands.executeCommand('workbench.action.keepEditor');
                        setTimeout(async () => {
                            await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                        }, 150);
                        this._postState(true);
                        break;
                    case 'restore':
                        this._focusPending = true;
                        suppressGuardForPanelMove();
                        this._panel.reveal(vscode.ViewColumn.Three, false);
                        vscode.commands.executeCommand('workbench.action.keepEditor');
                        setTimeout(async () => {
                            await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
                        }, 150);
                        enforceGroup3TabOrder('Plots');
                        this._postState(false);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private _handleSetCustomDir(dirPath: string | undefined, setOutput: boolean): void {
        const resolved = dirPath && dirPath.trim() ? dirPath.trim() : undefined;
        this._customPlotDir = resolved;

        // Update localResourceRoots to allow loading images from the new directory
        const roots = PlotsPanel._getResourceRoots(this._extensionUri);
        if (this._customPlotDir) {
            const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
            const normalizedPath = path.isAbsolute(this._customPlotDir)
                ? path.normalize(this._customPlotDir)
                : path.join(base, this._customPlotDir);
            const customUri = vscode.Uri.file(normalizedPath);
            roots.push(customUri);
        }
        this._panel.webview.options = {
            ...this._panel.webview.options,
            localResourceRoots: roots
        };

        // If setOutput is true, redirect R's plot output to this directory via options().
        // If clearing (resolved is undefined), reset back to the default .R-layout/plots.
        if (setOutput) {
            const term = getRConsoleTerminal();
            if (term) {
                if (resolved) {
                    const escaped = resolved.replace(/\\/g, '/');
                    term.sendText(`options(.rlayout_plot_dir = ${JSON.stringify(escaped)})`, true);
                } else {
                    term.sendText('options(.rlayout_plot_dir = NULL)', true);
                }
            }
        }

        // Track which action was last used so we can show persistent active state in the UI.
        this._lastDirAction = resolved ? (setOutput ? 'outview' : 'view') : undefined;

        // Persist to session memory
        PlotsPanel._sessionCustomPlotDir = this._customPlotDir;
        PlotsPanel._sessionLastDirAction = this._lastDirAction;

        this.clear(); // Clear existing plots
        this._startWatcher(); // Restart watcher on new dir
        this.syncPlots(); // Load existing plots from new dir
    }

    private async _handleBrowseCustomDir(): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const defaultUri = workspaceFolder ? workspaceFolder.uri : vscode.Uri.file(os.homedir());

        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Plot Directory',
            defaultUri: defaultUri
        });

        if (uris && uris.length > 0) {
            // Browse only sets the view dir - user must click Set Out/View Dir to redirect output
            this._handleSetCustomDir(uris[0].fsPath, false);
        }
    }

    private _handleDeleteCurrent(): void {
        if (this._currentIndex < 0 || this._currentIndex >= this._plots.length) { return; }
        const uri = this._plots[this._currentIndex];

        if (uri.fsPath.includes('_interactive.svg')) {
            vscode.window.showWarningMessage('Interactive widget placeholders can only be deleted from the Viewer tab.');
            return;
        }

        // Only allow physical deletion for files inside the .R-layout directory.
        // User-specified directories must not be modified - we only display them.
        const wf = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const rLayoutDir = path.join(wf, '.R-layout');
        const relative = path.relative(rLayoutDir, uri.fsPath);
        const isInside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
        if (!isInside) {
            vscode.window.showWarningMessage(
                'Deletion is only permitted for plots in the .R-layout directory. ' +
                'To remove plots from a custom folder, delete them manually.'
            );
            return;
        }

        try {
            if (fs.existsSync(uri.fsPath)) {
                fs.unlinkSync(uri.fsPath);
                const rdsPath = uri.fsPath.replace(/\.(png|jpg|jpeg|svg|gif|bmp|webp|ico)$/i, '.rds');
                if (fs.existsSync(rdsPath)) {
                    fs.unlinkSync(rdsPath);
                }
            }
            // The watcher will pick up the deletion and update the UI
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to delete plot: ${err.message}`);
        }
    }

    private async _handleResize(width: number, height: number, pixelRatio?: number, plotIndex?: number): Promise<void> {
        const targetIndex = typeof plotIndex === 'number' ? plotIndex : this._currentIndex;
        if (targetIndex < 0 || targetIndex >= this._plots.length) {
            return;
        }
        const sourceUri = this._plots[targetIndex];
        // Only dynamically resize generated plots, not interactive SVG placeholders
        if (sourceUri.fsPath.includes('_interactive.svg')) {
            return;
        }

        const ext = path.extname(sourceUri.fsPath);
        if (ext !== '.png') {
            return; // We only resize PNG plots saved via layoutManager.ts
        }

        const rdsPath = sourceUri.fsPath.replace(/\.png$/, '.rds');
        if (!fs.existsSync(rdsPath)) {
            return;
        }

        const rscriptPath = getRscriptPath();

        // Previous attempt: widening the replay device did not fix left-edge clipping.
        // Check whether the saved PNG is already clipped before changing replay dimensions.
        const renderScale = Math.min(Math.max(Number(pixelRatio) || 1, 1), 2.5);
        let w = width * renderScale;
        let h = height * renderScale;
        const res = 150; // Fixed baseline resolution for consistent text proportionality

        // Ensure physical dimensions never drop below 5 inches to prevent R "figure margins too large" errors.
        // We scale w and h proportionally to preserve the exact CSS aspect ratio, acting like a clean zoom out.
        const minPixels = 5 * res; // 750 pixels
        if (w < minPixels || h < minPixels) {
            const scale = Math.max(minPixels / w, minPixels / h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        } else {
            w = Math.round(w);
            h = Math.round(h);
        }

        // Prevent redundant re-rendering if this plot was already rendered at this exact dimension
        const cacheKey = sourceUri.fsPath;
        const lastDims = this._lastRenderedDims.get(cacheKey);
        if (lastDims && lastDims.w === w && lastDims.h === h && lastDims.res === res && lastDims.renderScale === renderScale) {
            return; // Already perfectly rendered for this size
        }

        const token = (this._resizeRenderTokens.get(cacheKey) || 0) + 1;
        this._resizeRenderTokens.set(cacheKey, token);

        const tmpPngPath = path.join(
            path.dirname(sourceUri.fsPath),
            `.${path.basename(sourceUri.fsPath, '.png')}.resize-${process.pid}-${Date.now()}-${token}.tmp`
        );

        // Escape paths for R
        const safeRdsPath = rdsPath.replace(/\\/g, '/');
        const safeTmpPngPath = tmpPngPath.replace(/\\/g, '/');

        const script = `
tryCatch({
    p <- readRDS('${safeRdsPath}')
    png('${safeTmpPngPath}', width=${w}, height=${h}, res=${res}, bg='white')
    replayPlot(p)
    dev.off()
}, error = function(e) {})
`;

        childProcess.execFile(rscriptPath, ['-e', script], { encoding: 'utf8' }, (error) => {
            if (error) {
                console.error('[R Layout] Dynamic resize re-rendering failed:', error);
                try { if (fs.existsSync(tmpPngPath)) { fs.unlinkSync(tmpPngPath); } } catch {}
                return;
            }

            if (this._resizeRenderTokens.get(cacheKey) !== token || !this._plots.some(plot => plot.fsPath === sourceUri.fsPath)) {
                try { if (fs.existsSync(tmpPngPath)) { fs.unlinkSync(tmpPngPath); } } catch {}
                return;
            }

            try {
                const stats = fs.existsSync(tmpPngPath) ? fs.statSync(tmpPngPath) : undefined;
                if (!stats || stats.size === 0) {
                    try { if (fs.existsSync(tmpPngPath)) { fs.unlinkSync(tmpPngPath); } } catch {}
                    return;
                }
                fs.renameSync(tmpPngPath, sourceUri.fsPath);
                this._lastRenderedDims.set(cacheKey, { w, h, res, renderScale });
            } catch (err) {
                console.error('[R Layout] Dynamic resize replacement failed:', err);
                try { if (fs.existsSync(tmpPngPath)) { fs.unlinkSync(tmpPngPath); } } catch {}
            }
            // If successful, the file watcher picks up the modified PNG and automatically calls _render().
        });
    }

    private async _handleRequestPreviewRender(format: string, widthStr: string, heightStr: string, unit: string, requestId?: number): Promise<void> {
        if (this._currentIndex < 0) {
            return;
        }
        const sourceUri = this._plots[this._currentIndex];

        // Interactive SVG doesn't need R rendering
        if (sourceUri.fsPath.includes('_interactive.svg')) {
            return;
        }

        const rdsPath = sourceUri.fsPath.replace(/\.png$/, '.rds');
        if (!fs.existsSync(rdsPath)) {
            return;
        }

        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const tmpDir = path.join(effectiveRoot, '.tmp');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const token = ++this._previewRenderToken;
        const previewPath = path.join(tmpDir, 'export_preview.png');
        const tmpPreviewPath = path.join(tmpDir, `export_preview.${process.pid}.${Date.now()}.${token}.tmp`);
        const targetExt = format.toLowerCase();
        const targetTempPath = path.join(tmpDir, `export_size_test.${targetExt}`);
        const tmpTargetTempPath = path.join(tmpDir, `export_size_test.${process.pid}.${Date.now()}.${token}.${targetExt}.tmp`);

        const safeRdsPath = rdsPath.replace(/\\/g, '/');
        const safePngPath = tmpPreviewPath.replace(/\\/g, '/');
        const safeTargetTempPath = tmpTargetTempPath.replace(/\\/g, '/');

        const rscriptPath = getRscriptPath();
        const script = `
tryCatch({
    p <- readRDS('${safeRdsPath}')

    .w <- as.numeric('${widthStr}')
    .h <- as.numeric('${heightStr}')
    .unit <- '${unit}'

    .res <- 300
    if (.unit == "cm") { .w_in <- .w / 2.54; .h_in <- .h / 2.54 }
    else if (.unit == "mm") { .w_in <- .w / 25.4; .h_in <- .h / 25.4 }
    else if (.unit == "px") {
      .base_res <- 300
      .w_in <- .w / .base_res
      .h_in <- .h / .base_res
      if (.w_in < 5 || .h_in < 5) {
        .scale <- max(5 / .w_in, 5 / .h_in)
        .w_in <- .w_in * .scale
        .h_in <- .h_in * .scale
      }
      .res <- .w / .w_in
    } else {
      .w_in <- .w; .h_in <- .h
    }

    png('${safePngPath}', width=.w, height=.h, units=.unit, res=.res, bg='white')
    replayPlot(p)
    dev.off()

    if ('${targetExt}' == 'pdf') {
        pdf(file='${safeTargetTempPath}', width=.w_in, height=.h_in, onefile=FALSE)
        replayPlot(p)
        dev.off()
    } else if ('${targetExt}' == 'svg') {
        svg(filename='${safeTargetTempPath}', width=.w_in, height=.h_in, onefile=FALSE)
        replayPlot(p)
        dev.off()
    } else if ('${targetExt}' == 'eps') {
        if (capabilities("cairo")) {
            cairo_ps(filename='${safeTargetTempPath}', width=.w_in, height=.h_in, onefile=FALSE, fallback_resolution=300)
        } else {
            postscript(file='${safeTargetTempPath}', width=.w_in, height=.h_in, horizontal=FALSE, onefile=FALSE, paper="special")
        }
        replayPlot(p)
        dev.off()
    } else if ('${targetExt}' == 'jpeg' || '${targetExt}' == 'jpg') {
        jpeg(filename='${safeTargetTempPath}', width=.w, height=.h, units=.unit, res=.res, bg='white', quality=90)
        replayPlot(p)
        dev.off()
    }
}, error = function(e) {})
`;

        childProcess.execFile(rscriptPath, ['-e', script], (error) => {
            const cleanupTemps = () => {
                try { if (fs.existsSync(tmpPreviewPath)) { fs.unlinkSync(tmpPreviewPath); } } catch {}
                try { if (fs.existsSync(tmpTargetTempPath)) { fs.unlinkSync(tmpTargetTempPath); } } catch {}
            };

            if (error || this._previewRenderToken !== token) {
                cleanupTemps();
                return;
            }

            if (fs.existsSync(tmpPreviewPath)) {
                let fileSizeInBytes = 0;
                if (targetExt === 'png') {
                    fileSizeInBytes = fs.statSync(tmpPreviewPath).size;
                } else if (fs.existsSync(tmpTargetTempPath)) {
                    fileSizeInBytes = fs.statSync(tmpTargetTempPath).size;
                }

                let fileSizeStr = '';
                if (fileSizeInBytes > 0) {
                    if (fileSizeInBytes < 1000) {
                        fileSizeStr = `${fileSizeInBytes} B`;
                    } else if (fileSizeInBytes < 1000 * 1000) {
                        fileSizeStr = `${(fileSizeInBytes / 1000).toFixed(1)} kB`;
                    } else {
                        fileSizeStr = `${(fileSizeInBytes / (1000 * 1000)).toFixed(2)} MB`;
                    }
                }

                try {
                    fs.renameSync(tmpPreviewPath, previewPath);
                    if (fs.existsSync(tmpTargetTempPath)) {
                        fs.renameSync(tmpTargetTempPath, targetTempPath);
                    }
                } catch (err) {
                    console.error('[R Layout] Preview render replacement failed:', err);
                    cleanupTemps();
                    return;
                }

                const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(previewPath)).toString();
                this._panel.webview.postMessage({
                    type: 'previewRendered',
                    src: webviewUri,
                    fileSize: fileSizeStr,
                    requestId
                });
            }
        });
    }

    private async _handleSaveAs(format: string, widthStr: string, heightStr: string, unit: string): Promise<void> {
        if (this._currentIndex < 0) { return; }
        const sourceUri = this._plots[this._currentIndex];

        const filterName = format.toUpperCase();
        const ext = format;

        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const defaultFilename = path.basename(sourceUri.fsPath).replace('.png', `.${ext}`);

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(effectiveRoot, defaultFilename)),
            filters: { [filterName]: [ext] }
        });

        if (saveUri) {
            try {
                // Plot ID is the basename without extension, e.g., 'plot_00002'
                const plotId = path.basename(sourceUri.fsPath, '.png');
                const plotDir = path.dirname(sourceUri.fsPath);
                const reqPath = path.join(plotDir, '..', '.plot_req');
                const reqContent = [
                    plotId,
                    format,
                    widthStr,
                    heightStr,
                    unit,
                    saveUri.fsPath
                ].join('\n');

                fs.writeFileSync(reqPath, reqContent, 'utf8');

                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Exporting plot...`,
                    cancellable: false
                }, async (progress) => {
                    let attempts = 0;
                    // Wait up to 10 seconds for the R process to consume the request
                    while (fs.existsSync(reqPath) && attempts < 50) {
                        await new Promise(r => setTimeout(r, 200));
                        attempts++;
                    }

                    // Allow a brief moment for OS flush
                    await new Promise(r => setTimeout(r, 500));

                    if (fs.existsSync(saveUri.fsPath)) {
                        vscode.window.setStatusBarMessage(`Export completed: ${path.basename(saveUri.fsPath)}`, 5000);
                        // Show an auto-disappearing notification immediately after export
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Export completed: ${path.basename(saveUri.fsPath)}`,
                            cancellable: false
                        }, async () => {
                            await new Promise(r => setTimeout(r, 2000));
                        });
                    } else {
                        vscode.window.showErrorMessage(`Failed to export plot to ${path.basename(saveUri.fsPath)}. Please check directory permissions.`);
                    }
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to export plot: ${err.message}`);
            }
        }
    }

    private async _handleCopyImage(): Promise<void> {
        if (this._plots.length === 0 || this._currentIndex < 0 || this._currentIndex >= this._plots.length) {
            return;
        }
        const currentPlotPath = this._plots[this._currentIndex].fsPath;

        try {
            const platform = os.platform();
            if (platform === 'darwin') {
                // macOS: copy as TIFF because JPEG/PNG sometimes loses transparency depending on the clipboard consumer
                childProcess.execSync(`osascript -e 'set the clipboard to (read (POSIX file "${currentPlotPath}") as TIFF picture)'`);
            } else if (platform === 'win32') {
                // Windows: use PowerShell
                childProcess.execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${currentPlotPath}'))"`);
            } else {
                // Linux: requires xclip
                childProcess.execSync(`xclip -selection clipboard -t image/png -i "${currentPlotPath}"`);
            }
            vscode.window.setStatusBarMessage('Plot copied to clipboard', 4000);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to copy plot to clipboard: ${e.message || e}`);
        }
    }

    // File System Watcher

    private _startWatcher(): void {
        // Dispose existing watcher if any
        if (this._watcher) {
            this._watcher.dispose();
            const idx = this._disposables.indexOf(this._watcher);
            if (idx > -1) {
                this._disposables.splice(idx, 1);
            }
            this._watcher = undefined;
        }

        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

        let watchDirFsPath: string;
        if (this._customPlotDir) {
            watchDirFsPath = path.isAbsolute(this._customPlotDir)
                ? this._customPlotDir
                : path.join(effectiveRoot, this._customPlotDir);
        } else {
            const config = vscode.workspace.getConfiguration('r-layout');
            const plotDir = '.R-layout/plots';
            watchDirFsPath = path.join(effectiveRoot, plotDir);
        }

        const pattern = new vscode.RelativePattern(
            vscode.Uri.file(watchDirFsPath),
            '*.{png,jpg,jpeg,svg,gif,bmp,webp,ico}'
        );

        this._watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this._watcher.onDidCreate(async (uri) => {
            // Guard against duplicates
            if (this._plots.some(p => p.fsPath === uri.fsPath)) { return; }

            // Windows race condition prevention (Rule #15):
            // Wait for R to finish flushing the image file to disk before exposing it to the UI.
            for (let i = 0; i < 10; i++) {
                try {
                    const stats = fs.statSync(uri.fsPath);
                    if (stats.size > 0) {
                        break;
                    }
                } catch (e) {
                    // ignore ENOENT if OS hasn't materialized it yet
                }
                await new Promise(r => setTimeout(r, 100));
            }

            // Second guard: prevent duplicates if another event pushed the same URI while we were waiting
            if (this._plots.some(p => p.fsPath === uri.fsPath)) { return; }

            this._plots.push(uri);
            this._plots.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
            this._currentIndex = this._plots.findIndex(p => p.fsPath === uri.fsPath);
            this._render();
            this._revealWithoutStealingContext();
        });
        this._watcher.onDidChange(() => {
            // Re-render current plot to pick up the updated file content
            this._render();
            this._revealWithoutStealingContext();
        });
        this._watcher.onDidDelete((uri) => {
            const idx = this._plots.findIndex(p => p.fsPath === uri.fsPath);
            if (idx !== -1) {
                this._plots.splice(idx, 1);
                if (this._currentIndex >= this._plots.length) {
                    this._currentIndex = this._plots.length - 1;
                }
                this._render();
            }
        });
        this._disposables.push(this._watcher);
    }

    // Public API

    public clear(): void {
        // Retain widget placeholders, clear everything else
        this._plots = this._plots.filter(p => p.fsPath.includes('_interactive.svg'));
        this._currentIndex = this._plots.length > 0 ? this._plots.length - 1 : -1;
        this._render();
    }

    public addPlot(uri: vscode.Uri): void {
        this._plots.push(uri);
        this._currentIndex = this._plots.length - 1;
        this._render();
    }

    /**
     * Scan the plot directory and merge any files that were created while the
     * layout was closed (i.e., not yet in `_plots`). Called on re-activation.
     */
    public syncPlots(): void {
        const effectiveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

        let dir: string;
        if (this._customPlotDir) {
            dir = path.isAbsolute(this._customPlotDir)
                ? this._customPlotDir
                : path.join(effectiveRoot, this._customPlotDir);
        } else {
            const config = vscode.workspace.getConfiguration('r-layout');
            const plotDir = '.R-layout/plots';
            dir = path.join(effectiveRoot, plotDir);
        }

        if (!fs.existsSync(dir)) { return; }

        const exts = new Set(['.png', '.jpg', '.jpeg', '.svg', '.gif', '.bmp', '.webp', '.ico']);
        const existing = new Set(this._plots.map(u => u.fsPath));

        let added = 0;
        for (const file of fs.readdirSync(dir)) {
            if (!exts.has(path.extname(file).toLowerCase())) { continue; }
            const uri = vscode.Uri.file(path.join(dir, file));
            if (!existing.has(uri.fsPath)) {
                this._plots.push(uri);
                added++;
            }
        }

        if (added > 0) {
            this._plots.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
            this._currentIndex = this._plots.length - 1;
            this._render();
        }
    }

    // Rendering

    private _revealWithoutStealingContext() {
        if (!this._panel.visible) {
            // Do not reveal if it would hide the currently active text editor
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.viewColumn === this._panel.viewColumn) {
                // The panel is in the same group as the user's active code.
                // Revealing it would hide their code, causing "No text editor active" errors
                // when running R commands. Do nothing.
                return;
            }

            this._panel.reveal(undefined, true);
        }
    }

    private _render(): void {
        if (!this._panel.webview.html) {
            this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        } else {
            this._postState();
        }
    }

    private _postState(overrideIsPoppedOut?: boolean): void {
        const plots = this._plots.map(uri => this._panel.webview.asWebviewUri(uri).toString() + `?t=${Date.now()}`);

        const inWorkspace = !!vscode.workspace.workspaceFolders?.[0];
        const defaultDir = inWorkspace ? './.R-layout/plots' : '~/.R-layout/plots';

        const isPoppedOut = overrideIsPoppedOut !== undefined ? overrideIsPoppedOut : (this._panel.viewColumn !== vscode.ViewColumn.Three && this._panel.viewColumn !== undefined);
        const actualMinimized = isPoppedOut ? false : this._isMinimized;

        this._panel.webview.postMessage({
            type: 'updateState',
            state: {
                plots: plots,
                currentIndex: this._currentIndex,
                isNightMode: this._isNightMode,
                minimized: actualMinimized,
                customPlotDir: this._customPlotDir,
                defaultDir: defaultDir,
                lastDirAction: this._lastDirAction,
                isPoppedOut: isPoppedOut
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const isPoppedOut = this._panel.viewColumn !== vscode.ViewColumn.Three && this._panel.viewColumn !== undefined;

        const inWorkspace = !!vscode.workspace.workspaceFolders?.[0];
        const defaultDir = inWorkspace ? './.R-layout/plots' : '~/.R-layout/plots';

        const moonIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M9.598 1.591a.75.75 0 01.785-.175 7 7 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/></svg>';
        const sunIcon = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 0zm0 13a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 13zm8-5a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2a.5.5 0 01.5.5zM3 8a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2A.5.5 0 013 8zm10.657-5.657a.5.5 0 010 .707l-1.414 1.415a.5.5 0 11-.707-.708l1.414-1.414a.5.5 0 01.707 0zm-9.193 9.193a.5.5 0 010 .707L3.05 13.657a.5.5 0 01-.707-.707l1.414-1.414a.5.5 0 01.707 0zm9.193 2.121a.5.5 0 01-.707 0l-1.414-1.414a.5.5 0 01.707-.707l1.414 1.414a.5.5 0 010 .707zM4.464 2.343a.5.5 0 01-.707 0L2.343 3.757a.5.5 0 11.707.707l1.414-1.414a.5.5 0 010-.707z"/></svg>';

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${webview.cspSource} data:;
                   style-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
                   font-src https://cdn.jsdelivr.net;
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.min.css" rel="stylesheet">
    <style nonce="${nonce}">
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
        body.minimized > * {
            opacity: 0 !important;
            pointer-events: none !important;
        }
        body.pane-restoring .thumbnail {
            transition: none !important;
        }
        .toolbar {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            padding: 0 12px;
            height: 32px; /* Fixed height to prevent shrinking */
            background: var(--vscode-editor-background); /* Matches active tab */
            border-bottom: 1px solid var(--vscode-editorGroup-border);
            z-index: 100;
            position: relative;
            flex-shrink: 0;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap;
            /* Previous attempt: WebKit height changes and removing scrollbar-width did not match native tab scrollbars. */
            scrollbar-width: thin;
        }
        .toolbar::-webkit-scrollbar {
            height: 1px;
        }
        .toolbar::-webkit-scrollbar-track {
            background: transparent;
        }
        .toolbar::-webkit-scrollbar-thumb {
            background-color: transparent;
            border-radius: 1px;
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
        .nav-controls {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
        }
        .separator {
            width: 1px;
            height: 16px;
            background-color: var(--vscode-toolbar-hoverBackground);
            margin: 0 4px;
        }
        .counter {
            font-size: 0.9em;
            opacity: 0.7;
            min-width: 44px;
            text-align: center;
            font-variant-numeric: tabular-nums;
        }
        .toolbar .btn-group {
            display: inline-flex;
            align-items: center;
            border-radius: 6px;
            gap: 0;
        }
        .toolbar .btn-group button {
            border-radius: 0 !important;
            padding: 3px 4px !important;
        }
        .toolbar .btn-group:hover:not(.disabled),
        .toolbar .btn-group.active {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar .btn-group:hover:not(.disabled) button,
        .toolbar .btn-group.active button {
            background: transparent !important;
        }
        .toolbar button {
            background: none;
            color: var(--vscode-foreground);
            border: none;
            padding: 3px 6px;
            border-radius: 6px;
            cursor: pointer;
            font-size: var(--vscode-font-size, 13px);
            opacity: 0.7;
        }
        .toolbar button:hover:not([disabled]) {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar button#btn-delete:hover:not([disabled]),
        .toolbar button#btn-clear:hover:not([disabled]) {
            color: var(--vscode-problemsErrorIcon-foreground, #DC3545);
        }
        .toolbar button svg { width: 14px; height: 14px; display: block; }
        .toolbar button[disabled] {
            opacity: 0.3;
            cursor: default;
            pointer-events: auto; /* Allow hover for tooltips */
        }
        .toolbar button[disabled]:hover {
            background: none;
        }

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

        .main-container {
            display: flex;
            flex-direction: row;
            flex: 1;
            overflow: hidden;
        }

        .thumbnail-sidebar {
            width: 108px;
            background: var(--vscode-sideBar-background);
            border-left: 1px solid var(--vscode-editorGroup-border);
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 6px;
            overflow-y: auto;
            flex-shrink: 0;
        }
        .thumbnail-sidebar::-webkit-scrollbar {
            width: 6px;
        }
        .thumbnail-sidebar::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 6px;
        }
        body.night-mode {
            --plot-filter: contrast(1.05) brightness(0.765);
        }
        .thumbnail {
            width: 100%;
            height: auto;
            object-fit: contain;
            border: 4px solid transparent;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s ease;
            background: white !important;
            background-clip: padding-box !important;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            opacity: 0.6;
            filter: var(--plot-filter, none) grayscale(20%);
        }
        .thumbnail.is-interactive {
            background: transparent !important;
            box-shadow: none;
        }
        .thumbnail.active {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 8px var(--vscode-focusBorder);
            opacity: 1;
            filter: var(--plot-filter, none) grayscale(0%);
            transform: scale(1.04);
        }
        .thumbnail:hover:not(.active) {
            border-color: var(--vscode-button-secondaryHoverBackground);
            opacity: 0.9;
            filter: var(--plot-filter, none) grayscale(0%);
        }

        .plot-area {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            cursor: default;
            user-select: none;
        }
        .plot-viewport {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
            border-radius: 8px;
            /* If saved PNGs are intact, inspect this clipping path and subpixel sizing first. */
            transform: translateZ(0); /* preserves rounded corners when panning */
        }
        .plot-area.zoomed {
            cursor: grab;
        }
        .plot-area.zoomed:active {
            cursor: grabbing;
        }
        .plot-area img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: white !important;
            transition: filter 0.2s ease, background-color 0.2s ease;
            filter: var(--plot-filter, none);
            pointer-events: none; /* Let drag events fall through to the area */
        }
        .plot-area img.is-interactive {
            background: transparent !important;
            box-shadow: none;
            object-fit: fill;
        }
        .compare-pane img.is-interactive {
            background: transparent !important;
            box-shadow: none !important;
            object-fit: fill;
            width: 100%;
            height: 100%;
        }
        #overlay-slider {
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 4px;
            background: transparent;
            outline: none;
            cursor: pointer;
            margin: 8px 0; /* extra margin for overflowing thumb */
            padding: 0;
        }
        #overlay-slider::-webkit-slider-runnable-track {
            width: 100%;
            height: 4px;
            background: var(--vscode-textLink-foreground);
            border-radius: 2px;
            margin: 0;
        }
        #overlay-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            height: 14px;
            width: 14px;
            border-radius: 50%;
            background: var(--vscode-textLink-foreground);
            cursor: pointer;
            border: none;
            margin-top: -5px; /* Center thumb vertically over the 4px track */
        }
        .compare-view {
            width: 100%;
            height: 100%;
            display: none;
            flex-direction: row;
            gap: 8px;
            position: relative;
        }
        .compare-pane {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
            border-radius: 8px;
            transform: translateZ(0); /* preserves rounded corners when panning */
        }
        .compare-pane::before {
            content: "";
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 8px;
            background: var(--vscode-editorWidget-border, #C0C0C0);
            z-index: 2;
            pointer-events: none;
            transition: background-color 0.2s ease;
        }
        .compare-pane.active-left::before {
            background: var(--vscode-charts-blue, #3794ff);
        }
        .compare-pane.active-right::before {
            background: var(--vscode-charts-purple, #b146c2);
        }
        body.vscode-dark .compare-pane:not(.active-left):not(.active-right)::before,
        body.night-mode .compare-pane:not(.active-left):not(.active-right)::before {
            background: #A9A9A9;
        }
        .compare-view.overlay-active .compare-pane::before {
            display: none;
        }
        .compare-pane img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            background: white !important;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            pointer-events: none;
            transition: transform 0.1s ease-out, background-color 0.2s ease;
            filter: var(--plot-filter, none);
        }
        .compare-pane.overlay-mode {
            position: absolute !important;
            top: 0; left: 0; width: 100%; height: 100%;
            z-index: 10;
            background: transparent;
            border: none;
            opacity: 0;
            pointer-events: none; /* allow clicking through to left pane when overlaying */
        }
        .compare-pane.overlay-mode img {
            background: transparent !important;
            box-shadow: none !important;
        }
        .empty-state {
            position: absolute;
            inset: 0;
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            opacity: 0.3;
        }
        .empty-state svg { width: 5em; height: 5em; margin-bottom: 16px; display: inline-block; }
        .empty-state p { font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
        .empty-state code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 6px;
            font-size: 0.9em;
        }

        /* Dropdown styles */
        .dir-dropdown {
            position: absolute;
            top: 32px;
            right: 8px;
            background: var(--vscode-editorHoverWidget-background, #252526);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            border-radius: 6px;
            padding: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            display: none;
            flex-direction: row;
            align-items: center;
            gap: 6px;
            z-index: 1000;
            width: 400px;
            max-width: calc(100vw - 24px);
        }
        .dir-dropdown.open {
            display: flex;
        }
        .dir-input-wrapper {
            position: relative;
            flex: 1 1 0%;
            min-width: 0;
            display: flex;
            align-items: center;
        }
        .dir-dropdown input {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 4px 28px 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            outline: none;
            box-sizing: border-box;
        }
        .dir-dropdown input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .dir-dropdown input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .dir-dropdown .btn-browse {
            position: absolute;
            right: 2px;
            background: none;
            color: var(--vscode-icon-foreground);
            border: none;
            padding: 4px;
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0.7;
            flex-shrink: 0;
        }
        .dir-dropdown .btn-browse:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-textLink-foreground);
            opacity: 1;
        }
        .dir-dropdown .btn-browse svg {
            width: 14px;
            height: 14px;
        }
        .dir-dropdown .dir-btn {
            background: var(--vscode-button-background) !important;
            color: var(--vscode-button-foreground) !important;
            border: none;
            padding: 5px 0;
            width: 60px;
            text-align: center;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            font-weight: 500;
            flex-shrink: 0;
        }
        .dir-dropdown .dir-btn:hover {
            background: var(--vscode-button-hoverBackground) !important;
        }
        #btn-clear-dir {
            background: var(--vscode-button-secondaryHoverBackground) !important;
            color: var(--vscode-button-secondaryForeground) !important;
            transition: filter 0.2s;
        }
        #btn-clear-dir:hover {
            background: var(--vscode-button-secondaryHoverBackground) !important;
            filter: brightness(1.2);
        }
        .btn-custom-dir.active {
            color: var(--vscode-textLink-foreground) !important;
            opacity: 1 !important;
            background: var(--vscode-toolbar-hoverBackground) !important;
        }
        .export-dropdown {
            position: absolute;
            top: 32px;
            right: 48px;
            background: var(--vscode-editorHoverWidget-background, #252526);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            border-radius: 6px;
            padding: 12px;
            display: none;
            z-index: 1000;
            flex-direction: column;
            gap: 10px;
            width: 220px;
        }
        .export-dropdown.open {
            display: flex;
        }
        .compare-dropdown {
            font-size: calc(1em - 1px);
            width: max-content !important;
            right: 80px !important;
            padding: 12px 14px !important;
        }
        .compare-dropdown label {
            font-size: inherit !important;
        }
        .sync-zoom-label {
            display: flex !important;
            flex-direction: row;
            align-items: center;
            gap: 8px;
            margin-bottom: 0 !important;
            cursor: pointer;
        }
        .sync-zoom-checkbox {
            width: 13px !important;
            height: 13px !important;
            margin: 0 !important;
            flex-shrink: 0;
            cursor: pointer;
            accent-color: var(--vscode-textLink-foreground);
        }
        .overlay-slider-wrapper {
            display: inline-flex;
            flex-direction: column;
            width: max-content;
        }
        .overlay-slider-header {
            display: flex;
            gap: 4px;
            align-items: baseline;
            margin-bottom: 6px;
        }
        .overlay-val {
            font-variant-numeric: tabular-nums;
        }
        .export-dropdown label {
            font-size: 0.9em;
            opacity: 0.9;
            display: block;
            margin-bottom: 4px;
        }
        .export-dropdown select, .export-dropdown input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 4px 6px;
            border-radius: 4px;
            font-size: 0.9em;
            font-family: inherit;
            outline: none;
            width: 100%;
            box-sizing: border-box;
        }

        .export-modal {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            z-index: 9999;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }
        .export-modal.active {
            display: flex;
        }
        .export-modal-content {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            width: 90%;
            height: 90%;
            max-width: 1200px;
            max-height: 800px;
            overflow: hidden;
        }
        .export-modal-top-strip {
            padding: 8px 12px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        .export-modal-instruction {
            font-size: 0.85em;
            opacity: 0.9;
            text-align: left;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .export-modal-instruction .codicon {
            color: var(--vscode-textLink-foreground);
        }
        .export-modal-main-area {
            display: flex;
            flex-direction: row;
            flex: 1;
            min-height: 0;
        }
        .export-modal-body {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: var(--vscode-editor-background);
            position: relative;
            overflow: auto;
            padding: 8px;
        }
        .export-modal-sidebar {
            width: 90px;
            background: var(--vscode-editorHoverWidget-background, #252526);
            border-left: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            display: flex;
            flex-direction: column;
            padding: 8px;
            justify-content: space-between;
            overflow-y: auto;
            font-size: 0.9em;
        }
        .export-controls-vertical {
            display: flex;
            flex-direction: column;
            gap: clamp(6px, 2.5vh, 16px);
        }
        .control-group {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: clamp(2px, 0.8vh, 4px);
        }
        .export-modal-sidebar label {
            opacity: 0.8;
            text-align: left;
        }
        .export-modal-sidebar select, .export-modal-sidebar input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: inherit;
            font-family: inherit;
            outline: none;
            width: 100%;
            height: 26px;
            box-sizing: border-box;
        }
        .export-modal-sidebar select {
            padding: 4px 8px;
            cursor: pointer;
        }
        .export-modal-sidebar input {
            padding: 4px 8px 4px 12px;
        }
        .export-modal-sidebar input[type="number"] {
            -moz-appearance: textfield;
        }
        .export-modal-sidebar input[type="number"]::-webkit-inner-spin-button,
        .export-modal-sidebar input[type="number"]::-webkit-outer-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        .export-actions-vertical {
            display: flex;
            flex-direction: column;
            gap: clamp(4px, 1.5vh, 8px);
            margin-top: clamp(8px, 2vh, 16px);
        }
        .export-actions-vertical .btn-modal {
            flex: 1;
            padding: 6px 0;
            text-align: center;
            min-width: 0;
        }
        .preview-container {
            position: relative;
            overflow: visible;
            border: 1px dashed var(--vscode-focusBorder);
            border-radius: 8px;
            min-width: 20px;
            min-height: 20px;
            max-width: 100%;
            max-height: 100%;
            background: white;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        }
        .custom-resizer {
            position: absolute;
            bottom: -14px;
            right: -14px;
            width: 24px;
            height: 24px;
            cursor: se-resize;
            z-index: 10;
        }
        .custom-resizer::after {
            content: '';
            position: absolute;
            bottom: 6px;
            right: 6px;
            width: 8px;
            height: 8px;
            border-right: 3px solid var(--vscode-textLink-foreground);
            border-bottom: 3px solid var(--vscode-textLink-foreground);
            border-bottom-right-radius: 2px;
            opacity: 1;
        }
        .preview-container img {
            width: 100%;
            height: 100%;
            object-fit: fill;
            display: block;
            pointer-events: none;
            border-radius: 8px;
        }
        .preview-overlay {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(255,255,255,0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            color: #111;
            font-weight: bold;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s;
        }
        .preview-overlay.loading {
            opacity: 1;
        }
        .btn-modal {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: inherit;
            font-family: inherit;
        }
        .btn-modal:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-modal.secondary {
            background: var(--vscode-button-secondaryHoverBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-modal.secondary:hover {
            filter: brightness(1.2);
        }
    </style>
</head>
<body${this._isMinimized ? ' class="minimized"' : ''}>
    <div class="toolbar">
        <div class="nav-controls">
            <button id="btn-prev" disabled data-tooltip="Previous Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M11.354 1.646L12.061 2.354 6.414 8l5.647 5.646-.707.708L5 8l6.354-6.354z"/></svg></button>
            <span class="counter">-</span>
            <button id="btn-next" disabled data-tooltip="Next Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M4.646 1.646L3.939 2.354 9.586 8l-5.647 5.646.707.708L11 8 4.646 1.646z"/></svg></button>
            <button id="btn-zoom-in" disabled data-tooltip="Zoom In">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <circle cx="7" cy="7" r="6" />
                    <line x1="11.2" y1="11.2" x2="14.8" y2="14.8" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="4" y1="7" x2="10" y2="7" />
                    <line x1="7" y1="4" x2="7" y2="10" />
                </svg>
            </button>
            <button id="btn-zoom-out" disabled data-tooltip="Zoom Out">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <circle cx="7" cy="7" r="6" />
                    <line x1="11.2" y1="11.2" x2="14.8" y2="14.8" stroke-width="1.5" stroke-linecap="round"/>
                    <line x1="4" y1="7" x2="10" y2="7" />
                </svg>
            </button>
            <button id="btn-reset-zoom" disabled data-tooltip="Reset Zoom">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2">
                    <path d="M5 2H2v3 M11 2h3v3 M2 11v3h3 M14 11v3h-3" />
                    <circle cx="8" cy="8" r="2.5" />
                    <circle cx="8" cy="8" r="0.5" fill="currentColor" stroke="none" />
                </svg>
            </button>
            <button id="btn-copy" disabled data-tooltip="Copy Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M10,13.33H3.33V4.67c0-0.37-0.3-0.67-0.67-0.67h0C2.3,4,2,4.3,2,4.67v8.67c0,0.73,0.6,1.33,1.33,1.33h6.67c0.37,0,0.67-0.3,0.67-0.67v0C10.67,13.63,10.37,13.33,10,13.33z M13.33,10.67V2.67c0-0.73-0.6-1.33-1.33-1.33H6c-0.73,0-1.33,0.6-1.33,1.33v8c0,0.73,0.6,1.33,1.33,1.33h6c0.73,0,1.33-0.6,1.33-1.33z M12,10.67H6V2.67h6V10.67z"/></svg></button>
            <button id="btn-save" disabled data-tooltip="Preview & Export Plot"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12,10v2H4v-2H2.67v2c0,0.73,0.6,1.33,1.33,1.33h8c0.73,0,1.33-0.6,1.33-1.33v-2H12z M11.33,7.33l-0.94-0.94L8.67,8.11V2.67h-1.33v5.45L5.61,6.39L4.67,7.33l3.33,3.33 L11.33,7.33z"/></svg></button>
            <button id="btn-night-mode" disabled data-tooltip="Switch to Night Mode">${moonIcon}</button>
            <button id="btn-delete" disabled data-tooltip="Delete Current Plot"><svg viewBox="0 0 16 16"><path fill="none" d="M9.25,2H6.75a0.25,0.25,0,0,0-0.25,0.25V3h3V2.25A0.25,0.25,0,0,0,9.25,2Z"/><path fill="currentColor" d="M13.5,3H10.5V2.25A1.25,1.25,0,0,0,9.25,1H6.75A1.25,1.25,0,0,0,5.5,2.25V3H2.5a0.5,0.5,0,0,0,0,1H3L3.63,13.53C3.67,14.37,4.31,15,5.13,15h5.75c0.82,0,1.45-.62,1.5-1.47L13,4h0.5a0.5,0.5,0,0,0,0-1ZM6,13H6a0.5,0.5,0,0,1-.5-.48l-0.25-7a0.5,0.5,0,1,1,1-.04l0.25,7A0.5,0.5,0,0,1,6,13ZM8.5,12.5a0.5,0.5,0,0,1-1,0V5.5a0.5,0.5,0,0,1,1,0ZM9.5,3H6.5V2.25a0.25,0.25,0,0,1,.25-.25h2.5a0.25,0.25,0,0,1,.25.25Zm1,9.55a0.5,0.5,0,0,1-.5.45H10a0.5,0.5,0,0,1-.5-.52l0.25-7a0.5,0.5,0,1,1,1,.04Z"/></svg></button>
            <button id="btn-clear" disabled data-tooltip="Clear All Plots"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M12.91,1.81L13.85,2.76L10.04,6.57C10.75,7.59 10.85,8.83 10.25,9.63L6.04,5.41C6.84,4.81 8.07,4.91 9.1,5.63L12.91,1.81M3.95,11.71C2.61,10.37 1.79,8.77 1.57,7.28L4.82,5.89L9.78,10.85L8.39,14.1C6.89,13.87 5.29,13.05 3.95,11.71Z"/></svg></button>
            <div id="compare-btn-group" class="btn-group">
                <button id="btn-compare" disabled data-tooltip="Enter Compare Mode"><svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h5v12H2V2zm7 0h5v12H9V2z"/></svg></button>
                <button id="btn-compare-options" style="display: none;" data-tooltip="Compare Options"><svg viewBox="0 0 16 16"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/></svg></button>
            </div>
            <button id="btn-custom-dir" class="btn-custom-dir" data-tooltip="Set Custom Plot Directory"><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m7.52 2c-0.00591-2.1e-4 -0.0118-3.1e-4 -0.0178-3.1e-4l-1.2-1.6c-0.0932-0.124-0.214-0.225-0.353-0.294-0.139-0.0694-0.292-0.106-0.447-0.106h-3.5c-0.53 0-1.04 0.211-1.41 0.586-0.375 0.375-0.586 0.884-0.586 1.41v10c0 0.53 0.211 1.04 0.586 1.41 0.375 0.375 0.884 0.586 1.41 0.586h4v-1h-4c-0.265 0-0.52-0.105-0.707-0.293-0.188-0.188-0.293-0.442-0.293-0.707v-7l3.88 3e-5c0.203 1.9e-4 0.383 3.5e-4 0.557-0.0415 0.153-0.0368 0.299-0.0974 0.434-0.18 0.153-0.0936 0.279-0.221 0.423-0.365l1.41-1.41h6.29c0.265 0 0.52 0.105 0.707 0.293s0.293 0.442 0.293 0.707v2h1v-2c0-0.53-0.211-1.04-0.586-1.41s-0.884-0.586-1.41-0.586h-6.48zm-2.02-1 1.2 1.6-1.08 1.08c-0.19 0.19-0.229 0.225-0.268 0.248-0.0447 0.0274-0.0935 0.0476-0.145 0.0599-0.0442 0.0106-0.0969 0.0138-0.365 0.0138h-3.84v-2c0-0.265 0.105-0.52 0.293-0.707 0.188-0.188 0.442-0.293 0.707-0.293h3.5z" clip-rule="evenodd" fill="currentColor" fill-rule="evenodd"/><path d="m11.5 7c0.276 0 0.5 0.224 0.5 0.5v3.5h3.5c0.276 0 0.5 0.224 0.5 0.5s-0.224 0.5-0.5 0.5h-3.5v3.5c0 0.276-0.224 0.5-0.5 0.5s-0.5-0.224-0.5-0.5v-3.5h-3.5c-0.276 0-0.5-0.224-0.5-0.5s0.224-0.5 0.5-0.5h3.5v-3.5c0-0.276 0.224-0.5 0.5-0.5z" fill="currentColor"/></svg></button>
            <button id="btn-popout" data-tooltip="${isPoppedOut ? 'Restore to Side Panel' : 'Pop-out to Main Editor'}"><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/><path d="M15 1.5V6h-1V2.707L7.854 8.854l-.708-.708L13.293 2H10V1h4.5l.5.5z"/></svg></button>
        </div>
    </div>
    <div id="dir-dropdown" class="dir-dropdown">
        <div class="dir-input-wrapper">
            <input type="text" id="dir-input" placeholder="Custom directory (absolute or relative)..." value="" />
            <button id="btn-browse" class="btn-browse" data-tooltip="Browse for Folder"><svg fill="none" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="m14 3h-6.5l-1.2-1.6c-0.0932-0.124-0.214-0.225-0.353-0.294-0.139-0.0694-0.292-0.106-0.447-0.106h-3.5c-0.53 0-1.04 0.211-1.41 0.586-0.375 0.375-0.586 0.884-0.586 1.41v10c0 0.53 0.211 1.04 0.586 1.41 0.375 0.375 0.884 0.586 1.41 0.586h12c0.53 0 1.04-0.211 1.41-0.586s0.586-0.884 0.586-1.41v-8c0-0.53-0.211-1.04-0.586-1.41-0.375-0.375-0.884-0.586-1.41-0.586zm-7.3 0.6c0.0932 0.124 0.214 0.225 0.353 0.294 0.139 0.0694 0.292 0.106 0.447 0.106h6.5c0.265 0 0.52 0.105 0.707 0.293 0.188 0.188 0.293 0.442 0.293 0.707v8c0 0.265-0.105 0.52-0.293 0.707s-0.442 0.293-0.707 0.293h-12c-0.265 0-0.52-0.105-0.707-0.293-0.188-0.188-0.293-0.442-0.293-0.707v-10c0-0.265 0.105-0.52 0.293-0.707 0.188-0.188 0.442-0.293 0.707-0.293h3.5l1.2 1.6z" fill="currentColor"/></svg></button>
        </div>
        <button id="btn-clear-dir" class="dir-btn">Clear</button>
        <button id="btn-set-out-view-dir" class="dir-btn">Set</button>
    </div>
    <div id="export-modal" class="export-modal">
        <div class="export-modal-content">
            <div class="export-modal-top-strip">
                <div class="export-modal-instruction">
                    <i class="codicon codicon-info"></i>
                    Drag the bottom-right corner of the plot below to find your best aspect ratio.
                </div>
            </div>
            <div class="export-modal-main-area">
                <div class="export-modal-body">
                    <div id="preview-container" class="preview-container">
                        <img id="preview-img" src="" alt="Plot Preview" />
                        <div id="preview-overlay" class="preview-overlay">Rendering&hellip;</div>
                        <div id="custom-resizer" class="custom-resizer"></div>
                    </div>
                </div>
                <div class="export-modal-sidebar">
                    <div class="export-controls-vertical">
                        <div class="control-group">
                            <label>Format</label>
                            <select id="export-format">
                                <option value="pdf">PDF</option>
                                <option value="svg">SVG</option>
                                <option value="eps">EPS</option>
                                <option value="png">PNG</option>
                                <option value="jpg">JPG</option>
                            </select>
                        </div>
                        <div class="control-group">
                            <label>Unit</label>
                            <select id="export-unit">
                                <option value="in">in</option>
                                <option value="px">px</option>
                            </select>
                        </div>
                        <div class="control-group">
                            <label>Width</label>
                            <input type="number" step="any" id="export-width" value="8" />
                        </div>
                        <div class="control-group">
                            <label>Height</label>
                            <input type="number" step="any" id="export-height" value="6" />
                        </div>
                    </div>
                    <div class="export-actions-vertical">
                        <div id="export-filesize" style="margin-bottom: 8px; opacity: 0.8; text-align: center;">...</div>
                        <button id="btn-export-cancel" class="btn-modal secondary">Cancel</button>
                        <button id="btn-export-confirm" class="btn-modal">Export</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div id="compare-dropdown" class="export-dropdown compare-dropdown">
        <label id="sync-zoom-label" for="chk-sync-zoom" class="sync-zoom-label">
            <input type="checkbox" id="chk-sync-zoom" checked class="sync-zoom-checkbox" />
            <span>Sync Zoom & Pan</span>
        </label>
        <div class="overlay-slider-wrapper">
            <div class="overlay-slider-header">
                <span>Overlay Transparency:</span>
                <span id="overlay-val" class="overlay-val">0%</span>
            </div>
            <input type="range" id="overlay-slider" min="0" max="1" step="0.01" value="0" />
        </div>
    </div>
    <div id="tooltip" class="tooltip"></div>
    <div class="main-container">
        <div class="plot-area" id="plot-area" style="position: relative;">
            <div class="plot-viewport">
                <img id="main-image" src="" alt="Plot" style="display: none;" />
                <div id="compare-view" class="compare-view">
                    <div id="compare-left" class="compare-pane" data-side="left">
                        <img id="img-left" src="" />
                    </div>
                    <div id="compare-right" class="compare-pane" data-side="right">
                        <img id="img-right" src="" />
                    </div>
                </div>
                <div id="empty-state" class="empty-state">
                    <svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h1v11h11v1H2V2zm3 8h2v3H5v-3zm3-4h2v7H8V6zm3-3h2v10h-2V3z"/></svg>
                    <p>No plots yet.<br/>
                    Plots generated in the R Console or found in your<br/>
                    custom directory will automatically appear here.</p>
                </div>
            </div>
        </div>
        <div class="thumbnail-sidebar" id="thumbnail-sidebar"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let isPoppedOut = ${isPoppedOut};

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateState') {
                renderState(message.state);
            } else if (message.command === 'setMinimized') {
                document.body.classList.toggle('minimized', message.minimized);
                if (!message.minimized && lastState) {
                    window.__suppressPlotResizeUntil = Date.now() + 700;
                    document.body.classList.add('pane-restoring');
                    setTimeout(() => document.body.classList.remove('pane-restoring'), 350);
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => renderState(lastState));
                    });
                }
            } else if (message.type === 'previewRendered') {
                if (message.requestId !== undefined && message.requestId < latestPreviewRequestId) return;
                const previewImg = document.getElementById('preview-img');
                const previewOverlay = document.getElementById('preview-overlay');
                const fileSizeDiv = document.getElementById('export-filesize');
                if (previewImg && message.src) {
                    previewImg.src = message.src + '?t=' + Date.now();
                    previewImg.style.visibility = 'visible';
                }
                if (fileSizeDiv && message.fileSize) {
                    fileSizeDiv.textContent = '~ ' + message.fileSize;
                }
                if (previewOverlay) previewOverlay.classList.remove('loading');
            }
        });

        const moonIcon = \`${moonIcon}\`;
        const sunIcon = \`${sunIcon}\`;

        const initialState = {
            plots: ${JSON.stringify(this._plots.map(uri => webview.asWebviewUri(uri).toString() + '?t=' + Date.now()))},
            currentIndex: ${this._currentIndex},
            isNightMode: ${this._isNightMode},
            minimized: ${this._isMinimized},
            customPlotDir: ${JSON.stringify(this._customPlotDir || '')},
            defaultDir: ${JSON.stringify(defaultDir)},
            lastDirAction: ${JSON.stringify(this._lastDirAction || null)},
            isPoppedOut: isPoppedOut
        };

        let lastState = initialState;
        let currentPlots = [];
        let currentImageSrc = '';

        let isCompareMode = false;
        let compareLeftIndex = -1;
        let compareRightIndex = -1;
        let activeCompareSide = 'left';
        let isSyncZoom = true;
        let lastBackendIndex = -1;
        let latestPreviewRequestId = 0;

        let transformState = {
            main: { scale: 1, translateX: 0, translateY: 0 },
            left: { scale: 1, translateX: 0, translateY: 0 },
            right: { scale: 1, translateX: 0, translateY: 0 }
        };

        function updateTransform() {
            const plotArea = document.getElementById('plot-area');
            if (!isCompareMode) {
                const img = document.getElementById('main-image');
                if (img) img.style.transform = 'translate(' + transformState.main.translateX + 'px, ' + transformState.main.translateY + 'px) scale(' + transformState.main.scale + ')';
                if (plotArea) plotArea.classList.toggle('zoomed', transformState.main.scale > 1.001);
            } else {
                const imgLeft = document.getElementById('img-left');
                const imgRight = document.getElementById('img-right');
                if (imgLeft) imgLeft.style.transform = 'translate(' + transformState.left.translateX + 'px, ' + transformState.left.translateY + 'px) scale(' + transformState.left.scale + ')';
                if (imgRight) imgRight.style.transform = 'translate(' + transformState.right.translateX + 'px, ' + transformState.right.translateY + 'px) scale(' + transformState.right.scale + ')';
                if (plotArea) plotArea.classList.toggle('zoomed', transformState.left.scale > 1.001 || transformState.right.scale > 1.001);
            }
        }

        function resetZoom() {
            transformState.main = { scale: 1, translateX: 0, translateY: 0 };
            transformState.left = { scale: 1, translateX: 0, translateY: 0 };
            transformState.right = { scale: 1, translateX: 0, translateY: 0 };
            updateTransform();
        }

        function setInitialComparePair(index, plotCount) {
            compareLeftIndex = index;
            if (plotCount <= 1) {
                compareRightIndex = index;
            } else if (index < plotCount - 1) {
                compareRightIndex = index + 1;
            } else {
                compareRightIndex = index - 1;
            }
        }

        function requestPlotRerenderAtIndex(index, container) {
            if (document.body.classList.contains('minimized')) return;
            if (Date.now() < window.__suppressPlotResizeUntil) return;
            if (!lastState || !lastState.plots || index < 0 || index >= lastState.plots.length) return;
            if (!container || container.clientWidth <= 20 || container.clientHeight <= 20) return;

            const url = lastState.plots[index];
            if (!url || url.includes('_interactive.svg')) return;

            vscode.postMessage({
                type: 'resizePlot',
                index: index,
                width: container.clientWidth,
                height: container.clientHeight,
                pixelRatio: Math.min(Math.max(window.devicePixelRatio || 1, 1), 2.5)
            });
        }

        function requestVisibleCompareRerenders() {
            if (!isCompareMode) return;
            const plotArea = document.getElementById('plot-area');
            requestPlotRerenderAtIndex(compareLeftIndex, plotArea);
            requestPlotRerenderAtIndex(compareRightIndex, plotArea);
        }

        function renderState(state) {
            lastState = state;
            document.body.classList.toggle('minimized', !!state.minimized);
            const hasPlots = state.plots.length > 0;

            if (state.plots.length !== currentPlots.length || state.currentIndex !== lastBackendIndex) {
                if (isCompareMode) {
                    if (activeCompareSide === 'left') compareLeftIndex = state.currentIndex;
                    else compareRightIndex = state.currentIndex;
                } else {
                    setInitialComparePair(state.currentIndex, state.plots.length);
                }
            }
            lastBackendIndex = state.currentIndex;

            const mainImg = document.getElementById('main-image');
            const emptyState = document.getElementById('empty-state');
            const plotArea = document.getElementById('plot-area');
            document.body.classList.toggle('night-mode', state.isNightMode);

            function getInteractiveSvgUri(isNightMode, isThumbnail = false, width = 800, height = 600) {
                const linkColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-textLink-foreground').trim() || '#007acc';
                const bgColor = '#151515';
                const dotColor = '#2d2d2d';

                const w = Math.round(width) || 800;
                const h = Math.round(height) || 600;

                if (isThumbnail) {
                    const fontSize = "65";
                    const iconTransform = "translate(330.88, 124) scale(8.64)";
                    const y1 = "356";
                    const y2 = "469";
                    const svgStr = '<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">' +
                        '<defs><pattern id="dot-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.5" fill="' + dotColor + '"/></pattern></defs>' +
                        '<rect width="800" height="600" rx="8" ry="8" fill="' + bgColor + '"/>' +
                        '<rect x="20" y="20" width="760" height="560" rx="8" ry="8" fill="url(#dot-grid)"/>' +
                        '<g fill="' + linkColor + '" transform="' + iconTransform + '">' +
                            '<path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/><path d="M15 1.5V6h-1V2.707L7.854 8.854l-.708-.708L13.293 2H10V1h4.5l.5.5z"/>' +
                        '</g>' +
                        '<text x="400" y="' + y1 + '" fill="' + linkColor + '" font-family="sans-serif" font-weight="normal" font-size="' + fontSize + '" text-anchor="middle">Open</text>' +
                        '<text x="400" y="' + y2 + '" fill="' + linkColor + '" font-family="sans-serif" font-weight="normal" font-size="' + fontSize + '" text-anchor="middle">Interactive Widget(s)</text>' +
                    '</svg>';
                    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
                } else {
                    let scale = 0.8;
                    let upperW = 120, upperH = 140, upperY = -100;
                    let lowerW = 280, lowerH = 60, lowerY = 40;
                    let padX = 20, padY = 20;

                    if (w < 360) {
                        scale = 0.48;
                        upperW = 60; upperH = 80; upperY = -60;
                        lowerW = 140; lowerH = 40; lowerY = 20;
                        padX = 0; padY = 0;
                    } else if (w < 450) {
                        scale = 0.64;
                        upperW = 60; upperH = 100; upperY = -60;
                        lowerW = 180; lowerH = 40; lowerY = 40;
                        padX = 0; padY = 0;
                    } else if (w < 600) {
                        scale = 0.72;
                        upperW = 100; upperH = 120; upperY = -80;
                        lowerW = 220; lowerH = 40; lowerY = 40;
                        padX = 20; padY = 20;
                    }

                    let N = Math.floor((w - 2 * padX) / 20);
                    if (scale === 0.8) {
                        if (N % 2 !== 0) N -= 1;
                    } else {
                        if (N % 2 === 0) N -= 1;
                    }
                    const gridW = Math.max(0, N * 20);

                    let M = Math.floor((h - 2 * padY) / 20);
                    if (M % 2 !== 0) M -= 1;
                    const gridH = Math.max(0, M * 20);

                    const gridX = (w - gridW) / 2;
                    const gridY = (h - gridH) / 2;

                    const cx = gridX + gridW / 2;
                    const cy = gridY + gridH / 2;

                    const svgStr = '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' +
                        '<defs><pattern id="dot-grid" width="20" height="20" patternUnits="userSpaceOnUse" x="' + gridX + '" y="' + gridY + '"><circle cx="10" cy="10" r="1.5" fill="' + dotColor + '"/></pattern></defs>' +
                        '<rect width="' + w + '" height="' + h + '" rx="8" ry="8" fill="' + bgColor + '"/>' +
                        '<rect x="' + gridX + '" y="' + gridY + '" width="' + gridW + '" height="' + gridH + '" rx="8" ry="8" fill="url(#dot-grid)"/>' +
                        '<rect x="' + (cx - upperW / 2) + '" y="' + (cy + upperY) + '" width="' + upperW + '" height="' + upperH + '" fill="' + bgColor + '"/>' +
                        '<rect x="' + (cx - lowerW / 2) + '" y="' + (cy + lowerY) + '" width="' + lowerW + '" height="' + lowerH + '" fill="' + bgColor + '"/>' +
                        '<g transform="translate(' + cx + ', ' + cy + ')">' +
                            '<g transform="scale(' + scale + ')">' +
                                '<g fill="' + linkColor + '" transform="translate(-48, -100) scale(6)">' +
                                    '<path d="M1.5 1H6v1H2v12h12v-4h1v4.5l-.5.5h-13l-.5-.5v-13l.5-.5z"/><path d="M15 1.5V6h-1V2.707L7.854 8.854l-.708-.708L13.293 2H10V1h4.5l.5.5z"/>' +
                                '</g>' +
                                '<text x="0" y="38" fill="' + linkColor + '" font-family="sans-serif" font-weight="normal" font-size="30" text-anchor="middle">Open</text>' +
                                '<text x="0" y="90" fill="' + linkColor + '" font-family="sans-serif" font-weight="normal" font-size="30" text-anchor="middle">Interactive Widget(s)</text>' +
                            '</g>' +
                        '</g>' +
                    '</svg>';
                    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
                }
            }

            if (isCompareMode) {
                document.getElementById('main-image').style.display = 'none';
                document.getElementById('compare-view').style.display = 'flex';
                document.getElementById('btn-compare').setAttribute('data-tooltip', 'Exit Compare Mode');
                document.getElementById('btn-compare').classList.add('active');
                document.getElementById('btn-compare').style.color = 'var(--vscode-textLink-foreground)';
                document.getElementById('btn-compare-options').style.display = 'flex';
                document.getElementById('compare-btn-group').classList.add('active');
            } else {
                document.getElementById('main-image').style.display = hasPlots ? 'block' : 'none';
                document.getElementById('compare-view').style.display = 'none';
                document.getElementById('btn-compare').setAttribute('data-tooltip', 'Enter Compare Mode');
                document.getElementById('btn-compare').classList.remove('active');
                document.getElementById('btn-compare').style.color = '';
                document.getElementById('btn-compare-options').style.display = 'none';
                document.getElementById('compare-btn-group').classList.remove('active');
            }

            if (hasPlots) {
                let themeChanged = window.__lastNightMode !== state.isNightMode;
                if (!isCompareMode) {
                    const originalSrc = state.plots[state.currentIndex];
                    const isInteractive = originalSrc.includes('_interactive.svg');
                    const plotW = plotArea.clientWidth;
                    const plotH = plotArea.clientHeight;
                    const hasStableInteractiveSize = plotW > 20 && plotH > 20;
                    const newSrc = isInteractive && hasStableInteractiveSize ? getInteractiveSvgUri(state.isNightMode, false, plotW, plotH) : originalSrc;

                    let srcChanged = currentImageSrc !== originalSrc;
                    if (isInteractive && !hasStableInteractiveSize) {
                        currentImageSrc = originalSrc;
                    } else if (srcChanged || (isInteractive && themeChanged) || (isInteractive && mainImg.getAttribute('src') !== newSrc)) {
                        currentImageSrc = originalSrc;
                        mainImg.src = newSrc;
                        if (srcChanged) resetZoom();

                        // Dynamically request re-render for this specific plot if it's new
                        // to ensure it matches the current window dimensions.
                        if (srcChanged && typeof triggerRerender === 'function') {
                            clearTimeout(window._plotSwitchTimeout);
                            window._plotSwitchTimeout = setTimeout(() => {
                                triggerRerender();
                            }, 400);
                        }

                        if (isInteractive) {
                            mainImg.removeAttribute('data-tooltip');
                            mainImg.style.cursor = 'pointer';
                            mainImg.style.pointerEvents = 'auto';
                            mainImg.classList.add('is-interactive');
                        } else {
                            mainImg.removeAttribute('data-tooltip');
                            mainImg.style.cursor = '';
                            mainImg.style.pointerEvents = 'none';
                            mainImg.classList.remove('is-interactive');
                        }
                    }
                } else {
                    const lUrl = state.plots[compareLeftIndex] || state.plots[0];
                    const rUrl = state.plots[compareRightIndex] || state.plots[0];
                    const leftPane = document.getElementById('compare-left');
                    const rightPane = document.getElementById('compare-right');
                    const lSrc = lUrl.includes('_interactive.svg') && leftPane.clientWidth > 20 && leftPane.clientHeight > 20 ? getInteractiveSvgUri(state.isNightMode, false, leftPane.clientWidth, leftPane.clientHeight) : lUrl;
                    const rSrc = rUrl.includes('_interactive.svg') && rightPane.clientWidth > 20 && rightPane.clientHeight > 20 ? getInteractiveSvgUri(state.isNightMode, false, rightPane.clientWidth, rightPane.clientHeight) : rUrl;

                    const imgLeft = document.getElementById('img-left');
                    const imgRight = document.getElementById('img-right');
                    leftPane.classList.toggle('active-left', activeCompareSide === 'left');
                    leftPane.classList.remove('active-right');
                    rightPane.classList.toggle('active-right', activeCompareSide === 'right');
                    rightPane.classList.remove('active-left');

                    if (imgLeft.getAttribute('src') !== lSrc) {
                        imgLeft.src = lSrc;
                    }
                    if (lUrl.includes('_interactive.svg')) imgLeft.classList.add('is-interactive');
                    else imgLeft.classList.remove('is-interactive');

                    if (imgRight.getAttribute('src') !== rSrc) {
                        imgRight.src = rSrc;
                    }
                    if (rUrl.includes('_interactive.svg')) imgRight.classList.add('is-interactive');
                    else imgRight.classList.remove('is-interactive');

                    requestVisibleCompareRerenders();
                }

                window.__lastNightMode = state.isNightMode;
                emptyState.style.display = 'none';
            } else {
                currentImageSrc = '';
                mainImg.style.display = 'none';
                document.getElementById('compare-view').style.display = 'none';
                emptyState.style.display = 'flex';
                resetZoom();
            }

            const sidebar = document.getElementById('thumbnail-sidebar');
            let themeChangedThumb = window.__lastNightModeThumb !== state.isNightMode;
            window.__lastNightModeThumb = state.isNightMode;

            while (sidebar.children.length > state.plots.length) {
                sidebar.removeChild(sidebar.lastChild);
            }
            while (sidebar.children.length < state.plots.length) {
                const img = document.createElement('img');
                img.className = 'thumbnail';
                img.onerror = function() {
                    if (!this.dataset.retried) {
                        this.dataset.retried = 'true';
                        setTimeout(() => this.src = this.dataset.originalSrc, 200);
                    }
                };
                sidebar.appendChild(img);
            }
            currentPlots = state.plots;

            const thumbs = sidebar.querySelectorAll('.thumbnail');
            thumbs.forEach((t, i) => {
                const url = state.plots[i];
                const thumbUrl = url.includes('_interactive.svg') ? getInteractiveSvgUri(state.isNightMode, true) : url;

                if (t.getAttribute('src') !== thumbUrl || (themeChangedThumb && url.includes('_interactive.svg'))) {
                    t.dataset.originalSrc = thumbUrl;
                    t.setAttribute('src', thumbUrl);
                    delete t.dataset.retried;
                }
                if (url.includes('_interactive.svg')) t.classList.add('is-interactive');
                else t.classList.remove('is-interactive');

                t.dataset.index = i;

                if (isCompareMode) {
                    if (i === compareLeftIndex || i === compareRightIndex) {
                        t.classList.add('active');
                        if (i === compareLeftIndex && i === compareRightIndex) t.style.borderColor = 'var(--vscode-focusBorder)';
                        else if (i === compareLeftIndex) t.style.borderColor = 'var(--vscode-charts-blue, #3794ff)';
                        else t.style.borderColor = 'var(--vscode-charts-purple, #b146c2)';
                    } else {
                        t.classList.remove('active');
                        t.style.borderColor = '';
                    }
                } else {
                    t.style.borderColor = '';
                    if (i === state.currentIndex) t.classList.add('active');
                    else t.classList.remove('active');
                }
            });

            const activeThumb = sidebar.querySelector('.thumbnail.active');
            if (activeThumb) {
                const sidebarRect = sidebar.getBoundingClientRect();
                const thumbRect = activeThumb.getBoundingClientRect();
                if (thumbRect.top < sidebarRect.top || thumbRect.bottom > sidebarRect.bottom) {
                    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }

            document.querySelector('.counter').textContent = hasPlots ? (state.currentIndex + 1) + ' / ' + state.plots.length : '-';

            const toggleDisabled = (id, condition) => {
                const btn = document.getElementById(id);
                if (btn) {
                    if (condition) btn.setAttribute('disabled', 'true');
                    else btn.removeAttribute('disabled');
                }
            };

            const isWidget = hasPlots && state.plots[state.currentIndex] && state.plots[state.currentIndex].includes('_interactive.svg');
            let hasWidgetInView = false;
            if (isCompareMode) {
                const lUrl = state.plots[compareLeftIndex] || "";
                const rUrl = state.plots[compareRightIndex] || "";
                hasWidgetInView = lUrl.includes('_interactive.svg') || rUrl.includes('_interactive.svg');
            } else {
                hasWidgetInView = isWidget;
            }

            if (!isCompareMode) {
                if (state.currentIndex <= 0) toggleDisabled('btn-prev', true);
                else toggleDisabled('btn-prev', false);
                if (state.currentIndex >= state.plots.length - 1 || !hasPlots) toggleDisabled('btn-next', true);
                else toggleDisabled('btn-next', false);
            } else {
                toggleDisabled('btn-prev', true);
                toggleDisabled('btn-next', true);
            }

            toggleDisabled('btn-zoom-in', !hasPlots || hasWidgetInView);
            toggleDisabled('btn-zoom-out', !hasPlots || hasWidgetInView);
            toggleDisabled('btn-reset-zoom', !hasPlots || hasWidgetInView);
            toggleDisabled('btn-copy', !hasPlots || isCompareMode || hasWidgetInView);
            toggleDisabled('btn-save', !hasPlots || isCompareMode || hasWidgetInView);
            toggleDisabled('btn-compare', !hasPlots || state.plots.length < 1);
            if (!hasPlots || state.plots.length < 1) {
                document.getElementById('compare-btn-group')?.classList.add('disabled');
            } else {
                document.getElementById('compare-btn-group')?.classList.remove('disabled');
            }
            toggleDisabled('btn-night-mode', !hasPlots);
            toggleDisabled('btn-delete', !hasPlots || isWidget || isCompareMode);
            toggleDisabled('btn-clear', !hasPlots || isCompareMode);

            const nightModeBtn = document.getElementById('btn-night-mode');
            if(nightModeBtn) {
                nightModeBtn.innerHTML = state.isNightMode ? sunIcon : moonIcon;
                nightModeBtn.setAttribute('data-tooltip', state.isNightMode ? 'Switch to Day Mode' : 'Switch to Night Mode');
            }

            const btnCustomDir = document.getElementById('btn-custom-dir');
            if (btnCustomDir) {
                if (state.customPlotDir) btnCustomDir.classList.add('active');
                else btnCustomDir.classList.remove('active');
            }

            const dirInput = document.getElementById('dir-input');
            if (dirInput) {
                dirInput.value = state.customPlotDir || '';
                dirInput.placeholder = state.defaultDir || 'Custom plot directory...';
            }

            const btnSetOutViewDir = document.getElementById('btn-set-out-view-dir');
            if (btnSetOutViewDir) btnSetOutViewDir.classList.toggle('active', state.lastDirAction === 'outview' || !state.lastDirAction);

            if (state.isPoppedOut !== undefined) {
                isPoppedOut = state.isPoppedOut;
                const btnPopout = document.getElementById('btn-popout');
                if (btnPopout) {
                    btnPopout.setAttribute('data-tooltip', isPoppedOut ? 'Restore to Side Panel' : 'Pop-out to Main Editor');
                }
            }
        }

            renderState(initialState);

            document.getElementById('thumbnail-sidebar')?.addEventListener('click', (e) => {
                if (e.target && e.target.classList.contains('thumbnail')) {
                    const index = parseInt(e.target.getAttribute('data-index'), 10);
                    if (isCompareMode) {
                        if (activeCompareSide === 'left') compareLeftIndex = index;
                        else compareRightIndex = index;

                        renderState({ plots: currentPlots, currentIndex: lastBackendIndex, isNightMode: window.__lastNightMode });
                    } else {
                        vscode.postMessage({ type: 'navigateTo', index: index });
                    }
                }
            });

            const compareDropdown = document.getElementById('compare-dropdown');
            const btnCompareOptions = document.getElementById('btn-compare-options');

            document.getElementById('btn-compare')?.addEventListener('click', () => {
                if (!document.getElementById('btn-compare').hasAttribute('disabled')) {
                    isCompareMode = !isCompareMode;
                    if (isCompareMode) {
                        activeCompareSide = 'left';
                        setInitialComparePair(lastBackendIndex, currentPlots.length);
                    } else {
                        compareDropdown.classList.remove('open');
                        document.getElementById('overlay-slider').value = 0;
                        const valLabel = document.getElementById('overlay-val');
                        if (valLabel) valLabel.textContent = '0%';
                        document.getElementById('compare-view').classList.remove('overlay-active');
                        document.getElementById('compare-right').classList.remove('overlay-mode');
                        document.getElementById('compare-right').style.opacity = '1';
                    }
                    resetZoom();
                    renderState({ plots: currentPlots, currentIndex: lastBackendIndex, isNightMode: window.__lastNightMode });
                }
            });

            btnCompareOptions?.addEventListener('click', (e) => {
                e.stopPropagation();
                compareDropdown.classList.toggle('open');
                document.getElementById('dir-dropdown')?.classList.remove('open');
                document.getElementById('export-dropdown')?.classList.remove('open');
            });

            document.getElementById('chk-sync-zoom')?.addEventListener('change', (e) => {
                isSyncZoom = e.target.checked;
                if (isSyncZoom) {
                    transformState.right = JSON.parse(JSON.stringify(transformState.left));
                    updateTransform();
                }
            });

            document.getElementById('overlay-slider')?.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                const percentage = Math.round(val * 100);
                const valLabel = document.getElementById('overlay-val');
                if (valLabel) valLabel.textContent = percentage + '%';

                const rightPane = document.getElementById('compare-right');
                const compareView = document.getElementById('compare-view');
                if (val > 0) {
                    compareView.classList.add('overlay-active');
                    rightPane.classList.add('overlay-mode');
                    rightPane.style.opacity = val.toString();
                } else {
                    compareView.classList.remove('overlay-active');
                    rightPane.classList.remove('overlay-mode');
                    rightPane.style.opacity = '1';
                }
            });

            document.getElementById('compare-left')?.addEventListener('mousedown', () => {
                activeCompareSide = 'left';
                renderState({ plots: currentPlots, currentIndex: lastBackendIndex, isNightMode: window.__lastNightMode });
            });

            document.getElementById('compare-right')?.addEventListener('mousedown', () => {
                activeCompareSide = 'right';
                renderState({ plots: currentPlots, currentIndex: lastBackendIndex, isNightMode: window.__lastNightMode });
            });

            document.getElementById('btn-prev')?.addEventListener('click', () => {
                if (!document.getElementById('btn-prev').hasAttribute('disabled')) vscode.postMessage({ type: 'navigatePrev' });
            });
            document.getElementById('btn-next')?.addEventListener('click', () => {
                if (!document.getElementById('btn-next').hasAttribute('disabled')) vscode.postMessage({ type: 'navigateNext' });
            });
            document.getElementById('btn-clear')?.addEventListener('click', () => {
                if (!document.getElementById('btn-clear').hasAttribute('disabled')) vscode.postMessage({ type: 'clear' });
            });
            document.getElementById('btn-delete')?.addEventListener('click', () => {
                if (!document.getElementById('btn-delete').hasAttribute('disabled')) vscode.postMessage({ type: 'deleteCurrent' });
            });

            const btnSave = document.getElementById('btn-save');
            const exportModal = document.getElementById('export-modal');
            const btnExportCancel = document.getElementById('btn-export-cancel');
            const formatSelect = document.getElementById('export-format');
            const unitSelect = document.getElementById('export-unit');
            const widthInput = document.getElementById('export-width');
            const heightInput = document.getElementById('export-height');
            const fileSizeDiv = document.getElementById('export-filesize');
            const previewContainer = document.getElementById('preview-container');
            const previewOverlay = document.getElementById('preview-overlay');

            let previewDebounceTimer;
            let currentUnit = unitSelect ? unitSelect.value : 'in';
            let isSyncingUI = false;
            let currentPreviewScale = 1;

            function clearPreview() {
                const previewImg = document.getElementById('preview-img');
                if (previewImg) {
                    previewImg.removeAttribute('src');
                    previewImg.style.visibility = 'hidden';
                }
                if (fileSizeDiv) fileSizeDiv.textContent = 'calculating...';
            }

            btnSave?.addEventListener('click', (e) => {
                if (!btnSave.hasAttribute('disabled')) {
                    e.stopPropagation();
                    exportModal.classList.add('active');
                    clearPreview();
                    isSyncingUI = true;
                    // Always reset to safe default dimensions when opening
                    if (currentUnit === 'px') {
                        widthInput.value = '2400';
                        heightInput.value = '1800';
                    } else {
                        widthInput.value = '8';
                        heightInput.value = '6';
                    }
                    syncPreviewContainer();
                    isSyncingUI = false;
                }
            });

            btnExportCancel?.addEventListener('click', () => {
                exportModal.classList.remove('active');
                clearTimeout(previewDebounceTimer);
                if (previewOverlay) previewOverlay.classList.remove('loading');
                clearPreview();
            });

            window.addEventListener('resize', () => {
                if (exportModal.classList.contains('active')) {
                    isSyncingUI = true;
                    syncPreviewContainer();
                    setTimeout(() => isSyncingUI = false, 50);
                }
            });

            function syncPreviewContainer() {
                let w = parseFloat(widthInput.value) || 8;
                let h = parseFloat(heightInput.value) || 6;

                // Enforce minimum bounds for image fidelity and R rendering stability
                let minW = 5, minH = 5;
                if (currentUnit === 'px') { minW = 500; minH = 500; }

                if (w < minW) { w = minW; widthInput.value = w.toString(); }
                if (h < minH) { h = minH; heightInput.value = h.toString(); }

                let uiW, uiH;
                if (currentUnit === 'px') {
                    uiW = w * 0.5;
                    uiH = h * 0.5;
                } else {
                    uiW = w * 100;
                    uiH = h * 100;
                }
                const maxW = window.innerWidth * 0.8;
                const maxH = window.innerHeight * 0.6;
                if (uiW > maxW || uiH > maxH) {
                    currentPreviewScale = Math.min(maxW / uiW, maxH / uiH);
                    uiW *= currentPreviewScale;
                    uiH *= currentPreviewScale;
                } else {
                    currentPreviewScale = 1;
                }
                previewContainer.style.width = uiW + 'px';
                previewContainer.style.height = uiH + 'px';
                triggerPreviewUpdate();
            }

            const triggerPreviewUpdate = () => {
                if (!exportModal.classList.contains('active')) return;

                clearTimeout(previewDebounceTimer);
                clearPreview();
                if (previewOverlay) previewOverlay.classList.add('loading');
                previewDebounceTimer = setTimeout(() => {
                    latestPreviewRequestId += 1;
                    vscode.postMessage({
                        type: 'previewRender',
                        format: formatSelect.value,
                        width: widthInput.value,
                        height: heightInput.value,
                        unit: unitSelect.value,
                        requestId: latestPreviewRequestId
                    });
                }, 400);
            };

            const customResizer = document.getElementById('custom-resizer');
            let isDraggingResizer = false;
            let startMouseX = 0, startMouseY = 0;
            let startW = 0, startH = 0;

            customResizer?.addEventListener('mousedown', (e) => {
                isDraggingResizer = true;
                startMouseX = e.clientX;
                startMouseY = e.clientY;
                startW = previewContainer.offsetWidth;
                startH = previewContainer.offsetHeight;
                document.body.style.userSelect = 'none';
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDraggingResizer) return;
                const dx = e.clientX - startMouseX;
                const dy = e.clientY - startMouseY;
                let newW = startW + (dx * 2);
                let newH = startH + (dy * 2);
                newW = Math.max(20, newW);
                newH = Math.max(20, newH);
                const modalBody = document.querySelector('.export-modal-body');
                if (modalBody) {
                    newW = Math.min(newW, modalBody.clientWidth - 12);
                    newH = Math.min(newH, modalBody.clientHeight - 12);
                }
                previewContainer.style.width = newW + 'px';
                previewContainer.style.height = newH + 'px';

                // Synchronize input fields immediately with the exact drag dimensions
                const actualW = newW / currentPreviewScale;
                const actualH = newH / currentPreviewScale;
                if (currentUnit === 'px') {
                    widthInput.value = Math.round(actualW * 2).toString();
                    heightInput.value = Math.round(actualH * 2).toString();
                } else {
                    widthInput.value = Number((actualW / 100).toFixed(2)).toString();
                    heightInput.value = Number((actualH / 100).toFixed(2)).toString();
                }
                triggerPreviewUpdate();
            });

            window.addEventListener('mouseup', () => {
                if (isDraggingResizer) {
                    isDraggingResizer = false;
                    document.body.style.userSelect = '';
                }
            });



            formatSelect?.addEventListener('change', () => {
                const isRaster = formatSelect.value === 'png' || formatSelect.value === 'jpg';
                if (isRaster) {
                    unitSelect.value = 'px';
                    widthInput.value = '2400';
                    heightInput.value = '1800';
                } else {
                    unitSelect.value = 'in';
                    widthInput.value = '8';
                    heightInput.value = '6';
                }
                currentUnit = unitSelect.value;
                isSyncingUI = true;
                syncPreviewContainer();
                setTimeout(() => isSyncingUI = false, 50);
            });

            unitSelect?.addEventListener('change', () => {
                const w = parseFloat(widthInput.value) || 0;
                const h = parseFloat(heightInput.value) || 0;
                if (currentUnit === 'in' && unitSelect.value === 'px') {
                    widthInput.value = Math.round(w * 300).toString();
                    heightInput.value = Math.round(h * 300).toString();
                    const isRaster = formatSelect.value === 'png' || formatSelect.value === 'jpg';
                    if (!isRaster) formatSelect.value = 'png';
                } else if (currentUnit === 'px' && unitSelect.value === 'in') {
                    widthInput.value = Number((w / 300).toFixed(2)).toString();
                    heightInput.value = Number((h / 300).toFixed(2)).toString();
                    const isRaster = formatSelect.value === 'png' || formatSelect.value === 'jpg';
                    if (isRaster) formatSelect.value = 'pdf';
                }
                currentUnit = unitSelect.value;
                isSyncingUI = true;
                syncPreviewContainer();
                setTimeout(() => isSyncingUI = false, 50);
            });

            const onInputManualChange = () => {
                isSyncingUI = true;
                triggerPreviewUpdate();
                setTimeout(() => isSyncingUI = false, 50);
            };
            widthInput?.addEventListener('change', onInputManualChange);
            heightInput?.addEventListener('change', onInputManualChange);

            document.getElementById('main-image')?.addEventListener('click', (e) => {
                if (currentImageSrc && currentImageSrc.includes('_interactive.svg')) {
                    vscode.postMessage({ type: 'openViewer' });
                }
            });

            document.getElementById('btn-export-confirm')?.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'saveAs',
                    format: formatSelect.value,
                    unit: unitSelect.value,
                    width: widthInput.value,
                    height: heightInput.value
                });
                exportModal.classList.remove('active');
            });

            document.addEventListener('click', (e) => {
                if (compareDropdown && !compareDropdown.contains(e.target) && e.target !== btnCompareOptions && !btnCompareOptions?.contains(e.target)) {
                    compareDropdown.classList.remove('open');
                }
            });
            document.getElementById('btn-night-mode')?.addEventListener('click', () => {
                if (!document.getElementById('btn-night-mode').hasAttribute('disabled')) vscode.postMessage({ type: 'toggleNightMode' });
            });
            document.getElementById('btn-copy')?.addEventListener('click', () => {
                if (document.getElementById('btn-copy').hasAttribute('disabled')) return;
                vscode.postMessage({ type: 'copyImage' });
                const btn = document.getElementById('btn-copy');
                const oldHtml = btn.innerHTML;
                btn.innerHTML = '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.5 12.2L2.1 7.8l.7-.7 3.7 3.7 7.4-7.4.7.7-8.1 8.1z"/></svg>';
                setTimeout(() => btn.innerHTML = oldHtml, 1000);
            });

            const plotArea = document.querySelector('.plot-area');

            function getComparePaneKey(targetPaneId) {
                if (targetPaneId === 'compare-left' || targetPaneId === 'img-left') return 'left';
                if (targetPaneId === 'compare-right' || targetPaneId === 'img-right') return 'right';
                return activeCompareSide;
            }

            function getZoomAnchor(mouseX, mouseY, targetKey, paneKey) {
                let container;
                if (paneKey === 'main') container = plotArea;
                else if (paneKey === 'left') container = document.getElementById('compare-left');
                else container = document.getElementById('compare-right');

                const containerRect = container.getBoundingClientRect();
                if (!isCompareMode || !isSyncZoom || mouseX === undefined || mouseY === undefined) {
                    return {
                        x: mouseX !== undefined ? mouseX : containerRect.left + containerRect.width / 2,
                        y: mouseY !== undefined ? mouseY : containerRect.top + containerRect.height / 2
                    };
                }

                let sourceContainer;
                if (targetKey === 'left') sourceContainer = document.getElementById('compare-left');
                else sourceContainer = document.getElementById('compare-right');

                const sourceRect = sourceContainer.getBoundingClientRect();
                const relX = sourceRect.width > 0 ? (mouseX - sourceRect.left) / sourceRect.width : 0.5;
                const relY = sourceRect.height > 0 ? (mouseY - sourceRect.top) / sourceRect.height : 0.5;

                return {
                    x: containerRect.left + relX * containerRect.width,
                    y: containerRect.top + relY * containerRect.height
                };
            }

            function applyZoom(zoomFactor, mouseX, mouseY, targetPaneId) {
                let targetKeys = [];
                const sourceCompareKey = getComparePaneKey(targetPaneId);
                if (!isCompareMode) {
                    targetKeys = ['main'];
                } else {
                    if (isSyncZoom) targetKeys = ['left', 'right'];
                    else {
                        targetKeys = [sourceCompareKey];
                    }
                }

                targetKeys.forEach(k => {
                    const st = transformState[k];
                    let newScale = st.scale * zoomFactor;
                    if (newScale < 0.1) newScale = 0.1;
                    if (newScale > 50) newScale = 50;

                    const actualZoomFactor = newScale / st.scale;

                    let img;
                    if (k === 'main') img = document.getElementById('main-image');
                    else if (k === 'left') img = document.getElementById('img-left');
                    else img = document.getElementById('img-right');

                    if (!img || img.style.display === 'none') return;
                    if (img.classList.contains('is-interactive')) return;

                    const rect = img.getBoundingClientRect();

                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;

                    const anchor = getZoomAnchor(mouseX, mouseY, sourceCompareKey, k);
                    const cx = anchor.x;
                    const cy = anchor.y;

                    st.translateX += (cx - centerX) * (1 - actualZoomFactor);
                    st.translateY += (cy - centerY) * (1 - actualZoomFactor);
                    st.scale = newScale;
                });

                updateTransform();
            }

            plotArea.addEventListener('wheel', (e) => {
                e.preventDefault();
                const zoomIntensity = 0.002;
                const zoomFactor = Math.exp(-e.deltaY * zoomIntensity);
                applyZoom(zoomFactor, e.clientX, e.clientY, e.target.id);
            }, { passive: false });

            let isDragging = false;
            let dragStart = { main: {x:0, y:0}, left: {x:0, y:0}, right: {x:0, y:0} };
            let dragTargetPaneId = '';

            plotArea.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const isZoomed = !isCompareMode
                    ? transformState.main.scale > 1.001
                    : (transformState.left.scale > 1.001 || transformState.right.scale > 1.001);
                if (!isZoomed) return;
                isDragging = true;
                dragTargetPaneId = e.target.id;
                dragStart.main = { x: e.clientX - transformState.main.translateX, y: e.clientY - transformState.main.translateY };
                dragStart.left = { x: e.clientX - transformState.left.translateX, y: e.clientY - transformState.left.translateY };
                dragStart.right = { x: e.clientX - transformState.right.translateX, y: e.clientY - transformState.right.translateY };
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                e.preventDefault();

                if (!isCompareMode) {
                    transformState.main.translateX = e.clientX - dragStart.main.x;
                    transformState.main.translateY = e.clientY - dragStart.main.y;
                } else {
                    if (isSyncZoom) {
                        transformState.left.translateX = e.clientX - dragStart.left.x;
                        transformState.left.translateY = e.clientY - dragStart.left.y;
                        transformState.right.translateX = e.clientX - dragStart.right.x;
                        transformState.right.translateY = e.clientY - dragStart.right.y;
                    } else {
                        if (dragTargetPaneId === 'compare-left' || dragTargetPaneId === 'img-left') {
                            transformState.left.translateX = e.clientX - dragStart.left.x;
                            transformState.left.translateY = e.clientY - dragStart.left.y;
                        } else if (dragTargetPaneId === 'compare-right' || dragTargetPaneId === 'img-right') {
                            transformState.right.translateX = e.clientX - dragStart.right.x;
                            transformState.right.translateY = e.clientY - dragStart.right.y;
                        } else {
                            const tState = transformState[activeCompareSide];
                            const dStart = dragStart[activeCompareSide];
                            tState.translateX = e.clientX - dStart.x;
                            tState.translateY = e.clientY - dStart.y;
                        }
                    }
                }
                updateTransform();
            });

            window.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                }
            });

            plotArea.addEventListener('dblclick', resetZoom);

            document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
                if (!document.getElementById('btn-zoom-in').hasAttribute('disabled')) applyZoom(1.2);
            });
            document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
                if (!document.getElementById('btn-zoom-out').hasAttribute('disabled')) applyZoom(1 / 1.2);
            });
            document.getElementById('btn-reset-zoom')?.addEventListener('click', () => {
                if (!document.getElementById('btn-reset-zoom').hasAttribute('disabled')) resetZoom();
            });

            const btnCustomDir = document.getElementById('btn-custom-dir');
            const dropdown = document.getElementById('dir-dropdown');
            const btnSetOutViewDir = document.getElementById('btn-set-out-view-dir');
            const btnClearDir = document.getElementById('btn-clear-dir');
            const btnBrowse = document.getElementById('btn-browse');
            const dirInput = document.getElementById('dir-input');

            btnCustomDir?.addEventListener('click', (e) => {
                e.stopPropagation();
                dropdown?.classList.toggle('open');
                btnCustomDir?.classList.toggle('active', dropdown?.classList.contains('open') || false);
                if (dropdown?.classList.contains('open')) dirInput?.focus();
            });
            dropdown?.addEventListener('click', (e) => {
                e.stopPropagation();
            });
            document.addEventListener('click', () => {
                dropdown?.classList.remove('open');
                btnCustomDir?.classList.remove('active');
            });
            btnSetOutViewDir?.addEventListener('click', () => {
                dropdown?.classList.remove('open');
                vscode.postMessage({ type: 'setOutViewDir', path: dirInput?.value });
            });
            dirInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    dropdown?.classList.remove('open');
                    vscode.postMessage({ type: 'setOutViewDir', path: dirInput.value });
                }
            });
            btnClearDir?.addEventListener('click', () => {
                dropdown?.classList.remove('open');
                if(dirInput) dirInput.value = '';
                vscode.postMessage({ type: 'setOutViewDir', path: '' });
            });
            btnBrowse?.addEventListener('click', () => {
                dropdown?.classList.remove('open');
                vscode.postMessage({ type: 'browseCustomDir' });
            });
            document.getElementById('btn-popout')?.addEventListener('click', () => {
                vscode.postMessage({ type: isPoppedOut ? 'restore' : 'popout' });
            });

            const tooltip = document.getElementById('tooltip');
            const setupTooltip = (el) => {
                if (!el || !tooltip) return;
                el.addEventListener('mouseenter', (e) => {
                    const text = el.getAttribute('data-tooltip');
                    if (!text) return;
                    tooltip.textContent = text;
                    tooltip.style.display = 'block';
                    const rect = el.getBoundingClientRect();

                    if (el.id === 'main-image') {
                        tooltip.style.top = (rect.top + 20) + 'px';
                    } else {
                        tooltip.style.top = (rect.bottom + 5) + 'px';
                    }

                    const padding = 10;
                    let left = rect.left + (rect.width/2) - (tooltip.offsetWidth/2);

                    if (el.id === 'main-image') {
                        left = window.innerWidth / 2 - tooltip.offsetWidth / 2;
                    }

                    if (left < padding) left = padding;
                    if (left + tooltip.offsetWidth > window.innerWidth - padding) {
                        left = window.innerWidth - tooltip.offsetWidth - padding;
                    }
                    tooltip.style.left = left + 'px';
                });
                el.addEventListener('mouseleave', () => {
                    tooltip.style.display = 'none';
                });
                el.addEventListener('click', () => {
                    tooltip.style.display = 'none';
                });
            };

            document.querySelectorAll('[data-tooltip]').forEach(setupTooltip);
            setupTooltip(document.getElementById('main-image'));

            window.addEventListener('keydown', (e) => {
                if (e.target && e.target.tagName === 'INPUT') return;
                if (isCompareMode) return;

                if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    const btnPrev = document.getElementById('btn-prev');
                    if (btnPrev && !btnPrev.hasAttribute('disabled')) {
                        vscode.postMessage({ type: 'navigatePrev' });
                    }
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    const btnNext = document.getElementById('btn-next');
                    if (btnNext && !btnNext.hasAttribute('disabled')) {
                        vscode.postMessage({ type: 'navigateNext' });
                    }
                }
            });

            // Dynamic Resize Re-rendering Observer
            window._plotSwitchTimeout = null;
            window.__suppressPlotResizeUntil = 0;
            let resizeTimeout;

            function schedulePlotRerender() {
                if (document.body.classList.contains('minimized')) return;
                if (Date.now() < window.__suppressPlotResizeUntil) return;
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    if (isCompareMode) {
                        requestVisibleCompareRerenders();
                    } else if (typeof triggerRerender === 'function') {
                        triggerRerender();
                    } else {
                        triggerPreviewUpdate();
                    }
                    const isWidget = lastState && lastState.plots && lastState.plots[lastState.currentIndex] && lastState.plots[lastState.currentIndex].includes('_interactive.svg');
                    const isLeftWidget = lastState && lastState.plots && lastState.plots[compareLeftIndex] && lastState.plots[compareLeftIndex].includes('_interactive.svg');
                    const isRightWidget = lastState && lastState.plots && lastState.plots[compareRightIndex] && lastState.plots[compareRightIndex].includes('_interactive.svg');
                    if (isWidget || (isCompareMode && (isLeftWidget || isRightWidget))) {
                        renderState(lastState);
                    }
                }, 400);
            }

            window.triggerRerender = function() {
                if (document.body.classList.contains('minimized')) return;
                if (Date.now() < window.__suppressPlotResizeUntil) return;
                const plotArea = document.getElementById('plot-area');
                if (isCompareMode) {
                    requestVisibleCompareRerenders();
                } else if (plotArea && plotArea.clientWidth > 20 && plotArea.clientHeight > 20) {
                    vscode.postMessage({
                        type: 'resize',
                        width: plotArea.clientWidth,
                        height: plotArea.clientHeight,
                        pixelRatio: Math.min(Math.max(window.devicePixelRatio || 1, 1), 2.5)
                    });
                }
            };

            window.addEventListener('resize', schedulePlotRerender);
            if (typeof ResizeObserver !== 'undefined') {
                const plotArea = document.getElementById('plot-area');
                if (plotArea) {
                    const resizeObserver = new ResizeObserver(schedulePlotRerender);
                    resizeObserver.observe(plotArea);
                }
            }

            vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }

    // Cleanup

    dispose(): void {
        PlotsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }
}

//  Utility
