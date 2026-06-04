import * as vscode from 'vscode';

export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function enforceGroup3TabOrder(panelTitle: string): Promise<void> {
    const GROUP3_ORDER = ['Workspace', 'Plots', 'Data Viewer', 'Viewer'];
    const group = vscode.window.tabGroups.activeTabGroup;
    if (group && group.viewColumn === vscode.ViewColumn.Three) {
        const presentTabs = group.tabs.map(t => t.label);
        const expectedOrder = GROUP3_ORDER.filter(label => presentTabs.includes(label));
        const currentIdx = presentTabs.indexOf(panelTitle);
        const expectedIdx = expectedOrder.indexOf(panelTitle);
        if (currentIdx > expectedIdx && expectedIdx !== -1) {
            await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: expectedIdx + 1 });
        }
    }
}
