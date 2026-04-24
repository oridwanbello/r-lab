const vscode = require('vscode');

async function test() {
    await vscode.commands.executeCommand('workbench.action.terminal.new');
    await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');
}
module.exports = test;
