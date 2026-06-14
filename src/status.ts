#!/usr/bin/env node
// Debug helper: prints the daemon's view of the world.
import * as net from 'net';
import { CONTROL_SOCKET, LOG_PATH } from './common';

const sock = net.createConnection(CONTROL_SOCKET);
sock.setTimeout(2000);
let buf = '';

sock.on('connect', () => sock.write('{"cmd":"status"}\n'));
sock.on('data', (d) => {
  buf += d.toString('utf8');
  if (buf.includes('\n')) {
    try {
      console.log(JSON.stringify(JSON.parse(buf.trim()), null, 2));
    } catch {
      console.log(buf.trim());
    }
    sock.destroy();
    process.exit(0);
  }
});
sock.on('timeout', () => {
  console.log('daemon did not respond in time');
  process.exit(1);
});
sock.on('error', () => {
  console.log(`daemon is not running (no socket at ${CONTROL_SOCKET})`);
  console.log(`log file: ${LOG_PATH}`);
  process.exit(1);
});
