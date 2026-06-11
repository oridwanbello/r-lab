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
    const GROUP3_ORDER = ['Workspace', 'Visuals', 'Data Viewer'];
    const targetTitle = (panelTitle === 'Plots' || panelTitle === 'Viewer' || panelTitle === 'Visualizations') ? 'Visuals' : panelTitle;
    
    // Give VS Code a moment to update the tab arrays after a reveal/move
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Find Group 3 regardless of which group is currently active
    const group = vscode.window.tabGroups.all.find(g => g.viewColumn === vscode.ViewColumn.Three);
    if (group) {
        const presentTabs = group.tabs.map(t => t.label);
        const expectedOrder = GROUP3_ORDER.filter(label => presentTabs.includes(label));
        const currentIdx = presentTabs.indexOf(targetTitle);
        const expectedIdx = expectedOrder.indexOf(targetTitle);
        
        // If the tab is out of order, move it to the expected position
        if (currentIdx !== expectedIdx && currentIdx !== -1 && expectedIdx !== -1) {
            // First ensure it's the active tab so moveActiveEditor works on it
            const tabToMove = group.tabs[currentIdx];
            if (!tabToMove.isActive) {
                // We can't easily move non-active tabs with the command, but since it was just revealed, it is usually active.
            }
            await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: expectedIdx + 1 });
        }
    }
}
