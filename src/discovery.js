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
 * Starts UDP discovery — broadcasting presence and listening for peers.
 *
 * @param {string}   myName       - Local user's display name
 * @param {number}   myTcpPort    - This instance's TCP listening port
 * @param {function} onPeerJoined - Called with a peer object when a new peer appears
 * @param {function} onPeerLeft   - Called with a peer object when a peer expires
 * @returns {dgram.Socket}        - The UDP socket (so caller can close it)
 */
export function startDiscovery(myName, myTcpPort, onPeerJoined, onPeerLeft) {
  // Unique ID for this instance — used to filter out our own reflected broadcasts
  const myNodeId = crypto.randomBytes(8).toString('hex');

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    // Non-fatal: log and continue (e.g. network interface went down briefly)
    console.error(`[Discovery] UDP error: ${err.message}`);
  });

  socket.on('message', (msg, rinfo) => {
    try {
      const packet = JSON.parse(msg.toString());

      if (packet.type === 'announce') {
        // Ignore our own reflected broadcast
        if (packet.nodeId === myNodeId) return;

        const isNew = upsertPeer(rinfo.address, packet.port, packet.name);
        if (isNew) {
          onPeerJoined({ ip: rinfo.address, port: packet.port, name: packet.name });
        }
      }
    } catch {
      // Drop malformed UDP packets silently
    }
  });

  socket.on('listening', () => {
    // Compute broadcast address at startup (uses the first active interface)
    const BROADCAST_ADDR = getBroadcastAddress();

    socket.setBroadcast(true);
    const announcePayload = Buffer.from(JSON.stringify({
      type:   'announce',
      name:   myName,
      port:   myTcpPort,
      nodeId: myNodeId,
    }));

    // Broadcast immediately, then on interval
    const broadcast = () => {
      socket.send(announcePayload, 0, announcePayload.length, UDP_PORT, BROADCAST_ADDR);
    };
    broadcast();
    setInterval(broadcast, ANNOUNCE_INTERVAL_MS);

    // Periodically prune peers that stopped announcing
    setInterval(() => {
      const expired = expireOldPeers();
      expired.forEach((peer) => onPeerLeft(peer));
    }, EXPIRE_INTERVAL_MS);
  });

  socket.bind(UDP_PORT);
  return socket;
}
