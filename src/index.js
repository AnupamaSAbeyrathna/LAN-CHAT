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
import { startServer, setRoomKey as serverSetKey } from './server.js';
import { startDiscovery } from './discovery.js';
import { getAllPeers, upsertPeer } from './peers.js';
import {
  sendMessage, broadcastMessage, sendLeave,
  sendJoinRequest, sendKeyGrant, sendNuke, pingPeer,
  setRoomKey as senderSetKey,
} from './sender.js';
import * as ui from './ui.js';
import {
  generateRoomKey, fingerprint, hexToKey, decrypt,
} from './crypto.js';

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

// ── Crypto state ──────────────────────────────────────────────────────────────
let roomKey = null;   // Buffer | null
let isCreator = false;

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
const BASE_COMMANDS = ['/list', '/msg ', '/ping ', '/status', '/nuke', '/help', '/quit'];

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

// Creator = first to start in the room → generates the room key
isCreator = true; // assumed until we see an existing room announce (see discovery)
roomKey = generateRoomKey();
senderSetKey(roomKey);
serverSetKey(roomKey, decrypt);
ui.setEncrypted(true);

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

// ── Key exchange (joiner side) ────────────────────────────────────────────────
function onKeyGrant(hexKey) {
  // We've received the room key from the creator
  isCreator = false;
  const key = hexToKey(hexKey);
  activateKey(key);
  // Signal ready — start broadcasting with key fingerprint
  ui.printSystem('🔒 Key received — encryption active!', 'info');
}

// ── Joiner sending join-request to creator ────────────────────────────────────
async function onJoinRequestNeeded(ip, port) {
  // We're not the creator — send a join-request to the peer who has the key
  isCreator = false;
  // Remove own key temporarily (we don't have the room key yet)
  senderSetKey(null);
  serverSetKey(null, null);
  ui.setEncrypted(false);

  try {
    await sendJoinRequest(ip, port, myName, myTcpPort);
    ui.printSystem(`Join request sent to ${ip}:${port} — waiting for approval...`, 'info');
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
startServer(myTcpPort, onPeerLeft, onPeerSeen, onJoinRequest, onKeyGrant, onNuke);

const discovery = startDiscovery(
  myName, myTcpPort, myRoom,
  roomKey ? fingerprint(roomKey) : null,
  onPeerJoined, onPeerLeft,
  onJoinRequestNeeded,
);

// ── Banner + status bar ───────────────────────────────────────────────────────
ui.printBanner(myName, myIP, myTcpPort, myRoom, isCreator);
ui.updatePrompt(0);
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

    // ── /nuke ─────────────────────────────────────────────────────────────────
  } else if (input === '/nuke') {
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
