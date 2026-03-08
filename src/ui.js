/**
 * ui.js — Centralized Terminal UI Module (v3 — Split-Screen)
 *
 * Layout (ANSI scroll-region approach):
 *
 *   ┌─────────────────────────────────────┐  ← row 1
 *   │                                     │
 *   │   CHAT AREA  (scrollable region)    │
 *   │                                     │
 *   ├─────────────────────────────────────┤  ← row H-2  (separator)
 *   │  STATUS BAR                         │  ← row H-1
 *   │  PROMPT ›                           │  ← row H    (readline input)
 *   └─────────────────────────────────────┘
 *
 * The scroll region is set to rows [1, H-2] so all normal output
 * stays inside the chat area and the bottom 2 rows are always visible.
 * When the terminal is resized, we reconfigure the scroll region.
 *
 * No external dependencies beyond chalk.
 */

import chalk from 'chalk';

// ── Internal state ─────────────────────────────────────────────────────────────
let _rl = null;
let _peerCount = 0;
let _room = 'general';
let _myName = 'You';
let _myIP = '';
let _myPort = 0;
let _encrypted = false;
let _startTime = Date.now();
let _statusTimer = null;
let _getStatusInfo = null;

// ── Terminal geometry ──────────────────────────────────────────────────────────
function rows() { return process.stdout.rows || 24; }
function cols() { return process.stdout.columns || 80; }

// ── ANSI helpers ───────────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;
/** Move cursor to absolute row, col (1-indexed). */
const moveTo = (r, c) => `${CSI}${r};${c}H`;
/** Save cursor position. */
const saveCur = () => process.stdout.write(`${ESC}7`);
/** Restore cursor position. */
const restCur = () => process.stdout.write(`${ESC}8`);
/** Set scroll region to rows [top, bot] (1-indexed). */
const scrollRegion = (top, bot) => process.stdout.write(`${CSI}${top};${bot}r`);
/** Reset scroll region to full terminal. */
const resetScrollRegion = () => process.stdout.write(`${CSI}r`);
/** Clear to end of line. */
const clrEOL = () => `${CSI}K`;
/** Erase entire line at current row. */
const clrLine = (r) => `${moveTo(r, 1)}${CSI}2K`;

// ── Layout constants ───────────────────────────────────────────────────────────
/** Row of the separator line (second-to-last). */
function rowSep() { return rows() - 1; }
/** Row of the status bar. */
function rowStatus() { return rows() - 1; }
/** Row of the input prompt (very last). */
function rowPrompt() { return rows(); }

// ── Setup / teardown ───────────────────────────────────────────────────────────
function setupLayout() {
  const H = rows();
  // Set scroll region: rows 1 … H-2 (chat area)
  scrollRegion(1, H - 2);
  // Draw separator
  _drawSeparator();
  // Position cursor at bottom of chat area (so new output flows there)
  process.stdout.write(moveTo(H - 2, 1));
}

function teardownLayout() {
  resetScrollRegion();
  // Move to last row and leave a clean line
  process.stdout.write(moveTo(rows(), 1));
}

function _drawSeparator() {
  const line = chalk.dim('─'.repeat(cols()));
  process.stdout.write(`${ESC}7${moveTo(rowSep(), 1)}${CSI}2K${line}${ESC}8`);
}

// ── Peer color palette ─────────────────────────────────────────────────────────
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

// ── URL regex ──────────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s]+/g;

function formatText(text) {
  return text.replace(URL_RE, (url) => {
    const link = `\x1b]8;;${url}\x1b\\${chalk.cyan.underline(url)}\x1b]8;;\x1b\\`;
    return link;
  });
}

// ── Init ───────────────────────────────────────────────────────────────────────
/**
 * Must be called once after readline is created and room is known.
 */
export function init(rl, identity = {}) {
  _rl = rl;
  _room = identity.room || 'general';
  _myName = identity.name || 'You';
  _myIP = identity.ip || '';
  _myPort = identity.port || 0;
  _startTime = Date.now();

  setupLayout();

  // Reconfigure on resize
  process.stdout.on('resize', () => {
    setupLayout();
    _redrawStatusBar();
    _redrawPrompt();
  });
}

/** Mark whether messages are E2E encrypted. */
export function setEncrypted(val) {
  _encrypted = !!val;
  _redrawStatusBar();
}

// ── Core print helper ──────────────────────────────────────────────────────────
/**
 * Print a line into the CHAT AREA only.
 * Saves cursor → moves into scroll region → writes → restores prompt.
 */
function print(line) {
  const H = rows();
  const chatBottom = H - 2;

  // Save cursor
  process.stdout.write(`${ESC}7`);
  // Move to bottom of chat area, ensure we're inside the scroll region
  process.stdout.write(moveTo(chatBottom, 1));
  // Scroll up one line (the scroll region will shift content up)
  process.stdout.write('\n');
  // Go to the new last line of the chat area and write content
  process.stdout.write(`\r${clrEOL()}${line}`);
  // Restore cursor (back to the prompt row and position)
  process.stdout.write(`${ESC}8`);

  // Redraw prompt to keep it clean (readline may have cleared it)
  _redrawPrompt();
}

// ── Message renderers ──────────────────────────────────────────────────────────
export function printMessage(from, text) {
  const time = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const color = peerColor(from);
  const sender = color.bold(from);
  const body = formatText(chalk.white(text));
  const enc = _encrypted ? chalk.dim(' 🔒') : '';
  print(`${time} ${sender}:${enc} ${body}`);
}

export function printOwnMessage(text, target = 'All') {
  const time = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const label = chalk.dim(`You → ${target}`);
  const body = formatText(chalk.dim(text));
  print(`${time} ${label}: ${body}`);
}

export function printSystem(msg, level = 'info') {
  const icon = level === 'error' ? chalk.red('✖')
    : level === 'warn' ? chalk.yellow('⚠')
      : chalk.dim('◆');
  print(`${icon} ${chalk.dim(msg)}`);
}

export function printPeerEvent(name, event) {
  const color = peerColor(name);
  const verb = event === 'join'
    ? chalk.green('joined the chat')
    : chalk.yellow('left the chat');
  const divider = chalk.dim('─'.repeat(36));
  print(`${divider} ${color.bold(name)} ${verb} ${divider}`);
}

export function printJoinRequest(name, ip, port) {
  const divider = chalk.dim('─'.repeat(36));
  print('');
  print(`${divider} ${chalk.yellow('⚑ Join Request')} ${divider}`);
  print(`  ${chalk.yellow.bold(name)} ${chalk.dim(`(${ip}:${port})`)} wants to join ${chalk.cyan('#' + _room)}`);
  print(`  Accept? ${chalk.green('[y]')}${chalk.dim('/')}${chalk.red('[N]')} `);
}


export function printNukeWarning(from) {
  print('');
  print(chalk.red.bold('  💥 NUKED by ' + from + ' — room is being destroyed'));
  print(chalk.red('  You will be disconnected in 2 seconds...'));
  print('');
}

// ── /list output ───────────────────────────────────────────────────────────────
export function printPeerList(peers) {
  print('');
  const total = peers.length + 1;
  print(`  ${chalk.bold(`Room #${_room}`)}  ${chalk.dim(`(${total} online)`)}`);
  print(chalk.dim('  ' + '─'.repeat(40)));

  const selfColor = peerColor(_myName);
  const selfLabel = selfColor.bold(_myName.padEnd(16));
  const selfAddr = chalk.dim(`${_myIP}:${_myPort}`);
  const selfEnc = _encrypted ? chalk.green(' 🔒') : '';
  print(`  ${chalk.cyan('●')} ${selfLabel} ${selfAddr}${selfEnc} ${chalk.cyan('(you)')}`);

  for (const p of peers) {
    const color = peerColor(p.name);
    const name = color.bold(p.name.padEnd(16));
    const addr = chalk.dim(`${p.ip}:${p.port}`);
    print(`  ${chalk.green('●')} ${name} ${addr}`);
  }
  print('');
  if (peers.length === 0) {
    print(chalk.dim('  Waiting for others to join this room...'));
    print('');
  }
}

// ── /help output ───────────────────────────────────────────────────────────────
export function printHelp() {
  print('');
  print(`  ${chalk.bold('Commands')}`);
  print(chalk.dim('  ' + '─'.repeat(40)));
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
    print(`  ${chalk.cyan(cmd.padEnd(22))} ${chalk.dim(desc)}`);
  }
  print('');
}

// ── /ping result ───────────────────────────────────────────────────────────────
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

// ── /status output ─────────────────────────────────────────────────────────────
export function printStatus(peers) {
  const uptime = Math.floor((Date.now() - _startTime) / 1000);
  const mins = Math.floor(uptime / 60);
  const secs = uptime % 60;
  const uptimeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  print('');
  print(`  ${chalk.bold('Room Status')}`);
  print(chalk.dim('  ' + '─'.repeat(40)));
  print(`  ${chalk.dim('Room:')}      ${chalk.cyan('#' + _room)}`);
  print(`  ${chalk.dim('Peers:')}     ${chalk.white(peers.length + 1)} ${chalk.dim('(including you)')}`);
  print(`  ${chalk.dim('Uptime:')}    ${chalk.white(uptimeStr)}`);
  print(`  ${chalk.dim('Your IP:')}   ${chalk.white(_myIP + ':' + _myPort)}`);
  print(`  ${chalk.dim('Security:')}  ${_encrypted
    ? chalk.green('● E2E encrypted  🔒')
    : chalk.yellow('◌ Unencrypted (waiting for key exchange)')}`);
  print('');
}

// ── Prompt management ──────────────────────────────────────────────────────────
function buildPrompt() {
  const roomLabel = chalk.cyan(`#${_room}`);
  const encIcon = _encrypted ? chalk.green(' 🔒') : '';
  if (_peerCount === 0) {
    return `${roomLabel}${encIcon} ${chalk.dim('[no peers]')} ${chalk.green('›')} `;
  }
  const peerLabel = _peerCount === 1 ? '1 peer' : `${_peerCount} peers`;
  return `${roomLabel}${encIcon} ${chalk.green(`[${peerLabel}]`)} ${chalk.green('›')} `;
}

/** Redraw the readline prompt anchored to the last row. */
function _redrawPrompt() {
  if (!_rl) return;
  _rl.setPrompt(buildPrompt());

  // Move cursor to the last row before letting readline redraw itself
  process.stdout.write(moveTo(rowPrompt(), 1));
  _rl.prompt(true);
}

export function updatePrompt(peerCount) {
  _peerCount = peerCount;
  _redrawPrompt();
}

// ── Live Status Bar ────────────────────────────────────────────────────────────
export function startStatusBar(getInfo) {
  _getStatusInfo = getInfo;
  _redrawStatusBar();
  _statusTimer = setInterval(() => _redrawStatusBar(), 3000);
}

export function stopStatusBar() {
  if (_statusTimer) {
    clearInterval(_statusTimer);
    _statusTimer = null;
  }
  // Erase the status row
  process.stdout.write(`${ESC}7${clrLine(rowStatus())}${ESC}8`);
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

  const content = `  ${chalk.cyan('#' + room)} ${chalk.dim('·')} ${chalk.white(peers)} ${chalk.dim('·')} uptime ${chalk.white(uptimeStr)} ${chalk.dim('·')} ${encStr}`;

  // Save cursor → jump to status row → clear → write → separator above → restore
  process.stdout.write(
    `${ESC}7` +
    `${moveTo(rowStatus(), 1)}${CSI}2K${content}` +
    `${ESC}8`
  );
}

// ── Banner ─────────────────────────────────────────────────────────────────────
export function printBanner(myName, myIP, myTcpPort, myRoom, isCreator) {
  const nameColor = peerColor(myName);
  const roleLabel = isCreator ? chalk.green('Creator') : chalk.cyan('Member');
  print('');
  print(chalk.bold.hex('#B8A9FF')('  ╔══════════════════════════════════════╗'));
  print(chalk.bold.hex('#B8A9FF')('  ║') + chalk.bold('       LAN Chat  ·  Version 2         ') + chalk.bold.hex('#B8A9FF')('║'));
  print(chalk.bold.hex('#B8A9FF')('  ╚══════════════════════════════════════╝'));
  print('');
  print(`  ${chalk.dim('You are')}  ${nameColor.bold(myName)} ${chalk.dim('(')}${roleLabel}${chalk.dim(')')}`);
  print(`  ${chalk.dim('Room:')}    ${chalk.cyan(`#${myRoom}`)}`);
  print(`  ${chalk.dim('IP:')}      ${chalk.white(myIP)} ${chalk.dim(`:${myTcpPort}`)}`);
  print(`  ${chalk.dim('Status:')}  ${chalk.green('●')} ${chalk.green('Auto-discovery active')}`);
  print(`  ${chalk.dim('Security:')} ${isCreator
    ? chalk.green('● Room key generated — approving joiners')
    : chalk.yellow('◌ Requesting key from room creator...')}`);
  print('');
  print(`  ${chalk.dim('Tab-complete commands and peer names. Type')} ${chalk.cyan('/help')} ${chalk.dim('for commands.')}`);
  print('');
}
