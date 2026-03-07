/**
 * ui.js — Centralized Terminal UI Module
 *
 * Responsibilities:
 *  - Consistent, color-coded message rendering
 *  - Safe "print without clobbering the readline prompt" pattern
 *  - Stable per-peer color assignment (hash-based from a curated palette)
 *  - Dynamic prompt showing live peer count
 *  - /list and /help output formatting
 *  - Startup banner
 */

import chalk from 'chalk';

// ── Internal state ────────────────────────────────────────────────────────────
let _rl = null;   // set via init()
let _peerCount = 0;

// ── Peer color palette ────────────────────────────────────────────────────────
// Each peer gets a deterministic color based on their name hash.
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

/**
 * Returns a stable chalk color function for a given peer name.
 */
export function peerColor(name) {
  if (!colorCache.has(name)) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
    colorCache.set(name, COLOR_PALETTE[hash % COLOR_PALETTE.length]);
  }
  return colorCache.get(name);
}

// ── Init ──────────────────────────────────────────────────────────────────────
/**
 * Must be called once after the readline interface is created.
 */
export function init(rl) {
  _rl = rl;
}

// ── Core print helper ─────────────────────────────────────────────────────────
/**
 * Safely prints a line by first wiping the current readline prompt,
 * then printing, then restoring the prompt.
 */
function print(line) {
  process.stdout.write('\r\x1b[K');
  console.log(line);
  if (_rl) _rl.prompt(true);
}

// ── Message renderers ─────────────────────────────────────────────────────────
/**
 * Render a message received from another peer.
 */
export function printMessage(from, text) {
  const time = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const color = peerColor(from);
  const sender = color.bold(from);
  print(`${time} ${sender}: ${chalk.white(text)}`);
}

/**
 * Render a message you just sent (echoed back to your own screen).
 * @param {string} text   - Message text
 * @param {string} target - Display target: 'All' or a peer name
 */
export function printOwnMessage(text, target = 'All') {
  const time = chalk.dim(`[${new Date().toLocaleTimeString()}]`);
  const label = chalk.dim(`You → ${target}`);
  print(`${time} ${label}: ${chalk.dim(text)}`);
}

/**
 * Render a system notice (join, leave, errors, etc.)
 * @param {string} msg   - The message to show
 * @param {'info'|'warn'|'error'} level
 */
export function printSystem(msg, level = 'info') {
  const icon = level === 'error' ? chalk.red('✖') :
    level === 'warn' ? chalk.yellow('⚠') :
      chalk.dim('◆');
  print(`${icon} ${chalk.dim(msg)}`);
}

/**
 * Render a join/leave notice with a subtle horizontal divider.
 */
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

// ── /list output ──────────────────────────────────────────────────────────────
export function printPeerList(peers) {
  if (peers.length === 0) {
    print(chalk.dim('  No peers online yet. Others will appear automatically when they join.'));
    return;
  }
  process.stdout.write('\r\x1b[K');
  console.log('');
  console.log(`  ${chalk.bold('Online Peers')}  ${chalk.dim(`(${peers.length} total)`)}`);
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  for (const p of peers) {
    const color = peerColor(p.name);
    const name = color.bold(p.name.padEnd(16));
    const addr = chalk.dim(`${p.ip}:${p.port}`);
    const dot = chalk.green('●');
    console.log(`  ${dot} ${name} ${addr}`);
  }
  console.log('');
  if (_rl) _rl.prompt(true);
}

// ── /help output ─────────────────────────────────────────────────────────────
export function printHelp() {
  process.stdout.write('\r\x1b[K');
  console.log('');
  console.log(`  ${chalk.bold('Commands')}`);
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  const cmds = [
    ['/list', 'Show all online peers'],
    ['/msg <name> <text>', 'Send a direct message to a peer'],
    ['/help', 'Show this help text'],
    ['/quit', 'Exit gracefully (notifies peers)'],
    ['<text>', 'Broadcast to all online peers'],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${chalk.cyan(cmd.padEnd(22))} ${chalk.dim(desc)}`);
  }
  console.log('');
  if (_rl) _rl.prompt(true);
}

// ── Prompt management ─────────────────────────────────────────────────────────
function buildPrompt() {
  if (_peerCount === 0) {
    return `${chalk.dim('[no peers]')} ${chalk.green('›')} `;
  }
  const label = _peerCount === 1 ? '1 peer' : `${_peerCount} peers`;
  return `${chalk.green(`[${label}]`)} ${chalk.green('›')} `;
}

/**
 * Update the prompt to reflect the current peer count.
 * Call this whenever a peer joins or leaves.
 */
export function updatePrompt(peerCount) {
  _peerCount = peerCount;
  if (_rl) {
    _rl.setPrompt(buildPrompt());
    // Only repaint if we're at an active prompt (not mid-output)
    process.stdout.write('\r\x1b[K');
    _rl.prompt(true);
  }
}

// ── Banner ────────────────────────────────────────────────────────────────────
export function printBanner(myName, myIP, myTcpPort, myRoom) {
  const nameColor = peerColor(myName);
  console.log('');
  console.log(chalk.bold.hex('#B8A9FF')('  ╔══════════════════════════════════════╗'));
  console.log(chalk.bold.hex('#B8A9FF')('  ║') + chalk.bold('       LAN Chat  ·  Version 1         ') + chalk.bold.hex('#B8A9FF')('║'));
  console.log(chalk.bold.hex('#B8A9FF')('  ╚══════════════════════════════════════╝'));
  console.log('');
  console.log(`  ${chalk.dim('You are')}  ${nameColor.bold(myName)}`);
  console.log(`  ${chalk.dim('Room:')}    ${chalk.cyan(`#${myRoom}`)}`);
  console.log(`  ${chalk.dim('IP:')}      ${chalk.white(myIP)} ${chalk.dim(`:${myTcpPort}`)}`);
  console.log(`  ${chalk.dim('Status:')}  ${chalk.green('●')} ${chalk.green('Auto-discovery active')}`);
  console.log('');
  console.log(`  ${chalk.dim('Tab-complete commands and peer names. Type')} ${chalk.cyan('/help')} ${chalk.dim('for commands.')}`);
  console.log('');
}
