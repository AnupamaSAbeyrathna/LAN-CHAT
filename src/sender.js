/**
 * sender.js — TCP Client
 *
 * Outbound message delivery:
 *  - sendMessage     : broadcast/DM chat message (AES-256-GCM if key set)
 *  - sendLeave       : graceful leave notification
 *  - sendJoinRequest : ask creator to join the room
 *  - sendKeyGrant    : (creator only) send room key to an approved peer
 *  - sendNuke        : broadcast forced disconnect to all peers
 *  - sendPing        : health-check with RTT measurement
 *  - broadcastMessage: parallel send to all peers
 */

import net from 'net';
import * as ui from './ui.js';
import { encrypt, keyToHex } from './crypto.js';

// Shared room key — set by index.js after key exchange
let _roomKey = null;

export function setRoomKey(key) { _roomKey = key; }

// ── Public API ────────────────────────────────────────────────────────────────

export function sendMessage(toIp, toPort, fromName, fromPort, text) {
  let payload;
  if (_roomKey) {
    const { iv, cipher, tag } = encrypt(_roomKey, text);
    payload = {
      type: 'msg', from: fromName, port: fromPort, iv, cipher, tag,
      timestamp: new Date().toISOString()
    };
  } else {
    payload = {
      type: 'msg', from: fromName, port: fromPort, text,
      timestamp: new Date().toISOString()
    };
  }
  return _send(toIp, toPort, payload);
}

export function sendLeave(toIp, toPort, fromName, fromPort) {
  return _send(toIp, toPort, {
    type: 'leave', from: fromName, port: fromPort,
    timestamp: new Date().toISOString(),
  }, { timeout: 2000, failSilently: true });
}

/** Sent by a new peer to the room creator asking to be let in. */
export function sendJoinRequest(toIp, toPort, fromName, fromPort) {
  return _send(toIp, toPort, {
    type: 'join-request', from: fromName, port: fromPort,
    timestamp: new Date().toISOString(),
  }, { timeout: 3000, failSilently: true });
}

/** Sent by creator to an approved peer — delivers the AES room key as hex. */
export function sendKeyGrant(toIp, toPort, roomKey) {
  return _send(toIp, toPort, {
    type: 'key-grant', key: keyToHex(roomKey),
    timestamp: new Date().toISOString(),
  }, { timeout: 5000, failSilently: false });
}

/** Broadcast a nuke signal — recipients should quit immediately. */
export function sendNuke(toIp, toPort, fromName, fromPort) {
  return _send(toIp, toPort, {
    type: 'nuke', from: fromName, port: fromPort,
    timestamp: new Date().toISOString(),
  }, { timeout: 2000, failSilently: true });
}

/**
 * Send a ping and measure round-trip latency.
 * Uses a persistent connection (doesn't call client.end()) to get the pong back.
 * @returns {Promise<{ latencyMs: number, alive: boolean }>}
 */
export function pingPeer(toIp, toPort) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;

    const client = net.createConnection({ host: toIp, port: toPort }, () => {
      client.write(JSON.stringify({ type: 'ping', ts: start }));
    });

    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      try {
        const packet = JSON.parse(buf);
        if (packet.type === 'pong' && !settled) {
          settled = true;
          client.destroy();
          resolve({ latencyMs: Date.now() - start, alive: true });
        }
      } catch { /* wait for more data */ }
    });

    client.setTimeout(3000, () => {
      if (!settled) { settled = true; client.destroy(); resolve({ latencyMs: -1, alive: false }); }
    });
    client.on('error', () => {
      if (!settled) { settled = true; resolve({ latencyMs: -1, alive: false }); }
    });
  });
}

/** Broadcasts a message to multiple peers in parallel. */
export async function broadcastMessage(peers, fromName, fromPort, text) {
  const results = await Promise.allSettled(
    peers.map((p) => sendMessage(p.ip, p.port, fromName, fromPort, text)),
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      ui.printSystem(
        `Failed to reach ${peers[i].name} (${peers[i].ip}): ${result.reason.message}`,
        'error',
      );
    }
  });
}

// ── Internal ──────────────────────────────────────────────────────────────────
function _send(ip, port, payload, { timeout = 3000, failSilently = false } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: ip, port }, () => {
      client.write(JSON.stringify(payload));
      client.end();
    });

    client.on('close', resolve);

    client.on('error', (err) => {
      if (failSilently) resolve();
      else reject(new Error(err.message));
    });

    client.setTimeout(timeout, () => {
      client.destroy();
      if (failSilently) resolve();
      else reject(new Error('Connection timed out'));
    });
  });
}
