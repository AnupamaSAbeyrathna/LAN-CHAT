/**
 * discovery.js — UDP Peer Discovery
 *
 * Changes from v1:
 *  - announce now includes `room` (prevents cross-room peer registration)
 *  - announce now includes `keyFingerprint` (creator broadcasts fingerprint;
 *    new joiners detect a room they don't have a key for and send join-request)
 *  - Incoming peer names are validated (max 32 chars, alphanum/hyphens)
 *  - Subnet-directed broadcast instead of 255.255.255.255
 */

import dgram from 'dgram';
import crypto from 'crypto';
import os from 'os';
import { upsertPeer, expireOldPeers } from './peers.js';

export const UDP_PORT = 9000;
const ANNOUNCE_INTERVAL_MS = 3_000;
const EXPIRE_INTERVAL_MS = 5_000;
const VALID_NAME_RE = /^[\w\-.]{1,32}$/;

function getBroadcastAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address.split('.').map(Number);
        const mask = iface.netmask.split('.').map(Number);
        return ip.map((octet, i) => octet | (~mask[i] & 0xff)).join('.');
      }
    }
  }
  return '255.255.255.255';
}

/**
 * @param {string}   myName          - Display name
 * @param {number}   myTcpPort       - TCP port
 * @param {string}   myRoom          - Room name (lowercase)
 * @param {string}   myKeyFp         - Fingerprint of the room key ("" if joiner has no key yet)
 * @param {function} onPeerJoined    - (peer) → void
 * @param {function} onPeerLeft      - (peer) → void
 * @param {function} onJoinRequestNeeded - (ip, port) → void  — called when we see a
 *                                         room announce but have no key yet, so we need
 *                                         to send a join-request to that creator
 * @returns {{ socket, stop, updateFingerprint }}
 */
export function startDiscovery(
  myName,
  myTcpPort,
  myRoom,
  myKeyFp,
  onPeerJoined,
  onPeerLeft,
  onJoinRequestNeeded = () => { },
) {
  const myNodeId = crypto.randomBytes(8).toString('hex');
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  let announceTimer = null;
  let expireTimer = null;
  let currentFp = myKeyFp; // mutable — updated after key exchange

  // Track peers we've already sent a join-request to (avoid spam)
  const joinRequested = new Set();

  socket.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✖ UDP discovery port ${UDP_PORT} is already in use.`);
      process.exit(1);
    }
    console.error(`[Discovery] UDP error: ${err.message}`);
  });

  socket.on('message', (msg, rinfo) => {
    try {
      const packet = JSON.parse(msg.toString());
      if (packet.type !== 'announce') return;
      if (packet.nodeId === myNodeId) return;                     // own reflection

      // Validate peer name
      const name = packet.name;
      if (!name || !VALID_NAME_RE.test(name)) return;

      // Room filter — only register peers in the same room
      const room = (packet.room || 'general').toLowerCase();
      if (room !== myRoom) return;

      const ip = rinfo.address;
      const port = packet.port;

      // Key fingerprint logic:
      //   - If the remote has a fingerprint and WE don't have a key yet → send join-request
      //   - If the remote has no fingerprint → legacy / unencrypted peer (accept normally)
      if (packet.keyFingerprint && !currentFp) {
        const reqKey = `${ip}:${port}`;
        if (!joinRequested.has(reqKey)) {
          joinRequested.add(reqKey);
          onJoinRequestNeeded(ip, port);
        }
        // Don't register them as a peer yet — they'll join once key is granted
        return;
      }

      const isNew = upsertPeer(ip, port, name);
      if (isNew) onPeerJoined({ ip, port, name });

    } catch {
      // Drop malformed UDP packets silently
    }
  });

  socket.on('listening', () => {
    const BROADCAST_ADDR = getBroadcastAddress();
    socket.setBroadcast(true);

    const buildPayload = () => Buffer.from(JSON.stringify({
      type: 'announce',
      name: myName,
      port: myTcpPort,
      nodeId: myNodeId,
      room: myRoom,
      keyFingerprint: currentFp || null,
    }));

    let announcePayload = buildPayload();

    const broadcast = () => {
      socket.send(announcePayload, 0, announcePayload.length, UDP_PORT, BROADCAST_ADDR);
    };
    broadcast();
    announceTimer = setInterval(broadcast, ANNOUNCE_INTERVAL_MS);

    expireTimer = setInterval(() => {
      expireOldPeers().forEach((peer) => onPeerLeft(peer));
    }, EXPIRE_INTERVAL_MS);
  });

  socket.bind(UDP_PORT);

  return {
    socket,
    stop() {
      if (announceTimer) clearInterval(announceTimer);
      if (expireTimer) clearInterval(expireTimer);
      socket.close();
    },
    /** Called after key exchange completes so announces include the new fingerprint. */
    updateFingerprint(fp) {
      currentFp = fp;
    },
  };
}
