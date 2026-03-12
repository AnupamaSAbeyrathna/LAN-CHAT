#!/usr/bin/env node

/**
 * index.js — Entry Point
 *
 * Features:
 *  - Named rooms with E2E AES-256-GCM encryption
 *  - Room creator generates key; joiners must be approved
 *  - Interactive room prompt when --room is not provided
 *  - Tab-completion for commands and peer names
 *  - /list (shows self), /msg, /ping, /status, /nuke, /help, /quit
 *  - Live status bar at bottom of terminal
 *  - Graceful SIGINT handling
 */

import readline from 'readline';
import os from 'os';
import { parseArgs } from 'node:util';
import { startServer, setRoomKey as serverSetKey } from '../net/server.js';
import { startDiscovery } from '../net/discovery.js';
import { getAllPeers, upsertPeer } from '../core/peers.js';
import {
  sendMessage, broadcastMessage, sendLeave,
  sendJoinRequest, sendKeyGrant, sendNuke, pingPeer,
  setRoomKey as senderSetKey,
} from '../net/sender.js';
import * as ui from '../ui/ui.js';
import {
  generateRoomKey, fingerprint, hexToKey, decrypt,
} from '../security/crypto.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────
const { values: cliArgs } = parseArgs({
  options: {
    name: { type: 'string', default: 'User' },
    port: { type: 'string', default: '9001' },
    room: { type: 'string', default: '' },
  },
  strict: false,
});

const myName = cliArgs.name;
const myTcpPort = parseInt(cliArgs.port, 10);
let myRoom = (cliArgs.room || '').toLowerCase().trim();

// ── Validate name ─────────────────────────────────────────────────────────────
if (!myName || myName.trim().length === 0 || myName.length > 32) {
  console.error('  ✖ Name must be 1–32 non-empty characters.');
  console.error('    Usage: node src/cli/index.js --name <YourName>');
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

// ── Crypto state ──────────────────────────────────────────────────────────────
let roomKey = null;      // Buffer | null
let isCreator = false;
let sentJoinRequest = false; // true once we've sent at least one join-request

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

// ── Tab completer ─────────────────────────────────────────────────────────────
const BASE_COMMANDS = ['/list', '/self', '/msg ', '/ping ', '/status', '/nuke', '/help', '/quit'];

function tabCompleter(line) {
  if (line.startsWith('/msg ') || line.startsWith('/ping ')) {
    const prefix = line.startsWith('/msg ') ? '/msg ' : '/ping ';
    const partial = line.slice(prefix.length);
    const peers = getAllPeers();
    const hits = peers
      .filter((p) => p.name.toLowerCase().startsWith(partial.toLowerCase()))
      .map((p) => `${prefix}${p.name} `);
    return [hits.length ? hits : [], line];
  }
  const hits = BASE_COMMANDS.filter((c) => c.startsWith(line));
  return [hits.length ? hits : BASE_COMMANDS, line];
}

// ── Readline ──────────────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '',
  completer: tabCompleter,
});

function isValidRoomFn(r) {
  return r.length >= 1 && r.length <= 32 && /^[\w-]+$/.test(r);
}

async function promptForRoom() {
  if (myRoom && isValidRoom(myRoom)) return;
  if (myRoom && !isValidRoom(myRoom)) {
    console.error('  ✖ Room name may only contain letters, numbers, and hyphens (1-32 chars).');
    process.exit(1);
  }

  process.stdout.write('\n');
  process.stdout.write('  ┌─ Join a Room ────────────────────────────────┐\n');
  process.stdout.write('  │  Share the same room name to chat together   │\n');
  process.stdout.write('  └──────────────────────────────────────────────┘\n');
  process.stdout.write('\n');

  return new Promise((resolve) => {
    const ask = () => {
      rl.question('  Room name [general]: ', (answer) => {
        const trimmed = answer.trim().toLowerCase() || 'general';
        if (!isValidRoomFn(trimmed)) {
          process.stdout.write('  ⚠  Only letters, numbers, hyphens allowed (1-32 chars). Try again.\n');
          ask();
        } else {
          myRoom = trimmed;
          resolve();
        }
      });
    };
    ask();
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
await promptForRoom();

// init UI before we start any services
ui.init(rl, { name: myName, ip: myIP, port: myTcpPort, room: myRoom });

// ── Peer event callbacks ──────────────────────────────────────────────────────
function onPeerJoined(peer) {
  ui.printPeerEvent(peer.name, 'join');
  ui.updatePrompt(getAllPeers().length);
}

function onPeerLeft(peer) {
  ui.printPeerEvent(peer.name, 'leave');
  ui.updatePrompt(getAllPeers().length);
}

function onPeerSeen(ip, port, name) {
  const isNew = upsertPeer(ip, port, name);
  if (isNew) onPeerJoined({ ip, port, name });
}

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
  if (isCreator && roomKey) return; // already the creator, ignore stale grants
  const key = hexToKey(hexKey);
  roomKey = key;
  isCreator = false;
  activateKey(key);
  ui.printSystem('🔒 Key received — E2E encryption active!', 'info');
  ui.updatePrompt(getAllPeers().length);
}

// ── Joiner sees existing creator in discovery → send join-request ─────────────
async function onJoinRequestNeeded(ip, port) {
  if (isCreator && roomKey) {
    // We already have a real key as creator — ignore stale triggers.
    return;
  }
  // Mark as joiner immediately so we don't race-generate a key
  isCreator = false;

  try {
    await sendJoinRequest(ip, port, myName, myTcpPort);
    sentJoinRequest = true; // prevent self-election while awaiting approval
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

// ── Graceful exit ─────────────────────────────────────────────────────────────
async function quit(notify = true) {
  if (notify) {
    ui.printSystem('Notifying peers and exiting...');
    const peers = getAllPeers();
    await Promise.allSettled(
      peers.map((p) => sendLeave(p.ip, p.port, myName, myTcpPort)),
    );
  }
  ui.stopStatusBar();
  discovery.stop();
  ui.printSystem('Goodbye! 👋');
  rl.close();
  process.exit(0);
}

rl.on('SIGINT', quit);

// ── Start services ────────────────────────────────────────────────────────────
// Phase 1: start server and discovery with NO room key yet.
// This lets us receive a key-grant from an existing room creator.
startServer(myTcpPort, onPeerLeft, onPeerSeen, onJoinRequest, onKeyGrant, onNuke);

const discovery = startDiscovery(
  myName, myTcpPort, myRoom,
  null,              // no fingerprint yet — we don't have a key yet
  onPeerJoined, onPeerLeft,
  onJoinRequestNeeded,
);

// Phase 1 (2s): Listen for an existing creator broadcasting a real fingerprint.
// If one is found, onJoinRequestNeeded() fires and we receive the key via key-grant.
ui.printSystem('Listening for existing room creator (2s)...', 'info');
await new Promise((resolve) => setTimeout(resolve, 2000));

if (!roomKey) {
  // Phase 2 (1s): No creator heard yet. Broadcast '__pending__' to signal we are
  // in the election window — any already-keyed node will immediately re-broadcast
  // its real fingerprint, which discovery catches and fires a join-request for us.
  discovery.updateFingerprint('__pending__');
  ui.printSystem('No creator found — running election (1s)...', 'info');
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!roomKey && sentJoinRequest) {
  // We sent a join-request but the key-grant hasn't arrived yet (creator is still
  // typing 'y'). Wait up to 30s for approval before falling back to creator mode.
  ui.printSystem('Awaiting key from room creator (up to 30s)...', 'info');
  await new Promise((resolve) => {
    const poll = setInterval(() => { if (roomKey) { clearInterval(poll); resolve(); } }, 200);
    setTimeout(() => { clearInterval(poll); resolve(); }, 30_000);
  });
}

if (!roomKey) {
  // Still no key → we are the first/only node → become creator.
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

// ── Command loop ──────────────────────────────────────────────────────────────
rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }

  // ── /list ──────────────────────────────────────────────────────────────────
  if (input === '/list') {
    ui.printPeerList(getAllPeers());

    // ── /help ──────────────────────────────────────────────────────────────────
  } else if (input === '/help') {
    ui.printHelp();

    // ── /status ───────────────────────────────────────────────────────────────
  } else if (input === '/status') {
    ui.printStatus(getAllPeers());

    // ── /self ────────────────────────────────────────────────────────────────
  } else if (input === '/self') {
    ui.printSelf({
      name: myName,
      room: myRoom,
      ip: myIP,
      port: myTcpPort,
      role: isCreator ? 'Creator' : 'Member',
      encrypted: !!roomKey,
      keyFingerprint: roomKey ? fingerprint(roomKey) : null,
    });

    // ── /nuke ─────────────────────────────────────────────────────────────────
  } else if (input === '/nuke') {
    if (!isCreator) {
      ui.printSystem('⛔ Only the room creator can use /nuke.', 'error');
    } else {
      const peers = getAllPeers();
      if (peers.length === 0) {
        ui.printSystem('No peers to nuke.', 'warn');
      } else {
        ui.printSystem('💥 Nuking all peers...', 'warn');
        await Promise.allSettled(
          peers.map((p) => sendNuke(p.ip, p.port, myName, myTcpPort)),
        );
        await quit(false);
      }
    }

    // ── /ping [name] ──────────────────────────────────────────────────────────
  } else if (input.startsWith('/ping')) {
    const targetName = input.slice(5).trim();
    const peers = getAllPeers();
    const targets = targetName
      ? peers.filter((p) => p.name.toLowerCase() === targetName.toLowerCase())
      : peers;

    if (targets.length === 0) {
      ui.printSystem(targetName ? `No peer named "${targetName}" online.` : 'No peers online.', 'warn');
    } else {
      for (const p of targets) {
        const { latencyMs, alive } = await pingPeer(p.ip, p.port);
        ui.printPingResult(p.name, latencyMs, alive);
      }
    }

    // ── /msg <name> <text> ────────────────────────────────────────────────────
  } else if (input.startsWith('/msg ')) {
    const rest = input.slice(5).trim();
    const space = rest.indexOf(' ');
    if (space === -1) {
      ui.printSystem('Usage: /msg <name> <message>', 'error');
    } else {
      const targetName = rest.slice(0, space).trim();
      const text = rest.slice(space + 1).trim();
      const peer = getAllPeers().find(
        (p) => p.name.toLowerCase() === targetName.toLowerCase(),
      );
      if (!peer) {
        ui.printSystem(`No peer named "${targetName}" is online. Use /list.`, 'error');
      } else {
        try {
          await sendMessage(peer.ip, peer.port, myName, myTcpPort, text);
          ui.printOwnMessage(text, peer.name);
        } catch (err) {
          ui.printSystem(`Failed to reach ${peer.name}: ${err.message}`, 'error');
        }
      }
    }

    // ── /quit ─────────────────────────────────────────────────────────────────
  } else if (input === '/quit') {
    await quit();

    // ── Unknown command ───────────────────────────────────────────────────────
  } else if (input.startsWith('/')) {
    ui.printSystem(`Unknown command "${input}". Type /help to see available commands.`, 'error');

    // ── Broadcast ─────────────────────────────────────────────────────────────
  } else {
    const peers = getAllPeers();
    if (peers.length === 0) {
      ui.printSystem('No peers online. Your message will be delivered once others join.', 'warn');
    } else {
      await broadcastMessage(peers, myName, myTcpPort, input);
      ui.printOwnMessage(input, 'All');
    }
  }

  ui.updatePrompt(getAllPeers().length);
});

rl.on('close', () => process.exit(0));
