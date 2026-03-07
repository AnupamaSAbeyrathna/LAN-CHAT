/**
 * sender.js — TCP Client
 * Opens a TCP connection to a target peer and sends a JSON message packet.
 * Connections are short-lived (one message per connection).
 *
 * sendMessage / sendLeave now accept the target's TCP port explicitly,
 * since peers may be running on different ports (e.g. same-machine testing).
 */

import net from 'net';
import chalk from 'chalk';

/**
 * Sends a chat message to a single peer.
 * @param {string} toIp     - Target peer's IP address
 * @param {number} toPort   - Target peer's TCP port
 * @param {string} fromName - Sender's display name
 * @param {number} fromPort - Sender's TCP port (included so receiver can key the peer)
 * @param {string} text     - The message text
 * @returns {Promise<void>}
 */
export function sendMessage(toIp, toPort, fromName, fromPort, text) {
  return _send(toIp, toPort, {
    type:      'msg',
    from:      fromName,
    port:      fromPort,
    text,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Sends a graceful "leave" notification to a peer.
 * Best-effort — failures are silently ignored.
 */
export function sendLeave(toIp, toPort, fromName, fromPort) {
  return _send(toIp, toPort, {
    type:      'leave',
    from:      fromName,
    port:      fromPort,
    timestamp: new Date().toISOString(),
  }, { timeout: 2000, failSilently: true });
}

/**
 * Broadcasts a message to multiple peers in parallel.
 * Per-peer failures are displayed but don't block the others.
 * @param {Array<{ip,port}>} peers - Target peers
 */
export async function broadcastMessage(peers, fromName, fromPort, text) {
  const results = await Promise.allSettled(
    peers.map((p) => sendMessage(p.ip, p.port, fromName, fromPort, text))
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      process.stdout.write('\r\x1b[K');
      console.log(chalk.red(`[System] Failed to reach ${peers[i].name} (${peers[i].ip}): ${result.reason.message}`));
      process.stdout.write(chalk.green('> '));
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
      else reject(new Error(`${err.message}`));
    });

    client.setTimeout(timeout, () => {
      client.destroy();
      if (failSilently) resolve();
      else reject(new Error(`Connection timed out`));
    });
  });
}
