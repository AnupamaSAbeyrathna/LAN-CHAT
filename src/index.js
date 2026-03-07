#!/usr/bin/env node

/**
 * index.js — Entry Point (Phase 1 + 2 + 3)
 *
 * Phase 3 additions:
 *  - Tab-completion for commands and peer names
 *  - Dynamic prompt showing live peer count: [2 peers] ›
 *  - All rendering via ui.js (colors, formatting, peer events)
 *  - /help command
 *  - /msg <name> works case-insensitively
 *  - Graceful SIGINT (Ctrl+C) handling
 *
 * Usage:
 *   node src/index.js --name Alice
 *   node src/index.js --name Bob --port 9002    ← same-machine testing
 */

import readline from 'readline';
import os from 'os';
import { parseArgs } from 'node:util';
import { startServer } from './server.js';
import { startDiscovery } from './discovery.js';
import { getAllPeers, upsertPeer } from './peers.js';
import { sendMessage, broadcastMessage, sendLeave } from './sender.js';
import * as ui from './ui.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────
const { values: cliArgs } = parseArgs({
  options: {
    name: { type: 'string', default: 'User' },
    port: { type: 'string', default: '9001' },
  },
  strict: false,
});

const myName = cliArgs.name;
const myTcpPort = parseInt(cliArgs.port, 10);

// ── Validate name ─────────────────────────────────────────────────────────────
if (!myName || myName.trim().length === 0 || myName.length > 32) {
  console.error('  ✖ Name must be 1–32 non-empty characters.');
  console.error('    Usage: node src/index.js --name <YourName>');
  process.exit(1);
}

if (/[^\w\-.]/.test(myName)) {
  console.error('  ✖ Name may only contain letters, numbers, hyphens, underscores, and dots.');
  process.exit(1);
}

// ── Local IP ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return '127.0.0.1';
}

const myIP = getLocalIP();

<<<<<<< HEAD
=======
// ── Crypto state ──────────────────────────────────────────────────────────────
let roomKey = null;     // Buffer | null
let isCreator = false;
let hasSentMessage = false; // true once we've encrypted+sent at least one message

function activateKey(key) {
  roomKey = key;
  senderSetKey(key);
  serverSetKey(key, decrypt);
  ui.setEncrypted(true);
  discovery.updateFingerprint(fingerprint(roomKey));
  ui.printSystem(`🔒 E2E encryption active (key fingerprint: ${fingerprint(key)})`, 'info');
}

// ── Room name validation ───────────────────────────────────────────────────────
function isValidRoom(r) {
  return r.length >= 1 && r.length <= 32 && /^[\w-]+$/.test(r);
}

>>>>>>> c94564b (Update discovery and index)
// ── Tab completer ─────────────────────────────────────────────────────────────
const BASE_COMMANDS = ['/list', '/msg ', '/help', '/quit'];

function tabCompleter(line) {
  // Complete peer name after "/msg "
  if (line.startsWith('/msg ')) {
    const partial = line.slice(5);
    const peers = getAllPeers();
    const hits = peers
      .filter((p) => p.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map((p) => `/msg ${p.name} `);
    return [hits.length ? hits : [], line];
  }

  // Complete base commands
  const hits = BASE_COMMANDS.filter((c) => c.startsWith(line));
  return [hits.length ? hits : BASE_COMMANDS, line];
}

// ── Readline ──────────────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '',           // set properly below after ui.init()
  completer: tabCompleter,
});

// Connect ui module to the readline instance
ui.init(rl);

// ── Peer event callbacks ──────────────────────────────────────────────────────
function onPeerJoined(peer) {
  ui.printPeerEvent(peer.name, 'join');
  ui.updatePrompt(getAllPeers().length);
}

function onPeerLeft(peer) {
  ui.printPeerEvent(peer.name, 'leave');
  ui.updatePrompt(getAllPeers().length);
}

// Called by server.js when a TCP message carries a port we haven't seen via UDP.
// This is the fallback path when UDP broadcast is blocked (firewall, AP isolation).
function onPeerSeen(ip, port, name) {
  const isNew = upsertPeer(ip, port, name);
  if (isNew) onPeerJoined({ ip, port, name });
}

<<<<<<< HEAD
=======
// ── Key exchange (creator side) ───────────────────────────────────────────────
async function onJoinRequest(ip, port, name) {
  ui.printJoinRequest(name, ip, port);

  // Read a single character answer from stdin
  const answer = await new Promise((resolve) => {
    rl.once('line', (line) => resolve(line.trim().toLowerCase()));
  });

  if (answer === 'y' || answer === 'yes') {
    try {
      await sendKeyGrant(ip, port, roomKey);
      // Now register them as a full peer
      const isNew = upsertPeer(ip, port, name);
      if (isNew) onPeerJoined({ ip, port, name });
      ui.printSystem(`✓ ${name} joined the room`, 'info');
    } catch (err) {
      ui.printSystem(`Failed to send key to ${name}: ${err.message}`, 'error');
    }
  } else {
    ui.printSystem(`${name}'s join request denied.`, 'warn');
  }
  ui.updatePrompt(getAllPeers().length);
}

// ── Key exchange (joiner side) — called when onKeyGrant received ──────────────
function onKeyGrant(hexKey) {
  // If we self-elected as creator AND have already sent encrypted messages,
  // we can't safely re-key mid-session — ignore the late grant.
  if (isCreator && roomKey && hasSentMessage) return;

  // If we self-elected but haven't sent anything yet, the self-generated key
  // was never shared with anyone — safe to replace it with the real creator's key.
  if (isCreator && roomKey && !hasSentMessage) {
    ui.printSystem('⚠ Late key-grant received — upgrading to creator\'s key.', 'warn');
  }

  const key = hexToKey(hexKey);
  roomKey = key;
  isCreator = false;
  activateKey(key);
  ui.printSystem('🔒 Key received — E2E encryption active!', 'info');
  ui.updatePrompt(getAllPeers().length);
}

// ── Joiner sees existing creator in discovery → send join-request ─────────────
async function onJoinRequestNeeded(ip, port) {
  // Mark as joiner immediately so we don't race-generate a key
  isCreator = false;

  try {
    await sendJoinRequest(ip, port, myName, myTcpPort);
    ui.printSystem(`Join request sent — waiting for approval...`, 'info');
  } catch {
    ui.printSystem(`Could not reach room creator at ${ip}:${port}`, 'warn');
  }
}

// ── Dual-creator conflict: we lost the nodeId tiebreak — yield to the winner ─────
async function onCreatorConflict(ip, port) {
  if (hasSentMessage) {
    // We've already sent encrypted messages with our key — can't safely re-key.
    // Log a warning and stay put; the other side will also stay as creator.
    ui.printSystem('⚠ Creator conflict detected but messages already sent — staying as creator.', 'warn');
    return;
  }

  ui.printSystem(`⚠ Simultaneous start detected — yielding creator role, requesting key...`, 'warn');

  // Reset crypto state: clear our self-generated key from all modules
  roomKey = null;
  isCreator = false;
  senderSetKey(null);
  serverSetKey(null, null);
  ui.setEncrypted(false);
  discovery.updateFingerprint(null);

  // Now send a join-request to the true creator
  try {
    await sendJoinRequest(ip, port, myName, myTcpPort);
    ui.printSystem(`Join request sent — waiting for approval...`, 'info');
  } catch {
    ui.printSystem(`Could not reach room creator at ${ip}:${port}`, 'warn');
  }
}

// ── Nuke handler ──────────────────────────────────────────────────────────────
async function onNuke(from) {
  ui.printNukeWarning(from);
  await new Promise((r) => setTimeout(r, 2000));
  await quit(false);
}

>>>>>>> c94564b (Update discovery and index)
// ── Graceful exit ─────────────────────────────────────────────────────────────
async function quit() {
  ui.printSystem('Notifying peers and exiting...');
  const peers = getAllPeers();
  await Promise.allSettled(
    peers.map((p) => sendLeave(p.ip, p.port, myName, myTcpPort))
  );
  discovery.stop();
  ui.printSystem('Goodbye! 👋');
  rl.close();
  process.exit(0);
}

// Ctrl+C graceful exit
rl.on('SIGINT', quit);

// ── Start services ────────────────────────────────────────────────────────────
startServer(myTcpPort, onPeerLeft, onPeerSeen);
const discovery = startDiscovery(myName, myTcpPort, onPeerJoined, onPeerLeft);

<<<<<<< HEAD
// ── Banner + initial prompt ───────────────────────────────────────────────────
ui.printBanner(myName, myIP, myTcpPort);
ui.updatePrompt(0);
=======
const discovery = startDiscovery(
  myName, myTcpPort, myRoom,
  null,              // no fingerprint yet — we don't have a key yet
  onPeerJoined, onPeerLeft,
  onJoinRequestNeeded,
  onCreatorConflict,
);

// Phase 2: creator election — wait 5s to hear from an existing creator.
// If no key-grant arrives in this window, we ARE the creator.
// 5s gives the creator enough time to see the join-request prompt and approve it.
ui.printSystem('Listening for existing room creator (5s)...', 'info');
await new Promise((resolve) => setTimeout(resolve, 5000));

if (!roomKey) {
  // No one sent us a key → we are the first in this room → become creator
  isCreator = true;
  roomKey = generateRoomKey();
  activateKey(roomKey);
  ui.printSystem(`Room created. Key fingerprint: ${fingerprint(roomKey)}`, 'info');
}

// ── Banner + status bar ───────────────────────────────────────────────────────
ui.printBanner(myName, myIP, myTcpPort, myRoom, isCreator);
ui.updatePrompt(getAllPeers().length);
ui.startStatusBar(() => ({
  room: myRoom,
  peerCount: getAllPeers().length,
  encrypted: !!roomKey,
}));
>>>>>>> c94564b (Update discovery and index)

// ── Command loop ──────────────────────────────────────────────────────────────
rl.on('line', async (line) => {
  const input = line.trim();

  if (!input) {
    rl.prompt();
    return;
  }

  // ── /list ──────────────────────────────────────────────────────────────────
  if (input === '/list') {
    ui.printPeerList(getAllPeers());

    // ── /help ──────────────────────────────────────────────────────────────────
  } else if (input === '/help') {
    ui.printHelp();

    // ── /msg <name> <text> ─────────────────────────────────────────────────────
  } else if (input.startsWith('/msg ')) {
    const rest = input.slice(5).trim();
    const space = rest.indexOf(' ');

    if (space === -1) {
      ui.printSystem('Usage: /msg <name> <message>', 'error');
    } else {
      const targetName = rest.slice(0, space).trim();
      const text = rest.slice(space + 1).trim();
      const peer = getAllPeers().find(
        (p) => p.name.toLowerCase() === targetName.toLowerCase()
      );

      if (!peer) {
        ui.printSystem(`No peer named "${targetName}" is online. Use /list to see peers.`, 'error');
      } else {
        try {
          await sendMessage(peer.ip, peer.port, myName, myTcpPort, text);
          hasSentMessage = true;
          ui.printOwnMessage(text, peer.name);
        } catch (err) {
          ui.printSystem(`Failed to reach ${peer.name}: ${err.message}`, 'error');
        }
      }
    }

    // ── /quit ──────────────────────────────────────────────────────────────────
  } else if (input === '/quit') {
    await quit();

    // ── Unknown command ────────────────────────────────────────────────────────
  } else if (input.startsWith('/')) {
    ui.printSystem(`Unknown command "${input}". Type /help to see available commands.`, 'error');

    // ── Broadcast ─────────────────────────────────────────────────────────────
  } else {
    const peers = getAllPeers();
    if (peers.length === 0) {
      ui.printSystem('No peers online. Your message will be delivered once others join.', 'warn');
    } else {
      await broadcastMessage(peers, myName, myTcpPort, input);
      hasSentMessage = true;
      ui.printOwnMessage(input, 'All');
    }
  }

  // Always repaint prompt after any command
  ui.updatePrompt(getAllPeers().length);
});

rl.on('close', () => process.exit(0));
