# LAN Chat 💬

A zero-config, peer-to-peer CLI chat app for machines on the same WiFi network.  
**No server. No account. End-to-end encrypted. Just open a terminal and start chatting.**

---

## Quick Start

```bash
npm install
node src/cli/index.js --name Alice --room dev
```

Everyone in the same room auto-discovers each other within a few seconds.  
The **room creator** approves joiners before the encrypted key is shared.

---

## Usage

```bash
# Basic
node src/cli/index.js --name Alice --room dev

# Open in a NEW terminal window automatically
npm run new -- --name Alice --room dev

# Same-machine testing (two terminals)
node src/cli/index.js --name Alice --room dev
node src/cli/index.js --name Bob --port 9002 --room dev
```

> **Tip:** Omit `--room` to get an interactive prompt asking for the room name.

---

## Commands

| Command | Description |
|---|---|
| `/list` | Show all online peers in the room (including yourself) |
| `/self` | Show your current identity (IP/port/room/security) |
| `/msg <name> <text>` | Direct message a peer |
| `/ping [name]` | Health-check peer(s) with round-trip latency |
| `/status` | Show room info, peer count, uptime, encryption state |
| `/nuke` | Kick all peers and destroy the room |
| `/help` | Show help |
| `/quit` or `Ctrl+C` | Exit gracefully |
| `<text>` | Broadcast to all peers |

> **Tip:** Press `Tab` to auto-complete commands and peer names.

---

## Rooms & Encryption

### How rooms work
- Each node broadcasts its room name via UDP every 3 seconds
- Only peers announcing the **same room name** discover each other
- Peers in a different room are completely invisible

### How E2E Encryption works

```
Alice starts #dev → generates AES-256-GCM room key
Bob joins #dev  → sends join-request to Alice
Alice's terminal: "Bob wants to join #dev. Accept? [y/N]"
Alice types "y"  → Alice's key is securely sent to Bob
Both peers now exchange 🔒 encrypted messages
```

- All messages are encrypted with **AES-256-GCM** (authenticated encryption)
- Third parties on the same network **cannot read messages** even if they know the room name
- The room key fingerprint is broadcast so new joiners can find the creator
- The 🔒 icon appears in messages and the status bar when encryption is active

---

## Live Status Bar

A persistent status line is shown below the prompt and updates every 3 seconds:

```
  #dev · 2 peers · uptime 4m · ● encrypted
```

---

## How It Works

| Layer | Technology | Purpose |
|---|---|---|
| Discovery | UDP broadcast on port `9000` | Auto-find peers on the LAN |
| Messaging | TCP on port `9001` (default) | Reliable message delivery |
| Encryption | AES-256-GCM (node:crypto) | E2E encrypted payloads |

- Each node **broadcasts** its presence every 3 seconds  
- Peers **expire** automatically after 15 seconds of silence  
- Messages are **encrypted** short-lived TCP connections carrying JSON packets  

---

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| `9000` | UDP | Discovery broadcasts (fixed) |
| `9001` | TCP | Chat messages (configurable via `--port`) |

---

## Scripts

| npm script | What it does |
|---|---|
| `npm start` | Start LAN Chat |
| `npm run new -- --name Alice --room dev` | Start in a **new terminal window** (when supported) |
| `npm run start:name -- --name Alice --room dev` | Start with a custom name (plus any other args) |
| `npm run start:alice` | Quick-start as Alice |
| `npm run start:bob` | Quick-start as Bob on port 9002 |
| `npm run matrix` | Quick-start as Neo |
| `npm run ghost` | Quick-start as Ghost |

---

## Security Notes

- **Encryption**: AES-256-GCM with per-room random keys — no external dependencies
- **Authentication**: Join requests require manual approval from the room creator
- **Input sanitization**: All peer names and message text are sanitized to prevent terminal injection
- **No internet**: Works on LAN only (Phase 4 roadmap item)

---

## Roadmap

- [x] Phase 1 — TCP server/client foundation  
- [x] Phase 2 — UDP auto-discovery  
- [x] Phase 3 — Polished CLI (colors, prompt, tab-complete)  
- [x] Phase 4 — Named rooms  
- [x] Phase 5 — E2E encryption (AES-256-GCM + approval-based key exchange)  
- [x] Phase 6 — Health check (`/ping`), room status, live status bar  
- [ ] Phase 7 — Internet support via relay server  
- [ ] Phase 8 — Message history  
- [ ] Phase 9 — File transfer  
