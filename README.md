# LAN Chat 💬

A zero-config, peer-to-peer CLI chat app for machines on the same WiFi network.
No server. No account. Just open a terminal and start chatting.

---

## Quick Start

```bash
npm install
node src/index.js --name YourName
```

Everyone on the same WiFi runs the same command — peers appear **automatically** within a few seconds.

---

## Usage

```bash
node src/index.js --name Alice
# Same-machine testing (two terminals):
node src/index.js --name Alice
node src/index.js --name Bob --port 9002
```

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

---

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `9000` | UDP | Discovery broadcasts (fixed) |
| `9001` | TCP | Chat messages (configurable via `--port`) |

---

## Roadmap

- [x] Phase 1 — TCP server/client foundation  
- [x] Phase 2 — UDP auto-discovery  
- [x] Phase 3 — Polished CLI (colors, prompt, tab-complete)  
- [ ] Phase 4 — Internet support via relay server  
- [ ] Phase 5 — Encryption  
- [ ] Phase 6 — Message history  
