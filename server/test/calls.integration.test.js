import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

const enabled = process.env.TEST_CALL_MONGO === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test('isolated call server: request, ring, accept, signaling, end and persistence failure',
  { skip: !enabled, timeout: 40000 }, async t => {
    const database = `asl_qa_calls_${randomUUID().replaceAll('-', '')}`;
    const uri = `mongodb://127.0.0.1:27017/${database}`;
    const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 3000 }).asPromise();
    const sockets = [];
    let child, identityServer;
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      if (child && child.exitCode === null) {
        const exit = once(child, 'exit');
        child.kill();
        await exit;
      }
      if (identityServer) { identityServer.closeAllConnections(); await new Promise(resolve => identityServer.close(resolve)); }
      // This test creates this exact unique database, never the application's DB.
      assert.match(connection.name, /^asl_qa_calls_[a-f0-9]{32}$/);
      assert.equal(connection.name, database);
      await connection.dropDatabase();
      await connection.close();
    });
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const secret = randomUUID(), password = randomUUID();
    const internalToken = randomUUID();
    const identity = { userId: '111111111111111111111111', username: 'qa-interpreter', fullName: 'QA Interpreter', role: 'interpreter' };
    identityServer = createHttpServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const valid = req.headers['x-internal-token'] === internalToken &&
        (req.url.endsWith('/validate') ? body.userId === identity.userId : body.username === identity.username && body.password === password);
      res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(valid ? { interpreter: identity } : { error: 'Invalid identity' }));
    }).listen(0, '127.0.0.1');
    await once(identityServer, 'listening');
    child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
      cwd: mkdtempSync(join(tmpdir(), 'asl-call-qa-')), windowsHide: true,
      env: { ...process.env, PORT: String(port), MONGODB_URI: uri,
        CALL_JWT_SECRET: secret, INTERPRETER_JWT_SECRET: randomUUID(),
        CALL_INTERNAL_TOKEN: internalToken, ASL_WEB_API_URL: `http://127.0.0.1:${identityServer.address().port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', error => t.diagnostic(error.message));
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const base = `http://127.0.0.1:${port}`;
    await poll(async () => {
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, 'server ready', 10000);
    async function api(route, body, token) {
      const response = await fetch(`${base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    }
    async function socket(token) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/calls?token=${encodeURIComponent(token)}`);
      sockets.push(ws);
      const messages = [];
      ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
      await once(ws, 'open');
      return { ws, messages,
        send: (type, payload) => ws.send(JSON.stringify({ type, payload })),
        wait: (type, callId) => poll(() => messages.find(m => m.type === type && m.payload?.callId === callId), `${type} for ${callId}`),
      };
    }
    const login = await api('/api/interpreter/login', { username: 'qa-interpreter', password });
    const interpreter = await socket(login.token);
    const available = () => api('/api/interpreter/presence', { availabilityStatus: 'available' }, login.token);
    const guest = (callId, extra = {}) => socket(jwt.sign({ scope: 'call', clientType: 'guest', callId,
      stayId: 'qa-stay', roomNumber: 'QA', guestName: 'QA Guest', ...extra }, secret, { expiresIn: '1m' }));

    await t.test('a guest request reaches the available interpreter and exchanges signaling', async () => {
      await available();
      const callId = 'qa-success';
      const mobile = await guest(callId);
      mobile.send('CALL_REQUEST', { callId });
      await mobile.wait('CALL_PENDING', callId);
      await interpreter.wait('CALL_REQUEST', callId);
      assert.equal((await connection.collection('callsessions').findOne({ callId })).status, 'ringing');
      interpreter.send('CALL_ACCEPTED', { callId });
      await mobile.wait('CALL_ACCEPTED', callId);
      interpreter.send('WEBRTC_OFFER', { callId, sdp: { type: 'offer', sdp: 'qa-offer' } });
      assert.equal((await mobile.wait('WEBRTC_OFFER', callId)).payload.sdp.sdp, 'qa-offer');
      mobile.send('WEBRTC_ANSWER', { callId, sdp: { type: 'answer', sdp: 'qa-answer' } });
      await interpreter.wait('WEBRTC_ANSWER', callId);
      mobile.send('CALL_ENDED', { callId, reason: 'completed' });
      await interpreter.wait('CALL_ENDED', callId);
      assert.equal((await connection.collection('callsessions').findOne({ callId })).status, 'completed');
      // Report delivery is exercised by reports.integration.test.js. Complete
      // this fixture so the next subtest can independently reserve the operator.
      await connection.collection('callsessions').updateOne({ callId }, { $set: { reportForwardStatus: 'forwarded' } });
    });

    await t.test('persistence errors notify the guest and release the reserved interpreter', async () => {
      await available();
      const callId = 'qa-invalid';
      const mobile = await guest(callId, { roomNumber: { invalid: true } });
      mobile.send('CALL_REQUEST', { callId });
      await mobile.wait('CALL_ERROR', callId);
      const presence = await connection.collection('interpreterpresences').findOne({ interpreterId: login.interpreter.userId });
      assert.equal(presence.availabilityStatus, 'available');
      assert.equal(presence.currentCallId, null);
      assert.ok(!interpreter.messages.some(m => m.type === 'CALL_REQUEST' && m.payload.callId === callId));
      assert.match(errors, /CALL_MESSAGE_FAILED/);
    });
  });
