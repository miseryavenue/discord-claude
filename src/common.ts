import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Config {
  clientId: string;
  showProjectName: boolean;
  showFileNames: boolean;
  showToolDetail: boolean;
  largeImage: string;
  largeText: string;
  smallImageWorking: string;
  smallImageIdle: string;
  activityType: number;
  buttons: { label: string; url: string }[];
  idleTimeoutMs: number;
  exitGraceMs: number;
  staleSessionMs: number;
  updateIntervalMs: number;
  presenceHeartbeatMs: number;
  debug: boolean;
}

/** Trimmed-down hook event forwarded from hook.ts to the daemon. */
export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  model?: string;
  source?: string;
  reason?: string;
  type?: string;
}

export interface Session {
  id: string;
  project: string;
  model: string;
  startedAt: number;
  lastEventAt: number;
  statusText: string;
  transcriptPath: string;
}

export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const LOG_PATH = path.join(os.tmpdir(), 'claude-discord-rpc.log');

export const IS_WINDOWS = process.platform === 'win32';

/** Per-user control socket so multiple users on one machine never collide. */
function controlSocketPath(): string {
  if (IS_WINDOWS) {
    let user = 'default';
    try {
      user = os.userInfo().username;
    } catch {}
    return `\\\\.\\pipe\\claude-discord-rpc-${user}`;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join(os.tmpdir(), `claude-discord-rpc-${uid}.sock`);
}

export const CONTROL_SOCKET = controlSocketPath();

export const DEFAULTS: Config = {
  // Shared application ID so the presence works out of the box for anyone
  // who clones the repo. Override with your own app in config.json.
  clientId: '',
  showProjectName: true,
  showFileNames: true,
  showToolDetail: true,
  largeImage:
    'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b0/Claude_AI_symbol.svg/960px-Claude_AI_symbol.svg.png',
  largeText: 'Claude Code',
  smallImageWorking: '',
  smallImageIdle: '',
  activityType: 0,
  buttons: [],
  idleTimeoutMs: 5 * 60 * 1000,
  exitGraceMs: 45 * 1000,
  staleSessionMs: 2 * 60 * 60 * 1000,
  updateIntervalMs: 3000,
  presenceHeartbeatMs: 15000,
  debug: false,
};

export function readConfig(): Config {
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  } catch {
    // missing or invalid config: fall back to defaults
  }
  return { ...DEFAULTS, ...user };
}

export function configMtime(): number {
  try {
    return fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

export function log(...parts: unknown[]): void {
  const text = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    try {
      if (fs.statSync(LOG_PATH).size > 512 * 1024) fs.truncateSync(LOG_PATH, 0);
    } catch {}
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}
