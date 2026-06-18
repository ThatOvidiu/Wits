# Wits — Web Interface to SSH

A lightweight, browser-based SSH interface built with [Bun](https://bun.sh). Run one file, open a browser, connect to a remote machine — no client install needed.

> **Not a real terminal.** TUI apps like `vim`, `htop`, `nano`, or `tmux` won't work. Wits is designed for running commands and reading output, not interactive full-screen applications.
s
> **Key-based auth only.** Password-based SSH login is not supported.

![version](https://img.shields.io/badge/version-0.9-green)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-blue)
![runtime](https://img.shields.io/badge/runtime-Bun-orange)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- Browser-based SSH interface with command history (↑ / ↓) and Ctrl+C support
- Passphrase gate before any UI is shown
- Save/load named SSH connection profiles
- Open the current session in your native SSH client
- Single-file — server + UI live in `wits.js`; no `package.json` or dependencies needed
- Compilable to a standalone binary via `bun build --compile`

---

## Security

The server binds to `127.0.0.1` only — never exposed on the network. Keep it that way.

Changing the bind address to `0.0.0.0` is a very bad idea. Your page would be exposed to your local network, intranet, or the entire internet. Don't do it.

Other things to know:
- The passphrase travels in plaintext over localhost HTTP — it's a convenience gate, not encryption.
- `StrictHostKeyChecking` is disabled — be cautious on untrusted networks.

**Need remote access?** Use an SSH tunnel instead of changing the bind address:

```bash
ssh -L <local_port>:127.0.0.1:<wits_port> user@your-server
```

Then open `http://localhost:<local_port>` locally. Traffic stays encrypted end-to-end.

---

## Requirements

- [Bun](https://bun.sh) v1.0+
- `ssh` available in `PATH`

**Install Bun:**

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Homebrew or npm
brew install bun
npm install -g bun
```

---

## Quick Start

```bash
# Clone and run
git clone https://github.com/ThatOvidiu/Wits.git && cd wits && bun wits.js

# Or grab just the file
curl -O https://raw.githubusercontent.com/ThatOvidiu/Wits/main/wits.js && bun wits.js
```

Open [http://localhost:8999](http://localhost:8999). The passphrase is printed when backend starts. the backend.

---

## CLI Options

| Flag | Description |
|------|-------------|
| `-p <port>` | Set the listening port (default: 8999) |
| `-pass <phrase>` | Set a custom passphrase |
| `-np` | Disable the passphrase gate |
| `-h` / `--help` | Print usage and exit |

Flags can be combined freely:

```bash
bun wits.js -p 9001 -pass mysecret
bun wits.js -p 9001 -np
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send command |
| `↑` / `↓` | Navigate command history |
| `Ctrl+C` | Send SIGINT to remote process |
| `Escape` | Close modal |

---

## Sessions

Saved sessions are stored in `sessions.saved` (CSV) alongside the script or binary, created automatically on first save.

---

## License

[MIT License](https://opensource.org/licenses/MIT) — Copyright © 2026 Ovidiu Albu. Permission is granted to use, copy, modify, and distribute this software freely, provided the copyright notice is retained.

