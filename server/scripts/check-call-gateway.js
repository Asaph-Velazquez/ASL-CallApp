// Read-only smoke check: authenticate a short-lived diagnostic guest socket,
// exchange ping/pong, then close. Never send CALL_REQUEST or reserve an interpreter.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

const webEnv = parse(readFileSync(new URL('../../../ASL-Web/server/.env', import.meta.url)));
const mobileEnv = parse(readFileSync(new URL('../../../ASL-MobileAPP/.env', import.meta.url)));
const publicOrigin = mobileEnv.EXPO_PUBLIC_API_URL || mobileEnv.EXPO_PUBLIC_PUBLIC_BASE_URL;
const urls = ['ws://localhost:3101/calls', 'ws://localhost:8080/calls'];
if (publicOrigin) {
  const url = new URL('/calls', publicOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  urls.push(url.toString());
}

const token = jwt.sign({ scope: 'call', clientType: 'guest', callId: `diagnostic-${randomUUID()}` },
  webEnv.CALL_JWT_SECRET || webEnv.JWT_SECRET, { expiresIn: '1m' });

for (const address of urls) {
  try {
    await new Promise((resolve, reject) => {
      const url = new URL(address);
      url.searchParams.set('token', token);
      const socket = new WebSocket(url, { handshakeTimeout: 10000 });
      const timer = setTimeout(() => finish(new Error('WebSocket ping timed out')), 12000);
      let finished = false;
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        else socket.terminate();
        if (error) reject(error); else resolve();
      }
      socket.on('open', () => socket.ping('asl-gateway-check'));
      socket.on('pong', () => finish());
      socket.on('error', error => finish(new Error(error.code || 'WebSocket connection failed')));
      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        finish(new Error(`HTTP ${response.statusCode} during WebSocket upgrade`));
      });
    });
    console.log(`OK authenticated WebSocket + ping/pong: ${address}`);
  } catch (error) {
    console.error(`FAIL ${address}: ${error.message}`);
    process.exitCode = 1;
  }
}
