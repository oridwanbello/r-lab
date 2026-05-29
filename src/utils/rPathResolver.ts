import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import * as util from 'util';

const execAsync = util.promisify(exec);

let cachedRPath = 'R';
let cachedRArgs: string[] = [];
let cachedRscriptPath = 'Rscript';

export function getRPath(): string {
    return cachedRPath;
}

export function getRArgs(): string[] {
    return cachedRArgs;
}

export function getRscriptPath(): string {
    return cachedRscriptPath;
}

export async function initializeRPathResolver(): Promise<void> {
    const config = vscode.workspace.getConfiguration('r-layout');
    
    // 1. Check our own setting first
    const ours = config.get<string>('rConsolePath', '');
    if (ours && ours !== 'R') {
        _setPaths(ours);
        return;
    }

    // 2. Check the official R extension paths based on OS
    const rConfig = vscode.workspace.getConfiguration('r');
    const platform = os.platform();
    let osSuffix = '';
    
    if (platform === 'win32') {
        osSuffix = 'windows';
    } else if (platform === 'darwin') {
        osSuffix = 'mac';
    } else {
        osSuffix = 'linux';
    }

    const rTerm = rConfig.get<string>(`rterm.${osSuffix}`, '');
    if (rTerm) {
        console.log(`[R Layout] Using R extension's r.rterm.${osSuffix}: ${rTerm}`);
        _setPaths(rTerm);
        return;
    }

    const rPath = rConfig.get<string>(`rpath.${osSuffix}`, '');
    if (rPath) {
        console.log(`[R Layout] Using R extension's r.rpath.${osSuffix}: ${rPath}`);
        _setPaths(rPath);
        return;
    }

    // 3. Windows Registry Fallback
    if (platform === 'win32') {
        try {
            const regPath = await getWindowsRegistryRPath();
            if (regPath) {
                console.log(`[R Layout] Found R via Windows Registry: ${regPath}`);
                _setPaths(regPath);
                return;
            }
        } catch (e) {
            console.error('[R Layout] Windows Registry lookup failed:', e);
        }
    }

    // 4. Default Fallback
    _setPaths(ours || 'R');

    // If we resolved to 'R', check if R actually exists. If not, warn the user.
    if (cachedRPath === 'R') {
        // In a real environment, if 'R' is not in PATH, spawning it fails. 
        // We will warn the user if we are on Windows and couldn't find anything,
        // as Windows users typically don't have R in PATH.
        if (platform === 'win32') {
            vscode.window.showWarningMessage(
                "R Layout couldn't find your R installation. If 'R' is not in your system PATH, please configure 'r-layout.rConsolePath' in your VS Code settings."
            );
        }
    }
}

function _setPaths(resolvedRPath: string) {
    const parts = resolvedRPath.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    let exePath = (parts.length > 0 && parts[0]) ? parts[0].replace(/^"|"$/g, '') : resolvedRPath;
    const args = parts.length > 1 ? parts.slice(1).map(p => (p as string).replace(/^"|"$/g, '')) : [];

    if (exePath.startsWith('~/') || exePath.startsWith('~\\')) {
        exePath = path.join(os.homedir(), exePath.slice(2));
    }
    
    cachedRPath = exePath;
    cachedRArgs = args;
    
    // Derive Rscript path using exePath
    if (/[/\\\\]R(\.exe)?$/i.test(exePath)) {
        cachedRscriptPath = exePath.replace(/([/\\\\])R(\.exe)?$/i, '$1Rscript$2');
    } else if (/[/\\\\]Rterm\.exe$/i.test(exePath)) {
        cachedRscriptPath = exePath.replace(/([/\\\\])Rterm\.exe$/i, '$1Rscript.exe');
    } else if (/^R(\.exe)?$/i.test(exePath)) {
        cachedRscriptPath = exePath.replace(/^R(\.exe)?$/i, 'Rscript$1');
    } else {
        // If it's something like 'radian', we just fallback to Rscript
        cachedRscriptPath = 'Rscript';
    }
}

async function getWindowsRegistryRPath(): Promise<string | undefined> {
    const keys = [
        'HKLM\\SOFTWARE\\R-core\\R',
        'HKCU\\SOFTWARE\\R-core\\R'
    ];

    for (const key of keys) {
        try {
            const { stdout } = await execAsync(`reg query "${key}" /v InstallPath`);
            const match = stdout.match(/InstallPath\s+REG_SZ\s+(.*)/i);
            if (match && match[1]) {
                const installPath = match[1].trim();
                
                // Prefer x64 if it exists
                const x64Path = path.join(installPath, 'bin', 'x64', 'R.exe');
                if (fs.existsSync(x64Path)) {
                    return x64Path;
                }
                
                const binPath = path.join(installPath, 'bin', 'R.exe');
                if (fs.existsSync(binPath)) {
                    return binPath;
                }
            }
        } catch (e) {
            // Key not found or error reading, try the next one
            continue;
        }
    }
    
    return undefined;
}
