// Minimal Discord IPC (Rich Presence) client. No dependencies.
// Frame format: [int32 LE opcode][int32 LE length][JSON payload]
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { IS_WINDOWS } from './common';

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;

export interface Activity {
  type?: number;
  instance?: boolean;
  details: string;
  state: string;
  timestamps: { start: number };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
  buttons?: { label: string; url: string }[];
}

interface DiscordIPCEvents {
  ready: (user: string) => void;
  closed: (info: { code?: number; message?: string }) => void;
  disconnect: () => void;
  'socket-error': (err: Error) => void;
  'error-frame': (data: { code?: number; message?: string }) => void;
}

export declare interface DiscordIPC {
  on<K extends keyof DiscordIPCEvents>(event: K, listener: DiscordIPCEvents[K]): this;
  emit<K extends keyof DiscordIPCEvents>(event: K, ...args: Parameters<DiscordIPCEvents[K]>): boolean;
}

function candidateSocketPaths(): string[] {
  if (IS_WINDOWS) {
    const out: string[] = [];
    for (let i = 0; i < 10; i++) out.push(`\\\\.\\pipe\\discord-ipc-${i}`);
    return out;
  }
  const dirs: string[] = [];
  for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const) {
    const v = process.env[key];
    if (v) dirs.push(v);
  }
  dirs.push('/tmp');
  // Flatpak/snap subdirs only exist on Linux; probing them elsewhere is harmless.
  const subs = ['', 'app/com.discordapp.Discord/', 'snap.discord/', 'snap.discord-canary/'];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const sub of subs) {
      for (let i = 0; i < 10; i++) {
        const p = path.join(dir, sub, `discord-ipc-${i}`);
        try {
          if (fs.statSync(p).isSocket()) out.push(p);
        } catch {}
      }
    }
  }
  return out;
}

export class DiscordIPC extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  public ready = false;

  constructor(private readonly clientId: string) {
    super();
  }

  /** Try every known Discord IPC location; resolves with the path that worked. */
  async connect(): Promise<string> {
    for (const candidate of candidateSocketPaths()) {
      try {
        await this.tryConnect(candidate);
        return candidate;
      } catch {
        // try the next candidate
      }
    }
    throw new Error('Discord IPC socket not found — is the Discord desktop app running?');
  }

  private tryConnect(sockPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error('connect timeout'));
        }
      }, 2000);
      sock.once('connect', () => {
        settled = true;
        clearTimeout(timer);
        this.attach(sock);
        this.send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
        resolve();
      });
      sock.once('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          reject(err);
        }
      });
    });
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on('data', (d) => this.onData(d));
    sock.on('error', (err) => this.emit('socket-error', err));
    sock.on('close', () => {
      this.ready = false;
      this.emit('disconnect');
    });
  }

  private onData(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const raw = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {}
      this.onFrame(op, payload);
    }
  }

  private onFrame(op: number, payload: Record<string, unknown>): void {
    if (op === OP.PING) return void this.send(OP.PONG, payload);
    if (op === OP.CLOSE) return void this.emit('closed', payload as { code?: number; message?: string });
    if (op !== OP.FRAME) return;
    if (payload.cmd === 'DISPATCH' && payload.evt === 'READY') {
      this.ready = true;
      const data = payload.data as { user?: { username?: string } } | undefined;
      this.emit('ready', data?.user?.username ?? 'unknown');
    } else if (payload.evt === 'ERROR') {
      this.emit('error-frame', (payload.data ?? {}) as { code?: number; message?: string });
    }
  }

  setActivity(activity: Activity): void {
    this.send(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID(),
    });
  }

  /** SET_ACTIVITY with no activity clears the presence for this pid. */
  clearActivity(): void {
    this.send(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid },
      nonce: crypto.randomUUID(),
    });
  }

  private send(op: number, obj: unknown): void {
    if (!this.sock || this.sock.destroyed) return;
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(json.length, 4);
    this.sock.write(Buffer.concat([head, json]));
  }

  destroy(): void {
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
    this.ready = false;
  }
}
