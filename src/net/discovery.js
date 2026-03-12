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
import { upsertPeer, expireOldPeers } from '../core/peers.js';

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
  let _broadcast = null; // set when socket starts listening; used by updateFingerprint
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
      if (packet.keyFingerprint && packet.keyFingerprint !== '__pending__' && (!currentFp || currentFp === '__pending__')) {
        const reqKey = `${ip}:${port}`;
        if (!joinRequested.has(reqKey)) {
          joinRequested.add(reqKey);
          onJoinRequestNeeded(ip, port);
        }
        // Don't register them as a peer yet — they'll join once key is granted
        return;
      }

      // If the peer is in the election window (__pending__) and WE already have a
      // real key, immediately re-broadcast our announce so they can see our real
      // fingerprint and send us a join-request before they accidentally self-elect.
      if (packet.keyFingerprint === '__pending__' && currentFp && currentFp !== '__pending__') {
        if (_broadcast) _broadcast();
        // Fall through — register them as a pending peer so we don't miss the join-request
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

    const broadcast = () => {
      // Rebuild payload each tick so keyFingerprint reflects the latest state
      // (e.g. after creator election completes and updateFingerprint() is called)
      const payload = buildPayload();
      socket.send(payload, 0, payload.length, UDP_PORT, BROADCAST_ADDR);
    };
    broadcast();
    announceTimer = setInterval(broadcast, ANNOUNCE_INTERVAL_MS);
    _broadcast = broadcast; // expose for updateFingerprint()

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
    /**
     * Called after creator election to update the fingerprint.
     * Fires an immediate extra broadcast so joiners see the fingerprint
     * right away without waiting up to ANNOUNCE_INTERVAL_MS.
     */
    updateFingerprint(fp) {
      currentFp = fp;
      if (_broadcast) _broadcast();
    },
  };
}
