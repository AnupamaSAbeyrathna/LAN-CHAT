/**
 * peers.js — In-memory Peer Registry
 * Tracks all known peers on the LAN with TTL-based auto-expiry.
 * Keyed by "ip:port" so multiple instances on the same machine work correctly.
 */

const PEER_TTL_MS = 15_000; // expire a peer if not seen for 15s

/** @type {Map<string, { ip: string, port: number, name: string, lastSeen: number }>} */
const peers = new Map();

/**
 * Insert or refresh a peer's last-seen time.
 * @returns {boolean} true if this is a brand-new peer
 */
export function upsertPeer(ip, port, name) {
  const key = `${ip}:${port}`;
  const isNew = !peers.has(key);
  peers.set(key, { ip, port, name, lastSeen: Date.now() });
  return isNew;
}

/**
 * Explicitly remove a peer (e.g. on receiving a 'leave' packet).
 * @returns {boolean} true if the peer existed
 */
export function removePeer(ip, port) {
  return peers.delete(`${ip}:${port}`);
}

/**
 * Returns all currently known peers as an array.
 */
export function getAllPeers() {
  return Array.from(peers.values());
}

/**
 * Removes peers that haven't announced in PEER_TTL_MS.
 * @returns {Array} Expired peer objects
 */
export function expireOldPeers() {
  const now = Date.now();
  const expired = [];
  for (const [key, peer] of peers) {
    if (now - peer.lastSeen > PEER_TTL_MS) {
      peers.delete(key);
      expired.push(peer);
    }
  }
  return expired;
}
