/**
 * ui.js — Centralized Terminal UI Module
 *
 * Responsibilities:
 *  - Consistent, color-coded message rendering with URL hyperlinks
 *  - Safe "print without clobbering the readline prompt" pattern
 *  - Stable per-peer color assignment (hash-based from a curated palette)
 *  - Dynamic prompt: #room [N peers] ›
 *  - /list (includes self), /help, /ping, /status output
 *  - Live status bar at bottom of terminal
 *  - Startup banner with room + encryption indicator
 *  - /nuke warning display
 */

import chalk from 'chalk';

// ── Internal state ────────────────────────────────────────────────────────────
let _rl = null;
let _peerCount = 0;
let _room = 'general';
let _myName = 'You';
let _myIP = '';
let _myPort = 0;
let _encrypted = false;
let _startTime = Date.now();
let _statusTimer = null;
let _getStatusInfo = null; // callback: () => { peerCount, encrypted, room }

// ── Peer color palette ────────────────────────────────────────────────────────
const COLOR_PALETTE = [
  chalk.hex('#61DAFB'), // React blue
  chalk.hex('#F7DF1E'), // JS yellow
  chalk.hex('#FF6B9D'), // pink
  chalk.hex('#A8FF78'), // mint green
  chalk.hex('#FF9F43'), // orange
  chalk.hex('#B8A9FF'), // lavender
  chalk.hex('#FF6B6B'), // coral
  chalk.hex('#4ECDC4'), // teal
];

const colorCache = new Map();

/** Returns a stable chalk color function for a given peer name. */
export function peerColor(name) {
  if (!colorCache.has(name)) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
    colorCache.set(name, COLOR_PALETTE[hash % COLOR_PALETTE.length]);
  }
  return colorCache.get(name);
}

// ── URL regex ─────────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Format message text — detects URLs and wraps them with OSC 8 hyperlinks
 * (clickable in modern terminals) and highlights them in cyan.
 */
function formatText(text) {
  return text.replace(URL_RE, (url) => {
    // OSC 8 hyperlink: \x1b]8;;URL\x1b\\LABEL\x1b]8;;\x1b\\
    const link = `\x1b]8;;${url}\x1b\\${chalk.cyan.underline(url)}\x1b]8;;\x1b\\`;
    return link;
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
/**
 * Must be called once after readline is created and room is known.
 * @param {object} rl        - readline interface
 * @param {object} identity  - { name, ip, port, room }
 */
export function init(rl, identity = {}) {
  _rl = rl;
  _room = identity.room || 'general';
  _myName = identity.name || 'You';
  _myIP = identity.ip || '';
  _myPort = identity.port || 0;
  _startTime = Date.now();
}

/** Mark whether messages are E2E encrypted (affects banner + status bar). */
export function setEncrypted(val) {
  _encrypted = !!val;
}

// ── Core print helper ─────────────────────────────────────────────────────────
/**
 * Safely prints a line by first clearing the readline prompt line,
 * printing, then restoring the prompt.
 */
function print(line) {
  process.stdout.write('\r\x1b[K');
  console.log(line);
  if (_rl) _rl.prompt(true);
}

// ── Message renderers ─────────────────────────────────────────────────────────
/** Render a message received from another peer. */
export function printMessage(from, text) {
  const time = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const color = peerColor(from);
  const sender = color.bold(from);
  const body = formatText(chalk.white(text));
  const enc = _encrypted ? chalk.dim(' 🔒') : '';
  print(`${time} ${sender}:${enc} ${body}`);
}

/** Render a message you just sent (echoed back to your own screen). */
export function printOwnMessage(text, target = 'All') {
  const time = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const label = chalk.dim(`You → ${target}`);
  const body = formatText(chalk.dim(text));
  print(`${time} ${label}: ${body}`);
}

/**
 * Render a system notice.
 * @param {'info'|'warn'|'error'} level
 */
export function printSystem(msg, level = 'info') {
  const icon = level === 'error' ? chalk.red('✖')
    : level === 'warn' ? chalk.yellow('⚠')
      : chalk.dim('◆');
  print(`${icon} ${chalk.dim(msg)}`);
}

/** Render a join/leave event with a divider. */
export function printPeerEvent(name, event) {
  const color = peerColor(name);
  const verb = event === 'join'
    ? chalk.green('joined the chat')
    : chalk.yellow('left the chat');
  const divider = chalk.dim('─'.repeat(36));
  process.stdout.write('\r\x1b[K');
  console.log(`${divider} ${color.bold(name)} ${verb} ${divider}`);
  if (_rl) _rl.prompt(true);
}

/** Render a join-request approval prompt (inlined in the stream). */
export function printJoinRequest(name, ip, port) {
  const divider = chalk.dim('─'.repeat(36));
  process.stdout.write('\r\x1b[K');
  console.log('');
  console.log(`${divider} ${chalk.yellow('⚑ Join Request')} ${divider}`);
  console.log(`  ${chalk.yellow.bold(name)} ${chalk.dim(`(${ip}:${port})`)} wants to join ${chalk.cyan('#' + _room)}`);
  process.stdout.write(`  Accept? ${chalk.green('[y]')}${chalk.dim('/')}${chalk.red('[N]')} `);
}

/** Render a nuke warning received from a peer. */
export function printNukeWarning(from) {
  process.stdout.write('\r\x1b[K');
  console.log('');
  console.log(chalk.red.bold('  💥 NUKED by ' + from + ' — room is being destroyed'));
  console.log(chalk.red('  You will be disconnected in 2 seconds...'));
  console.log('');
  if (_rl) _rl.prompt(true);
}

// ── /list output ──────────────────────────────────────────────────────────────
export function printPeerList(peers) {
  process.stdout.write('\r\x1b[K');
  console.log('');
  const total = peers.length + 1; // +1 for self
  console.log(`  ${chalk.bold(`Room #${_room}`)}  ${chalk.dim(`(${total} online)`)}`);
  console.log(chalk.dim('  ' + '─'.repeat(40)));

  // Self always first
  const selfColor = peerColor(_myName);
  const selfLabel = selfColor.bold(_myName.padEnd(16));
  const selfAddr = chalk.dim(`${_myIP}:${_myPort}`);
  const selfEnc = _encrypted ? chalk.green(' 🔒') : '';
  console.log(`  ${chalk.cyan('●')} ${selfLabel} ${selfAddr}${selfEnc} ${chalk.cyan('(you)')}`);

  for (const p of peers) {
    const color = peerColor(p.name);
    const name = color.bold(p.name.padEnd(16));
    const addr = chalk.dim(`${p.ip}:${p.port}`);
    const dot = chalk.green('●');
    console.log(`  ${dot} ${name} ${addr}`);
  }
  console.log('');
  if (peers.length === 0) {
    console.log(chalk.dim('  Waiting for others to join this room...'));
    console.log('');
  }
  if (_rl) _rl.prompt(true);
}

// ── /help output ─────────────────────────────────────────────────────────────
export function printHelp() {
  process.stdout.write('\r\x1b[K');
  console.log('');
  console.log(`  ${chalk.bold('Commands')}`);
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  const cmds = [
    ['/list', 'Show all online peers (includes you)'],
    ['/msg <name> <text>', 'Send a direct message'],
    ['/ping [name]', 'Check peer latency (omit name = all)'],
    ['/status', 'Show room status'],
    ['/nuke', 'Kick all peers and destroy the room'],
    ['/help', 'Show this help text'],
    ['/quit', 'Exit gracefully (notifies peers)'],
    ['<text>', 'Broadcast to all peers'],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${chalk.cyan(cmd.padEnd(22))} ${chalk.dim(desc)}`);
  }
  console.log('');
  if (_rl) _rl.prompt(true);
}

// ── /ping result ─────────────────────────────────────────────────────────────
export function printPingResult(name, latencyMs, alive) {
  const color = peerColor(name);
  const nameStr = color.bold(name.padEnd(16));
  if (!alive) {
    print(`  ${chalk.red('✖')} ${nameStr} ${chalk.red('unreachable')}`);
    return;
  }
  const bar = latencyMs < 10 ? chalk.green('▓▓▓')
    : latencyMs < 50 ? chalk.yellow('▓▓░')
      : chalk.red('▓░░');
  print(`  ${chalk.green('✓')} ${nameStr} ${chalk.dim('──')} ${chalk.white(latencyMs + 'ms')} ${bar}`);
}

// ── /status output ────────────────────────────────────────────────────────────
export function printStatus(peers) {
  const uptime = Math.floor((Date.now() - _startTime) / 1000);
  const mins = Math.floor(uptime / 60);
  const secs = uptime % 60;
  const uptimeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  process.stdout.write('\r\x1b[K');
  console.log('');
  console.log(`  ${chalk.bold('Room Status')}`);
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  console.log(`  ${chalk.dim('Room:')}      ${chalk.cyan('#' + _room)}`);
  console.log(`  ${chalk.dim('Peers:')}     ${chalk.white(peers.length + 1)} ${chalk.dim('(including you)')}`);
  console.log(`  ${chalk.dim('Uptime:')}    ${chalk.white(uptimeStr)}`);
  console.log(`  ${chalk.dim('Your IP:')}   ${chalk.white(_myIP + ':' + _myPort)}`);
  console.log(`  ${chalk.dim('Security:')}  ${_encrypted
    ? chalk.green('● E2E encrypted  🔒')
    : chalk.yellow('◌ Unencrypted (waiting for key exchange)')}`);
  console.log('');
  if (_rl) _rl.prompt(true);
}

// ── Prompt management ─────────────────────────────────────────────────────────
function buildPrompt() {
  const roomLabel = chalk.cyan(`#${_room}`);
  const encIcon = _encrypted ? chalk.green('🔒') : '';
  if (_peerCount === 0) {
    return `${roomLabel} ${encIcon} ${chalk.dim('[no peers]')} ${chalk.green('›')} `;
  }
  const peerLabel = _peerCount === 1 ? '1 peer' : `${_peerCount} peers`;
  return `${roomLabel} ${encIcon} ${chalk.green(`[${peerLabel}]`)} ${chalk.green('›')} `;
}

export function updatePrompt(peerCount) {
  _peerCount = peerCount;
  if (_rl) {
    _rl.setPrompt(buildPrompt());
    process.stdout.write('\r\x1b[K');
    _rl.prompt(true);
  }
}

// ── Live Status Bar ───────────────────────────────────────────────────────────
/**
 * Starts a persistent status bar rendered one line below the prompt.
 * Uses ANSI cursor-save/restore to avoid disrupting input.
 * @param {function} getInfo - Returns { peerCount, encrypted, room }
 */
export function startStatusBar(getInfo) {
  _getStatusInfo = getInfo;
  _statusTimer = setInterval(() => _redrawStatusBar(), 3000);
}

export function stopStatusBar() {
  if (_statusTimer) {
    clearInterval(_statusTimer);
    _statusTimer = null;
  }
  // Clear last status bar line
  process.stdout.write('\x1b[s\x1b[1B\r\x1b[K\x1b[u');
}

function _redrawStatusBar() {
  if (!_getStatusInfo) return;
  const { peerCount, encrypted, room } = _getStatusInfo();
  const uptime = Math.floor((Date.now() - _startTime) / 1000);
  const mins = Math.floor(uptime / 60);
  const secs = uptime % 60;
  const uptimeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const encStr = encrypted
    ? chalk.green('● encrypted')
    : chalk.yellow('◌ unencrypted');
  const peers = peerCount === 1 ? '1 peer' : `${peerCount} peers`;

  const bar = chalk.dim(
    `  #${room} · ${peers} · uptime ${uptimeStr} · ${encStr}`
  );

  // Save cursor → move down 1 line → clear line → write bar → restore cursor
  process.stdout.write(`\x1b[s\x1b[1B\r\x1b[K${bar}\x1b[u`);
}

// ── Banner ────────────────────────────────────────────────────────────────────
export function printBanner(myName, myIP, myTcpPort, myRoom, isCreator) {
  const nameColor = peerColor(myName);
  const roleLabel = isCreator ? chalk.green('Creator') : chalk.cyan('Member');
  console.log('');
  console.log(chalk.bold.hex('#B8A9FF')('  ╔══════════════════════════════════════╗'));
  console.log(chalk.bold.hex('#B8A9FF')('  ║') + chalk.bold('       LAN Chat  ·  Version 2         ') + chalk.bold.hex('#B8A9FF')('║'));
  console.log(chalk.bold.hex('#B8A9FF')('  ╚══════════════════════════════════════╝'));
  console.log('');
  console.log(`  ${chalk.dim('You are')}  ${nameColor.bold(myName)} ${chalk.dim(`(${roleLabel}${chalk.dim(')')}`)}`)
  console.log(`  ${chalk.dim('Room:')}    ${chalk.cyan(`#${myRoom}`)}`);
  console.log(`  ${chalk.dim('IP:')}      ${chalk.white(myIP)} ${chalk.dim(`:${myTcpPort}`)}`);
  console.log(`  ${chalk.dim('Status:')}  ${chalk.green('●')} ${chalk.green('Auto-discovery active')}`);
  console.log(`  ${chalk.dim('Security:')} ${isCreator
    ? chalk.green('● Room key generated — approving joiners')
    : chalk.yellow('◌ Requesting key from room creator...')}`);
  console.log('');
  console.log(`  ${chalk.dim('Tab-complete commands and peer names. Type')} ${chalk.cyan('/help')} ${chalk.dim('for commands.')}`);
  console.log('');
}
