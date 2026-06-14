#!/usr/bin/env node
// Installs the Rich Presence hooks into ~/.claude/settings.json (user-level,
// so presence works in every project). Idempotent: re-running replaces any
// previous discord-claude entries. A timestamped backup is written first.
//
// Usage: node dist/install.js [discord-application-id]
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_PATH, ROOT, readConfig } from './common';

const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'Notification', 'SessionEnd'];

// JSON-escaped form of the script path, so matching works on Windows too
// (backslashes are escaped inside the stringified settings).
const NEEDLE = JSON.stringify(HOOK_SCRIPT).slice(1, -1);

interface HookEntry {
  type: 'command';
  command: string;
  timeout: number;
  async?: boolean;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function die(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

const clientId = (process.argv[2] ?? '').trim();
if (clientId && !/^\d{15,21}$/.test(clientId)) {
  die(`a Discord application ID is a 15-21 digit number, got: ${clientId}`);
}

// Make sure a config.json exists so users have something to tweak.
if (!fs.existsSync(CONFIG_PATH)) {
  const example = path.join(ROOT, 'config.example.json');
  try {
    fs.copyFileSync(example, CONFIG_PATH);
    console.log('✓ created config.json from config.example.json');
  } catch {}
}

if (clientId) {
  let cfgRaw: Record<string, unknown> = {};
  try {
    cfgRaw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  cfgRaw.clientId = clientId;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRaw, null, 2) + '\n');
  console.log('✓ saved application ID to config.json');
}

let settings: Settings = {};
if (fs.existsSync(SETTINGS_PATH)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Settings;
  } catch (err) {
    die(`could not parse ${SETTINGS_PATH}: ${(err as Error).message} — fix it and re-run`);
  }
  const backup = `${SETTINGS_PATH}.backup-${Date.now()}`;
  fs.copyFileSync(SETTINGS_PATH, backup);
  console.log(`✓ backed up settings to ${backup}`);
}

settings.hooks = settings.hooks ?? {};
for (const event of EVENTS) {
  const groups = (settings.hooks[event] ?? []).filter(
    (g) => !JSON.stringify(g).includes(NEEDLE)
  );
  const entry: HookEntry = {
    type: 'command',
    command: `"${process.execPath}" "${HOOK_SCRIPT}"`,
    timeout: 10,
  };
  // Async = zero added latency. SessionEnd stays synchronous so it completes
  // before Claude Code exits (it only writes one line to a local socket).
  if (event !== 'SessionEnd') entry.async = true;
  groups.push({ hooks: [entry] });
  settings.hooks[event] = groups;
}

fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
console.log(`✓ hooks installed into ${SETTINGS_PATH}`);
console.log(`  events: ${EVENTS.join(', ')}`);

if (!readConfig().clientId) {
  console.log(`
⚠ No Discord application ID configured — presence stays off until one is set:
   1. https://discord.com/developers/applications → "New Application"
     (note: Discord rejects names containing "Claude" — pick something like "Clawd Code")
   2. Copy the Application ID from General Information
   3. Run: node dist/install.js <that-id>`);
}
console.log('\n→ Start a new Claude Code session (hooks load at session start) and check Discord.');
