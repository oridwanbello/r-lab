import * as vscode from 'vscode';
import * as os from 'os';
import { getNonce } from '../utils/webviewUtils';
import { recordLayoutFocus } from '../layout/layoutManager';
import { PlotsPanel } from './plotsPanel';
import { ViewerPanel } from './viewerPanel';

type VizTarget = 'plots' | 'viewer';

interface HostedFragment {
    links: string;
    styles: string;
    body: string;
    scripts: string[];
}

class HostedWebview {
    private _html = '';
    private _options: vscode.WebviewOptions = {};
    private _messageHandlers: Array<(message: any) => any> = [];

    public readonly cspSource: string;

    public constructor(
        private readonly _owner: VisualsPanel,
        private readonly _target: VizTarget,
        private readonly _parentWebview: vscode.Webview
    ) {
        this.cspSource = _parentWebview.cspSource;
    }

    public set html(value: string) {
        this._html = value;
        this._owner.setHostedHtml(this._target, value);
    }

    public get html(): string {
        return this._html;
    }

    public set options(value: vscode.WebviewOptions) {
        this._options = value;
        this._owner.updateHostedResourceRoots(this._target, value.localResourceRoots ?? []);
    }

    public get options(): vscode.WebviewOptions {
        return this._options;
    }

    public postMessage(message: any): Thenable<boolean> {
        return this._owner.postMessageToHosted(this._target, message);
    }

    public asWebviewUri(uri: vscode.Uri): vscode.Uri {
        return this._parentWebview.asWebviewUri(uri);
    }

    public onDidReceiveMessage(
        listener: (message: any) => any,
        thisArgs?: any,
        disposables?: vscode.Disposable[]
    ): vscode.Disposable {
        const handler = thisArgs ? listener.bind(thisArgs) : listener;
        this._messageHandlers.push(handler);
        const disposable = new vscode.Disposable(() => {
            this._messageHandlers = this._messageHandlers.filter(h => h !== handler);
        });
        disposables?.push(disposable);
        return disposable;
    }

    public receive(message: any): void {
        for (const handler of this._messageHandlers) {
            handler(message);
        }
    }
}

class HostedPanel {
    public readonly webview: HostedWebview;
    public iconPath?: vscode.Uri;
    private _viewStateHandlers: Array<(event: { webviewPanel: HostedPanel }) => any> = [];

    public constructor(
        private readonly _owner: VisualsPanel,
        private readonly _target: VizTarget,
        private readonly _parentPanel: vscode.WebviewPanel
    ) {
        this.webview = new HostedWebview(_owner, _target, _parentPanel.webview);
    }

    public get viewColumn(): vscode.ViewColumn | undefined {
        return this._parentPanel.viewColumn;
    }

    public get visible(): boolean {
        return this._parentPanel.visible && this._owner.activeTarget === this._target;
    }

    public get active(): boolean {
        return this.visible;
    }

    public reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
        this._owner.revealTarget(this._target, column, preserveFocus);
        for (const handler of this._viewStateHandlers) {
            handler({ webviewPanel: this });
        }
    }

    public dispose(): void {
        this._viewStateHandlers = [];
    }

    public onDidDispose(
        _listener: () => any,
        _thisArgs?: any,
        disposables?: vscode.Disposable[]
    ): vscode.Disposable {
        const disposable = new vscode.Disposable(() => {});
        disposables?.push(disposable);
        return disposable;
    }

    public onDidChangeViewState(
        listener: (event: { webviewPanel: HostedPanel }) => any,
        thisArgs?: any,
        disposables?: vscode.Disposable[]
    ): vscode.Disposable {
        const handler = thisArgs ? listener.bind(thisArgs) : listener;
        this._viewStateHandlers.push(handler);
        const disposable = new vscode.Disposable(() => {
            this._viewStateHandlers = this._viewStateHandlers.filter(h => h !== handler);
        });
        disposables?.push(disposable);
        return disposable;
    }
}

export class VisualsPanel {
    public static currentPanel: VisualsPanel | undefined;
    public static readonly viewType = 'r-layout.visualsPanel';
    public static readonly legacyViewType = 'r-layout.visualizationsPanel';
    public static lastClosedState: any | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _hostedWebviews: Partial<Record<VizTarget, HostedWebview>> = {};
    private readonly _hostedResourceRoots: Record<VizTarget, vscode.Uri[]> = { plots: [], viewer: [] };
    private _activeTarget: VizTarget = 'plots';
    private _ready = false;

    public static createOrShow(
        extensionUri: vscode.Uri,
        column: vscode.ViewColumn = vscode.ViewColumn.Three,
        forceReveal: boolean = true
    ): VisualsPanel {
        if (VisualsPanel.currentPanel) {
            VisualsPanel.currentPanel._panel.title = 'Visuals';
            if (forceReveal) {
                VisualsPanel.currentPanel._panel.reveal(column, true);
            }
            return VisualsPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            VisualsPanel.viewType,
            'Visuals',
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: VisualsPanel._defaultResourceRoots(extensionUri),
                portMapping: []
            }
        );
        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'blank.svg');

        VisualsPanel.currentPanel = new VisualsPanel(panel, extensionUri);
        return VisualsPanel.currentPanel;
    }

    private static _defaultResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
        return [
            extensionUri,
            ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? []),
            vscode.Uri.file(os.homedir())
        ];
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._render();
        this._createHostedPanels();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.onDidChangeViewState(
            (event) => {
                if (event.webviewPanel.active) {
                    recordLayoutFocus('Visuals', event.webviewPanel.viewColumn);
                }
            },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            (message: { type: string; target?: VizTarget; message?: any }) => {
                switch (message.type) {
                    case 'ready':
                        this._ready = true;
                        this._flushHostedHtml();
                        this._panel.webview.postMessage({ type: 'restoreTarget', target: this._activeTarget });
                        this._setActiveTarget(this._activeTarget);
                        break;
                    case 'switchTarget':
                        if (message.target === 'plots' || message.target === 'viewer') {
                            this._setActiveTarget(message.target);
                            VisualsPanel.lastClosedState = this.saveState();
                        }
                        break;
                    case 'hostedMessage':
                        if (message.target === 'plots' || message.target === 'viewer') {
                            const hostedType = (message.message as { type?: string } | undefined)?.type;
                            if (hostedType === 'popout' || hostedType === 'restore') {
                                this._setActiveTarget(message.target);
                            }
                            this._hostedWebviews[message.target]?.receive(message.message);
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public get activeTarget(): VizTarget {
        return this._activeTarget;
    }

    public reveal(column?: vscode.ViewColumn, preserveFocus: boolean = true): void {
        this._panel.reveal(column, preserveFocus);
    }

    public revealTarget(target: VizTarget, column?: vscode.ViewColumn, preserveFocus: boolean = true): void {
        this._setActiveTarget(target);
        this._panel.reveal(column, preserveFocus);
    }

    public setMinimized(minimized: boolean): void {
        PlotsPanel.currentPanel?.setMinimized(minimized);
        ViewerPanel.currentPanel?.setMinimized(minimized);
        this._panel.webview.postMessage({ type: 'setMinimized', minimized });
    }

    public restoreActivePlotlyWidgetAfterPaneSplit(): void {
        ViewerPanel.currentPanel?.restoreActivePlotlyWidgetAfterPaneSplit();
        this._panel.webview.postMessage({ type: 'nudgeActiveSurface' });
    }

    public saveState(): any {
        return {
            activeTarget: this._activeTarget,
            viewerState: ViewerPanel.currentPanel?.saveState()
        };
    }

    public async loadState(state: any): Promise<void> {
        if (!state) { return; }
        this._activeTarget = state.activeTarget === 'viewer' ? 'viewer' : 'plots';
        if (state.viewerState) {
            await ViewerPanel.currentPanel?.loadState(state.viewerState);
        }
        this._setActiveTarget(this._activeTarget);
    }

    public setHostedHtml(target: VizTarget, html: string): void {
        if (!this._ready) { return; }
        this._panel.webview.postMessage({
            type: 'setHostedContent',
            target,
            fragment: this._extractFragment(html)
        });
    }

    public postMessageToHosted(target: VizTarget, message: any): Thenable<boolean> {
        if (!this._ready) {
            return Promise.resolve(false);
        }
        return this._panel.webview.postMessage({
            type: 'postHostedMessage',
            target,
            message: { ...message, target }
        });
    }

    public updateHostedResourceRoots(target: VizTarget, roots: readonly vscode.Uri[]): void {
        this._hostedResourceRoots[target] = [...roots];
        const merged = new Map<string, vscode.Uri>();
        for (const uri of VisualsPanel._defaultResourceRoots(this._extensionUri)) {
            merged.set(uri.toString(), uri);
        }
        for (const uri of [...this._hostedResourceRoots.plots, ...this._hostedResourceRoots.viewer]) {
            merged.set(uri.toString(), uri);
        }
        this._panel.webview.options = {
            ...this._panel.webview.options,
            localResourceRoots: [...merged.values()]
        };
    }

    public dispose(): void {
        VisualsPanel.lastClosedState = this.saveState();
        VisualsPanel.currentPanel = undefined;
        if (PlotsPanel.currentPanel) {
            PlotsPanel.currentPanel.dispose();
        }
        if (ViewerPanel.currentPanel) {
            ViewerPanel.currentPanel.dispose();
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            disposable?.dispose();
        }
    }

    private _createHostedPanels(): void {
        const plotsPanel = new HostedPanel(this, 'plots', this._panel);
        const viewerPanel = new HostedPanel(this, 'viewer', this._panel);
        this._hostedWebviews.plots = plotsPanel.webview;
        this._hostedWebviews.viewer = viewerPanel.webview;
        PlotsPanel.createHosted(plotsPanel as any, this._extensionUri);
        ViewerPanel.createHosted(viewerPanel as any, this._extensionUri);
    }

    private _flushHostedHtml(): void {
        for (const target of ['plots', 'viewer'] as VizTarget[]) {
            const html = this._hostedWebviews[target]?.html;
            if (html) {
                this.setHostedHtml(target, html);
            }
        }
    }

    private _setActiveTarget(target: VizTarget): void {
        this._activeTarget = target;
        this._panel.title = 'Visuals';
        if (!this._ready) { return; }
        this._panel.webview.postMessage({ type: 'setActiveTarget', target });
    }

    private _extractFragment(html: string): HostedFragment {
        const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).join('\n');
        const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
        const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
        const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
        return { links, styles, body, scripts };
    }

    private _render(): void {
        const nonce = getNonce();
        const cspSource = this._panel.webview.cspSource;
        this._panel.webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${cspSource} http: https: data:;
                   frame-src *;
                   font-src https://cdn.jsdelivr.net;
                   style-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
                   script-src 'nonce-${nonce}' 'unsafe-eval';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
            height: 100%;
        }
        body {
            font-family: var(--vscode-font-family);
            font-weight: 400;
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100%;
            overflow: hidden;
        }
        body.minimized > * { visibility: hidden !important; pointer-events: none !important; }
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
        .tab { min-width: 0; padding: 8px 10px; cursor: pointer; opacity: 0.6; font-size: var(--vscode-font-size, 13px); font-weight: normal; letter-spacing: 0.3px; white-space: nowrap; display: flex; align-items: center; justify-content: center; gap: 4px; position: relative; overflow: hidden; text-overflow: ellipsis; background: transparent; color: var(--vscode-editor-foreground); border: 0; }
        .tab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tab:not(:last-child) { border-right: 1px solid var(--vscode-editorGroup-border); }
        .tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        .tab.active { opacity: 1; color: var(--vscode-foreground); }
        .tab.active::after {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 3px;
            background: var(--vscode-button-background);
        }
        .surfaces {
            flex: 1;
            min-height: 0;
            position: relative;
            background: var(--vscode-editor-background);
        }
        .viz-surface {
            position: absolute;
            inset: 0;
            min-width: 0;
            min-height: 0;
            visibility: hidden;
            pointer-events: none;
        }
        .viz-surface.active {
            visibility: visible;
            pointer-events: auto;
        }
    </style>
</head>
<body>
    <div class="tabs">
        <button id="tab-plots" class="tab active" data-target="plots"><span class="tab-label">Plots</span></button>
        <button id="tab-viewer" class="tab" data-target="viewer"><span class="tab-label">Viewer</span></button>
    </div>
    <div class="surfaces">
        <div id="plots-root" class="viz-surface active"></div>
        <div id="viewer-root" class="viz-surface"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const roots = {
            plots: document.getElementById('plots-root'),
            viewer: document.getElementById('viewer-root')
        };
        const tabs = {
            plots: document.getElementById('tab-plots'),
            viewer: document.getElementById('tab-viewer')
        };
        const active = { target: 'plots' };
        const controllers = {};
        const generations = { plots: 0, viewer: 0 };

        function setActiveTarget(target) {
            active.target = target;
            for (const key of Object.keys(roots)) {
                roots[key].classList.toggle('active', key === target);
                tabs[key].classList.toggle('active', key === target);
            }
            setTimeout(() => {
                window.dispatchEvent(new Event('resize'));
                window.postMessage({ target, type: 'restorePaneSplit' }, '*');
            }, 80);
        }

        function cssForRoot(css, rootId) {
            function findBlockEnd(text, start) {
                let depth = 1;
                for (let i = start; i < text.length; i++) {
                    if (text[i] === '{') depth++;
                    else if (text[i] === '}') {
                        depth--;
                        if (depth === 0) return i;
                    }
                }
                return text.length - 1;
            }

            function splitSelectors(selector) {
                const parts = [];
                let current = '';
                let parenDepth = 0;
                for (const ch of selector) {
                    if (ch === '(') parenDepth++;
                    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
                    if (ch === ',' && parenDepth === 0) {
                        parts.push(current.trim());
                        current = '';
                    } else {
                        current += ch;
                    }
                }
                if (current.trim()) parts.push(current.trim());
                return parts;
            }

            function scopeSelector(selector) {
                if (!selector || selector.startsWith('#' + rootId)) return selector;
                if (selector.startsWith('@')) return selector;
                let next = selector
                    .replace(/^body(?=$|[\\s.#:[>+~])/u, '#' + rootId)
                    .replace(/^html(?=$|[\\s.#:[>+~])/u, '#' + rootId)
                    .replace(/^:root(?=$|[\\s.#:[>+~])/u, '#' + rootId);
                if (next === selector && selector.startsWith('*')) {
                    next = '#' + rootId + ' ' + selector;
                } else if (next === selector) {
                    next = '#' + rootId + ' ' + selector;
                }
                return next;
            }

            function scopeBlock(text) {
                let output = '';
                let cursor = 0;
                while (cursor < text.length) {
                    const brace = text.indexOf('{', cursor);
                    if (brace === -1) {
                        output += text.slice(cursor);
                        break;
                    }
                    const selector = text.slice(cursor, brace).trim();
                    const close = findBlockEnd(text, brace + 1);
                    const body = text.slice(brace + 1, close);
                    const lowerSelector = selector.toLowerCase();

                    if (lowerSelector.startsWith('@media') || lowerSelector.startsWith('@supports') || lowerSelector.startsWith('@container')) {
                        output += selector + ' {' + scopeBlock(body) + '}';
                    } else if (lowerSelector.startsWith('@keyframes') || lowerSelector.startsWith('@font-face') || lowerSelector.startsWith('@page')) {
                        output += selector + ' {' + body + '}';
                    } else {
                        const selectors = splitSelectors(selector);
                        const hasRootSelector = selectors.some(part => /^(body|html|:root)(?=$|[\s.#:[>+~])/u.test(part));
                        const scopedSelector = selectors.map(scopeSelector).join(', ');
                        const scopedBody = hasRootSelector
                            ? body.replace(/\bheight\s*:\s*100vh\s*;/giu, 'height: 100%;')
                            : body;
                        output += scopedSelector + ' {' + scopedBody + '}';
                    }
                    cursor = close + 1;
                }
                return output;
            }

            return scopeBlock(css || '');
        }

        function createDocumentProxy(root, target, generation) {
            return {
                get body() { return root; },
                get head() { return document.head; },
                get documentElement() { return document.documentElement; },
                getElementById: id => root.querySelector('#' + CSS.escape(id)),
                querySelector: selector => root.querySelector(selector),
                querySelectorAll: selector => root.querySelectorAll(selector),
                createElement: tag => document.createElement(tag),
                addEventListener: (type, listener, options) => {
                    const wrapped = (event) => {
                        if (generations[target] !== generation) return;
                        listener(event);
                    };
                    root.addEventListener(type, wrapped, options);
                },
                removeEventListener: (type, listener, options) => root.removeEventListener(type, listener, options)
            };
        }

        function createWindowProxy(target, generation) {
            return new Proxy(window, {
                get(obj, prop) {
                    if (prop === 'addEventListener') {
                        return (type, listener, options) => {
                            const wrapped = (event) => {
                                if (generations[target] !== generation) return;
                                if ((type === 'keydown' || type === 'resize') && active.target !== target) return;
                                if (type === 'message') {
                                    const msgTarget = event.data && event.data.target;
                                    if (msgTarget && msgTarget !== target) return;
                                }
                                listener(event);
                            };
                            obj.addEventListener(type, wrapped, options);
                        };
                    }
                    const value = obj[prop];
                    return typeof value === 'function' ? value.bind(obj) : value;
                },
                set(obj, prop, value) {
                    obj[prop] = value;
                    return true;
                }
            });
        }

        function syncThemeClasses() {
            const classes = Array.from(document.body.classList).filter(c => c.startsWith('vscode-') || c === 'night-mode');
            for (const key of Object.keys(roots)) {
                for (const c of Array.from(roots[key].classList)) {
                    if (c.startsWith('vscode-') || c === 'night-mode') {
                        roots[key].classList.remove(c);
                    }
                }
                for (const c of classes) {
                    roots[key].classList.add(c);
                }
            }
        }

        function installHostedContent(target, fragment) {
            const root = roots[target];
            const generation = ++generations[target];
            root.innerHTML = '';
            const style = document.createElement('style');
            style.setAttribute('nonce', '${nonce}');
            style.textContent = cssForRoot(fragment.styles || '', root.id);
            root.appendChild(style);

            const links = document.createElement('div');
            links.innerHTML = fragment.links || '';
            while (links.firstChild) root.appendChild(links.firstChild);

            const body = document.createElement('div');
            body.innerHTML = fragment.body || '';
            while (body.firstChild) root.appendChild(body.firstChild);

            const api = { postMessage: message => vscode.postMessage({ type: 'hostedMessage', target, message }) };
            const docProxy = createDocumentProxy(root, target, generation);
            const winProxy = createWindowProxy(target, generation);
            controllers[target] = { root, api };
            for (const script of fragment.scripts || []) {
                const body = 'const document = hostDocument; const window = hostWindow;\\n' + script;
                const fn = new Function('root', 'hostDocument', 'hostWindow', 'hostVscode', 'CSS', 'ResizeObserver', 'MutationObserver', 'Event', 'URL', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'acquireVsCodeApi', body);
                fn(root, docProxy, winProxy, api, CSS, ResizeObserver, MutationObserver, Event, URL, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame, () => api);
            }
            syncThemeClasses();
        }

        for (const key of Object.keys(tabs)) {
            tabs[key].addEventListener('click', () => vscode.postMessage({ type: 'switchTarget', target: key }));
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'setHostedContent') {
                installHostedContent(msg.target, msg.fragment);
            } else if (msg.type === 'postHostedMessage') {
                window.postMessage(msg.message, '*');
            } else if (msg.type === 'setActiveTarget' || msg.type === 'restoreTarget') {
                setActiveTarget(msg.target);
            } else if (msg.type === 'nudgeActiveSurface') {
                window.dispatchEvent(new Event('resize'));
                window.postMessage({ target: active.target, type: 'restorePaneSplit' }, '*');
            } else if (msg.type === 'setMinimized') {
                document.body.classList.toggle('minimized', msg.minimized);
            }
        });

        syncThemeClasses();
        const themeObserver = new MutationObserver(syncThemeClasses);
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
