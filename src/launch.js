#!/usr/bin/env node

/**
 * launch.js — Open CLIChatter in a New Terminal Window
 *
 * Detects the available terminal emulator and spawns
 * `node src/index.js [args]` in a new window.
 *
 * Priority:  gnome-terminal → konsole → xfce4-terminal → xterm → macOS Terminal
 *
 * Usage:
 *   node src/launch.js --name Alice --room dev
 *   npm run new -- --name Alice --room dev
 */

import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(__dirname, 'index.js');

// Pass through all args after this script's name
const userArgs = process.argv.slice(2);
const nodeCmd = `node ${ENTRY} ${userArgs.map((a) => JSON.stringify(a)).join(' ')}`;

function commandExists(cmd) {
    return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

function tryLaunch(terminal, args) {
    console.log(`  Launching in ${terminal}...`);
    const child = spawn(terminal, args, {
        detached: true,
        stdio: 'ignore',
        cwd: ROOT,
    });
    child.unref();
    return true;
}

// ── Terminal detection ────────────────────────────────────────────────────────
if (commandExists('gnome-terminal')) {
    tryLaunch('gnome-terminal', ['--', 'bash', '-c', `${nodeCmd}; exec bash`]);

} else if (commandExists('konsole')) {
    tryLaunch('konsole', ['-e', 'bash', '-c', `${nodeCmd}; exec bash`]);

} else if (commandExists('xfce4-terminal')) {
    tryLaunch('xfce4-terminal', ['-e', `bash -c "${nodeCmd}; exec bash"`]);

} else if (commandExists('tilix')) {
    tryLaunch('tilix', ['-e', `bash -c "${nodeCmd}; exec bash"`]);

} else if (commandExists('xterm')) {
    tryLaunch('xterm', ['-e', `${nodeCmd}`]);

} else if (process.platform === 'darwin' && commandExists('open')) {
    // macOS: write a temp script and open it with Terminal.app
    import('node:fs').then(({ writeFileSync }) => {
        const tmp = `/tmp/lan-chat-launch-${Date.now()}.sh`;
        writeFileSync(tmp, `#!/bin/bash\n${nodeCmd}\n`, { mode: 0o755 });
        tryLaunch('open', ['-a', 'Terminal', tmp]);
    });

} else {
    console.error('  ✖ No supported terminal emulator found.');
    console.error('    Install one of: gnome-terminal, konsole, xfce4-terminal, xterm');
    console.error(`  Running in this terminal instead:\n`);
    // Fall back: just run here
    import('./index.js');
}
