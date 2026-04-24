const vscode = require('vscode');
const fs = require('fs');

exports.run = async function() {
    const commands = await vscode.commands.getCommands(true);
    fs.writeFileSync('commands_dump.txt', commands.join('\n'));
    
    const views = [];
    for (const ext of vscode.extensions.all) {
        if (ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.views) {
            for (const container in ext.packageJSON.contributes.views) {
                for (const view of ext.packageJSON.contributes.views[container]) {
                    views.push(view.id);
                }
            }
        }
    }
    fs.writeFileSync('views_dump.txt', views.join('\n'));
}
