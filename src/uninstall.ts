#!/usr/bin/env node
// Removes the discord-claude hooks from ~/.claude/settings.json and stops
// the daemon if it is running.
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import { CONTROL_SOCKET } from './common';

const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
const NEEDLE = JSON.stringify(HOOK_SCRIPT).slice(1, -1);
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

if (fs.existsSync(SETTINGS_PATH)) {
  let settings: { hooks?: Record<string, unknown[]>; [key: string]: unknown };
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    console.error(`✗ could not parse ${SETTINGS_PATH}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (settings.hooks) {
    const backup = `${SETTINGS_PATH}.backup-${Date.now()}`;
    fs.copyFileSync(SETTINGS_PATH, backup);
    console.log(`✓ backed up settings to ${backup}`);
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = (settings.hooks[event] ?? []).filter(
        (g) => !JSON.stringify(g).includes(NEEDLE)
      );
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log('✓ hooks removed from ' + SETTINGS_PATH);
  }
} else {
  console.log('nothing to remove: no ' + SETTINGS_PATH);
}

const sock = net.createConnection(CONTROL_SOCKET);
sock.setTimeout(1500);
sock.on('connect', () => {
  sock.end('{"cmd":"shutdown"}\n');
  console.log('✓ daemon stopped');
  setTimeout(() => process.exit(0), 300);
});
const done = () => {
  console.log('✓ daemon was not running');
  process.exit(0);
};
sock.on('error', done);
sock.on('timeout', done);
