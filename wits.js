/**
 * wits.js — Wits, Web Interface to SSH
 * Run:  bun wits.js [-p <port>] [-np] [-pass <passphrase>]
 * Open: http://localhost:8999 (default)
 */

const VERSION = '0.1.13'
let PORT = 8999;
const _CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const RANDOM_PASS = Array.from({ length: 25 }, () => _CHARS[Math.floor(Math.random() * _CHARS.length)]).join('');

// --- Argument parsing --------------------------------------------------------

// import.meta.path is the absolute path to the source file on disk.
// It is empty/undefined in a compiled binary (no source file exists at runtime).
const isCompiled = !import.meta.path;
const args = process.argv.slice(isCompiled ? 1 : 2);

let AUTH_MODE = "hostname";   // "hostname" | "none" | "custom"
let CUSTOM_PASS = "";

function printUsage() {
  console.log("\nUsage:");
  console.log("  bun wits.js                      (port=8999, passphrase=random 25-char alphanumeric)");
  console.log("  bun wits.js -p <port>            (custom listening port)");
  console.log("  bun wits.js -np                  (no passphrase)");
  console.log("  bun wits.js -pass <passphrase>  (custom passphrase)");
  console.log("  Flags may be combined, e.g.: bun wits.js -p 9001 -np");
}

{
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-p") {
      const val = args[i + 1];
      const n = Number(val);
      if (!val || !Number.isInteger(n) || n < 1 || n > 65535) {
        console.log("Error: -p requires a valid port number (1-65535).\n");
        printUsage();
        process.exit(1);
      }
      PORT = n;
      i += 2;
    } else if (a === "-np") {
      AUTH_MODE = "none";
      i++;
    } else if (a === "-pass") {
      const val = args[i + 1];
      if (!val) {
        console.log("Error: -pass requires a passphrase argument.\n");
        printUsage();
        process.exit(1);
      }
      AUTH_MODE = "custom";
      CUSTOM_PASS = val;
      i += 2;
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.log(`Error: unknown argument: ${a}\n`);
      printUsage();
      process.exit(1);
    }
  }
}

const sessions      = new Map();   // id -> { proc }
const activeClients = new Set();   // all live WebSocket connections

// ─── Cross-platform helpers ───────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

function expandHome(keyPath) {
  if (!keyPath.startsWith("~")) return keyPath;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? null;
  if (!home) {
    dbg("WARN", `Cannot expand ~ — neither HOME nor USERPROFILE is set`);
    return keyPath;
  }
  const expanded = keyPath.replace(/^~/, home);
  // Normalise to forward-slashes for OpenSSH on all platforms
  return expanded.replace(/\\/g, "/");
}

// ─── Server-side debug logger ─────────────────────────────────────────────────

let shuttingDown = false;                        // prevents duplicate shutdown handling
const short = id => (id || "").slice(0, 8);      // abbreviate UUIDs in log output

function dbg(level, ...args) {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  const tag = { INFO: "\x1b[36mINFO\x1b[0m", WARN: "\x1b[33mWARN\x1b[0m", ERROR: "\x1b[31mERROR\x1b[0m", SSH: "\x1b[35mSSH \x1b[0m", WS: "\x1b[32mWS  \x1b[0m" }[level] ?? level;
  process.stdout.write(`[${ts}] [${tag}] ${args.join(" ")}\r\n`);
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wits</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230d0f14'/><rect width='32' height='32' rx='6' fill='%231e6b4a' fill-opacity='0.3'/><text x='3' y='14' font-family='monospace' font-size='9' font-weight='bold' fill='%23a3ffd6'>SSH</text><text x='3' y='26' font-family='monospace' font-size='9' font-weight='bold' fill='%2352d68a'>&gt;_ </text></svg>">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:     #0d0f14;
    --panel:  #13161e;
    --border: #2a3050;
    --accent: #a3ffd6;
    --accent2:#52d68a;
    --danger: #ff6b81;
    --warn:   #ffe082;
    --text:   #eef2ff;
    --muted:  #9aa5c4;
    --mono:   Consolas, 'Cascadia Mono', 'Lucida Console', Monaco, 'DejaVu Sans Mono', 'Liberation Mono', monospace;
    --sans:   -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --debug-bg: #090b10;
    --green-bg:   #1e6b4a;
    --green-fg:   #a3ffd6;
    --stop-red:   #c82828;
  }

  html, body { height: 100%; }
  body {
    background: #000; color: var(--text);
    font-family: var(--mono);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }

  #frame {
    width: 100%; height: 100%;
    display: flex; flex-direction: row;
    border: 1px solid var(--border);
    overflow: hidden;
    background: var(--panel);
  }

  #toolbar {
    width: 300px; flex-shrink: 0;
    display: flex; flex-direction: column; align-items: stretch; gap: 10px;
    padding: 16px 30px; background: var(--panel);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .logo-bar {
    display: flex; align-items: baseline; gap: 8px;
    padding-bottom: 10px; border-bottom: 1px solid var(--border); margin-bottom: 2px;
  }
  .logo {
    font-family: var(--mono); font-weight: 700; font-size: 35px;
    letter-spacing: .12em; color: var(--green-fg); text-transform: uppercase;
    white-space: nowrap;
  }
  .logo-version {
    font-size: 10px; color: var(--muted); letter-spacing: .1em;
  }
  .field-group { display: flex; flex-direction: column; gap: 3px; }
  label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; white-space: nowrap; }

  input[type="text"], input[type="number"] {
    background: #000; border: 1px solid var(--border);
    color: var(--text); font-family: var(--mono); font-size: 13px;
    padding: 5px 9px; border-radius: 5px; outline: none; transition: border-color .15s;
    width: 100%;
  }
  input:focus { border-color: var(--accent2); }

  .btn {
    font-family: var(--mono); font-size: 12px; font-weight: 600;
    letter-spacing: .06em; text-transform: uppercase;
    padding: 6px 14px; border: none; border-radius: 5px;
    cursor: pointer; transition: opacity .15s, filter .15s; white-space: nowrap;
  }
  #toolbar .btn { width: 100%; text-align: center; padding: 7px 14px; }
  .btn:disabled { opacity: .35; }
  .btn:not(:disabled):hover { filter: brightness(1.15); }
  .btn-connect    { background: var(--green-bg); color: var(--green-fg); }
  .btn-disconnect { background: var(--danger);   color: #fff; }
  .btn-clear      { background: var(--border);   color: var(--muted); }

  #pill {
    display: flex; align-items: center;
    gap: 6px; font-size: 11px; color: var(--muted); flex-wrap: wrap;
    padding: 4px 0;
  }
  #pill-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    background: var(--muted); transition: background .3s;
  }
  #pill-dot.on  { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
  #sidebar-spacer { flex: 1; min-height: 12px; }

  /* -- Right content column -- */
  #content {
    flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0;
  }

  /* -- Main area -- */
  #main {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
  }

  #output {
    flex: 1; overflow-y: auto; padding: 14px 18px;
    padding-top: 21px;
    font-size: 13.5px; line-height: 1.65;
    white-space: pre-wrap; word-break: break-all;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  .line-info { color: var(--accent); }
  .line-ssh  { color: #a3ffd6; }
  .line-err  { color: var(--danger); }
  .line-cmd  { color: var(--warn);   }
  .line-sys  { color: var(--muted); font-style: italic; }
  @keyframes conn-blink { 0%,100%{opacity:1} 50%{opacity:0.15} }
  .conn-refused { color: var(--danger); font-weight: 700; animation: conn-blink 1.4s ease-in-out infinite; }

  /* -- Debug panel -- */
  #debug-wrapper {
    flex-shrink: 0; display: flex; flex-direction: column;
    border-top: 1px solid var(--border);
    height: 220px;
    min-height: 28px;
    transition: height .2s ease;
  }
  #debug-wrapper.collapsed { height: 28px; }

  #debug-header {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 12px; background: var(--panel); cursor: pointer;
    user-select: none; flex-shrink: 0;
  }
  #debug-header span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
  #debug-toggle { margin-left: auto; font-size: 11px; color: var(--muted); }
  #debug-badge {
    background: var(--accent2); color: #fff; border-radius: 99px;
    font-size: 10px; padding: 1px 6px; min-width: 18px; text-align: center;
    display: none;
  }
  #debug-badge.visible { display: inline-block; }

  #debug-log {
    flex: 1; overflow-y: auto; padding: 6px 12px;
    background: var(--debug-bg); font-size: 11.5px; line-height: 1.6;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  #debug-wrapper.collapsed #debug-log { display: none; }

  .dl { display: flex; gap: 8px; }
  .dl-ts    { color: #3d4257; white-space: nowrap; flex-shrink: 0; }
  .dl-level { flex-shrink: 0; width: 44px; font-weight: 600; }
  .dl-msg   { color: var(--text); word-break: break-all; }
  .dl-ws    .dl-level { color: #00d4aa; }
  .dl-ssh   .dl-level { color: #7c5cfc; }
  .dl-cmd   .dl-level { color: var(--warn); }
  .dl-err   .dl-level { color: var(--danger); }
  .dl-info  .dl-level { color: var(--muted); }

  #cmd-bar {
    flex-shrink: 0; display: flex; align-items: center;
    padding: 14px 16px; background: var(--panel);
    border-top: 1px solid var(--border);
  }
  #prompt { color: var(--accent); font-size: 14px; padding-right: 8px; user-select: none; }
  #cmd-input {
    flex: 1; background: transparent; border: none;
    color: var(--text); font-family: var(--mono); font-size: 14px;
    outline: none; caret-color: var(--accent);
  }
  @keyframes ph-pulse { 0%,100%{ color: rgba(163,255,214,0.85); } 50%{ color: rgba(163,255,214,0.35); } }
  #cmd-input::placeholder { color: rgba(163,255,214,0.85); animation: ph-pulse 3s ease-in-out infinite; }
  #cmd-input:disabled::placeholder { animation: none; color: var(--muted); }
  #cmd-input:disabled { opacity: .4; }
  #cmd-input.masked { color: var(--muted); letter-spacing: .1em; }
  #send-btn { background: var(--accent2); color: #fff; margin-left: 8px; padding: 4px 14px; flex-shrink: 0; }
  #btn-clear-debug { background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 2px 8px; font-size: 10px; margin-left: auto; }
  .btn-save       { background: var(--green-bg); color: var(--green-fg); }
  .btn-load       { background: var(--green-bg); color: var(--green-fg); }
  .btn-ssh-client { background: var(--green-bg); color: var(--green-fg); }
  input[type="number"] { -moz-appearance: textfield; }
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  #btn-key-browse { width: 28px; flex-shrink: 0; }
  #btn-stop { background: var(--stop-red); color: #fff; }

  /* -- Inline error bar (log style) -- */
  #err-bar {
    display: none; align-items: center; gap: 10px;
    padding: 7px 14px; background: rgba(200,40,40,0.12);
    border-top: 1px solid rgba(200,40,40,0.4);
    font-size: 12px; color: var(--danger); flex-shrink: 0;
  }
  #err-bar.visible { display: flex; }
  #err-bar-msg { flex: 1; }
  #err-bar-close { background: transparent; border: none; color: var(--danger); cursor: pointer; font-size: 15px; padding: 0 2px; line-height: 1; flex-shrink: 0; }

  /* -- Shutdown modal -- */
  #modal-shutdown .modal-box { align-items: center; text-align: center; gap: 24px; border-color: var(--danger); }
  .shutdown-icon  { font-size: 64px; color: var(--danger); line-height: 1; }
  @keyframes fadepulse { 0%,100%{opacity:0.15} 50%{opacity:1} }
  .shutdown-title { font-size: 28px; font-weight: 700; color: var(--danger); letter-spacing: .04em; animation: fadepulse 2s ease-in-out infinite; }
  .shutdown-sub   { font-size: 14px; color: var(--muted); }

  /* -- Passphrase modal -- */
  #modal-passphrase {
    position: fixed; inset: 0; z-index: 1001;
    background: #000;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px;
  }
  #modal-passphrase.hidden { display: none; }
  .pp-title { font-family: var(--mono); font-size: 13px; color: var(--muted); letter-spacing: .14em; text-transform: uppercase; }
  .pp-input {
    background: var(--panel); border: 1px solid var(--border);
    color: var(--text); font-family: var(--mono); font-size: 16px;
    padding: 10px 16px; border-radius: 6px; outline: none; width: 260px;
    text-align: center; letter-spacing: .1em;
    transition: border-color .15s;
  }
  .pp-input:focus { border-color: var(--accent); }
  .pp-error { font-size: 12px; color: var(--danger); font-family: var(--mono); min-height: 16px; }
  @keyframes pp-shake {
    0%,100%{ transform: translateX(0); }
    20%{ transform: translateX(-8px); }
    40%{ transform: translateX(8px); }
    60%{ transform: translateX(-6px); }
    80%{ transform: translateX(6px); }
  }
  .pp-input.shake { animation: pp-shake 0.35s ease; border-color: var(--danger); }

  /* -- Splash screen -- */
  #splash {
    position: fixed; inset: 0; z-index: 999;
    background: var(--bg);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 18px;
    transition: opacity 1.4s ease;
  }
  #splash.fade-out { opacity: 0; pointer-events: none; }
  #splash-ascii {
    color: var(--accent);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.2;
    white-space: pre;
    text-shadow: 0 0 22px var(--accent);
    animation: fadepulse 3s ease-in-out 1 forwards;
  }
  #splash-tagline {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
    letter-spacing: .18em;
    text-transform: uppercase;
  }
  #splash-meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent2);
    letter-spacing: .12em;
    display: flex; gap: 24px;
  }

  /* -- Modals -- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,.65);
    display: flex; align-items: center; justify-content: center; z-index: 200;
  }
  .modal-box {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 24px; min-width: 340px; display: flex; flex-direction: column; gap: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,.5);
  }
  .modal-box-wide { min-width: 480px; }
  .modal-header { display: flex; align-items: center; justify-content: space-between; }
  .modal-title { font-size: 13px; font-weight: 600; color: var(--accent); letter-spacing: .07em; text-transform: uppercase; }
  .modal-close { background: transparent; border: none; color: var(--muted); font-size: 18px; cursor: pointer; line-height: 1; padding: 0; }
  .modal-close:hover { color: var(--text); }
  .modal-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; display: block; margin-bottom: 5px; }
  .modal-input {
    width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); font-family: var(--mono); font-size: 13px;
    padding: 7px 10px; border-radius: 5px; outline: none;
  }
  .modal-input:focus { border-color: var(--accent2); }
  .modal-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .modal-list { display: flex; flex-direction: column; gap: 5px; max-height: 320px; overflow-y: auto; }
  .modal-row {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px;
    border-radius: 6px; border: 1px solid var(--border); cursor: pointer; transition: border-color .15s;
  }
  .modal-row:hover { border-color: var(--accent); }
  .modal-row-name { flex: 0 0 auto; font-size: 13px; color: var(--text); min-width: 100px; }
  .modal-row-meta { flex: 1; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .modal-row-del { background: transparent; border: none; color: var(--muted); cursor: pointer; font-size: 15px; padding: 0 2px; flex-shrink: 0; }
  .modal-row-del:hover { color: var(--danger); }
  .modal-empty { font-size: 12px; color: var(--muted); font-style: italic; text-align: center; padding: 20px 0; }
</style>
</head>
<body>

<!-- Passphrase gate (shown before splash) -->
<div id="modal-passphrase">
  <div class="pp-title">Enter passphrase to continue</div>
  <input id="pp-input" class="pp-input" type="password" autocomplete="off" spellcheck="false" placeholder="passphrase">
  <div id="pp-error" class="pp-error"></div>
  <button id="pp-ok" class="btn btn-connect" style="width:260px;padding:8px 0;">OK</button>
</div>

<div id="splash" style="display:none">
  <div id="splash-ascii">__        ___ _
\ \      / (_) |_ ___
 \ \ /\ / /| | __/ __|
  \ V  V / | | |_\__ \
   \_/\_/  |_|\__|___/</div>
  <div id="splash-tagline">Web Interface to SSH</div>
  <div id="splash-meta">
    <span>v${VERSION}</span>
    <span id="splash-platform"></span>
  </div>
</div>

<div id="frame">
<div id="toolbar">
  <div class="logo-bar">
    <span class="logo">Wits</span>
    <span class="logo-version">v${VERSION}</span>
  </div>
  <div class="field-group">
    <label id="lbl-host">host</label>
    <input id="in-host" type="text" value="" autocomplete="off">
  </div>
  <div class="field-group">
    <label id="lbl-user">user</label>
    <input id="in-user" type="text" value="" autocomplete="off">
  </div>
  <div class="field-group">
    <label id="lbl-port">port</label>
    <input id="in-port" type="number" value="" autocomplete="off">
  </div>
  <div class="field-group">
    <label id="lbl-key">key</label>
    <div style="display:flex;gap:4px;align-items:center;">
      <input id="in-key" type="text" value="" autocomplete="off" style="flex:1;min-width:0;">
      <button id="btn-key-browse" title="Browse for key file" style="background:var(--border);border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:11px;padding:4px 0;border-radius:5px;cursor:pointer;text-align:center;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--muted)'">...</button>
      <input id="in-key-file" type="file" style="display:none">
    </div>
  </div>
  <button class="btn btn-connect"    id="btn-connect">Connect</button>
  <button class="btn btn-disconnect" id="btn-disconnect" style="display:none">Disconnect</button>
  <button class="btn btn-ssh-client" id="btn-ssh-client">Open with SSH client</button>
  <button class="btn btn-save"       id="btn-save">Save</button>
  <button class="btn btn-load"       id="btn-load">Load session</button>

  <div id="sidebar-spacer"></div>

  <div id="pill">
    <div id="pill-dot"></div>
    <span id="pill-label">disconnected</span>
  </div>
  <button id="btn-clear" style="background:transparent;border:1px solid var(--border);color:var(--muted);font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:2px 10px;border-radius:5px;cursor:pointer;width:100%;" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--muted)'">Clear</button>
  <button class="btn" id="btn-stop">Stop backend</button>
</div>

<div id="content">

<div id="main">
  <div id="output"></div>
</div>

<div id="cmd-bar">
  <span id="prompt">$&gt;</span>
  <input id="cmd-input" type="text" placeholder="enter command..." disabled autocomplete="off" spellcheck="false">
  <button class="btn" id="send-btn" disabled>Send</button>
</div>

<div id="err-bar">
  <span>&#x2716;</span>
  <span id="err-bar-msg"></span>
  <button id="err-bar-close" onclick="closeErrModal()">&#x2715;</button>
</div>

<!-- -- Debug panel -- -->
<div id="debug-wrapper">
  <div id="debug-header" onclick="toggleDebug()">
    <span>Debug Log</span>
    <span id="debug-badge"></span>
    <span id="debug-toggle">^</span>
    <button class="btn btn-clear" id="btn-clear-debug" onclick="event.stopPropagation(); clearDebug()" style="margin-left:8px;padding:2px 8px;font-size:10px;">Clear</button>
  </div>
  <div id="debug-log"></div>
</div>

</div>

</div> <!-- /#frame -->

<!-- Shutdown modal (non-dismissable) --><div id="modal-shutdown" class="modal-overlay" style="display:none">
  <div class="modal-box">
    <div class="shutdown-icon">&#x23FC;</div>
    <div class="shutdown-title">Backend is down</div>
    <div class="shutdown-sub">The server is no longer available.<br>You can close this tab.</div>
  </div>
</div>

<!-- Save session modal -->
<div id="modal-save" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeSaveModal()">
  <div class="modal-box">
    <div class="modal-header">
      <span class="modal-title">Save session</span>
      <button class="modal-close" onclick="closeSaveModal()">&#x2715;</button>
    </div>
    <div>
      <label class="modal-label" for="modal-save-name">Session name</label>
      <input id="modal-save-name" class="modal-input" type="text" placeholder="e.g. prod-server" autocomplete="off">
      <div id="modal-save-err" style="font-size:11px;color:var(--danger);font-family:var(--mono);min-height:14px;margin-top:6px;"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-clear"   onclick="closeSaveModal()">Cancel</button>
      <button class="btn btn-connect" id="modal-save-ok">Save</button>
    </div>
  </div>
</div>

<!-- Load session modal -->
<div id="modal-load" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeLoadModal()">
  <div class="modal-box modal-box-wide">
    <div class="modal-header">
      <span class="modal-title">Load session</span>
      <button class="modal-close" onclick="closeLoadModal()">&#x2715;</button>
    </div>
    <div id="modal-load-list" class="modal-list"></div>
    <div class="modal-footer">
      <button class="btn btn-clear" onclick="closeLoadModal()">Cancel</button>
    </div>
  </div>
</div>

<!-- Key rejected modal -->
<div id="modal-key-rejected" class="modal-overlay" style="display:none">
  <div class="modal-box" style="width:25vw;min-width:0">
    <div class="modal-header">
      <span class="modal-title" style="color:var(--danger)">Authentication failed</span>
    </div>
    <div id="modal-key-rejected-msg" style="font-size:13px;color:var(--text);line-height:1.6;"></div>
    <div class="modal-footer">
      <button class="btn btn-clear" onclick="closeKeyRejectedModal()">Close</button>
    </div>
  </div>
</div>

<script>
  const output    = document.getElementById('output');
  const cmdInput  = document.getElementById('cmd-input');
  const sendBtn   = document.getElementById('send-btn');
  const btnConn   = document.getElementById('btn-connect');
  const btnDisc   = document.getElementById('btn-disconnect');
  const btnClear  = document.getElementById('btn-clear');
  const pillDot   = document.getElementById('pill-dot');
  const pillLabel = document.getElementById('pill-label');
  const debugLog  = document.getElementById('debug-log');
  const debugBadge = document.getElementById('debug-badge');
  const debugWrapper = document.getElementById('debug-wrapper');

  let ws = null;
  const history = [];
  let histIdx = -1;
  let debugCount = 0;
  let debugCollapsed = false;
  let passwordMode = false;
  let passwordBuffer = '';
  const MAX_LINES = 5000;         // scrollback cap -- only this many lines kept in DOM
  const MAX_BUF   = 500_000;      // incoming buffer cap (bytes) -- excess dropped to prevent OOM
  let lines      = [];            // array of complete line strings (each ends with \n)
  let curLine    = '';            // current incomplete line (no \n yet)
  let pendingBuf = '';            // raw incoming text waiting for next animation frame
  let rafPending = false;
  let dataChunkCount = 0;         // for debug throttling

  // -- Debug panel helpers ----------------------------------------------------

  function ts() {
    return new Date().toTimeString().slice(0, 12); // HH:MM:SS.mmm
  }

  function dlog(level, msg) {
    debugCount++;
    debugBadge.textContent = debugCount;
    debugBadge.classList.add('visible');

    const cls = { WS: 'dl-ws', SSH: 'dl-ssh', CMD: 'dl-cmd', ERR: 'dl-err' }[level] ?? 'dl-info';
    const row = document.createElement('div');
    row.className = 'dl ' + cls;
    row.innerHTML =
      '<span class="dl-ts">' + ts() + '</span>' +
      '<span class="dl-level">[' + level + ']</span>' +
      '<span class="dl-msg">' + escHtml(msg) + '</span>';
    debugLog.appendChild(row);
    debugLog.scrollTop = debugLog.scrollHeight;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function toggleDebug() {
    debugCollapsed = !debugCollapsed;
    debugWrapper.classList.toggle('collapsed', debugCollapsed);
    document.getElementById('debug-toggle').textContent = debugCollapsed ? 'v' : '^';
  }

  function clearDebug() {
    debugLog.innerHTML = '';
    debugCount = 0;
    debugBadge.textContent = '0';
    debugBadge.classList.remove('visible');
  }

  // -- Terminal output helpers ------------------------------------------------

  function stripAnsi(str) {
    return str
      .replace(/\x1b\[[0-9;?]*[@-~]/g, '')               // CSI  e.g. \x1b[32m \x1b[2J
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC  e.g. \x1b]0;title\x07
      .replace(/\x1b[\s\S]/g, '');                        // everything else
  }

  // Escape HTML so raw SSH output can't inject markup, then
  // highlight "Connection refused" with a blinking red span.
  function safeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/Connection refused/gi, '<span class="conn-refused">$&</span>');
  }

  // Render a chunk of raw text: strip ANSI, split on newlines/CRs,
  // maintain the lines[] array (capped at MAX_LINES), then replace
  // output.innerHTML in one shot.
  function renderChunk(text) {
    const tokens = stripAnsi(text).split(/(\r\n|\r|\n)/);
    for (const tok of tokens) {
      if (tok === '\r\n' || tok === '\n') {
        lines.push(curLine + '\n');
        if (lines.length > MAX_LINES) lines.shift();
        curLine = '';
      } else if (tok === '\r') {
        curLine = '';
      } else if (tok) {
        curLine += tok;
      }
    }
    output.innerHTML = safeHtml(lines.join('') + curLine);
    output.scrollTop = output.scrollHeight;
  }

  function flushPending() {
    rafPending = false;
    if (!pendingBuf) return;
    const buf = pendingBuf;
    pendingBuf = '';
    renderChunk(buf);
  }

  // writeOutput -- all output paths go through here.
  // cls: styled system/error/cmd line -> rendered immediately as plain text.
  // no cls: raw SSH data -> buffered, rendered on next animation frame.
  function writeOutput(text, cls) {
    if (cls) {
      if (pendingBuf) flushPending();   // keep ordering with buffered raw data
      renderChunk(stripAnsi(text));
      return;
    }
    // Cap incoming buffer -- prevents OOM when SSH floods data (e.g. find /)
    // faster than the browser can consume it.
    if (pendingBuf.length + text.length > MAX_BUF) {
      const keep = Math.floor(MAX_BUF / 2);
      pendingBuf = pendingBuf.slice(-keep);
      // dlog('WARN', 'Buffer cap hit - dropped oldest ' + (MAX_BUF - keep) + ' bytes');
    }
    pendingBuf += text;
    if (!rafPending) { rafPending = true; requestAnimationFrame(flushPending); }
  }

  function line(text, cls) { writeOutput(text, cls); }

  function setConnected(on) {
    if (!on && passwordMode) {
      passwordMode = false;
      passwordBuffer = '';
      cmdInput.value = '';
      cmdInput.classList.remove('masked');
      cmdInput.placeholder = 'enter command...';
    }
    cmdInput.disabled = !on;
    sendBtn.disabled  = !on;
    btnConn.style.display = on ? 'none' : '';
    btnDisc.style.display = on ? ''     : 'none';
    pillDot.className     = on ? 'on'   : '';
    document.getElementById('btn-load').disabled        = on;
    if (on) {
      document.getElementById('btn-connect').disabled    = true;
      document.getElementById('btn-ssh-client').disabled = true;
      document.getElementById('btn-save').disabled       = true;
    } else {
      updateActionButtons();
    }
    document.getElementById('in-host').disabled         = on;
    document.getElementById('in-user').disabled         = on;
    document.getElementById('in-port').disabled         = on;
    document.getElementById('in-key').disabled          = on;
    document.getElementById('btn-key-browse').disabled  = on;
    if (on) {
      pillLabel.textContent = 'connected';
      pillLabel.style.color = 'var(--accent)';
    } else {
      pillLabel.textContent = 'disconnected';
      pillLabel.style.color = '';
    }
    dlog('WS', 'State -> ' + (on ? 'CONNECTED' : 'DISCONNECTED'));
    if (on) cmdInput.focus();
  }

  // -- Shared field validation ------------------------------------------------
  // Fills defaults for optional fields, returns array of error strings for
  // required fields that are still empty after defaulting.
  function validate() {
    var errors = [];
    if (!document.getElementById('in-host').value.trim()) errors.push('Host is required');
    if (!document.getElementById('in-user').value.trim()) errors.push('User is required');
    if (!document.getElementById('in-port').value.trim()) errors.push('Port is required');
    if (!document.getElementById('in-key').value.trim())  errors.push('Key is required');
    return errors;
  }

  function showErr(errors) {
    var bar = document.getElementById('err-bar');
    var msg = document.getElementById('err-bar-msg');
    msg.textContent = Array.isArray(errors) ? errors.join('  |  ') : errors;
    bar.classList.add('visible');
    dlog('ERR', msg.textContent);
  }

  function closeErrModal() {
    document.getElementById('err-bar').classList.remove('visible');
  }

  async function stopServer() {
    var btn = document.getElementById('btn-stop');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fetch('/shutdown', { method: 'POST' });
    } catch(e) { /* server may close socket before response -- expected */ }
    if (ws) { try { ws.close(); } catch(e) {} ws = null; }
    document.getElementById('modal-shutdown').style.display = 'flex';
  }

  // -- WebSocket --------------------------------------------------------------

  function openWS() {
    var errors = validate();
    if (errors.length) { showErr(errors); return; }

    const host = document.getElementById('in-host').value.trim();
    const user = document.getElementById('in-user').value.trim();
    const port = document.getElementById('in-port').value.trim();
    const key  = document.getElementById('in-key').value.trim();

    const wsUrl = 'ws://' + location.host + '/ws';
    dlog('WS', 'Opening WebSocket -> ' + wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      dlog('WS', 'WebSocket opened (readyState=' + ws.readyState + ')');
      const payload = { type: 'connect', host, user, port, key };
      dlog('SSH', 'Sending connect: ' + JSON.stringify(payload));
      ws.send(JSON.stringify(payload));
      line('Connecting ' + user + '@' + host + ':' + port + ' ...\n', 'line-info');
    };

    ws.onmessage = ({ data }) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        dlog('ERR', 'Failed to parse server message: ' + data);
        return;
      }

      // Only log non-data events + every 100th data chunk to keep debug panel usable
      if (msg.type !== 'data') {
        dlog('WS', 'Received type=' + msg.type);
      } else {
        dataChunkCount++;
        // if (dataChunkCount === 1 || dataChunkCount % 100 === 0)
        //   dlog('WS', 'data chunk #' + dataChunkCount + '  len=' + msg.data.length);
      }

      if      (msg.type === 'connected')     setConnected(true);
      else if (msg.type === 'closed')      { setConnected(false); line('\n[session closed]\n', 'line-sys'); }
      else if (msg.type === 'key-rejected'){ setConnected(false); showKeyRejectedModal(); }
      else if (msg.type === 'data') {
        const plain = stripAnsi(msg.data);
        if (/password[^:]*:\s*$/i.test(plain) || /enter passphrase[^:]*:\s*$/i.test(plain)) {
          passwordMode = true;
          passwordBuffer = '';
          cmdInput.value = '';
          cmdInput.classList.add('masked');
          cmdInput.placeholder = 'enter password...';
        }
        line(msg.data);
      }
      else if (msg.type === 'error')       { line(msg.data, 'line-err'); dlog('ERR', 'Server error: ' + msg.data); }
      else                                   dlog('WS', 'Unknown message type: ' + msg.type);
    };

    ws.onclose = (e) => {
      dlog('WS', 'WebSocket closed -- code=' + e.code + ' reason=' + (e.reason || '(none)') + ' wasClean=' + e.wasClean);
      setConnected(false);
      if (e.code === 1006) {
        document.getElementById('modal-shutdown').style.display = 'flex';
      }
    };

    ws.onerror = (e) => {
      dlog('ERR', 'WebSocket error event fired (check server is running on port ' + location.port + ')');
      line('WebSocket error\n', 'line-err');
      setConnected(false);
    };
  }

  function sendCmd() {
    const cmd = cmdInput.value;
    if (!cmd.trim() || !ws) {
      if (!ws) dlog('ERR', 'sendCmd called but ws is null');
      return;
    }
    if (passwordMode) {
      dlog('CMD', 'Sending: [password]');
      ws.send(JSON.stringify({ type: 'cmd', data: passwordBuffer, secret: true }));
      passwordMode = false;
      passwordBuffer = '';
      cmdInput.value = '';
      cmdInput.classList.remove('masked');
      cmdInput.placeholder = 'enter command...';
    } else {
      dlog('CMD', 'Sending: ' + cmd);
      history.unshift(cmd);
      histIdx = -1;
      line('$ ' + cmd + '\n', 'line-cmd');
      ws.send(JSON.stringify({ type: 'cmd', data: cmd }));
      cmdInput.value = '';
    }
  }

  // -- Event listeners --------------------------------------------------------

  btnConn.addEventListener('click', openWS);
  btnDisc.addEventListener('click', () => {
    if (!ws) { dlog('ERR', 'Disconnect clicked but ws is null'); return; }
    dlog('WS', 'Sending disconnect request');
    ws.send(JSON.stringify({ type: 'disconnect' }));
  });
  btnClear.addEventListener('click', () => {
    lines = []; curLine = ''; pendingBuf = ''; rafPending = false;
    output.innerHTML = '';
  });
  sendBtn.addEventListener('click', sendCmd);

  cmdInput.addEventListener('keydown', e => {
    if (passwordMode) {
      if (e.key === 'Enter') { sendCmd(); return; }
      if (e.key === 'Backspace') {
        passwordBuffer = passwordBuffer.slice(0, -1);
        cmdInput.value = '•'.repeat(passwordBuffer.length);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        passwordBuffer += e.key;
        cmdInput.value = '•'.repeat(passwordBuffer.length);
      }
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') { sendCmd(); return; }
    if (e.key === 'ArrowUp') {
      histIdx = Math.min(histIdx + 1, history.length - 1);
      cmdInput.value = history[histIdx] ?? '';
      e.preventDefault();
    }
    if (e.key === 'ArrowDown') {
      histIdx = Math.max(histIdx - 1, -1);
      cmdInput.value = histIdx === -1 ? '' : history[histIdx];
      e.preventDefault();
    }
    if (e.ctrlKey && e.key === 'c' && ws) {
      dlog('CMD', 'Sending SIGINT (Ctrl+C)');
      ws.send(JSON.stringify({ type: 'ctrl', signal: 'SIGINT' }));
      line('^C\n', 'line-sys');
      e.preventDefault();
    }
  });

  document.getElementById('btn-key-browse').addEventListener('click', function() {
    document.getElementById('in-key-file').click();
  });
  document.getElementById('in-key-file').addEventListener('change', function() {
    if (this.files && this.files[0]) {
      document.getElementById('in-key').value = this.files[0].path || this.files[0].name;
      clearSessionLabel('key');
      updateActionButtons();
    }
  });
  var SESSION_FIELDS = ['host','user','port','key'];
  function setSessionLabels() {
    SESSION_FIELDS.forEach(function(f) {
      document.getElementById('lbl-' + f).textContent = f + ' (from session)';
    });
  }
  function clearSessionLabel(f) {
    document.getElementById('lbl-' + f).textContent = f;
  }
  function updateActionButtons() {
    const allFilled = SESSION_FIELDS.every(f => document.getElementById('in-' + f).value.trim() !== '');
    document.getElementById('btn-connect').disabled    = !allFilled;
    document.getElementById('btn-ssh-client').disabled = !allFilled;
    document.getElementById('btn-save').disabled       = !allFilled;
  }
  SESSION_FIELDS.forEach(function(f) {
    document.getElementById('in-' + f).addEventListener('input', function() {
      clearSessionLabel(f);
      updateActionButtons();
    });
  });
  document.getElementById('in-port').addEventListener('keydown', function(e) {
    if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault();
  });
  updateActionButtons();

  // -- Session management --

  document.getElementById('btn-save').addEventListener('click', openSaveModal);
  document.getElementById('btn-load').addEventListener('click', openLoadModal);
  document.getElementById('btn-ssh-client').addEventListener('click', openWithSshClient);
  document.getElementById('btn-stop').addEventListener('click', stopServer);
  document.getElementById('modal-save-ok').addEventListener('click', saveSession);
  document.getElementById('modal-save-name').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') saveSession();
    if (e.key === 'Escape') closeSaveModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { closeSaveModal(); closeLoadModal(); closeErrModal(); closeKeyRejectedModal(); }
  });

  async function openWithSshClient() {
    var errors = validate();
    if (errors.length) { showErr(errors); return; }
    var body = {
      host: document.getElementById('in-host').value.trim(),
      user: document.getElementById('in-user').value.trim(),
      port: document.getElementById('in-port').value.trim(),
      key:  document.getElementById('in-key').value.trim()
    };
    try {
      var res = await fetch('/open-ssh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var json = await res.json();
      if (res.ok && json.ok) dlog('INFO', 'SSH client launched: ' + json.cmd);
      else showErr(json.error || 'Failed to open SSH client');
    } catch(e) { showErr('Could not reach server: ' + e.message); }
  }

  function openSaveModal() {
    document.getElementById('modal-save-name').value = '';
    document.getElementById('modal-save-err').textContent = '';
    document.getElementById('modal-save').style.display = 'flex';
    setTimeout(function() { document.getElementById('modal-save-name').focus(); }, 50);
  }
  function closeSaveModal() {
    document.getElementById('modal-save').style.display = 'none';
  }

  async function saveSession() {
    var nameErr = [];
    var name = document.getElementById('modal-save-name').value.trim();
    if (!name) nameErr.push('Session name is required');
    var fieldErrors = validate();
    var all = nameErr.concat(fieldErrors);
    if (all.length) { showErr(all); return; }

    var body = {
      name: name,
      host: document.getElementById('in-host').value.trim(),
      user: document.getElementById('in-user').value.trim(),
      port: document.getElementById('in-port').value.trim(),
      key:  document.getElementById('in-key').value.trim()
    };
    try {
      var res = await fetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var json = await res.json();
      if (res.ok && json.ok) { closeSaveModal(); dlog('INFO', 'Session saved: ' + name); }
      else document.getElementById('modal-save-err').textContent = json.error || 'Failed to save session (HTTP ' + res.status + ')';
    } catch(e) { showErr('Could not reach server: ' + e.message); }
  }

  async function openLoadModal() {
    document.getElementById('modal-load').style.display = 'flex';
    await refreshSessionList();
  }
  function closeLoadModal() {
    document.getElementById('modal-load').style.display = 'none';
  }

  function showKeyRejectedModal() {
    const user = document.getElementById('in-user').value.trim();
    const host = document.getElementById('in-host').value.trim();
    document.getElementById('modal-key-rejected-msg').textContent =
      'The SSH key for ' + user + '@' + host + ' was rejected by the remote host. ' +
      'Wits supports key-based authentication only — verify that the correct public key is authorised on the remote host.';
    document.getElementById('modal-key-rejected').style.display = 'flex';
  }
  function closeKeyRejectedModal() {
    document.getElementById('modal-key-rejected').style.display = 'none';
  }

  async function refreshSessionList() {
    var list = document.getElementById('modal-load-list');
    list.innerHTML = '';
    try {
      var res = await fetch('/sessions');
      var sessions = await res.json();
      if (!sessions.length) {
        var empty = document.createElement('div');
        empty.className = 'modal-empty';
        empty.textContent = 'No saved sessions yet.';
        list.appendChild(empty);
        return;
      }
      sessions.forEach(function(s) {
        var row  = document.createElement('div');
        row.className = 'modal-row';

        var nameEl = document.createElement('span');
        nameEl.className = 'modal-row-name';
        nameEl.textContent = s.name;

        var metaEl = document.createElement('span');
        metaEl.className = 'modal-row-meta';
        metaEl.textContent = s.user + '@' + s.host + ':' + s.port + '  ' + s.key;

        var del = document.createElement('button');
        del.className = 'modal-row-del';
        del.title = 'Delete';
        del.textContent = '\u2715';
        del.onclick = async function(e) {
          e.stopPropagation();
          var r = await fetch('/sessions/' + encodeURIComponent(s.name), { method: 'DELETE' });
          var j = await r.json();
          if (!r.ok || !j.ok) { showErr(j.error || 'Could not delete session'); return; }
          await refreshSessionList();
        };

        row.appendChild(nameEl);
        row.appendChild(metaEl);
        row.appendChild(del);
        row.onclick = function() {
          document.getElementById('in-host').value = s.host;
          document.getElementById('in-user').value = s.user;
          document.getElementById('in-port').value = s.port;
          document.getElementById('in-key').value  = s.key;
          setSessionLabels();
          updateActionButtons();
          closeLoadModal();
          dlog('INFO', 'Session loaded: ' + s.name);
        };
        list.appendChild(row);
      });
    } catch(e) {
      var err = document.createElement('div');
      err.className = 'modal-empty';
      err.textContent = 'Error: ' + e.message;
      list.appendChild(err);
    }
  }

  // -- Passphrase gate --
  (function() {
    var ppModal = document.getElementById('modal-passphrase');
    var ppInput = document.getElementById('pp-input');
    var ppError = document.getElementById('pp-error');
    var splash  = document.getElementById('splash');

    function unlock() {
      ppModal.classList.add('hidden');
      splash.style.display = 'flex';
    }

    function shake() {
      ppInput.classList.remove('shake');
      void ppInput.offsetWidth;
      ppInput.classList.add('shake');
      setTimeout(function() { ppInput.classList.remove('shake'); }, 400);
    }

    async function tryAuth() {
      var val = ppInput.value;
      if (!val) { shake(); return; }
      try {
        var res = await fetch('/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: val })
        });
        var json = await res.json();
        if (json.ok) { unlock(); }
        else {
          ppError.textContent = 'Incorrect passphrase';
          ppInput.value = '';
          shake();
        }
      } catch(e) {
        ppError.textContent = 'Could not reach server';
        shake();
      }
    }

    // Check auth_mode from /info -- if "none", skip prompt immediately
    fetch('/info').then(function(r) { return r.json(); }).then(function(info) {
      if (info.auth_mode === 'none') { unlock(); return; }
      ppInput.focus();
    }).catch(function() { ppInput.focus(); });

    ppInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') tryAuth();
      ppError.textContent = '';
    });
    document.getElementById('pp-ok').addEventListener('click', tryAuth);
  })();

  // -- Persistent control WebSocket (server notifications, open immediately) --
  (function() {
    function openCtrl() {
      var ctrlWs = new WebSocket('ws://' + location.host + '/ctrl');
      ctrlWs.onmessage = function(e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'sigint') {
            dlog('WS', 'Backend SIGINT -- showing shutdown modal');
            document.getElementById('modal-shutdown').style.display = 'flex';
          }
        } catch(ex) {}
      };
      ctrlWs.onclose = function() {
        // Reconnect after 1s unless the shutdown modal is already visible
        setTimeout(function() {
          if (document.getElementById('modal-shutdown').style.display === 'none' ||
              !document.getElementById('modal-shutdown').style.display) {
            openCtrl();
          }
        }, 1000);
      };
    }
    openCtrl();
  })();
  // -- Startup message --
  (function() {
    var host = document.getElementById('in-host').value.trim();
    var user = document.getElementById('in-user').value.trim();
    var port = document.getElementById('in-port').value.trim();
    line('\n\n\n', 'line-ssh');
    line('\n', 'line-info');
    line(
      'CONNECT       open an SSH session with the current host/user/port/key\n' +
      'DISCONNECT    close the active session gracefully\n' +
      'SAVE          save the current connection details under a named profile\n' +
      'LOAD SESSION  pick and restore a previously saved profile\n' +
      'CLEAR         wipe the terminal output\n' +
      'STOP BACKEND  shut down the Bun backend process\n' +
      '\nCtrl+C in the command bar sends SIGINT to the remote process.\n' +
      'Arrow Up/Down cycle through command history.\n\n',
      'line-sys'
    );
  })();

  (function() {
    fetch('/info')
      .then(function(r) { return r.json(); })
      .then(function(info) {
        document.getElementById('splash-platform').textContent = info.platform || 'unknown';
        dlog('INFO', 'Server platform: ' + info.platform);
      })
      .catch(function() {
        document.getElementById('splash-platform').textContent = 'unknown';
        dlog('INFO', 'Server platform: unknown (fetch failed)');
      });
    setTimeout(function() {
      var el = document.getElementById('splash');
      el.classList.add('fade-out');
      setTimeout(function() { el.style.display = 'none'; }, 1500);
    }, 2000);
  })();
</script>
</body>
</html>`;

// ─── Stream stdout/stderr to the websocket ────────────────────────────────────

async function pipeStream(stream, ws, label, id) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  dbg("SSH", `[${short(id)}] pipe start: ${label}`);
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        dbg("SSH", `[${short(id)}] pipe end: ${label} (${chunkCount} chunks)`);
        break;
      }
      chunkCount++;
      const text = dec.decode(value);

      if (/Permission denied \(publickey/i.test(text)) {
        const session = sessions.get(id);
        if (session && !session.keyRejected) {
          session.keyRejected = true;
          dbg("WARN", `[${short(id)}] SSH key rejected — remote host requested password`);
          ws.send(JSON.stringify({ type: "key-rejected" }));
          try { session.proc.kill(); } catch {}
        }
        return;
      }

      ws.send(JSON.stringify({ type: "data", data: text }));
    }
  } catch (err) {
    dbg("ERROR", `[${short(id)}] ${label} pipe error: ${err?.message ?? err}`);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

// ─── Route handlers ──────────────────────────────────────────────────────────

const JSON_HDR = { "Content-Type": "application/json" };
const HTML_HDR = { "Content-Type": "text/html; charset=utf-8" };

const authTokens = new Set();

function isAuthenticated(req) {
  if (AUTH_MODE === "none") return true;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)wits_session=([^;]+)/);
  return m ? authTokens.has(m[1]) : false;
}

// IP guard + request logger + optional auth check
const R = (fn, requireAuth = true) => (req, server) => {
  const clientIP = server.requestIP(req)?.address;
  if (clientIP !== "127.0.0.1" && clientIP !== "::1") {
    dbg("WARN", `Rejected connection from ${clientIP}`);
    return new Response("Forbidden", { status: 403 });
  }
  dbg("INFO", `HTTP ${req.method} ${new URL(req.url).pathname}`);
  if (requireAuth && !isAuthenticated(req)) {
    dbg("WARN", `Unauthenticated request to ${new URL(req.url).pathname}`);
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: JSON_HDR });
  }
  return fn(req, server);
};

async function routeOpenSsh(req) {
  try {
    const { host, user, port, key } = await req.json();
    const expandedKey = expandHome(key);
    const sshCmd = ["ssh", "-i", expandedKey, "-p", String(port),
      "-o", "StrictHostKeyChecking=no", `${user}@${host}`];
    const cmdStr = sshCmd.join(" ");
    let spawnArgs;
    if (process.platform === "win32") {
      spawnArgs = ["cmd", "/c", "start", "cmd", "/k", ...sshCmd];
    } else if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script "${cmdStr.replace(/"/g, '\\"')}"`;
      spawnArgs = ["osascript", "-e", script];
    } else {
      const terminals = [
        ["x-terminal-emulator", "-e"], ["gnome-terminal", "--"],
        ["xterm", "-e"], ["konsole", "-e"], ["xfce4-terminal", "-e"],
      ];
      const { stdout } = await Bun.spawn(["sh", "-c",
        terminals.map(t => `command -v ${t[0]}`).join("; ")
      ], { stdout: "pipe" }).stdout.text().catch(() => "");
      const found = terminals.find(t => stdout.includes(t[0])) || ["xterm", "-e"];
      spawnArgs = [...found, ...sshCmd];
    }
    dbg("INFO", `open-ssh: ${spawnArgs.join(" ")}`);
    Bun.spawn(spawnArgs, { detached: true, stdout: null, stderr: null, stdin: null });
    return new Response(JSON.stringify({ ok: true, cmd: cmdStr }), { headers: JSON_HDR });
  } catch (err) {
    dbg("ERROR", `open-ssh: ${err?.message}`);
    return new Response(JSON.stringify({ ok: false, error: `Could not launch SSH client: ${err?.message}` }), { status: 500, headers: JSON_HDR });
  }
}

async function routeAuth(req) {
  const grant = () => {
    const token = crypto.randomUUID();
    authTokens.add(token);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...JSON_HDR, "Set-Cookie": `wits_session=${token}; Path=/; HttpOnly; SameSite=Strict` }
    });
  };
  if (AUTH_MODE === "none") return grant();
  const { passphrase } = await req.json();
  const expected = AUTH_MODE === "custom" ? CUSTOM_PASS : RANDOM_PASS;
  const ok = (passphrase || "") === expected;
  dbg("INFO", `Auth attempt: ${ok ? "OK" : "FAIL"} (via passphrase)`);
  return ok ? grant() : new Response(JSON.stringify({ ok: false }), { headers: JSON_HDR });
}

function routeInfo() {
  return new Response(JSON.stringify({ platform: process.platform, version: VERSION, auth_mode: AUTH_MODE }), { headers: JSON_HDR });
}

async function routeSessionsGet() {
  return new Response(JSON.stringify(await readSessions()), { headers: JSON_HDR });
}

async function routeSessionsPost(req) {
  try {
    const { name, host, user, port, key } = await req.json();
    const list = await readSessions();
    if (list.some(s => s.name === name))
      return new Response(JSON.stringify({ ok: false, error: `A session named "${name}" already exists` }), { status: 409, headers: JSON_HDR });
    list.push({ name, host, user, port, key });
    await writeSessions(list);
    dbg("INFO", `Session saved: ${name}`);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HDR });
  } catch (err) {
    dbg("ERROR", `POST /sessions: ${err?.message}`);
    return new Response(JSON.stringify({ ok: false, error: err?.message }), { status: 500, headers: JSON_HDR });
  }
}

async function routeSessionDelete(req) {
  try {
    const name = decodeURIComponent(req.params.name);
    await writeSessions((await readSessions()).filter(s => s.name !== name));
    dbg("INFO", `Session deleted: ${name}`);
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HDR });
  } catch (err) {
    dbg("ERROR", `DELETE /sessions: ${err?.message}`);
    return new Response(JSON.stringify({ ok: false, error: err?.message }), { status: 500, headers: JSON_HDR });
  }
}

function routeShutdown() {
  if (shuttingDown) return new Response(JSON.stringify({ ok: true }), { headers: JSON_HDR });
  shuttingDown = true;
  dbg("INFO", "Shutdown requested -- closing all sessions");
  for (const [id, { proc }] of sessions) {
    try { proc.kill(); } catch {}
    dbg("SSH", `[${short(id)}] killed on shutdown`);
  }
  sessions.clear();
  setTimeout(() => { dbg("INFO", "Exiting."); process.exit(0); }, 150);
  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HDR });
}

function routeWs(req, server) {
  const id = crypto.randomUUID();
  const ok = server.upgrade(req, { data: { id, ctrl: false } });
  if (!ok) { dbg("ERROR", `WebSocket upgrade failed for ${short(id)}`); return new Response("Upgrade failed", { status: 400 }); }
  dbg("WS", `Upgrade accepted, id=${short(id)}`);
}

function routeCtrl(req, server) {
  const id = "ctrl-" + crypto.randomUUID().slice(0, 8);
  const ok = server.upgrade(req, { data: { id, ctrl: true } });
  if (!ok) return new Response("Upgrade failed", { status: 400 });
  dbg("WS", `Control WS connected id=${id}`);
}

// --- Sessions CSV ------------------------------------------------------------

const SESSIONS_FILE = "sessions.saved";

function csvField(s) {
  s = String(s ?? "");
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function parseCSV(text) {
  return text.trim().split("\n").filter(Boolean).map(line => {
    const fields = [];
    let field = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ && line[i+1] === '"' ? (field += '"', i++) : (inQ = !inQ); }
      else if (c === "," && !inQ) { fields.push(field); field = ""; }
      else field += c;
    }
    fields.push(field);
    const [name, host, user, port, key] = fields;
    return { name, host, user, port, key };
  });
}

async function readSessions() {
  try {
    return parseCSV(await Bun.file(SESSIONS_FILE).text());
  } catch (err) {
    if (err?.code !== "ENOENT") dbg("WARN", `readSessions: ${err?.message}`);
    return [];
  }
}

async function writeSessions(sessions) {
  const csv = sessions.map(s =>
    [s.name, s.host, s.user, s.port, s.key].map(csvField).join(",")
  ).join("\n") + "\n";
  try {
    await Bun.write(SESSIONS_FILE, csv);
  } catch (err) {
    dbg("ERROR", `writeSessions: ${err?.message}`);
    throw new Error(`Could not save sessions file: ${err?.message}`);
  }
}

let server;
try {
  server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",

  routes: {
    "/open-ssh":      { POST:   R(routeOpenSsh) },
    "/auth":          { POST:   R(routeAuth, false) },
    "/info":          { GET:    R(routeInfo, false) },
    "/sessions":      { GET:    R(routeSessionsGet), POST: R(routeSessionsPost) },
    "/sessions/:name":{ DELETE: R(routeSessionDelete) },
    "/shutdown":      { POST:   R(routeShutdown) },
    "/ws":            { GET:    R(routeWs) },
    "/ctrl":          { GET:    R(routeCtrl, false) },
    "/":              R(() => new Response(HTML, { headers: HTML_HDR }), false),
  },
  fetch() { return new Response("Not found", { status: 404 }); },

  websocket: {
    open(ws) {
      activeClients.add(ws);
      dbg("WS", `[+] ${ws.data.ctrl ? 'ctrl' : 'client'} connected id=${short(ws.data.id)}`);
    },

    async message(ws, raw) {
      const id = ws.data.id;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        dbg("ERROR", `[${short(id)}] Failed to parse message: ${raw}`);
        return;
      }

      dbg("WS", `[${short(id)}] message type=${msg.type}`);

      // ── Connect ────────────────────────────────────────────────────────────
      if (msg.type === "connect") {
        const { host, user, port = "22", key } = msg;
        dbg("SSH", `[${short(id)}] Connect request -> ${user}@${host}:${port}  key="${key}"  platform=${process.platform}`);

        if (!host || !user) {
          dbg("ERROR", `[${short(id)}] Missing host or user -- aborting`);
          ws.send(JSON.stringify({ type: "error", data: "Missing host or user." }));
          return;
        }

        const expandedKey = expandHome(key);
        dbg("SSH", `[${short(id)}] Key path expanded: "${key}" -> "${expandedKey}"`);

        // Check if key file exists (best-effort)
        try {
          const stat = await Bun.file(expandedKey).exists();
          dbg("SSH", `[${short(id)}] Key file exists: ${stat}`);
          if (!stat) {
            dbg("WARN", `[${short(id)}] Key file not found at "${expandedKey}" -- SSH may fail`);
            ws.send(JSON.stringify({ type: "error", data: `Warning: key file not found: ${expandedKey}` }));
          }
        } catch (e) {
          dbg("WARN", `[${short(id)}] Could not stat key file: ${e?.message}`);
        }

        const sshArgs = [
          "ssh", "-tt",
          "-i", expandedKey,
          "-p", String(port),
          "-o", "StrictHostKeyChecking=no",
          "-o", "BatchMode=yes",
          "-o", "ConnectTimeout=10",
          `${user}@${host}`,
        ];
        dbg("SSH", `[${short(id)}] spawn: ${user}@${host}:${port}`);

        let proc;
        try {
          proc = Bun.spawn(sshArgs, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          dbg("SSH", `[${short(id)}] Process spawned, pid=${proc.pid}`);
        } catch (err) {
          dbg("ERROR", `[${short(id)}] Bun.spawn failed: ${err?.message ?? err}`);
          ws.send(JSON.stringify({ type: "error", data: `Failed to spawn SSH: ${err?.message}` }));
          return;
        }

        sessions.set(id, { proc, keyRejected: false });
        ws.send(JSON.stringify({ type: "connected" }));

        pipeStream(proc.stdout, ws, "stdout", id);
        pipeStream(proc.stderr, ws, "stderr", id);

        proc.exited.then((code) => {
          dbg("SSH", `[${short(id)}] Process exited with code=${code}`);
          sessions.delete(id);
          try { ws.send(JSON.stringify({ type: "closed" })); } catch {}
        });

        return;
      }

      // ── Send command ───────────────────────────────────────────────────────
      if (msg.type === "cmd") {
        const session = sessions.get(id);
        if (!session) {
          dbg("WARN", `[${short(id)}] cmd: no session`);
          return;
        }
        const payload = msg.data + "\n";
        dbg("SSH", `[${short(id)}] stdin <- ${msg.secret ? '[redacted]' : JSON.stringify(msg.data)}`);
        try {
          session.proc.stdin.write(payload);
        } catch (err) {
          dbg("ERROR", `[${short(id)}] stdin write: ${err?.message}`);
          ws.send(JSON.stringify({ type: "error", data: `stdin error: ${err?.message}` }));
        }
        return;
      }

      if (msg.type === "ctrl" && msg.signal === "SIGINT") {
        const session = sessions.get(id);
        if (!session) { dbg("WARN", `[${short(id)}] SIGINT: no session`); return; }
        dbg("SSH", `[${short(id)}] SIGINT`);
        try {
          session.proc.stdin.write(new Uint8Array([0x03]));
        } catch (err) {
          dbg("ERROR", `[${short(id)}] SIGINT failed: ${err?.message}`);
        }
        return;
      }

      if (msg.type === "disconnect") {
        const session = sessions.get(id);
        if (session) {
          dbg("SSH", `[${short(id)}] disconnect: exit + kill/800ms`);
          try { session.proc.stdin.write("exit\n"); } catch {}
          setTimeout(() => {
            try { session.proc.kill(); dbg("SSH", `[${short(id)}] killed`); } catch {}
          }, 800);
          sessions.delete(id);
        } else {
          dbg("WARN", `[${short(id)}] disconnect: no session`);
        }
        ws.send(JSON.stringify({ type: "closed" }));
        return;
      }

      dbg("WARN", `[${short(id)}] unhandled type: ${msg.type}`);
    },

    close(ws) {
      activeClients.delete(ws);
      const id = ws.data.id;
      const session = sessions.get(id);
      if (session) {
        dbg("SSH", `[${short(id)}] WS closed -- killing orphaned SSH process`);
        try { session.proc.kill(); } catch {}
        sessions.delete(id);
      }
      dbg("WS", `[-] client disconnected id=${short(id)}`);
    },
  },
});
} catch (err) {
  const msg = err?.code === "EADDRINUSE"
    ? `Failed to start server. Is port ${PORT} in use?`
    : `Failed to start server: ${err?.message ?? err}`;
  dbg("ERROR", msg);
  process.exit(1);
}

dbg("INFO", `Platform: ${process.platform}  HOME=${process.env.HOME ?? "(unset)"}  USERPROFILE=${process.env.USERPROFILE ?? "(unset)"}`);

process.on("SIGINT", () => {
  dbg("INFO", "SIGINT received -- closing sessions and shutting down");
  for (const [id, { proc }] of sessions) {
    try { proc.kill(); } catch {}
    dbg("SSH", `[${short(id)}] killed on SIGINT`);
  }
  sessions.clear();
  for (const ws of activeClients) {
    try {
      ws.send(JSON.stringify({ type: ws.data.ctrl ? "sigint" : "closed" }));
    } catch {}
  }
  setTimeout(() => process.exit(0), 200);
});
console.log(`\n  Wits v${VERSION} — Web Interface to SSH`);
console.log(`  ->  http://localhost:${PORT}`);
if (AUTH_MODE === "none")     console.log(`  Auth: disabled (-np)\n`);
else if (AUTH_MODE === "custom") console.log(`  Auth: custom passphrase (-pass)\n`);
else                          console.log(`  Passphrase is ${RANDOM_PASS}\n`);

