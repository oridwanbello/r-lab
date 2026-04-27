const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

pkg.contributes.menus['editor/title'] = pkg.contributes.menus['editor/title'].filter(item => !item.command.startsWith('workbench.action.splitEditor'));

pkg.contributes.menus['editor/title'].push({
    command: "-workbench.action.splitEditorRight",
    when: "r-layout.layoutActive && activeEditorGroupIndex != 0"
});
pkg.contributes.menus['editor/title'].push({
    command: "-workbench.action.splitEditorDown",
    when: "r-layout.layoutActive && activeEditorGroupIndex != 0"
});
pkg.contributes.menus['editor/title'].push({
    command: "-workbench.action.splitEditor",
    when: "r-layout.layoutActive && activeEditorGroupIndex != 0"
});

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
