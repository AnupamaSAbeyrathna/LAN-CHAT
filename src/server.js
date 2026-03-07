/**
 * server.js — TCP Server
 *
 * Handles inbound packets:
 *  - msg      : chat message (decrypts if room key set)
 *  - leave    : graceful peer disconnect
 *  - join-request : new peer asking to join (routed to approval callback)
 *  - key-grant    : room key received from creator
 *  - nuke     : force-disconnect signal
 *  - ping     : health-check; replies with pong on same socket
 *
 * Security:
 *  - 64KB inbound buffer cap (prevents memory exhaustion)
 *  - `socket.remoteAddress` ::ffff: prefix stripped
 *  - peer name and text sanitized before display
 */

import net from 'net';
import { removePeer } from './peers.js';
import * as ui from './ui.js';
import { sanitize } from './crypto.js';

const MAX_PACKET_SIZE = 64 * 1024;

// Shared room key — set after key-grant received (or generated as creator)
let _roomKey = null;
let _decryptFn = null; // injected to avoid circular import

/**
 * Provide decrypt function and room key store from outside.
 * Must be called by index.js after crypto module is loaded.
 */
export function setRoomKey(key, decryptFn) {
  _roomKey = key;
  _decryptFn = decryptFn;
}

export function getRoomKey() { return _roomKey; }

/**
 * Creates and starts the TCP server.
 * @param {number}   tcpPort
 * @param {function} onLeave        - (peer) → void
 * @param {function} onPeerSeen     - (ip, port, name) → void  [UDP fallback]
 * @param {function} onJoinRequest  - (ip, port, name) → void  [approval callback]
 * @param {function} onKeyGrant     - (hexKey) → void           [key received]
 * @param {function} onNuke         - (from) → void             [nuke received]
 * @returns {net.Server}
 */
export function startServer(
  tcpPort = 9001,
  onLeave = () => { },
  onPeerSeen = () => { },
  onJoinRequest = () => { },
  onKeyGrant = () => { },
  onNuke = () => { },
) {
  const server = net.createServer((socket) => {
    let rawData = '';

    socket.on('data', (chunk) => {
      rawData += chunk.toString();
      if (rawData.length > MAX_PACKET_SIZE) {
        socket.destroy();
        return;
      }
    });

    socket.on('end', () => {
      try {
        const packet = JSON.parse(rawData);
        const remoteIp = stripIPv6Prefix(socket.remoteAddress);
        handlePacket(packet, remoteIp, socket, {
          onLeave, onPeerSeen, onJoinRequest, onKeyGrant, onNuke,
        });
      } catch {
        // Drop malformed packets silently
      }
    });

    socket.on('error', () => { });
  });

  server.listen(tcpPort, '0.0.0.0', () => {
    ui.printSystem(`TCP server ready on port ${tcpPort}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  ✖ Port ${tcpPort} is already in use.\n` +
        `    Try: node src/index.js --name <Name> --port <other port>\n`,
      );
      process.exit(1);
    }
  });

  return server;
}

// ── Packet dispatcher ─────────────────────────────────────────────────────────
function handlePacket(packet, remoteIp, socket, cbs) {
  const { onLeave, onPeerSeen, onJoinRequest, onKeyGrant, onNuke } = cbs;

  switch (packet.type) {
    case 'msg': {
      const from = sanitize(packet.from || '');
      if (!from) break;
      if (packet.port) onPeerSeen(remoteIp, packet.port, from);

      // Decrypt if encrypted, fall back to plaintext for legacy peers
      let text = '';
      if (_roomKey && _decryptFn && packet.iv && packet.cipher) {
        try {
          text = _decryptFn(_roomKey, packet.iv, packet.cipher, packet.tag);
        } catch {
          ui.printSystem(`Received garbled message from ${from} — decryption failed`, 'warn');
          break;
        }
      } else if (packet.text) {
        text = sanitize(packet.text);
      } else {
        break;
      }

      ui.printMessage(from, text);
      break;
    }

    case 'leave': {
      const from = sanitize(packet.from || '');
      removePeer(remoteIp, packet.port);
      onLeave({ ip: remoteIp, port: packet.port, name: from });
      break;
    }

    case 'join-request': {
      const name = sanitize(packet.from || '');
      const port = packet.port;
      if (name && port) onJoinRequest(remoteIp, port, name);
      break;
    }

    case 'key-grant': {
      if (packet.key && typeof packet.key === 'string' && packet.key.length === 64) {
        onKeyGrant(packet.key);
      }
      break;
    }

    case 'nuke': {
      const from = sanitize(packet.from || 'Unknown');
      onNuke(from);
      break;
    }

    case 'ping': {
      // Reply immediately with pong on the same socket (before it closes)
      try {
        socket.write(JSON.stringify({ type: 'pong', ts: packet.ts }));
      } catch { /* ignore */ }
      break;
    }

    default:
      break;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/** Strip the ::ffff: IPv4-mapped IPv6 prefix Node adds on dual-stack sockets. */
function stripIPv6Prefix(addr) {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}
