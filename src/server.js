/**
 * server.js — TCP Server
 * Listens for incoming chat messages from other peers on the LAN.
 * All rendering is delegated to ui.js.
 */

import net from 'net';
import { removePeer } from './peers.js';
import * as ui from './ui.js';

/**
 * Creates and starts the TCP server.
 * @param {number}   tcpPort   - Port to listen on (default 9001)
 * @param {function} onLeave    - Called when a 'leave' packet is received: (peer)
 * @param {function} onPeerSeen - Called on every 'msg' with (ip, port, name) — backfills
 *                                 peer registry when UDP discovery is blocked
 * @returns {net.Server}
 */
export function startServer(tcpPort = 9001, onLeave = () => {}, onPeerSeen = () => {}) {
  const server = net.createServer((socket) => {
    let rawData = '';

    socket.on('data', (chunk) => {
      rawData += chunk.toString();
    });

    socket.on('end', () => {
      try {
        const packet = JSON.parse(rawData);
        handlePacket(packet, socket.remoteAddress, onLeave, onPeerSeen);
      } catch {
        // Drop malformed packets silently
      }
    });

    socket.on('error', () => {
      // Ignore abrupt disconnections
    });
  });

  server.listen(tcpPort, '0.0.0.0', () => {
    ui.printSystem(`TCP server ready on port ${tcpPort}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  ✖ Port ${tcpPort} is already in use.\n` +
        `    Try: node src/index.js --name <Name> --port <other port>\n`
      );
      process.exit(1);
    }
  });

  return server;
}

function handlePacket(packet, remoteIp, onLeave, onPeerSeen) {
  switch (packet.type) {
    case 'msg':
      // Backfill peer registry from TCP connection (fallback when UDP is blocked)
      if (packet.port) onPeerSeen(remoteIp, packet.port, packet.from);
      ui.printMessage(packet.from, packet.text);
      break;

    case 'leave':
      removePeer(remoteIp, packet.port);
      onLeave({ ip: remoteIp, port: packet.port, name: packet.from });
      break;

    default:
      break;
  }
}
