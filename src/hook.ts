#!/usr/bin/env node
// Claude Code hook entry point. Reads the hook event JSON from stdin,
// forwards a trimmed version to the daemon, and spawns the daemon if it
// isn't running. Must never block Claude Code: always exits 0, never
// writes to stdout (hook stdout can be injected into the session context).
import * as net from 'net';
import * as path from 'path';
import { spawn } from 'child_process';
import { CONTROL_SOCKET, log, type HookEvent } from './common';

const KEEP_INPUT_KEYS = ['file_path', 'notebook_path', 'description', 'skill'] as const;

// Absolute upper bound so a wedged hook can never hang a session.
setTimeout(() => process.exit(0), 8000).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let evt: HookEvent & { tool_input?: Record<string, unknown> };
  try {
    evt = JSON.parse(raw);
  } catch {
    return process.exit(0);
  }
  if (!evt || !evt.hook_event_name) return process.exit(0);

  // Forward only what the daemon needs — never prompt text or tool output.
  const msg: HookEvent = {
    hook_event_name: evt.hook_event_name,
    session_id: evt.session_id,
    cwd: evt.cwd,
    transcript_path: evt.transcript_path,
    tool_name: evt.tool_name,
    model: evt.model,
    source: evt.source,
    reason: evt.reason,
    type: evt.type,
  };
  if (evt.tool_input && typeof evt.tool_input === 'object') {
    const input: Record<string, unknown> = {};
    for (const k of KEEP_INPUT_KEYS) {
      if (evt.tool_input[k] !== undefined) input[k] = evt.tool_input[k];
    }
    msg.tool_input = input;
  }
  // Don't bother starting a daemon just to tell it a session ended.
  send(JSON.stringify(msg) + '\n', evt.hook_event_name !== 'SessionEnd');
});

function send(line: string, mayStartDaemon: boolean, attempt = 0): void {
  const sock = net.createConnection(CONTROL_SOCKET);
  let delivered = false;
  sock.on('connect', () => {
    delivered = true;
    sock.end(line);
  });
  // A failed connect emits 'error' then 'close' — only exit once the line
  // was actually handed off, otherwise the retry below must keep running.
  sock.on('close', () => {
    if (delivered) process.exit(0);
  });
  sock.on('error', () => {
    sock.destroy();
    if (!mayStartDaemon) return process.exit(0);
    if (attempt === 0) startDaemon();
    if (attempt >= 12) {
      log('hook: gave up reaching the daemon');
      return process.exit(0);
    }
    setTimeout(() => send(line, mayStartDaemon, attempt + 1), 200);
  });
}

function startDaemon(): void {
  try {
    spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (err) {
    log('hook: failed to spawn daemon:', (err as Error).message);
  }
}
