const vscode = require('vscode');
const fs = require('fs');

async function getViews() {
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
  fs.writeFileSync('views.txt', views.join('\n'));
}
