import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { INTERPRETER_ISSUER, INTERPRETER_AUDIENCE } from '../interpreterAuth.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(50); }
  throw Error('Timed out waiting for identity test condition');
}
async function port() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening'); const result = probe.address().port;
  await new Promise(resolve => probe.close(resolve)); return result;
}

test('hotel-owned interpreter accounts: roles, legacy rejection, revocation and service outage',
  { skip: process.env.TEST_CALL_MONGO !== '1', timeout: 100000 }, async t => {
    const prefix = `asl_qa_identity_${randomUUID().replaceAll('-', '')}`;
    const dbs = [], children = [], sockets = [];
    t.after(async () => {
      sockets.forEach(peer => peer.ws.terminate());
      for (const child of children) if (child.pid && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
      for (const db of dbs) {
        assert.ok([`${prefix}_hotel`, `${prefix}_call`].includes(db.name));
        assert.match(db.name, /^asl_qa_identity_[a-f0-9]{32}_(hotel|call)$/);
        await db.dropDatabase(); await db.close();
      }
    });
    for (const suffix of ['hotel', 'call']) dbs.push(await mongoose.createConnection(
      `mongodb://127.0.0.1:27017/${prefix}_${suffix}`, { serverSelectionTimeoutMS: 3000 }).asPromise());
    const [hotelPort, callPort] = await Promise.all([port(), port()]);
    const hotel = `http://127.0.0.1:${hotelPort}`, call = `http://127.0.0.1:${callPort}`;
    const internalToken = randomUUID(), secret = randomUUID(), interpreterSecret = randomUUID(), password = randomUUID();
    async function start(entry, portNumber, env) {
      const child = spawn(process.execPath, [fileURLToPath(new URL(entry, import.meta.url))], {
        cwd: mkdtempSync(join(tmpdir(), 'asl-identity-qa-')), windowsHide: true,
        env: { ...process.env, NODE_ENV: 'test', PORT: String(portNumber), CALL_INTERNAL_TOKEN: internalToken, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '', errors = '', spawnError;
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-4096); });
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
      child.on('error', error => { spawnError = error; });
      try {
        await poll(async () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null) throw Error('Server exited before becoming healthy');
          try { return (await fetch(`http://127.0.0.1:${portNumber}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
          catch { return false; }
        });
      } catch (error) {
        // El diagnóstico conserva sólo las últimas salidas y oculta credenciales de prueba.
        let diagnostic = `${error.message}\nstdout: ${output || '(empty)'}\nstderr: ${errors || '(empty)'}`;
        for (const credential of [internalToken, secret, interpreterSecret, password]) {
          diagnostic = diagnostic.replaceAll(credential, '[redacted]');
        }
        diagnostic = diagnostic.replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
          .replace(/([?&](?:token|password|secret)=)[^\s&]+/gi, '$1[redacted]')
          .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
        throw Error(`Unable to start ${entry} on port ${portNumber} (exitCode=${child.exitCode}, signal=${child.signalCode}): ${diagnostic}`);
      }
      return child;
    }
    const hotelProcess = await start('../../../ASL-Web/server/index.js', hotelPort, {
      MONGODB_URI: `mongodb://127.0.0.1:27017/${prefix}_hotel`, JWT_SECRET: secret, USE_HTTPS: 'false', CALL_PROXY_TARGET: call,
    });
    await start('../index.js', callPort, {
      MONGODB_URI: `mongodb://127.0.0.1:27017/${prefix}_call`, ASL_WEB_API_URL: hotel,
      CALL_JWT_SECRET: secret, INTERPRETER_JWT_SECRET: interpreterSecret,
      INTERPRETER_DEFAULT_USERNAME: 'legacy', INTERPRETER_DEFAULT_PASSWORD: password,
    });
    async function api(base, path, body, token, method = body ? 'POST' : 'GET', extra = {}) {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
      return { status: response.status, data: await response.json() };
    }
    const register = (username, role, token) => api(hotel, '/api/staff/register', { username, password, role, fullName: `QA ${username}` }, token);
    const login = (base, username, pass = password) => api(base, base === hotel ? '/api/staff/login' : '/api/interpreter/login', { username, password: pass });
    async function connect(base, token, path = '/calls') {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}?token=${encodeURIComponent(token)}`);
      const peer = { ws, messages: [], closed: false }; sockets.push(peer);
      ws.on('message', raw => peer.messages.push(JSON.parse(raw.toString())));
      ws.on('close', code => { peer.closed = true; peer.code = code; });
      await once(ws, 'open'); return peer;
    }
    async function deniedSocket(base, token, path = '/calls') {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}${path}?token=${encodeURIComponent(token)}`);
      sockets.push({ ws });
      return new Promise((resolve, reject) => {
        ws.on('open', () => { ws.terminate(); reject(Error('Unauthorized socket opened')); });
        ws.on('unexpected-response', (_, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
        ws.on('error', () => {});
      });
    }

    assert.equal((await register('admin', 'admin')).status, 201);
    const admin = (await login(hotel, 'admin')).data.token;
    assert.equal((await register('operator', 'interpreter')).status, 401);
    for (const [username, role] of [['staff', 'staff'], ['operator', 'interpreter'], ['delete-me', 'interpreter'], ['outage', 'interpreter']]) {
      assert.equal((await register(username, role, admin)).status, 201);
    }
    assert.equal((await register('operator', 'interpreter', admin)).status, 409);
    assert.equal((await register('invalid-role', 'owner', admin)).status, 400);
    const staff = (await login(hotel, 'staff')).data.token;
    assert.equal((await register('unauthorized', 'interpreter', staff)).status, 403);
    assert.equal((await login(hotel, 'operator')).status, 403);
    assert.equal((await login(call, 'staff')).status, 401);
    assert.equal((await login(call, 'admin')).status, 401);
    assert.equal((await login(call, 'operator', 'wrong-password')).status, 401);
    assert.equal((await login(call, 'legacy')).status, 401);
    assert.equal(await dbs[1].collection('interpreterusers').countDocuments(), 0, 'no automatic interpreter account');
    const operatorLogin = await login(call, 'operator');
    assert.equal(operatorLogin.status, 200);
    const operator = operatorLogin.data, userId = operator.interpreter.userId;
    assert.equal(jwt.decode(operator.token).iss, INTERPRETER_ISSUER);
    assert.equal(jwt.decode(operator.token).aud, INTERPRETER_AUDIENCE);
    assert.equal((await api(call, '/api/interpreter/session', null, operator.token)).status, 200);
    assert.equal((await api(hotel, '/api/staff/list', null, operator.token)).status, 401);
    assert.equal(await deniedSocket(hotel, operator.token, '/ws/hotel'), 401);
    const legacyToken = jwt.sign({ userId, role: 'interpreter' }, interpreterSecret);
    assert.equal((await api(call, '/api/interpreter/session', null, legacyToken)).status, 401);
    assert.equal(await deniedSocket(call, legacyToken), 401);
    const wrongRole = jwt.sign({ userId, role: 'admin' }, interpreterSecret,
      { expiresIn: '1h', issuer: INTERPRETER_ISSUER, audience: INTERPRETER_AUDIENCE });
    assert.equal((await api(call, '/api/interpreter/session', null, wrongRole)).status, 401);
    assert.equal(await deniedSocket(call, wrongRole), 401);
    assert.equal((await api(hotel, '/api/internal/interpreters/validate', { userId })).status, 401);
    // Server-to-server validation must not consume the public 100-request quota.
    for (let i = 0; i < 105; i++) assert.equal((await api(hotel, '/api/internal/interpreters/validate', { userId }, null, 'POST', { 'x-internal-token': internalToken })).status, 200);
    const record = await dbs[0].collection('staffusers').findOne({ username: 'operator' });
    assert.match(record.password, /^\$argon2id\$/);
    assert.equal(operator.interpreter.password, undefined);

    const active = await connect(call, operator.token);
    await api(call, '/api/interpreter/presence', { availabilityStatus: 'available' }, operator.token);
    let callId, guest;
    await t.test('CPM_INT_001: hotel-issued session traverses the gateway proxy, rings with guest context and exchanges SDP', async () => {
      const stayId = `qa-stay-${randomUUID()}`;
      await dbs[0].collection('stays').insertOne({ stayId, roomNumber: 'QA-15', guestName: 'QA Guest',
        active: true, status: 'active', checkIn: new Date(Date.now() - 60000), checkOut: new Date(Date.now() + 3600000) });
      const guestToken = jwt.sign({ stayId, roomNumber: 'QA-15', guestName: 'QA Guest' }, secret, { expiresIn: '1m' });
      const session = await api(hotel, '/api/calls/session', {}, guestToken);
      assert.equal(session.status, 200);
      assert.equal(session.data.callServerUrl, `${hotel.replace('http:', 'ws:')}/calls`);
      const claims = jwt.verify(session.data.callToken, secret);
      assert.equal(claims.stayId, stayId);
      assert.equal(claims.callId, session.data.callId);
      assert.equal(claims.scope, 'call');
      callId = session.data.callId;
      const endpoint = new URL(session.data.callServerUrl);
      guest = await connect(endpoint.origin.replace('ws:', 'http:'), session.data.callToken, endpoint.pathname);
      guest.ws.send(JSON.stringify({ type: 'CALL_REQUEST', payload: { callId } }));
      await poll(() => active.messages.some(message => message.type === 'CALL_REQUEST' && message.payload.callId === callId));
      const invitation = active.messages.find(message => message.type === 'CALL_REQUEST' && message.payload.callId === callId);
      assert.equal(invitation.payload.guestName, 'QA Guest');
      assert.equal(invitation.payload.roomNumber, 'QA-15');
      active.ws.send(JSON.stringify({ type: 'CALL_ACCEPTED', payload: { callId } }));
      await poll(() => guest.messages.some(message => message.type === 'CALL_ACCEPTED' && message.payload.callId === callId));
      active.ws.send(JSON.stringify({ type: 'WEBRTC_OFFER', payload: { callId, sdp: { type: 'offer', sdp: 'qa-proxied-offer' } } }));
      await poll(() => guest.messages.some(message => message.type === 'WEBRTC_OFFER' && message.payload.sdp.sdp === 'qa-proxied-offer'));
      guest.ws.send(JSON.stringify({ type: 'WEBRTC_ANSWER', payload: { callId, sdp: { type: 'answer', sdp: 'qa-proxied-answer' } } }));
      await poll(() => active.messages.some(message => message.type === 'WEBRTC_ANSWER' && message.payload.sdp.sdp === 'qa-proxied-answer'));
      assert.equal((await dbs[1].collection('callsessions').findOne({ callId })).status, 'active');
    });
    const deleted = (await login(call, 'delete-me')).data;
    const idle = await connect(call, deleted.token);
    await api(call, '/api/interpreter/presence', { availabilityStatus: 'available' }, deleted.token);
    const expiring = await connect(call, jwt.sign({ userId: deleted.interpreter.userId, role: 'interpreter' }, interpreterSecret,
      { expiresIn: '2s', issuer: INTERPRETER_ISSUER, audience: INTERPRETER_AUDIENCE }));
    const staffSocket = await connect(hotel, staff, '/ws/hotel');
    const staffId = String((await dbs[0].collection('staffusers').findOne({ username: 'staff' }))._id);
    const started = Date.now();
    assert.equal((await api(hotel, '/api/staff/update-role', { userId, role: 'staff' }, admin, 'PUT')).status, 200);
    assert.equal((await api(hotel, `/api/staff/delete/${deleted.interpreter.userId}`, null, admin, 'DELETE')).status, 200);
    assert.equal((await api(hotel, `/api/staff/update/${staffId}`, { username: 'staff', fullName: 'Now Interpreter', role: 'interpreter' }, admin, 'PUT')).status, 200);
    assert.equal((await api(hotel, '/api/staff/list', null, staff)).status, 403);
    assert.equal((await api(call, '/api/interpreter/session', null, operator.token)).status, 401);
    await poll(() => active.closed && idle.closed && expiring.closed && staffSocket.closed, 30000);
    assert.ok(Date.now() - started < 30000);
    assert.equal(active.code, 1008);
    assert.ok(guest.messages.some(message => message.type === 'CALL_ENDED'));
    await poll(async () => (await dbs[1].collection('interpreterpresences').findOne({ interpreterId: userId }))?.availabilityStatus === 'offline');
    assert.equal((await dbs[1].collection('callsessions').findOne({ callId })).status, 'completed');

    const outageLogin = await login(call, 'outage');
    assert.equal(outageLogin.status, 200);
    const outage = await connect(call, outageLogin.data.token);
    const stopped = once(hotelProcess, 'exit'); hotelProcess.kill(); await stopped;
    const unavailableAt = Date.now();
    assert.equal((await login(call, 'outage')).status, 503);
    assert.equal((await api(call, '/api/interpreter/session', null, outageLogin.data.token)).status, 503);
    await poll(() => outage.closed, 30000);
    assert.ok(Date.now() - unavailableAt < 30000);
    assert.equal(outage.code, 1013);
  });
