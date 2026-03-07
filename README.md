# LAN Chat 💬

A zero-config, peer-to-peer CLI chat app for machines on the same WiFi network.
No server. No account. Just open a terminal and start chatting.

---

## Quick Start

```bash
npm install
npm run start:name YourName
```

Everyone on the same WiFi runs the same command — peers appear **automatically** within a few seconds.

---

## Usage

You can easily start the app with your chosen name using the `start:name` command:
```bash
npm run start:name YourName

# or manually using node:
node src/index.js --name YourName
```

### Predefined Profiles (NPM Scripts)
For quick testing or just for fun, try out the predefined profiles included in `package.json`:

| Command | Description |
|---|---|
| `npm run start:alice` | Starts the chat as **Alice** on the default port (`9001`) |
| `npm run start:bob` | Starts the chat as **Bob** on port `9002` (perfect for local same-machine testing alongside Alice) |
| `npm run matrix` | Enter the Matrix as **Neo** 💊 |
| `npm run ghost` | Haunt the chat as **Ghost** 👻 |

### Commands

| Command | Description |
|---|---|
| `/list` | Show all online peers |
| `/msg <name> <text>` | Direct message a peer |
| `<text>` | Broadcast to all peers |
| `/help` | Show help |
| `/quit` or `Ctrl+C` | Exit gracefully |

> **Tip:** Press `Tab` to auto-complete commands and peer names.

---

## How It Works

| Layer | Technology | Purpose |
|---|---|---|
| Discovery | UDP broadcast on port `9000` | Auto-find peers on the LAN |
| Messaging | TCP on port `9001` (default) | Reliable message delivery |

- Each node **broadcasts** its presence every 3 seconds  
- Peers **expire** automatically after 15 seconds of silence  
- Messages are short-lived TCP connections carrying JSON packets  
- **TCP Fallback:** If UDP broadcasts are dropped (e.g., strict firewalls or AP isolation), peers automatically discover each other via incoming direct TCP messages.  

---

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `9000` | UDP | Discovery broadcasts (fixed) |
| `9001` | TCP | Chat messages (configurable via `--port`) |

---

## Recent Updates

- **Predefined Profiles (NPM Scripts):** Added playful and convenient run scripts for quick testing (`npm run matrix`, `npm run start:bob`, etc.).
- **TCP Fallback Discovery:** Peers can now automatically discover each other via incoming direct TCP connections if UDP broadcasts are dropped by the network (e.g., strict firewalls or AP isolation).
- **Graceful Termination Fixes:** Fixed an issue where the discovery service wasn't properly shutting down on `/quit` or `Ctrl+C` (`discovery is not defined` error).
- **Stability Improvements:** Resolved server-side reference errors that occurred when UDP failed and the TCP stream attempted to backfill the peer configuration.

---

## Roadmap

- [x] Phase 1 — TCP server/client foundation  
- [x] Phase 2 — UDP auto-discovery  
- [x] Phase 3 — Polished CLI (colors, prompt, tab-complete)  
- [ ] Phase 4 — Internet support via relay server  
- [ ] Phase 5 — Encryption  
- [ ] Phase 6 — Message history  
