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
startDiscovery(myName, myTcpPort, onPeerJoined, onPeerLeft);

// ── Banner + initial prompt ───────────────────────────────────────────────────
ui.printBanner(myName, myIP, myTcpPort);
ui.updatePrompt(0);

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
      ui.printOwnMessage(input, 'All');
    }
  }

  // Always repaint prompt after any command
  ui.updatePrompt(getAllPeers().length);
});

rl.on('close', () => process.exit(0));
