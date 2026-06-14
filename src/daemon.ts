#!/usr/bin/env node
// Persistent daemon: receives hook events on a local control socket and
// mirrors them to Discord Rich Presence. Spawned on demand by hook.ts;
// exits on its own once all Claude Code sessions have ended.
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import {
  CONTROL_SOCKET,
  IS_WINDOWS,
  readConfig,
  configMtime,
  log,
  type Config,
  type HookEvent,
  type Session,
} from './common';
import { DiscordIPC } from './ipc';
import { prettyModel, describeToolUse, buildActivity } from './activity';

let cfg: Config = readConfig();
let cfgSeen = configMtime();

const sessions = new Map<string, Session>();

let discord: DiscordIPC | null = null;
let discordReady = false;
let connectFailures = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let warnedNoClientId = false;

let lastSentJson: string | null = null;
let lastSendAt = 0;
let lastHeartbeatAt = 0;
let sendTimer: NodeJS.Timeout | null = null;
let exitTimer: NodeJS.Timeout | null = null;
let typeSupported = true;

const KNOWN_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Stop',
  'Notification',
  'SessionEnd',
]);

// ---------- control socket (hooks talk to us here) ----------

type ControlMessage = Partial<HookEvent> & { cmd?: string };

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(line, sock);
    }
  });
  sock.on('error', () => {});
});

function handleLine(line: string, sock: net.Socket): void {
  let msg: ControlMessage;
  try {
    msg = JSON.parse(line) as ControlMessage;
  } catch {
    return;
  }
  if (msg.cmd === 'status') {
    try {
      sock.write(JSON.stringify(statusInfo()) + '\n');
    } catch {}
    return;
  }
  if (msg.cmd === 'shutdown') return shutdown('control command');
  if (msg.hook_event_name) handleEvent(msg as HookEvent);
}

function bindControlSocket(allowRecover: boolean): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && allowRecover) {
      // Either another daemon is alive, or a stale socket file was left behind.
      const probe = net.createConnection(CONTROL_SOCKET);
      probe.setTimeout(1000);
      probe.on('connect', () => {
        probe.destroy();
        log('daemon: another instance is running, exiting');
        process.exit(0);
      });
      const recover = () => {
        probe.destroy();
        if (!IS_WINDOWS) {
          try {
            fs.unlinkSync(CONTROL_SOCKET);
          } catch {}
          bindControlSocket(false);
        } else {
          setTimeout(() => bindControlSocket(false), 500);
        }
      };
      probe.on('error', recover);
      probe.on('timeout', recover);
    } else {
      log('daemon: could not bind control socket:', err.message);
      process.exit(1);
    }
  });
  server.listen(CONTROL_SOCKET, () => {
    log(`daemon: started (pid ${process.pid}), control socket ${CONTROL_SOCKET}`);
  });
}

// ---------- session tracking ----------

function projectName(cwd: string | undefined): string {
  try {
    return path.basename(String(cwd ?? ''));
  } catch {
    return '';
  }
}

function handleEvent(evt: HookEvent): void {
  maybeReloadConfig();
  const now = Date.now();
  const id = evt.session_id ?? 'unknown';
  const name = evt.hook_event_name;

  if (!KNOWN_EVENTS.has(name)) {
    if (cfg.debug) log(`event ${name} ignored (unknown hook event)`);
    return;
  }

  if (name === 'SessionEnd') {
    if (sessions.delete(id)) log(`session ${id.slice(0, 8)} ended (${evt.reason ?? 'unknown'})`);
    scheduleUpdate();
    checkEmpty();
    return;
  }

  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      project: projectName(evt.cwd),
      model: '',
      startedAt: now,
      lastEventAt: now,
      statusText: 'Waiting for the next prompt',
      transcriptPath: evt.transcript_path ?? '',
    };
    sessions.set(id, s);
    log(`session ${id.slice(0, 8)} tracked (${s.project || 'unknown project'})`);
  }
  if (evt.cwd) s.project = projectName(evt.cwd);
  if (evt.transcript_path) s.transcriptPath = evt.transcript_path;
  s.lastEventAt = now;

  switch (name) {
    case 'SessionStart':
      s.startedAt = now;
      if (evt.model) s.model = prettyModel(evt.model);
      s.statusText = 'Waiting for the next prompt';
      break;
    case 'UserPromptSubmit':
      s.statusText = 'Thinking…';
      break;
    case 'PreToolUse':
      s.statusText = describeToolUse(evt.tool_name, evt.tool_input, cfg);
      break;
    case 'Stop':
      s.statusText = 'Waiting for the next prompt';
      break;
    case 'Notification':
      if (evt.type === 'permission_prompt') s.statusText = 'Waiting for approval';
      else if (evt.type === 'idle_prompt') s.lastEventAt = now - cfg.idleTimeoutMs - 1;
      break;
    default:
      break;
  }

  if (exitTimer) {
    clearTimeout(exitTimer);
    exitTimer = null;
  }
  if (cfg.debug) log(`event ${name} (${id.slice(0, 8)}) -> "${s.statusText}"`);
  scheduleUpdate();
}

function currentSession(): Session | null {
  let best: Session | null = null;
  for (const s of sessions.values()) {
    if (!best || s.lastEventAt > best.lastEventAt) best = s;
  }
  return best;
}

function checkEmpty(): void {
  if (sessions.size > 0 || exitTimer) return;
  exitTimer = setTimeout(() => {
    if (sessions.size === 0) shutdown('no active sessions');
  }, cfg.exitGraceMs);
}

function sweepStale(): void {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastEventAt < cfg.staleSessionMs) continue;
    let alive = false;
    try {
      alive = now - fs.statSync(s.transcriptPath).mtimeMs < cfg.staleSessionMs;
    } catch {}
    if (!alive) {
      sessions.delete(s.id);
      log(`session ${s.id.slice(0, 8)} swept (stale)`);
    }
  }
  checkEmpty();
}

// ---------- presence updates (throttled, trailing edge) ----------

function scheduleUpdate(): void {
  if (sendTimer) return; // the pending send will pick up the latest state
  const wait = Math.max(0, lastSendAt + cfg.updateIntervalMs - Date.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    sendNow();
  }, wait);
}

function sendNow(): void {
  lastSendAt = Date.now();
  if (!discordReady || !discord) return;
  const s = currentSession();
  if (!s) {
    if (lastSentJson !== 'cleared') {
      discord.clearActivity();
      lastSentJson = 'cleared';
      log('presence cleared');
    }
    return;
  }
  const idle = Date.now() - s.lastEventAt > cfg.idleTimeoutMs;
  const activity = buildActivity(s, cfg, idle, typeSupported);
  const json = JSON.stringify(activity);
  const changed = json !== lastSentJson;
  const heartbeatDue =
    cfg.presenceHeartbeatMs > 0 && Date.now() - lastHeartbeatAt >= cfg.presenceHeartbeatMs;
  if (!changed && !heartbeatDue) return;
  lastSentJson = json;
  lastHeartbeatAt = Date.now();
  discord.setActivity(activity);
  if (cfg.debug) {
    const kind = changed ? 'presence' : 'heartbeat';
    log(`${kind}: "${activity.details}" | "${activity.state}"${idle ? ' (idle)' : ''}`);
  }
}

// ---------- Discord connection ----------

function connectDiscord(): void {
  if (!cfg.clientId) {
    if (!warnedNoClientId) {
      warnedNoClientId = true;
      log('discord: no clientId configured — presence disabled until one is set in config.json');
    }
    return;
  }
  if (discord) discord.destroy();
  const ipc = new DiscordIPC(cfg.clientId);
  discord = ipc;
  ipc.on('ready', (user) => {
    discordReady = true;
    connectFailures = 0;
    lastSentJson = null;
    log(`discord: connected and ready (account: ${user})`);
    sendNow();
  });
  ipc.on('closed', (info) => {
    log(`discord: connection closed by Discord: ${JSON.stringify(info)}`);
  });
  ipc.on('disconnect', () => {
    discordReady = false;
    scheduleReconnect();
  });
  ipc.on('socket-error', (err) => {
    if (cfg.debug) log('discord: socket error:', err.message);
  });
  ipc.on('error-frame', (data) => {
    const msg = data.message ?? '';
    log('discord: rejected an update:', msg || JSON.stringify(data));
    if (typeSupported && /type/i.test(msg)) {
      // Older Discord clients reject the activity "type" field — retry without it.
      typeSupported = false;
      lastSentJson = null;
      scheduleUpdate();
    }
  });
  ipc
    .connect()
    .then((sockPath) => log(`discord: handshaking via ${sockPath}`))
    .catch((err: Error) => {
      log('discord: connect failed:', err.message);
      scheduleReconnect();
    });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  connectFailures++;
  const delay = Math.min(15000 * connectFailures, 120000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectDiscord();
  }, delay);
}

function restartDiscord(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  discordReady = false;
  connectFailures = 0;
  warnedNoClientId = false;
  connectDiscord();
}

function maybeReloadConfig(): void {
  const m = configMtime();
  if (m === cfgSeen) return;
  cfgSeen = m;
  const oldClientId = cfg.clientId;
  cfg = readConfig();
  log('config reloaded');
  lastSentJson = null;
  if (cfg.clientId !== oldClientId) restartDiscord();
}

// ---------- lifecycle ----------

function statusInfo() {
  const now = Date.now();
  return {
    pid: process.pid,
    clientId: cfg.clientId ? 'set' : 'missing',
    discord: discordReady ? 'ready' : 'not connected',
    sessions: [...sessions.values()].map((s) => ({
      id: s.id.slice(0, 8),
      project: s.project,
      model: s.model,
      status: s.statusText,
      secondsSinceEvent: Math.round((now - s.lastEventAt) / 1000),
    })),
  };
}

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`daemon: shutting down (${reason})`);
  try {
    if (discordReady && discord) discord.clearActivity();
  } catch {}
  setTimeout(() => {
    try {
      discord?.destroy();
    } catch {}
    try {
      server.close();
    } catch {}
    cleanupSocketFile();
    process.exit(0);
  }, 200);
}

function cleanupSocketFile(): void {
  if (IS_WINDOWS) return; // named pipes vanish with the process
  try {
    fs.unlinkSync(CONTROL_SOCKET);
  } catch {}
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', cleanupSocketFile);
process.on('uncaughtException', (err) => {
  log('daemon: uncaught exception:', err.stack ?? String(err));
});

setInterval(() => {
  maybeReloadConfig();
  sweepStale();
  scheduleUpdate(); // re-render so idle state kicks in without new events
}, 5000).unref();

// Safety net: never outlive a full day without any session activity.
setInterval(() => {
  const s = currentSession();
  if (!s || Date.now() - s.lastEventAt > 24 * 60 * 60 * 1000) shutdown('24h safety timeout');
}, 60 * 60 * 1000).unref();

bindControlSocket(true);
connectDiscord();
checkEmpty();
