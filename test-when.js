const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

pkg.contributes.menus['editor/title'].forEach(item => {
    if (item.command === 'r-layout.maximizeTopRight') {
        item.when = "r-layout.layoutActive && !r-layout.isTopRightMaximized && (activeEditor =~ /^r-layout\\./ || activeEditor == 'terminalEditor' || resourceScheme == 'vscode-terminal')";
    } else if (item.command === 'r-layout.restoreRightSplit') {
        item.when = "r-layout.layoutActive && r-layout.isTopRightMaximized && (activeEditor =~ /^r-layout\\./ || activeEditor == 'terminalEditor' || resourceScheme == 'vscode-terminal')";
    }
});

fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
