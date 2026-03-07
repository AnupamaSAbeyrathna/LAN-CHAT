/**
 * discovery.js — UDP Peer Discovery
 *
 * Every node:
 *  1. Broadcasts an "announce" packet to the LAN subnet every 3s
 *  2. Listens for "announce" packets from other peers and updates the registry
 *  3. Periodically expires stale peers (no announcement in 15s)
 *
 * Each announce packet includes a random nodeId so a node can reliably
 * ignore its own reflected broadcasts — this also works correctly when
 * multiple instances run on the same machine with different TCP ports.
 */

import dgram from 'dgram';
import crypto from 'crypto';
import os from 'os';
import { upsertPeer, expireOldPeers } from './peers.js';

export const UDP_PORT         = 9000;   // Well-known LAN discovery port (fixed)
const ANNOUNCE_INTERVAL_MS    = 3_000;
const EXPIRE_INTERVAL_MS      = 5_000;

/**
 * Calculate the subnet-directed broadcast address from the first non-loopback
 * IPv4 interface (e.g. 255.255.255.0 mask on 10.74.83.72 → 10.74.83.255).
 * Falls back to 255.255.255.255 if no interface is found.
 */
function getBroadcastAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip   = iface.address.split('.').map(Number);
        const mask = iface.netmask.split('.').map(Number);
        return ip.map((octet, i) => octet | (~mask[i] & 0xff)).join('.');
      }
    }
  }
  return '255.255.255.255';
}

/**
<<<<<<< HEAD
 * Starts UDP discovery — broadcasting presence and listening for peers.
 *
 * @param {string}   myName       - Local user's display name
 * @param {number}   myTcpPort    - This instance's TCP listening port
 * @param {function} onPeerJoined - Called with a peer object when a new peer appears
 * @param {function} onPeerLeft   - Called with a peer object when a peer expires
 * @returns {{ socket: dgram.Socket, stop: () => void }}
 */
export function startDiscovery(myName, myTcpPort, onPeerJoined, onPeerLeft) {
  // Unique ID for this instance — used to filter out our own reflected broadcasts
=======
 * @param {string}   myName          - Display name
 * @param {number}   myTcpPort       - TCP port
 * @param {string}   myRoom          - Room name (lowercase)
 * @param {string}   myKeyFp         - Fingerprint of the room key ("" if joiner has no key yet)
 * @param {function} onPeerJoined    - (peer) → void
 * @param {function} onPeerLeft      - (peer) → void
 * @param {function} onJoinRequestNeeded - (ip, port) → void  — called when we see a
 *                                         room announce but have no key yet, so we need
 *                                         to send a join-request to that creator
 * @param {function} onCreatorConflict   - (ip, port) → void  — called when BOTH sides
 *                                         self-elected as creator (simultaneous start).
 *                                         The lower nodeId yields and calls this.
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
  onCreatorConflict = () => { },
) {
>>>>>>> c94564b (Update discovery and index)
  const myNodeId = crypto.randomBytes(8).toString('hex');

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let announceTimer = null;
  let expireTimer = null;

  socket.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✖ UDP discovery port ${UDP_PORT} is already in use.`);
      process.exit(1);
    }
    // Non-fatal: log and continue (e.g. network interface went down briefly)
    console.error(`[Discovery] UDP error: ${err.message}`);
  });

  socket.on('message', (msg, rinfo) => {
    try {
      const packet = JSON.parse(msg.toString());

      if (packet.type === 'announce') {
        // Ignore our own reflected broadcast
        if (packet.nodeId === myNodeId) return;

<<<<<<< HEAD
        const isNew = upsertPeer(rinfo.address, packet.port, packet.name);
        if (isNew) {
          onPeerJoined({ ip: rinfo.address, port: packet.port, name: packet.name });
=======
      // Room filter — only register peers in the same room
      const room = (packet.room || 'general').toLowerCase();
      if (room !== myRoom) return;

      const ip = rinfo.address;
      const port = packet.port;

      // Key fingerprint logic:
      //   - If the remote has a fingerprint and WE don't have a key yet → send join-request
      //   - If the remote has no fingerprint → legacy / unencrypted peer (accept normally)
      //   - If BOTH have different fingerprints → dual-creator conflict; lower nodeId yields
      if (packet.keyFingerprint && !currentFp) {
        const reqKey = `${ip}:${port}`;
        if (!joinRequested.has(reqKey)) {
          joinRequested.add(reqKey);
          onJoinRequestNeeded(ip, port);
>>>>>>> c94564b (Update discovery and index)
        }
      }
<<<<<<< HEAD
=======

      // Dual-creator conflict: both nodes self-elected simultaneously.
      // Tiebreak deterministically: lower nodeId yields to avoid both sides retrying.
      if (
        packet.keyFingerprint &&
        currentFp &&
        packet.keyFingerprint !== currentFp &&
        packet.nodeId
      ) {
        if (myNodeId < packet.nodeId) {
          // We lose the tiebreak — drop our self-generated key and request the winner's
          const reqKey = `${ip}:${port}`;
          if (!joinRequested.has(reqKey)) {
            joinRequested.add(reqKey);
            currentFp = null; // clear so future announces don't re-trigger conflict
            onCreatorConflict(ip, port);
          }
        }
        // The winner (higher nodeId) does nothing — it stays as creator
        return;
      }

      const isNew = upsertPeer(ip, port, name);
      if (isNew) onPeerJoined({ ip, port, name });

>>>>>>> c94564b (Update discovery and index)
    } catch {
      // Drop malformed UDP packets silently
    }
  });

  socket.on('listening', () => {
    // Compute broadcast address at startup (uses the first active interface)
    const BROADCAST_ADDR = getBroadcastAddress();

    socket.setBroadcast(true);
    const announcePayload = Buffer.from(JSON.stringify({
      type: 'announce',
      name: myName,
      port: myTcpPort,
      nodeId: myNodeId,
    }));

    // Broadcast immediately, then on interval
    const broadcast = () => {
      socket.send(announcePayload, 0, announcePayload.length, UDP_PORT, BROADCAST_ADDR);
    };
    broadcast();
    announceTimer = setInterval(broadcast, ANNOUNCE_INTERVAL_MS);

    // Periodically prune peers that stopped announcing
    expireTimer = setInterval(() => {
      const expired = expireOldPeers();
      expired.forEach((peer) => onPeerLeft(peer));
    }, EXPIRE_INTERVAL_MS);
  });

  socket.bind(UDP_PORT);

  /** Clean up timers and close the UDP socket. */
  function stop() {
    if (announceTimer) clearInterval(announceTimer);
    if (expireTimer) clearInterval(expireTimer);
    socket.close();
  }

  return { socket, stop };
}
